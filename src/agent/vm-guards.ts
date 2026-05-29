// VM invariant guards — the *teeth* of the host-only-refresh invariant
// (design doc §3). Pure, dependency-free functions the Gondolin dispatch path
// runs at createVm-options-building time so the guest is enforced-by-construction
// to hold only placeholders: real refresh/durable tokens never leave the host.
//
// Two enforcement surfaces, both pure (no IO — `path.resolve` + lexical
// normalization only, never `fs.realpath`, so a missing path still validates and
// tests need no filesystem):
//   - `assertNoCredentialMounts`  HARD-FAIL if any host-path mount resolves under
//     a credential directory (or the home-dir root itself). Read-only is NOT
//     exempt: a RO mount of `~/.claude/.credentials.json` still exfiltrates the
//     refresh token into the guest.
//   - `stripCredentialEnv`        remove every known credential env var (the
//     per-adapter token vars PLUS the `*_API_KEY`/`*_TOKEN`/`*_SECRET` families and
//     the named ANTHROPIC_*/OPENAI_*/OPENCODE_*/GITHUB_*/COPILOT_* set). Generalizes
//     the runner's `buildForwardedEnv`, which strips only the single dispatched
//     token var.
//
// DORMANT (Phase 3): nothing on the live dispatch path imports this yet; it is
// wired only into the dormant `gondolin-dispatch.ts`.

import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import type { VmMount } from './vm-port.js';

/** Thrown by {@link assertNoCredentialMounts} — typed so callers can branch on it. */
export class CredentialMountError extends Error {
  constructor(
    message: string,
    /** The offending mount's (canonicalized) host path. */
    readonly hostPath: string,
    /** The denylist entry the path resolved under. */
    readonly deniedUnder: string,
  ) {
    super(message);
    this.name = 'CredentialMountError';
  }
}

export interface CredentialMountGuardOptions {
  /** Home directory root. Default `os.homedir()`. */
  homeDir?: string;
  /**
   * Extra absolute (or `~`-prefixed) credential directories/files to deny, on top
   * of the built-in set (`~/.claude`, `~/.codex`, opencode auth dir, `~/.config`,
   * `~/.ssh`). Mirrors the design's "configurable denylist".
   */
  extraDenylist?: readonly string[];
  /**
   * Resolve a path through symlinks. Default `fs.realpathSync`. The guard checks BOTH
   * the lexical canonical form AND this symlink-resolved form against the denylist, so
   * a mount source that is itself a symlink to a credential tree (e.g.
   * `/tmp/x -> ~/.codex`) is caught — a purely lexical check would miss it (codex
   * review, HIGH). Injected in tests to simulate symlinks without touching the FS; a
   * path that cannot be resolved (missing) falls back to its lexical form.
   */
  realpath?: (p: string) => string;
}

/**
 * Built-in credential directories/files, `~`-relative. opencode stores its
 * `auth.json` under `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`);
 * we deny the whole `~/.local/share/opencode` subtree. `~/.config` and `~/.ssh`
 * round out the denylist the design calls for.
 */
const BUILTIN_CRED_RELATIVE = [
  '.claude',
  '.codex',
  '.config',
  '.ssh',
  path.join('.local', 'share', 'opencode'),
  path.join('.symphony', 'oauth'),
] as const;

/**
 * Lexically canonicalize a host path WITHOUT touching the filesystem: expand a
 * leading `~` / `~/…` against `homeDir`, then `path.resolve` (which collapses
 * `.`/`..` and makes it absolute against cwd for a relative input). We deliberately
 * do NOT `fs.realpath` — the path need not exist, and a symlink-following resolve
 * is an IO + a TOCTOU surface; the deny check is a prefix test on the lexical
 * canonical form, which is strictly more conservative (it cannot be widened by a
 * symlink that resolves *out* of a denied dir).
 */
export function canonicalizeHostPath(hostPath: string, homeDir: string): string {
  let p = hostPath;
  if (p === '~') {
    p = homeDir;
  } else if (p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(homeDir, p.slice(2));
  }
  return path.resolve(p);
}

/**
 * True when `child` is `parent` or lies beneath it. Compares canonical absolute
 * paths with a trailing-separator guard so `/home/u/.codexible` does not count as
 * under `/home/u/.codex`.
 */
