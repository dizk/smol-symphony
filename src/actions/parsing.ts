// Parse a per-state `actions:` block into typed records (issue 36).
//
// Lifts the YAML shape into the closed `WorkflowAction` union, validating
// each kind's required fields up-front so a missing `head:` on
// `create_pr_if_missing` (or a misspelled `kind:`) fails at workflow load
// instead of at the first dispatch into the terminal state.

import { WorkflowError } from '../workflow.js';
import type {
  ActionErrorPolicy,
  ActionPredicate,
  WorkflowAction,
  WorkflowActionKind,
} from './types.js';

const KNOWN_KINDS: readonly WorkflowActionKind[] = [
  'push_branch',
  'create_pr_if_missing',
  'ensure_branch',
  'checkout',
  'merge',
  'delete_branch',
  'run_in_vm',
  'propose_followup',
] as const;

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

function expectString(stateName: string, idx: number, kind: string, key: string, v: unknown): string {
  const s = asString(v);
  if (s === null || s.length === 0) {
    throw new WorkflowError(
      'workflow_parse_error',
      `state "${stateName}": actions[${idx}] (${kind}): "${key}" must be a non-empty string`,
    );
  }
  return s;
}

function parsePredicate(stateName: string, idx: number, raw: unknown): ActionPredicate {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const m = raw as Record<string, unknown>;
    if (typeof m.branch_exists === 'string') return { branch_exists: m.branch_exists };
    if (typeof m.file_present === 'string') return { file_present: m.file_present };
  }
  throw new WorkflowError(
    'workflow_parse_error',
    `state "${stateName}": actions[${idx}] "if" must be a "$var" string, {branch_exists: <ref>}, or {file_present: <path>}`,
  );
}

function parseErrorPolicy(stateName: string, idx: number, raw: unknown): ActionErrorPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkflowError(
      'workflow_parse_error',
      `state "${stateName}": actions[${idx}] "on_error" must be a map`,
    );
  }
  const m = raw as Record<string, unknown>;
  const out: ActionErrorPolicy = {};
  if (m.retry !== undefined) {
    if (typeof m.retry !== 'object' || m.retry === null || Array.isArray(m.retry)) {
      throw new WorkflowError(
        'workflow_parse_error',
        `state "${stateName}": actions[${idx}] "on_error.retry" must be a map`,
      );
    }
    const r = m.retry as Record<string, unknown>;
    const count = asInt(r.count);
    const backoff = asInt(r.backoff_ms);
    if (count === null || count < 0) {
      throw new WorkflowError(
        'workflow_parse_error',
        `state "${stateName}": actions[${idx}] "on_error.retry.count" must be a non-negative integer`,
      );
    }
    if (backoff === null || backoff < 0) {
      throw new WorkflowError(
        'workflow_parse_error',
        `state "${stateName}": actions[${idx}] "on_error.retry.backoff_ms" must be a non-negative integer`,
      );
    }
    out.retry = { count, backoff_ms: backoff };
  }
  if (m.then !== undefined) {
    if (m.then === 'abort') {
      out.then = 'abort';
    } else if (
      typeof m.then === 'object' &&
      !Array.isArray(m.then) &&
      typeof (m.then as Record<string, unknown>).route_to === 'string'
    ) {
      out.then = { route_to: (m.then as Record<string, string>).route_to! };
    } else {
      throw new WorkflowError(
        'workflow_parse_error',
        `state "${stateName}": actions[${idx}] "on_error.then" must be "abort" or {route_to: <state>}`,
      );
    }
  }
  return out;
}

