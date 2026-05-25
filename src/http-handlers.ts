// Pure decision helpers extracted from src/http.ts. Each function takes already-parsed
// inputs and returns the decision (data, validation result, or routing kind) without
// touching IncomingMessage / ServerResponse / the filesystem. The HTTP shell in
// src/http.ts is then a thin dispatcher: parse → decide (here) → emit.

// Compact view of the declared per-state config used by the dashboard. The view-builder
// in src/bin/symphony.ts derives this from `cfg.states` on every request so a workflow
// reload (which mutates the live config in place) is reflected without rebinding the
// server. Order is the workflow declaration order — operators get state columns and
// approve/discard targets in the sequence they wrote them in `states:`.
export interface StateView {
  name: string;
  role: 'active' | 'terminal' | 'holding';
}

// ─── Route matcher ──────────────────────────────────────────────────────
// One place that knows which pathnames the server answers. matchRoute returns
// a discriminated union; the dispatcher in http.ts maps `kind` to a per-route
// shell handler. Identifiers parsed out of the path are already
// decodeURIComponent'd so handlers see the same string the orchestrator does.

export type Route =
  | { kind: 'dashboard' }
  | { kind: 'preview' }
  | { kind: 'partial'; slug: string }
  | { kind: 'state' }
  | { kind: 'refresh' }
  | { kind: 'issues' }
  | { kind: 'mcp'; identifier: string }
  | { kind: 'steering'; identifier: string }
  | { kind: 'triage'; identifier: string; action: 'approve' | 'discard' }
  | { kind: 'detail_html'; identifier: string }
  | { kind: 'detail_json'; identifier: string }
  | { kind: 'not_found' };

const MCP_RE = /^\/api\/v1\/issues\/([^/]+)\/mcp$/;
const STEERING_RE = /^\/api\/v1\/issues\/([^/]+)\/steering-reply$/;
const TRIAGE_RE = /^\/api\/v1\/issues\/([^/]+)\/(approve|discard)$/;
const DETAIL_HTML_RE = /^\/issues\/([^/]+)\/?$/;
const DETAIL_JSON_RE = /^\/api\/v1\/([^/]+)$/;
const PARTIALS_PREFIX = '/api/v1/partials/';

export function matchRoute(pathname: string): Route {
  if (pathname === '/') return { kind: 'dashboard' };
  if (pathname === '/preview' || pathname === '/preview/') return { kind: 'preview' };
  if (pathname.startsWith(PARTIALS_PREFIX)) {
    return { kind: 'partial', slug: pathname.slice(PARTIALS_PREFIX.length) };
  }
  if (pathname === '/api/v1/state') return { kind: 'state' };
  if (pathname === '/api/v1/refresh') return { kind: 'refresh' };
  if (pathname === '/api/v1/issues') return { kind: 'issues' };
  const mcp = MCP_RE.exec(pathname);
  if (mcp) return { kind: 'mcp', identifier: decodeURIComponent(mcp[1]!) };
  const steering = STEERING_RE.exec(pathname);
  if (steering) return { kind: 'steering', identifier: decodeURIComponent(steering[1]!) };
  const triage = TRIAGE_RE.exec(pathname);
  if (triage) {
    return {
      kind: 'triage',
      identifier: decodeURIComponent(triage[1]!),
      action: triage[2] as 'approve' | 'discard',
    };
  }
  const detailHtml = DETAIL_HTML_RE.exec(pathname);
  if (detailHtml) return { kind: 'detail_html', identifier: decodeURIComponent(detailHtml[1]!) };
  const detailJson = DETAIL_JSON_RE.exec(pathname);
  if (detailJson) return { kind: 'detail_json', identifier: decodeURIComponent(detailJson[1]!) };
  return { kind: 'not_found' };
}

// ─── Partial name resolver ──────────────────────────────────────────────
export type PartialName = 'header' | 'attention' | 'board' | 'totals';
const PARTIAL_NAMES: ReadonlySet<string> = new Set(['header', 'attention', 'board', 'totals']);
export function resolvePartialName(slug: string): PartialName | null {
  return PARTIAL_NAMES.has(slug) ? (slug as PartialName) : null;
}

// ─── Header parsing ─────────────────────────────────────────────────────
export function extractBearerToken(authHeader: string | undefined): string {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return '';
  return authHeader.slice('Bearer '.length).trim();
}

export interface ContentTypeFlags {
  isFormBody: boolean;
  isJsonBody: boolean;
  isEmptyCtype: boolean;
}

export function classifyContentType(ctype: string | undefined): ContentTypeFlags {
  const lower = (ctype ?? '').toLowerCase();
  const baseCtype = lower.split(';', 1)[0]!.trim();
  return {
    isFormBody: baseCtype === 'application/x-www-form-urlencoded',
    isJsonBody: baseCtype === 'application/json',
    isEmptyCtype: baseCtype === '',
  };
}

// ─── CSRF gates ─────────────────────────────────────────────────────────
// Two endpoints accept POSTs from the dashboard and from API clients. Both
// gate cross-site form POSTs (a "simple" CORS request that bypasses preflight)
// by requiring an HX-Request header + same-origin. Steering-reply only treats
// form-urlencoded as form; triage also treats an empty Content-Type as form,
// matching how /api/v1/issues handles bodyless POSTs.

export type CsrfDecision =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

