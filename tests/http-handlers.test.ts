// Unit tests for the pure helpers extracted from src/http.ts. Each helper takes
// already-parsed inputs and returns a decision/data; tests cover the branches in
// isolation without spinning up the HTTP server.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  type Route,
  type StateView,
  matchRoute,
  resolvePartialName,
  extractBearerToken,
  classifyContentType,
  checkSteeringCsrf,
  checkTriageCsrf,
  extractFormText,
  extractJsonText,
  decideCreateIssue,
  decideTriageTransition,
} from '../src/http-handlers.js';

describe('matchRoute', () => {
  it('matches / as dashboard', () => {
    assert.deepEqual(matchRoute('/'), { kind: 'dashboard' });
  });

  it('matches /preview and /preview/ as preview', () => {
    assert.deepEqual(matchRoute('/preview'), { kind: 'preview' });
    assert.deepEqual(matchRoute('/preview/'), { kind: 'preview' });
  });

  it('matches /api/v1/partials/<slug> with the raw slug', () => {
    assert.deepEqual(matchRoute('/api/v1/partials/header'), { kind: 'partial', slug: 'header' });
    assert.deepEqual(matchRoute('/api/v1/partials/unknown'), { kind: 'partial', slug: 'unknown' });
  });

  it('matches well-known top-level endpoints', () => {
    assert.deepEqual(matchRoute('/api/v1/state'), { kind: 'state' });
    assert.deepEqual(matchRoute('/api/v1/refresh'), { kind: 'refresh' });
    assert.deepEqual(matchRoute('/api/v1/issues'), { kind: 'issues' });
  });

  it('matches the mcp endpoint and decodes its identifier', () => {
    assert.deepEqual(matchRoute('/api/v1/issues/foo-1/mcp'), {
      kind: 'mcp',
      identifier: 'foo-1',
    });
    assert.deepEqual(matchRoute('/api/v1/issues/space%20id/mcp'), {
      kind: 'mcp',
      identifier: 'space id',
    });
  });

  it('matches the steering-reply endpoint', () => {
    assert.deepEqual(matchRoute('/api/v1/issues/x/steering-reply'), {
      kind: 'steering',
      identifier: 'x',
    });
  });

  it('matches triage approve / discard with the action label', () => {
    assert.deepEqual(matchRoute('/api/v1/issues/abc/approve'), {
      kind: 'triage',
      identifier: 'abc',
      action: 'approve',
    });
    assert.deepEqual(matchRoute('/api/v1/issues/abc/discard'), {
      kind: 'triage',
      identifier: 'abc',
      action: 'discard',
    });
  });

  it('matches the detail HTML page with and without trailing slash', () => {
    assert.deepEqual(matchRoute('/issues/abc'), { kind: 'detail_html', identifier: 'abc' });
    assert.deepEqual(matchRoute('/issues/abc/'), { kind: 'detail_html', identifier: 'abc' });
  });

  it('matches the detail JSON catch-all on /api/v1/<id> only for single-segment IDs', () => {
    assert.deepEqual(matchRoute('/api/v1/abc'), { kind: 'detail_json', identifier: 'abc' });
    // Multi-segment paths under /api/v1 must not collapse into detail_json.
    const r = matchRoute('/api/v1/issues/abc/other');
    assert.equal(r.kind, 'not_found');
  });

  it('does not let /api/v1/state, refresh, or issues fall through to detail_json', () => {
    // Order matters: literal matches are checked before the catch-all.
    const r1 = matchRoute('/api/v1/state');
    const r2 = matchRoute('/api/v1/refresh');
    const r3 = matchRoute('/api/v1/issues');
    assert.equal(r1.kind, 'state');
    assert.equal(r2.kind, 'refresh');
    assert.equal(r3.kind, 'issues');
  });

  it('returns not_found for unknown paths', () => {
    assert.deepEqual(matchRoute('/nope'), { kind: 'not_found' });
    assert.deepEqual(matchRoute('/api/v2/whatever'), { kind: 'not_found' });
  });
});

describe('resolvePartialName', () => {
  it('accepts the four known partial slugs', () => {
    assert.equal(resolvePartialName('header'), 'header');
    assert.equal(resolvePartialName('attention'), 'attention');
    assert.equal(resolvePartialName('board'), 'board');
    assert.equal(resolvePartialName('totals'), 'totals');
  });

  it('rejects unknown slugs', () => {
    assert.equal(resolvePartialName('unknown'), null);
    assert.equal(resolvePartialName(''), null);
    assert.equal(resolvePartialName('HEADER'), null);
  });
});