function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

/**
 * Best-effort symlink resolution of an already-lexically-canonical path. Falls back
 * to the input when it cannot be resolved (a missing path can't be mounted anyway,
 * and a non-existent path is not a symlink to a credential tree).
 */
function realResolve(canonical: string, realpath: (p: string) => string): string {
  try {
    return path.resolve(realpath(canonical));
  } catch {
    return canonical;
  }
}

/**
 * Resolve the full denylist (built-ins + extras) to canonical absolute paths, plus
 * their symlink-resolved forms (so a credential dir that is itself a symlink, e.g.
 * `~/.codex -> /data/codex`, is matched whether a mount names the link or the target).
 */
function resolveDenylist(
  homeDir: string,
  extra: readonly string[],
  realpath: (p: string) => string,
): string[] {
  const lexical = [
    ...BUILTIN_CRED_RELATIVE.map((rel) => path.join(homeDir, rel)),
    ...extra.map((e) => canonicalizeHostPath(e, homeDir)),
  ];
  const out = new Set<string>();
  for (const d of lexical) {
    out.add(d);
    out.add(realResolve(d, realpath));
  }
  return [...out];
}

/** Throw if `candidate` is a home root or overlaps any denylist entry. */
function assertCandidateAllowed(
  candidate: string,
  homeRoots: ReadonlySet<string>,
  denylist: readonly string[],
): void {
  // The home root (lexical OR symlink-resolved) is always denied — mounting it
  // exposes every credential dir at once, and a workspace legitimately lives
  // *under* home so the root can't just go in the per-dir denylist.
  if (homeRoots.has(candidate)) {
    throw new CredentialMountError(
      `refusing to mount the home directory root ${candidate} into a guest VM ` +
        `(exposes every credential directory at once)`,
      candidate,
      candidate,
    );
  }
  for (const denied of denylist) {
    // Bidirectional overlap: reject if the mount is UNDER a credential dir, IS one,
    // OR is an ANCESTOR that contains one (e.g. mounting `~/.local/share` exposes
    // `~/.local/share/opencode`). RO + symlinked sources are not exempt.
    if (isUnder(candidate, denied) || isUnder(denied, candidate)) {
      throw new CredentialMountError(
        `refusing to mount ${candidate} into a guest VM: it overlaps the credential ` +
          `path ${denied} (mounting it, a parent of it, or a child of it all expose ` +
          `the credential tree; read-only + symlinked sources are NOT exempt)`,
        candidate,
        denied,
      );
    }
  }
}

/**
 * HARD-FAIL if any mount's host path OVERLAPS a credential directory (the mount is
 * under one, IS one, or is an ancestor that contains one) or is the home-dir root.
 * Checks BOTH the lexical canonical form AND the symlink-resolved form (against a
 * denylist also resolved both ways), so neither a direct credential path, a symlink
 * pointing at one, nor an ancestor-of-one slips through (codex review, HIGH). Read-only
 * mounts are NOT exempt. Throws {@link CredentialMountError} on the first offender.
 */
export function assertNoCredentialMounts(
  mounts: readonly VmMount[],
  opts: CredentialMountGuardOptions = {},
): void {
  const homeDir = path.resolve(opts.homeDir ?? os.homedir());
  const realpath = opts.realpath ?? ((p: string) => realpathSync(p));
  // Both the lexical and symlink-resolved home roots are denied, so a symlinked
  // home (e.g. /home/u -> /data/u) can't be bypassed by mounting the real root.
  const homeRoots = new Set([homeDir, realResolve(homeDir, realpath)]);
  const denylist = resolveDenylist(homeDir, opts.extraDenylist ?? [], realpath);
  for (const m of mounts) {
    const lexical = canonicalizeHostPath(m.host, homeDir);
    const resolved = realResolve(lexical, realpath);
    for (const candidate of new Set([lexical, resolved])) {
      assertCandidateAllowed(candidate, homeRoots, denylist);
    }
  }
}

// ---------------------------------------------------------------------------
// stripCredentialEnv — drop every known credential env var.
// ---------------------------------------------------------------------------

