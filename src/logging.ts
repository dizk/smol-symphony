// Structured key=value logging to stderr per SPEC.md §9.1.
// Sink failures do not crash the orchestrator (§9.2).

type Level = 'debug' | 'info' | 'warn' | 'error';

const ENV_LEVEL = (process.env.SYMPHONY_LOG_LEVEL ?? 'info').toLowerCase() as Level;
const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function quote(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
}

function format(level: Level, msg: string, fields: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const parts = [`ts=${ts}`, `level=${level}`, `msg=${quote(msg)}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${quote(v)}`);
  }
  return parts.join(' ');
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (LEVEL_RANK[level] < LEVEL_RANK[ENV_LEVEL]) return;
  try {
    process.stderr.write(format(level, msg, fields) + '\n');
  } catch {
    // Spec §9.2: a failed sink must not crash the service.
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields ?? {}),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields ?? {}),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields ?? {}),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields ?? {}),
};

export interface IssueLogContext {
  issue_id?: string;
  issue_identifier?: string;
  session_id?: string;
}

export function withIssue(ctx: IssueLogContext) {
  return {
    debug: (msg: string, fields: Record<string, unknown> = {}) => log.debug(msg, { ...ctx, ...fields }),
    info: (msg: string, fields: Record<string, unknown> = {}) => log.info(msg, { ...ctx, ...fields }),
    warn: (msg: string, fields: Record<string, unknown> = {}) => log.warn(msg, { ...ctx, ...fields }),
    error: (msg: string, fields: Record<string, unknown> = {}) => log.error(msg, { ...ctx, ...fields }),
  };
}