describe('extractBearerToken', () => {
  it('extracts the token after "Bearer "', () => {
    assert.equal(extractBearerToken('Bearer abc123'), 'abc123');
  });

  it('trims trailing whitespace', () => {
    assert.equal(extractBearerToken('Bearer abc123   '), 'abc123');
  });

  it('returns empty string for missing or malformed headers', () => {
    assert.equal(extractBearerToken(undefined), '');
    assert.equal(extractBearerToken(''), '');
    assert.equal(extractBearerToken('Basic abc'), '');
    assert.equal(extractBearerToken('bearer abc'), ''); // case-sensitive on the prefix
  });
});

describe('classifyContentType', () => {
  it('classifies form, json, empty, and other types', () => {
    assert.deepEqual(classifyContentType('application/x-www-form-urlencoded'), {
      isFormBody: true,
      isJsonBody: false,
      isEmptyCtype: false,
    });
    assert.deepEqual(classifyContentType('application/json'), {
      isFormBody: false,
      isJsonBody: true,
      isEmptyCtype: false,
    });
    assert.deepEqual(classifyContentType(undefined), {
      isFormBody: false,
      isJsonBody: false,
      isEmptyCtype: true,
    });
    assert.deepEqual(classifyContentType('text/plain'), {
      isFormBody: false,
      isJsonBody: false,
      isEmptyCtype: false,
    });
  });

  it('strips parameters (charset, boundary, …)', () => {
    assert.deepEqual(classifyContentType('application/json; charset=utf-8'), {
      isFormBody: false,
      isJsonBody: true,
      isEmptyCtype: false,
    });
    assert.deepEqual(classifyContentType('application/x-www-form-urlencoded;charset=UTF-8'), {
      isFormBody: true,
      isJsonBody: false,
      isEmptyCtype: false,
    });
  });

  it('lowercases the value', () => {
    assert.deepEqual(classifyContentType('APPLICATION/JSON'), {
      isFormBody: false,
      isJsonBody: true,
      isEmptyCtype: false,
    });
  });
});

describe('checkSteeringCsrf', () => {
  const form = { isFormBody: true, isJsonBody: false, isEmptyCtype: false };
  const json = { isFormBody: false, isJsonBody: true, isEmptyCtype: false };
  const empty = { isFormBody: false, isJsonBody: false, isEmptyCtype: true };
  const other = { isFormBody: false, isJsonBody: false, isEmptyCtype: false };

  it('accepts form bodies with HX-Request + same-origin', () => {
    assert.deepEqual(checkSteeringCsrf(form, true, true), { ok: true });
  });

  it('rejects form bodies missing HX-Request', () => {
    const r = checkSteeringCsrf(form, false, true);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 403);
      assert.equal(r.code, 'forbidden');
    }
  });

  it('rejects form bodies that are not same-origin', () => {
    const r = checkSteeringCsrf(form, true, false);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403);
  });

  it('accepts JSON unconditionally (preflight gates it)', () => {
    assert.deepEqual(checkSteeringCsrf(json, false, false), { ok: true });
  });

  it('rejects empty Content-Type with 415 (steering does not treat it as a form)', () => {
    const r = checkSteeringCsrf(empty, true, true);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 415);
  });

  it('rejects unknown Content-Type with 415', () => {
    const r = checkSteeringCsrf(other, true, true);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 415);
  });
});

describe('checkTriageCsrf', () => {
  const form = { isFormBody: true, isJsonBody: false, isEmptyCtype: false };
  const json = { isFormBody: false, isJsonBody: true, isEmptyCtype: false };
  const empty = { isFormBody: false, isJsonBody: false, isEmptyCtype: true };
  const other = { isFormBody: false, isJsonBody: false, isEmptyCtype: false };

  it('accepts form with HX-Request + same-origin', () => {
    assert.deepEqual(checkTriageCsrf(form, true, true), { ok: true });
  });

  it('accepts empty Content-Type with HX-Request + same-origin (treats it as form)', () => {
    assert.deepEqual(checkTriageCsrf(empty, true, true), { ok: true });
  });

  it('rejects empty Content-Type missing HX-Request with 403', () => {
    const r = checkTriageCsrf(empty, false, true);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403);
  });

  it('rejects empty Content-Type cross-origin with 403', () => {
    const r = checkTriageCsrf(empty, true, false);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403);
  });

  it('accepts JSON unconditionally', () => {
    assert.deepEqual(checkTriageCsrf(json, false, false), { ok: true });
  });

  it('rejects other Content-Type with 415', () => {
    const r = checkTriageCsrf(other, true, true);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 415);
  });
});