function parseAction(stateName: string, idx: number, raw: unknown): WorkflowAction {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new WorkflowError(
      'workflow_parse_error',
      `state "${stateName}": actions[${idx}] must be a map with a "kind" field`,
    );
  }
  const m = raw as Record<string, unknown>;
  const kind = asString(m.kind);
  if (!kind || !(KNOWN_KINDS as readonly string[]).includes(kind)) {
    throw new WorkflowError(
      'workflow_parse_error',
      `state "${stateName}": actions[${idx}] "kind" must be one of: ${KNOWN_KINDS.join(', ')} (got: ${String(m.kind)})`,
    );
  }
  const base = {
    name: asString(m.name) ?? undefined,
    if: parsePredicate(stateName, idx, m.if),
    on_error: parseErrorPolicy(stateName, idx, m.on_error),
  };
  // Strip undefined to keep parsed records clean (deep-equal in tests).
  const cleanBase: Record<string, unknown> = {};
  if (base.name !== undefined) cleanBase.name = base.name;
  if (base.if !== null) cleanBase.if = base.if;
  if (base.on_error !== undefined) cleanBase.on_error = base.on_error;

  switch (kind) {
    case 'push_branch':
      return {
        kind: 'push_branch',
        remote: expectString(stateName, idx, kind, 'remote', m.remote),
        ref: expectString(stateName, idx, kind, 'ref', m.ref),
        ...cleanBase,
      };
    case 'create_pr_if_missing':
      return {
        kind: 'create_pr_if_missing',
        base: expectString(stateName, idx, kind, 'base', m.base),
        head: expectString(stateName, idx, kind, 'head', m.head),
        title_from: expectString(stateName, idx, kind, 'title_from', m.title_from),
        body_from: expectString(stateName, idx, kind, 'body_from', m.body_from),
        ...cleanBase,
      };
    case 'ensure_branch':
      return {
        kind: 'ensure_branch',
        name: expectString(stateName, idx, kind, 'name', m.name),
        seed_from: asString(m.seed_from) ?? undefined,
        ...cleanBase,
      } as WorkflowAction;
    case 'checkout':
      return {
        kind: 'checkout',
        ref: expectString(stateName, idx, kind, 'ref', m.ref),
        ...cleanBase,
      };
    case 'merge': {
      const onConflictRaw = m.on_conflict;
      let onConflict: { route_to: string } | 'abort';
      if (onConflictRaw === 'abort') {
        onConflict = 'abort';
      } else if (
        typeof onConflictRaw === 'object' &&
        onConflictRaw !== null &&
        !Array.isArray(onConflictRaw) &&
        typeof (onConflictRaw as Record<string, unknown>).route_to === 'string'
      ) {
        onConflict = { route_to: (onConflictRaw as Record<string, string>).route_to! };
      } else {
        throw new WorkflowError(
          'workflow_parse_error',
          `state "${stateName}": actions[${idx}] (merge): "on_conflict" must be "abort" or {route_to: <state>}`,
        );
      }
      return {
        kind: 'merge',
        source: expectString(stateName, idx, kind, 'source', m.source),
        target: expectString(stateName, idx, kind, 'target', m.target),
        on_conflict: onConflict,
        ...cleanBase,
      };
    }
    case 'delete_branch': {
      const scope = asString(m.scope);
      if (scope !== 'local' && scope !== 'remote' && scope !== 'both') {
        throw new WorkflowError(
          'workflow_parse_error',
          `state "${stateName}": actions[${idx}] (delete_branch): "scope" must be one of local|remote|both`,
        );
      }
      const remote = asString(m.remote) ?? undefined;
      if ((scope === 'remote' || scope === 'both') && !remote) {
        throw new WorkflowError(
          'workflow_parse_error',
          `state "${stateName}": actions[${idx}] (delete_branch): "remote" is required when scope includes "remote"`,
        );
      }
      return {
        kind: 'delete_branch',
        name: expectString(stateName, idx, kind, 'name', m.name),
        scope,
        remote,
        ...cleanBase,
      } as WorkflowAction;
    }
    case 'run_in_vm': {
      const name = asString(m.name);
      if (!name || name.length === 0) {
        throw new WorkflowError(
          'workflow_parse_error',
          `state "${stateName}": actions[${idx}] (run_in_vm): "name" is required (used by cache + rerun CLI)`,
        );
      }
      // Names are used as a path segment in the cache layout
      // (`<root>/actions/run_in_vm/<name>/<hash>/result.json`). Restrict to a
      // safe identifier set so `--check=<name>` is unambiguous and no name
      // can escape the namespace (e.g. via `..`). The cache layer also
      // defensively encodes unsafe chars, but rejecting at parse time keeps
      // the CLI surface honest.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        throw new WorkflowError(
          'workflow_parse_error',
          `state "${stateName}": actions[${idx}] (run_in_vm): "name" must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (got: ${JSON.stringify(name)})`,
        );
      }
      const cmdRaw = m.cmd;
      if (!Array.isArray(cmdRaw) || cmdRaw.length === 0 || !cmdRaw.every((s) => typeof s === 'string')) {
        throw new WorkflowError(
          'workflow_parse_error',
          `state "${stateName}": actions[${idx}] (run_in_vm): "cmd" must be a non-empty list of strings`,
        );
      }
      const envRaw = m.env;
      let env: Record<string, string> | undefined;
      if (envRaw !== undefined) {
        if (typeof envRaw !== 'object' || envRaw === null || Array.isArray(envRaw)) {
          throw new WorkflowError(
            'workflow_parse_error',
            `state "${stateName}": actions[${idx}] (run_in_vm): "env" must be a map of string→string`,
          );
        }
        env = {};
        for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) {
          if (typeof v !== 'string') {
            throw new WorkflowError(
              'workflow_parse_error',
              `state "${stateName}": actions[${idx}] (run_in_vm): env["${k}"] must be a string`,
            );
          }
          env[k] = v;
        }
      }
      const timeout: number | null | undefined =
        m.timeout === undefined ? undefined : asInt(m.timeout);
      if (m.timeout !== undefined && (timeout === null || timeout === undefined || timeout <= 0)) {
        throw new WorkflowError(
          'workflow_parse_error',
          `state "${stateName}": actions[${idx}] (run_in_vm): "timeout" must be a positive integer (seconds)`,
        );
      }
      const action: import('./types.js').RunInVmAction = {
        kind: 'run_in_vm',
        name,
        cmd: cmdRaw as string[],
        ...cleanBase,
      };
      if (env !== undefined) action.env = env;
      if (timeout !== undefined && timeout !== null) action.timeout = timeout;
      return action;
    }
    case 'propose_followup': {
      const labelsRaw = m.labels;
      let labels: string[] | undefined;
      if (labelsRaw !== undefined) {
        if (!Array.isArray(labelsRaw) || !labelsRaw.every((s) => typeof s === 'string')) {
          throw new WorkflowError(
            'workflow_parse_error',
            `state "${stateName}": actions[${idx}] (propose_followup): "labels" must be a list of strings`,
          );
        }
        labels = labelsRaw as string[];
      }
      const priority = m.priority === undefined ? undefined : asInt(m.priority);
      if (m.priority !== undefined && priority === null) {
        throw new WorkflowError(
          'workflow_parse_error',
          `state "${stateName}": actions[${idx}] (propose_followup): "priority" must be an integer`,
        );
      }
      const action: import('./types.js').ProposeFollowupAction = {
        kind: 'propose_followup',
        title: expectString(stateName, idx, kind, 'title', m.title),
        ...cleanBase,
      };
      const body = asString(m.body);
      if (body !== null) action.body = body;
      if (labels !== undefined) action.labels = labels;
      if (priority !== undefined && priority !== null) action.priority = priority;
      return action;
    }
    default: {
      // Exhaustiveness check at the type level — adding a new kind to the union
      // without extending this switch is a TypeScript error.
      const _exhaustive: never = kind as never;
      void _exhaustive;
      throw new WorkflowError('workflow_parse_error', `unreachable action kind: ${String(kind)}`);
    }
  }
}

export function parseActionsBlock(stateName: string, raw: unknown): WorkflowAction[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new WorkflowError(
      'workflow_parse_error',
      `state "${stateName}": actions must be a list of typed action records`,
    );
  }
  return raw.map((entry, idx) => parseAction(stateName, idx, entry));
}