const UNSUPPORTED_MEDIA: CsrfDecision = {
  ok: false,
  status: 415,
  code: 'unsupported_media_type',
  message: 'content-type must be application/json or application/x-www-form-urlencoded',
};

export function checkSteeringCsrf(
  ctype: ContentTypeFlags,
  isHtmx: boolean,
  isSameOrigin: boolean,
): CsrfDecision {
  if (!ctype.isFormBody && !ctype.isJsonBody) return UNSUPPORTED_MEDIA;
  if (ctype.isFormBody && (!isHtmx || !isSameOrigin)) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'form-encoded steering replies require an HTMX same-origin request',
    };
  }
  return { ok: true };
}

export function checkTriageCsrf(
  ctype: ContentTypeFlags,
  isHtmx: boolean,
  isSameOrigin: boolean,
): CsrfDecision {
  if (!ctype.isFormBody && !ctype.isJsonBody && !ctype.isEmptyCtype) return UNSUPPORTED_MEDIA;
  if ((ctype.isFormBody || ctype.isEmptyCtype) && (!isHtmx || !isSameOrigin)) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'triage actions require an HTMX same-origin request or application/json',
    };
  }
  return { ok: true };
}

// ─── Body text extraction ───────────────────────────────────────────────
export function extractFormText(raw: string): string {
  return (new URLSearchParams(raw).get('text') ?? '').trim();
}

export function extractJsonText(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const t = (body as Record<string, unknown>).text;
  return typeof t === 'string' ? t.trim() : '';
}

// ─── POST /api/v1/issues body validation ────────────────────────────────
// `identifier` and `state` are optional: identifier is derived from the title when
// omitted, state defaults to the first declared active state (typically `Todo`).
// State is restricted to declared non-terminal states (active or holding) so the
// kanban's `+ new issue` affordance can target Triage and so terminal states stay
// closed to direct creation. Values containing path separators / `..` are rejected
// by the set lookup so the request cannot escape the tracker root via path.join.

export type CreateIssueDecision =
  | { ok: false; status: number; code: 'bad_request'; message: string }
  | {
      ok: true;
      identifier: string;
      title: string;
      state: string;
      description: string | undefined;
      priority: number | null;
      labels: string[];
      blocked_by: string[];
    };

export function decideCreateIssue(
  body: unknown,
  states: readonly StateView[],
): CreateIssueDecision {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, code: 'bad_request', message: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const identifier = typeof b.identifier === 'string' ? b.identifier.trim() : '';
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const stateInput = typeof b.state === 'string' ? b.state.trim() : '';
  if (!title) {
    return { ok: false, status: 400, code: 'bad_request', message: 'title is required' };
  }
  const firstActiveName = states.find((s) => s.role === 'active')?.name ?? '';
  const state = stateInput || firstActiveName;
  if (!state) {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'state is required (no active states declared to default to)',
    };
  }
  const allowedNames = states.filter((s) => s.role !== 'terminal').map((s) => s.name);
  const allowedStates = new Set(allowedNames);
  if (!allowedStates.has(state)) {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: `state must be one of: ${allowedNames.join(', ') || '<none configured>'}`,
    };
  }
  const description = typeof b.description === 'string' ? b.description : undefined;
  const priority =
    typeof b.priority === 'number' && Number.isFinite(b.priority) ? b.priority : null;
  const labels = Array.isArray(b.labels)
    ? b.labels.filter((x): x is string => typeof x === 'string')
    : [];
  const blocked_by = Array.isArray(b.blocked_by)
    ? b.blocked_by.filter((x): x is string => typeof x === 'string')
    : [];
  return { ok: true, identifier, title, state, description, priority, labels, blocked_by };
}

// ─── Triage approve / discard transition ────────────────────────────────
// Approve: first declared `active` state in declaration order, falling back to
// the literal "Todo" so a workflow without an active state still has a defined
// error path (validateStates refuses configs without an active role, so the
// fallback is defensive).
// Discard: prefers a state literally named "Cancelled" (case-insensitive) and
// falls back to the first declared `terminal` state. Refuses when neither
// exists rather than silently deleting.
// From-state: the first declared `holding` state in declaration order. Refuses
// when missing — the workflow parser already rejects such configs but we don't
// want to silently pick a wrong directory if that ever changes.

export type TriageDecision =
  | { ok: false; status: number; code: string; message: string }
  | { ok: true; toState: string; fromState: string };

export function decideTriageTransition(
  action: 'approve' | 'discard',
  states: readonly StateView[],
): TriageDecision {
  let toState: string;
  if (action === 'approve') {
    const firstActive = states.find((s) => s.role === 'active');
    toState = firstActive?.name ?? 'Todo';
  } else {
    const terminals = states.filter((s) => s.role === 'terminal');
    const cancelled = terminals.find((s) => s.name.toLowerCase() === 'cancelled');
    const target = cancelled ?? terminals[0];
    if (!target) {
      return {
        ok: false,
        status: 409,
        code: 'no_discard_target',
        message: 'no terminal state configured to discard the proposal into',
      };
    }
    toState = target.name;
  }
  const holdingState = states.find((s) => s.role === 'holding');
  if (!holdingState) {
    return {
      ok: false,
      status: 409,
      code: 'no_holding_state',
      message: 'no holding state declared in workflow; cannot resolve triage from-state',
    };
  }
  return { ok: true, toState, fromState: holdingState.name };
}