describe('extractFormText', () => {
  it('extracts and trims the `text` field', () => {
    assert.equal(extractFormText('text=hello'), 'hello');
    assert.equal(extractFormText('text=%20%20padded%20%20'), 'padded');
    assert.equal(extractFormText('text=hello&other=world'), 'hello');
  });

  it('returns empty string when text is missing or empty', () => {
    assert.equal(extractFormText(''), '');
    assert.equal(extractFormText('other=value'), '');
    assert.equal(extractFormText('text='), '');
    assert.equal(extractFormText('text=   '), '');
  });
});

describe('extractJsonText', () => {
  it('extracts and trims `text` from a JSON object', () => {
    assert.equal(extractJsonText({ text: 'hello' }), 'hello');
    assert.equal(extractJsonText({ text: '  padded  ' }), 'padded');
  });

  it('returns empty string for non-string text', () => {
    assert.equal(extractJsonText({ text: 42 }), '');
    assert.equal(extractJsonText({ text: null }), '');
    assert.equal(extractJsonText({}), '');
  });

  it('returns empty string for non-object / array / null bodies', () => {
    assert.equal(extractJsonText(null), '');
    assert.equal(extractJsonText('hello'), '');
    assert.equal(extractJsonText([{ text: 'hello' }]), '');
    assert.equal(extractJsonText(undefined), '');
  });
});

describe('decideCreateIssue', () => {
  const states: StateView[] = [
    { name: 'Todo', role: 'active' },
    { name: 'In Progress', role: 'active' },
    { name: 'Triage', role: 'holding' },
    { name: 'Done', role: 'terminal' },
    { name: 'Cancelled', role: 'terminal' },
  ];

  it('accepts a minimal {title} body and defaults state to first active', () => {
    const r = decideCreateIssue({ title: 'hello' }, states);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.title, 'hello');
      assert.equal(r.state, 'Todo');
      assert.equal(r.identifier, '');
      assert.deepEqual(r.labels, []);
      assert.deepEqual(r.blocked_by, []);
      assert.equal(r.priority, null);
      assert.equal(r.description, undefined);
    }
  });

  it('rejects non-object bodies', () => {
    const cases: unknown[] = [null, 'str', 42, [], undefined];
    for (const body of cases) {
      const r = decideCreateIssue(body, states);
      assert.equal(r.ok, false, `expected reject for ${JSON.stringify(body)}`);
    }
  });

  it('rejects missing/blank title', () => {
    const r = decideCreateIssue({}, states);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /title is required/);
    const r2 = decideCreateIssue({ title: '   ' }, states);
    assert.equal(r2.ok, false);
  });

  it('trims title, identifier, and state', () => {
    const r = decideCreateIssue({ title: '  foo  ', identifier: '  id  ', state: '  Triage  ' }, states);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.title, 'foo');
      assert.equal(r.identifier, 'id');
      assert.equal(r.state, 'Triage');
    }
  });

  it('accepts non-terminal states including holding', () => {
    const r = decideCreateIssue({ title: 'x', state: 'Triage' }, states);
    assert.equal(r.ok, true);
    const r2 = decideCreateIssue({ title: 'x', state: 'In Progress' }, states);
    assert.equal(r2.ok, true);
  });

  it('refuses terminal states', () => {
    const r = decideCreateIssue({ title: 'x', state: 'Done' }, states);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /state must be one of: Todo, In Progress, Triage/);
  });

  it('refuses undeclared states', () => {
    const r = decideCreateIssue({ title: 'x', state: 'Bogus' }, states);
    assert.equal(r.ok, false);
  });

  it('refuses path-escape attempts in state via set lookup', () => {
    const r = decideCreateIssue({ title: 'x', state: '../etc/passwd' }, states);
    assert.equal(r.ok, false);
  });

  it('errors when no active state is declared and no state is supplied', () => {
    const r = decideCreateIssue({ title: 'x' }, [{ name: 'Triage', role: 'holding' }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /no active states declared/);
  });

  it('coerces malformed optional fields to safe defaults', () => {
    const r = decideCreateIssue(
      {
        title: 'x',
        description: 42, // not a string → undefined
        priority: 'high', // not a number → null
        labels: ['a', 1, 'b'], // strings only
        blocked_by: ['x', 'y', null, 'z'], // strings only
      },
      states,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.description, undefined);
      assert.equal(r.priority, null);
      assert.deepEqual(r.labels, ['a', 'b']);
      assert.deepEqual(r.blocked_by, ['x', 'y', 'z']);
    }
  });

  it('accepts finite numeric priority and string description', () => {
    const r = decideCreateIssue(
      { title: 'x', priority: 3, description: 'desc' },
      states,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.priority, 3);
      assert.equal(r.description, 'desc');
    }
  });

  it('rejects non-finite priority (NaN, Infinity)', () => {
    const r1 = decideCreateIssue({ title: 'x', priority: NaN }, states);
    const r2 = decideCreateIssue({ title: 'x', priority: Infinity }, states);
    assert.equal(r1.ok && r1.priority, null);
    assert.equal(r2.ok && r2.priority, null);
  });
});