/**
 * Exact credential env-var names dropped regardless of the family-suffix rules
 * below. Covers each adapter's token var (claude `ANTHROPIC_AUTH_TOKEN`, codex
 * `OPENAI_API_KEY`, opencode `OPENCODE_PROXY_TOKEN`) plus the GitHub durable-token
 * vars the opencode host-mint reads.
 */
const NAMED_CREDENTIAL_VARS: ReadonlySet<string> = new Set([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENCODE_PROXY_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'COPILOT_GITHUB_TOKEN',
]);

/**
 * Name prefixes whose entire family is credential-bearing and dropped wholesale.
 * The ANTHROPIC_ / OPENAI_ / OPENCODE_ / COPILOT_ families cover an adapter's full
 * env surface; GITHUB_ / GH_ cover the durable GitHub OAuth token the opencode
 * host-mint uses.
 */
const CREDENTIAL_NAME_PREFIXES: readonly string[] = [
  'ANTHROPIC_',
  'OPENAI_',
  'OPENCODE_',
  'COPILOT_',
  'GITHUB_',
  'GH_',
];

/**
 * Name suffixes that mark a var as secret-bearing across any vendor. `*_API_KEY`,
 * `*_TOKEN`, `*_SECRET` — generalizes the runner's single-var strip to the whole
 * family so a forwarded `FOO_API_KEY` can never plant a real key in the guest's
 * PID-1 environment (readable via `/proc/1/environ`).
 */
const CREDENTIAL_NAME_SUFFIXES: readonly string[] = ['_API_KEY', '_TOKEN', '_SECRET'];

/**
 * True when a name is a *secret-bearing token* by the named-set or the
 * `*_API_KEY`/`*_TOKEN`/`*_SECRET` suffix rule. Deliberately does NOT include the
 * vendor *prefix* families — this is the strip applied to adapter-injected runtime
 * env, which legitimately carries non-secret config like `ANTHROPIC_MODEL` /
 * `OPENAI_BASE_URL`. Those prefix families are dropped only from the operator boot
 * env (see {@link isCredentialEnvName}).
 */
export function isCredentialTokenName(name: string): boolean {
  const upper = name.toUpperCase();
  if (NAMED_CREDENTIAL_VARS.has(upper)) return true;
  for (const suffix of CREDENTIAL_NAME_SUFFIXES) {
    if (upper.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * True when an env var name is credential-bearing under ANY rule: the named set, the
 * vendor prefix families (ANTHROPIC_ / OPENAI_ / OPENCODE_ / COPILOT_ / GITHUB_ /
 * GH_), or the `*_API_KEY`/`*_TOKEN`/`*_SECRET` suffix families. This is the strict
 * boot-env policy.
 */
export function isCredentialEnvName(name: string): boolean {
  if (isCredentialTokenName(name)) return true;
  const upper = name.toUpperCase();
  for (const prefix of CREDENTIAL_NAME_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Return a copy of `env` with every credential-bearing var removed (the strict
 * boot-env policy — named set + vendor prefix families + secret suffixes). The guest
 * gets only placeholders (seeded into the per-VM `secretManager`, never the boot
 * env), so the real token never enters the VM. Generalizes the runner's
 * `buildForwardedEnv`, which strips only the single dispatched proxy token var.
 *
 * Use this for the operator-forwarded boot env. For adapter-injected RUNTIME env
 * (model/effort/base-url), use {@link stripCredentialTokenVars}, which preserves the
 * vendor-prefixed config knobs while still dropping any actual token.
 */
export function stripCredentialEnv(env: Record<string, string>): Record<string, string> {
  return stripBy(env, isCredentialEnvName);
}

/**
 * Return a copy of `env` with only secret-bearing TOKENS removed (named set + secret
 * suffixes), preserving non-secret vendor-prefixed config like `ANTHROPIC_MODEL` /
 * `OPENAI_BASE_URL`. Defense-in-depth for the adapter runtime env: even though the
 * real secret is delivered via the per-VM secretManager placeholder and never via an
 * env var, a token must never ride runtime env either.
 */
export function stripCredentialTokenVars(env: Record<string, string>): Record<string, string> {
  return stripBy(env, isCredentialTokenName);
}

function stripBy(
  env: Record<string, string>,
  drop: (name: string) => boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (drop(k)) continue;
    out[k] = v;
  }
  return out;
}