describe('decideTriageTransition', () => {
  const standard: StateView[] = [
    { name: 'Triage', role: 'holding' },
    { name: 'Todo', role: 'active' },
    { name: 'In Progress', role: 'active' },
    { name: 'Done', role: 'terminal' },
    { name: 'Cancelled', role: 'terminal' },
  ];

  it('approve targets the first declared active state', () => {
    const r = decideTriageTransition('approve', standard);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.toState, 'Todo');
      assert.equal(r.fromState, 'Triage');
    }
  });

  it('approve falls back to literal "Todo" when no active state is declared', () => {
    const r = decideTriageTransition('approve', [
      { name: 'Triage', role: 'holding' },
      { name: 'Done', role: 'terminal' },
    ]);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.toState, 'Todo');
  });

  it('discard prefers "Cancelled" (case-insensitive)', () => {
    const r = decideTriageTransition('discard', standard);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.toState, 'Cancelled');

    const r2 = decideTriageTransition('discard', [
      { name: 'Triage', role: 'holding' },
      { name: 'Todo', role: 'active' },
      { name: 'Done', role: 'terminal' },
      { name: 'cancelled', role: 'terminal' },
    ]);
    assert.equal(r2.ok, true);
    if (r2.ok) assert.equal(r2.toState, 'cancelled');
  });

  it('discard falls back to first terminal when no "cancelled" exists', () => {
    const r = decideTriageTransition('discard', [
      { name: 'Triage', role: 'holding' },
      { name: 'Todo', role: 'active' },
      { name: 'Archived', role: 'terminal' },
      { name: 'Done', role: 'terminal' },
    ]);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.toState, 'Archived');
  });

  it('discard refuses with no_discard_target when no terminal exists', () => {
    const r = decideTriageTransition('discard', [
      { name: 'Triage', role: 'holding' },
      { name: 'Todo', role: 'active' },
    ]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, 'no_discard_target');
      assert.equal(r.status, 409);
    }
  });

  it('refuses with no_holding_state when no holding state is declared', () => {
    const r = decideTriageTransition('approve', [
      { name: 'Todo', role: 'active' },
      { name: 'Done', role: 'terminal' },
    ]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, 'no_holding_state');
      assert.equal(r.status, 409);
    }
  });

  it('returns the first declared holding state as the from-state', () => {
    const r = decideTriageTransition('approve', [
      { name: 'Inbox', role: 'holding' },
      { name: 'Triage', role: 'holding' },
      { name: 'Todo', role: 'active' },
    ]);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.fromState, 'Inbox');
  });
});

// Exercise the discriminated union narrowing so a future refactor that changes
// Route's shape fails this test at typecheck time rather than at runtime.
describe('Route discriminator shapes', () => {
  it('every kind from matchRoute has the expected fields', () => {
    const samples: Record<Route['kind'], string> = {
      dashboard: '/',
      preview: '/preview',
      partial: '/api/v1/partials/header',
      state: '/api/v1/state',
      refresh: '/api/v1/refresh',
      issues: '/api/v1/issues',
      mcp: '/api/v1/issues/x/mcp',
      steering: '/api/v1/issues/x/steering-reply',
      triage: '/api/v1/issues/x/approve',
      detail_html: '/issues/x',
      detail_json: '/api/v1/x',
      not_found: '/nope',
    };
    for (const [expectedKind, pathname] of Object.entries(samples)) {
      const r = matchRoute(pathname);
      assert.equal(r.kind, expectedKind, `pathname ${pathname} produced ${r.kind}`);
    }
  });
});
