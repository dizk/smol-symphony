// Registry of ACP adapters symphony knows how to launch end-to-end.
//
// Each profile encodes the executable inside the VM that speaks ACP, plus the
// optional model/effort injection channels (env vars, extra argv, staged files)
// the adapter natively understands. There is no per-adapter credential file
// plumbing — credentials are no longer staged into the VM. The host credential
// proxy substitutes a per-VM sentinel for the real upstream token on every
// request (Anthropic OAuth for claude, an OpenAI API key or ChatGPT-OAuth
// access token for codex); each proxy adapter declares its VM-facing base-URL
// and token env var names via `proxyEnv`.
//
// To add a new adapter (e.g. opencode), populate the profile and add it to
// ADAPTERS. Unprofiled adapters are not supported at runtime.

import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isKnownAdapter, type AcpAdapterId } from './adapter-names.js';

// Re-export the names registry so orchestrator-side callers can keep importing
// `isKnownAdapter` / `AcpAdapterId` from this module. The canonical home is
// adapter-names.ts; this is just a convenience re-export.
export { isKnownAdapter, type AcpAdapterId };

/**
 * How a chosen runtime knob (model, effort, …) is surfaced to a specific adapter.
 * Three orthogonal channels: env vars, extra argv passed to the adapter binary, and
 * files staged into the workspace runtime dir then copied into the VM before the
 * adapter starts. Adapters pick whichever channel matches their native mechanism —
 * env for claude-agent-acp's ANTHROPIC_MODEL, argv for codex-acp's `-c key=value`,
 * staged file for claude-agent-acp's settings.json (effortLevel lives there).
 *
 * `stagedFiles` entries declare both the staging-dir filename and the absolute guest
 * path the in-VM launch command must copy them to. The runner stages each file like
 * the identity file (same staging-root logic, same symlink defenses) and
 * `deriveAcpCommand` emits a `mkdir -p` + `cp` line per file before exec'ing the
 * proxy.
 */
export interface ModelInjection {
  env?: Record<string, string>;
  extraArgs?: string[];
  stagedFiles?: StagedFileSpec[];
}

/** Alias for symmetry with effortInjection; same shape as ModelInjection. */
export type EffortInjection = ModelInjection;

export interface StagedFileSpec {
  /**
   * File name inside the workspace runtime staging dir. Must be unique vs any other
   * staged file for the same attempt — collisions would silently overwrite earlier
   * writes.
   */
  stagedName: string;
  /** UTF-8 content to write. */
  content: string;
  /** Absolute path inside the VM where deriveAcpCommand should copy the file. */
  guestPath: string;
}

/**
 * How symphony supplies upstream credentials to this adapter at dispatch time.
 *
 *  - `'proxy'`: the host credential proxy mints a per-dispatch sentinel; the
 *    in-VM client dials the proxy (via the adapter's base-URL env var) with the
 *    sentinel as its bearer, and the proxy substitutes the real upstream token
 *    host-side on every request. No credential bytes — and crucially no refresh
 *    token — ever enter the VM. Both claude and codex use this (see
 *    `src/agent/credential-proxy.ts`).
 *  - `'forward-env'`: the adapter reads a credential env var forwarded verbatim
 *    into the VM via `smolvm.forward_env`. The proxy is not involved. No shipped
 *    adapter uses this today; it remains for adapters the proxy cannot serve.
 * The runner dispatches on this field (not on `id`) so that proxy-capable
 * adapters route through the proxy and `forward-env` adapters proceed without
 * one — never crash-looping a dispatch for an adapter the proxy can't serve.
 * Both claude and codex are `'proxy'`. codex additionally needs a placeholder
 * `~/.codex/auth.json` staged (see `stageCodexPlaceholderAuth`): a live dispatch
 * showed codex-acp fails its session-init credential check with "Authentication
 * required" when only the env sentinel is set and no auth.json file exists, even
 * though it then uses the env `OPENAI_API_KEY` (= sentinel) as its request
 * bearer. The placeholder is a fake (no real token) — the proxy substitutes the
 * real OpenAI credential at egress. See `docs/research/codex-proxy-accept-matrix.md`.
 */
export type CredentialStrategy = 'proxy' | 'forward-env';

/**
 * The VM-facing env var names a `'proxy'`-strategy adapter expects for the
 * credential proxy. The runner stages `baseUrlVar=<proxy base URL>` and
 * `tokenVar=<per-dispatch sentinel>` into the in-VM adapter env; the in-VM
 * client then dials the proxy with the sentinel as its bearer. claude reads
 * `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`; codex reads
 * `OPENAI_BASE_URL`/`OPENAI_API_KEY`.
 */
export interface ProxyEnvVars {
  baseUrlVar: string;
  tokenVar: string;
}

export interface AdapterProfile {
  id: AcpAdapterId;
  /**
   * ACP adapter launch command, split into argv. Each token is shell-quoted before
   * being emitted into the `bash -lc` string, so future profiles with multi-token
   * commands (e.g. `['opencode', 'acp']`) compose without shell-injection risk.
   */
  binary: readonly string[];
  /** How symphony supplies upstream credentials to this adapter. See {@link CredentialStrategy}. */
  credentialStrategy: CredentialStrategy;
  /**
   * For `'proxy'`-strategy adapters: the VM-facing env var names the runner uses
   * to stage the proxy base URL + sentinel. Required when `credentialStrategy`
   * is `'proxy'`; unused for `'forward-env'`. See {@link ProxyEnvVars}.
   */
  proxyEnv?: ProxyEnvVars;
  /**
   * Map an `acp.model` string into the env vars / extra argv this adapter needs to
   * actually select the model. Called only when `acp.model` is non-null; profiles can
   * assume a non-empty string. Return shape lets new adapters pick whatever mechanism
   * they natively support (e.g. opencode could pass `--model` here).
   */
  modelInjection(model: string): ModelInjection;
  /**
   * Map an `acp.effort` string into env / argv / staged files. Optional because not
   * every adapter has a native effort knob. Called only when `acp.effort` is non-null;
   * profiles can assume a non-empty string. Symphony does not validate the value
   * (Anthropic's `supportedEffortLevels` is model-dependent — `xhigh` is only valid
   * on models with `supportsEffort`); the adapter rejects invalid values at startup.
   */
  effortInjection?(effort: string): EffortInjection;
  /**
   * For a `'proxy'`-strategy adapter whose native transport would otherwise
   * BYPASS the base-URL env var, the per-dispatch `-c key=value` config
   * overrides that pin it onto an explicit HTTPS provider routed through the
   * host credential proxy. Returns extra adapter argv, appended after the model
   * `-c` override. Applied at exec time (not at model-injection time) because
   * the args carry the proxy's ephemeral port, known only once the sentinel is
   * registered against the running proxy.
   *
   * Only codex declares it: codex's Responses API defaults to a
   * `wss://api.openai.com/v1/responses` WebSocket transport that ignores
   * `OPENAI_BASE_URL` and dials OpenAI directly, sending the per-dispatch
   * sentinel raw → 401 (issue #127). Forcing `supports_websockets=false` + an
   * explicit `base_url` routes `/v1/responses` over HTTPS to the proxy, which
   * is path-transparent. claude omits it (its only transport honors the
   * base-URL env var). Receives the proxy `baseUrl` (`http://host:port`, NO
   * `/v1`) and the token env var name (`OPENAI_API_KEY`).
   */
  proxyProviderArgs?(input: { baseUrl: string; tokenVar: string }): string[];
}

// VM-facing env var names the opencode custom provider reads (via `{env:VAR}`)
// for the proxy base URL + sentinel. Defined as constants so the profile's
// `proxyEnv` and the staged opencode.json reference the exact same names — a
// drift between them would silently break the in-VM provider resolution.
// Declared before ADAPTERS because the object literal reads them at module init.
const OPENCODE_PROXY_BASE_URL_VAR = 'OPENCODE_PROXY_BASE_URL';
const OPENCODE_PROXY_TOKEN_VAR = 'OPENCODE_PROXY_TOKEN';

export const ADAPTERS: Record<AcpAdapterId, AdapterProfile> = {
  claude: {
    id: 'claude',
    binary: ['claude-agent-acp'],
    // Anthropic subscription OAuth lives only on the host; the proxy substitutes
    // a per-VM sentinel for the real access token on every upstream request.
    credentialStrategy: 'proxy',
    proxyEnv: { baseUrlVar: 'ANTHROPIC_BASE_URL', tokenVar: 'ANTHROPIC_AUTH_TOKEN' },
    // claude-agent-acp reads ANTHROPIC_MODEL on startup (see acp-agent.js getAvailableModels:
    // ANTHROPIC_MODEL > settings.model > default). The adapter resolves aliases like
    // "opus" or "claude-sonnet-4-5" against the SDK's model list, so anything the user
    // would type into Claude Code works here.
    modelInjection: (model) => ({ env: { ANTHROPIC_MODEL: model } }),
    // claude-agent-acp reads `effortLevel` out of merged settings (the SDK's
    // `resolveSettings` walks `$CLAUDE_CONFIG_DIR/settings.json`, `<cwd>/.claude/settings.json`,
    // etc.) and applies it via `query.applyFlagSettings`. There is no ANTHROPIC_EFFORT env var
    // and the wrapper does not expose a CLI flag, so the only reachable channel from symphony
    // is a settings.json staged next to the identity file and copied to /root/.claude/settings.json
    // before the proxy execs the adapter. Valid values are `low|medium|high|xhigh|max`, gated
    // per-model by claude-agent-acp's `supportedEffortLevels`; symphony lets the adapter reject
    // invalid choices rather than mirroring the gate.
    effortInjection: (effort) => ({
      stagedFiles: [
        {
          stagedName: 'claude-settings.json',
          content: JSON.stringify({ effortLevel: effort }),
          guestPath: '/root/.claude/settings.json',
        },
      ],
    }),
  },
  codex: {
    id: 'codex',
    binary: ['codex-acp'],
    // The proxy substitutes a per-VM sentinel for the real OpenAI credential on
    // every request; the VM holds OPENAI_API_KEY=<sentinel> + OPENAI_BASE_URL=
    // <proxy>, never a real token. BUT codex-acp's session-init credential check
    // fails ("Authentication required") if no ~/.codex/auth.json FILE exists,
    // even with the env sentinel present (a live dispatch proved this — #116
    // staged only the env). So a fake placeholder auth.json is staged
    // (stageCodexPlaceholderAuth) purely to satisfy that init check; codex then
    // uses the env OPENAI_API_KEY (= sentinel, precedence over the file) as its
    // bearer and the proxy swaps in the real credential. No real token, and no
    // refresh token, ever enters the VM. See docs/research/codex-proxy-accept-matrix.md.
    credentialStrategy: 'proxy',
    proxyEnv: { baseUrlVar: 'OPENAI_BASE_URL', tokenVar: 'OPENAI_API_KEY' },
    // codex-acp takes config overrides via `-c key=value` where value is parsed as TOML
    // (raw-string fallback on parse failure). We always emit a quoted TOML string so
    // model names containing dots or hyphens don't surprise the TOML parser.
    modelInjection: (model) => ({ extraArgs: ['-c', `model=${JSON.stringify(model)}`] }),
    // Pin codex onto an explicit HTTPS provider routed through the credential
    // proxy. Without this, codex's Responses API defaults to a
    // `wss://api.openai.com/v1/responses` WebSocket transport that bypasses the
    // proxy (ignores OPENAI_BASE_URL), dialing OpenAI directly with the raw
    // per-dispatch sentinel → 401 (issue #127). `supports_websockets=false`
    // kills the wss attempt; the explicit `base_url` sends `/v1/responses` over
    // HTTPS to the path-transparent proxy.
    proxyProviderArgs: ({ baseUrl, tokenVar }) => codexProxyProviderArgs(baseUrl, tokenVar),
  },
  opencode: {
    id: 'opencode',
    binary: ['opencode', 'acp'],
    // opencode reaches GitHub Copilot through the host credential proxy. The VM
    // receives OPENCODE_PROXY_BASE_URL=<proxy> + OPENCODE_PROXY_TOKEN=<sentinel>;
    // a staged opencode.json declares a custom `@ai-sdk/openai-compatible`
    // provider whose baseURL/apiKey read those env vars (opencode interpolates
    // `{env:VAR}`). The proxy validates the sentinel, swaps in a short-lived
    // GitHub Copilot token (exchanged host-side from the operator's `opencode
    // auth login` GitHub OAuth token at api.github.com/copilot_internal/v2/token),
    // injects the Copilot editor headers, and forwards to api.githubcopilot.com.
    // The durable GitHub OAuth token never enters the VM. See
    // docs/research/opencode-copilot-accept-matrix.md.
    credentialStrategy: 'proxy',
    proxyEnv: { baseUrlVar: OPENCODE_PROXY_BASE_URL_VAR, tokenVar: OPENCODE_PROXY_TOKEN_VAR },
    // opencode picks its model from the staged opencode.json `model` key
    // ("<providerID>/<modelID>"); the ACP `session/new` carries no model. The
    // provider block must exist even when no model is pinned, so the whole
    // config (provider + model) is staged together via stageOpencodeConfig
    // (see runner.stageAdapterExtras), not through this env/argv channel.
    // Returning an empty injection keeps this path inert.
    modelInjection: () => ({}),
  },
};

/** Provider id of the opencode → credential-proxy custom provider. */
export const OPENCODE_PROXY_PROVIDER_ID = 'symphony-copilot';

/**
 * Default GitHub Copilot model opencode uses when the workflow pins no
 * `acp.model`. DOC-DERIVED: `gpt-4o` is broadly available across Copilot
 * subscription tiers. Operators override per-state via `acp.model` (any id
 * their Copilot subscription exposes — GPT-5, Claude Sonnet, Gemini, …).
 */
export const OPENCODE_DEFAULT_COPILOT_MODEL = 'gpt-4o';

// A small pinned set of Copilot-backed model ids the custom provider advertises
// so opencode does not need to hit `<baseURL>/models` for discovery (the proxy
// forwards /models too, but pinning avoids the round-trip and a discovery
// dependency). DOC-DERIVED — the exact id set a given Copilot subscription
// exposes is operator/tier-dependent; an operator's `acp.model` is always
// merged in (see buildOpencodeConfig) so a pinned model that isn't in this list
// still resolves.
const OPENCODE_PINNED_COPILOT_MODELS: readonly string[] = [
  'gpt-4o',
  'gpt-4.1',
  'o4-mini',
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'gemini-2.5-pro',
];

/**
 * Build the opencode.json staged into the VM (pure; exported for tests). It
 * declares the `symphony-copilot` custom provider pointed at the credential
 * proxy via `{env:…}` interpolation, advertises a pinned Copilot model set
 * (plus the operator's selected model), and pins the default model to
 * `<providerID>/<model>`. Two-space-indented so it reads cleanly if an operator
 * inspects the staged file.
 *
 * The `{env:VAR}` names match the profile's `proxyEnv` exactly (shared
 * constants), so the in-VM opencode resolves the proxy base URL + sentinel the
 * runner stages.
 */
export function buildOpencodeConfig(model: string | null): string {
  const selected = model && model.length > 0 ? model : OPENCODE_DEFAULT_COPILOT_MODEL;
  const ids = new Set<string>([...OPENCODE_PINNED_COPILOT_MODELS, selected]);
  const models: Record<string, Record<string, never>> = {};
  for (const id of ids) models[id] = {};
  return JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        [OPENCODE_PROXY_PROVIDER_ID]: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Symphony Copilot proxy',
          options: {
            baseURL: `{env:${OPENCODE_PROXY_BASE_URL_VAR}}`,
            apiKey: `{env:${OPENCODE_PROXY_TOKEN_VAR}}`,
          },
          models,
        },
      },
      model: `${OPENCODE_PROXY_PROVIDER_ID}/${selected}`,
    },
    null,
    2,
  );
}

/**
 * Absolute guest path the staged opencode.json is copied to inside the VM.
 * opencode reads its global config from `$XDG_CONFIG_HOME/opencode/opencode.json`
 * (defaulting to `~/.config/opencode/opencode.json`); the VM runs as root, so
 * `/root/.config/opencode/opencode.json`. DOC-DERIVED: that `opencode acp`
 * honours the global config + custom provider + `{env:VAR}` interpolation is
 * recorded in docs/research/opencode-copilot-accept-matrix.md.
 */
export const OPENCODE_CONFIG_GUEST_PATH = '/root/.config/opencode/opencode.json';

/**
 * Stage the opencode.json (custom-provider + model) into the workspace runtime
 * tree. Mirrors stageCodexPlaceholderAuth: synthetic content (no secret — the
 * sentinel arrives via env, never a real token), so it never fails on a missing
 * host file.
 */
export async function stageOpencodeConfig(
  workspacePath: string,
  model: string | null,
): Promise<StagedRuntimePaths> {
  return stageRuntimeFile(workspacePath, 'opencode.json', buildOpencodeConfig(model));
}

/** Provider id for the codex → credential-proxy `model_providers` override. */
const CODEX_PROXY_PROVIDER_ID = 'symphony-proxy';

/**
 * Build the per-dispatch codex `-c` overrides that pin codex onto an explicit
 * HTTPS provider routed through the host credential proxy (issue #127). See the
 * codex profile's `proxyProviderArgs` for why this is required.
 *
 *   - `model_provider=<id>` selects the provider below over codex's built-in
 *     `openai` provider, whose Responses transport defaults to a
 *     `wss://api.openai.com` WebSocket that bypasses the proxy entirely.
 *   - `base_url=<proxy>/v1` sends `/v1/responses` to the proxy — the proxy
 *     returns its base as `http://host:port` WITHOUT `/v1`, so we append it
 *     (tolerating a stray trailing slash defensively).
 *   - `env_key=<tokenVar>` keeps the per-dispatch sentinel (already staged into
 *     `OPENAI_API_KEY`) as the bearer the proxy validates and swaps.
 *   - `wire_api="responses"` matches codex's gpt-5-codex transport.
 *   - `supports_websockets=false` forces the HTTPS Responses fallback.
 *
 * String values are emitted as JSON-quoted TOML strings (TOML basic strings use
 * the same double-quote syntax) so values with dots/hyphens can't surprise the
 * TOML parser; `supports_websockets=false` is a raw TOML boolean, not a string.
 */
function codexProxyProviderArgs(baseUrl: string, tokenVar: string): string[] {
  const id = CODEX_PROXY_PROVIDER_ID;
  const field = (name: string): string => `model_providers.${id}.${name}`;
  const v1BaseUrl = `${baseUrl.replace(/\/+$/, '')}/v1`;
  return [
    '-c', `model_provider=${JSON.stringify(id)}`,
    '-c', `${field('name')}=${JSON.stringify('Symphony credential proxy')}`,
    '-c', `${field('base_url')}=${JSON.stringify(v1BaseUrl)}`,
    '-c', `${field('env_key')}=${JSON.stringify(tokenVar)}`,
    '-c', `${field('wire_api')}=${JSON.stringify('responses')}`,
    '-c', `${field('supports_websockets')}=false`,
  ];
}

export function profileFor(id: AcpAdapterId): AdapterProfile {
  return ADAPTERS[id];
}

/**
 * Where in the workspace symphony stages adapter runtime files (identity,
 * settings.json, …).
 *
 * Strategy by workspace shape (resolved at stage time, not by this helper):
 *   - `.git/` is a directory  → `<ws>/.git/symphony-runtime/<subdir>/<name>`
 *     Files under `.git/` are git's private area; `git add`/`git status` never
 *     recurse into it, so the file is structurally untrackable. No
 *     `info/exclude` games needed.
 *   - `.git` does not exist   → `<ws>/.symphony-runtime/<subdir>/<name>`
 *     There's no git in this workspace, so no commit/add semantics to worry
 *     about. Falls back to a workspace-root path.
 *   - `.git` is a file (linked worktree) → refused at stage time. The
 *     per-worktree gitdir lives outside the workspace mount, so symphony
 *     cannot place the file where the in-VM agent can see it without
 *     re-introducing the working-tree-leak risk. Linked worktrees are
 *     unsupported under the TCP bridge transport; use a non-linked workspace
 *     clone or fork scripts/vm-agent.mjs.
 *
 * Returned path is relative to `workspacePath` and slash-joined (POSIX) so it
 * works as-is in the in-VM acp launch command, regardless of host OS path
 * separator.
 */
export interface StagedRuntimePaths {
  /** Absolute path on the host (where the writer actually wrote). */
  absPath: string;
  /** POSIX path relative to workspacePath (used in the in-VM launch command). */
  relPath: string;
}

export async function stageRuntimeFile(
  workspacePath: string,
  stagedName: string,
  content: string,
): Promise<StagedRuntimePaths> {
  return stageNamedFileUnder(workspacePath, 'runtime', stagedName, content);
}

/**
 * Stage the host's claude identity into the workspace runtime tree. Reads
 * `~/.claude.json`, extracts only the operator's `oauthAccount.accountUuid`
 * and `oauthAccount.organizationUuid`, and writes a minimal JSON file at
 * `<workspace>/.git/symphony-runtime/identity/claude.json` (or the
 * `.symphony-runtime/` fallback when the workspace has no `.git/`). The
 * in-VM claude-agent-acp reads these fields to compose a well-formed
 * `metadata.user_id` on every upstream call so a future re-activation of
 * Anthropic's server-side fingerprint check doesn't break dispatch.
 *
 * Defensive shape: NO token strings, NO `device_id`/`session_id` (those are
 * per-process — the in-VM client mints fresh ones on first run), NO local
 * config (prompt-history pointers, theme, recent paths). Identity only. See
 * the integration test in tests/credential-proxy.test.ts which greps the
 * staged file for `accessToken`/`refreshToken` substrings.
 *
 * When `~/.claude.json` is missing or contains no `oauthAccount` we skip the
 * staging (returning null) rather than fail the dispatch — the proxy seam
 * is defense in depth, not a hard gate on running.
 */
export async function stageClaudeIdentity(
  workspacePath: string,
): Promise<StagedRuntimePaths | null> {
  const src = path.join(homedir(), '.claude.json');
  let raw: string;
  try {
    raw = await readFile(src, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const account = extractOauthAccountIdentity(parsed);
  if (!account) return null;
  const content = JSON.stringify({ oauthAccount: account });
  return stageNamedFileUnder(workspacePath, 'identity', 'claude.json', content);
}

/**
 * Stage a FAKE placeholder `~/.codex/auth.json` into the workspace for the codex
 * adapter. codex-acp's session-init credential check fails with "Authentication
 * required" when no auth.json file exists, even though the per-dispatch sentinel
 * is supplied via the `OPENAI_API_KEY` env var (a live dispatch proved this —
 * #116 staged only the env). This file exists PURELY to satisfy that init check:
 * it contains NO real credential — `OPENAI_API_KEY` is a sentinel-shaped
 * placeholder and there is no OAuth `tokens` block — so codex falls through to
 * the env `OPENAI_API_KEY` (= the real per-dispatch sentinel, which has
 * precedence over the file) as its request bearer, and the host credential proxy
 * substitutes the real OpenAI token at egress. No real token, and no refresh
 * token, ever enters the VM.
 *
 * `auth_mode: 'apikey'` so codex takes the API-key path (the env sentinel),
 * never an OAuth handshake. `last_refresh` is omitted (no OAuth tokens to age).
 */
export async function stageCodexPlaceholderAuth(
  workspacePath: string,
): Promise<StagedRuntimePaths> {
  const placeholder = JSON.stringify({
    OPENAI_API_KEY: 'sk-symphony-placeholder',
    auth_mode: 'apikey',
  });
  return stageNamedFileUnder(workspacePath, 'credential', 'auth.json', placeholder);
}

/**
 * Pull just the identity fields out of the parsed `~/.claude.json`. Anything
 * outside `accountUuid`/`organizationUuid` is dropped — see
 * `stageClaudeIdentity`'s contract.
 */
function extractOauthAccountIdentity(
  parsed: unknown,
): { accountUuid: string; organizationUuid: string } | null {
  const acct = pickObjectField(parsed, 'oauthAccount');
  if (!acct) return null;
  const accountUuid = pickStringField(acct, 'accountUuid');
  const organizationUuid = pickStringField(acct, 'organizationUuid');
  if (accountUuid === null || organizationUuid === null) return null;
  return { accountUuid, organizationUuid };
}

function pickObjectField(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = (value as Record<string, unknown>)[key];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function pickStringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) return null;
  return v;
}

/**
 * Shared implementation for the runtime/identity staging paths. Writes
 * `content` into `<staging-root>/<subdir>/<stagedName>` (0600) with the same
 * symlink/race defenses we previously used for the credential file: explicit
 * cleanup of the leaf, exclusive create via `flag: 'wx'`, and a post-write
 * `realpath` check to detect a symlink that raced into a parent between
 * `ensureRealDir` and the write.
 */
async function stageNamedFileUnder(
  workspacePath: string,
  subdir: 'runtime' | 'identity' | 'credential',
  stagedName: string,
  content: string,
): Promise<StagedRuntimePaths> {
  if (!/^[A-Za-z0-9._-]+$/.test(stagedName)) {
    throw new Error(
      `stageNamedFileUnder: stagedName ${JSON.stringify(stagedName)} contains characters outside ` +
        `[A-Za-z0-9._-]; refuse to compose into the staging path.`,
    );
  }
  const { stagingRootAbs, stagingRootRel } = await resolveStagingLocation(workspacePath);
  const subDir = path.join(stagingRootAbs, subdir);
  await ensureRealDir(stagingRootAbs);
  await ensureRealDir(subDir);

  const dst = path.join(subDir, stagedName);
  await rm(dst, { force: true, recursive: false });
  await writeFile(dst, content, { mode: 0o600, flag: 'wx' });

  const expectedReal = path.join(await realpath(workspacePath), stagingRootRel, subdir, stagedName);
  const actualReal = await realpath(dst);
  if (actualReal !== expectedReal) {
    await rm(dst, { force: true }).catch(() => undefined);
    throw new Error(
      `staging path redirected: wrote to ${actualReal}, expected ${expectedReal}. ` +
        `A symlink raced in during staging; manually inspect and remove any leaked ` +
        `file at the actual path before retrying.`,
    );
  }

  const relPath = path.posix.join(stagingRootRel, subdir, stagedName);
  return { absPath: dst, relPath };
}

/**
 * Decide where to stage runtime files based on workspace shape. See
 * StagedRuntimePaths for the policy. Returns absolute + relative (POSIX,
 * relative to workspacePath) paths to the staging root directory; the caller
 * composes `<subdir>/<name>` under it.
 */
async function resolveStagingLocation(workspacePath: string): Promise<{
  stagingRootAbs: string;
  stagingRootRel: string;
}> {
  const gitPath = path.join(workspacePath, '.git');
  let gitSt;
  try {
    gitSt = await lstat(gitPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No `.git` in the workspace itself. The workspace-root fallback is only
      // safe when the workspace is also NOT inside an ancestor git repo — git's
      // repository discovery walks up the directory tree, so a workspace at e.g.
      // `<parent>/.symphony/workspaces/X` with no own `.git` ends up inside
      // `<parent>/.git`. A `git add -A` (from a host-side hook, or from any
      // process with the host filesystem visible) would then stage the file in
      // the parent's index. Detect that and refuse.
      //
      // Resolve symlinks first: git's discovery follows the resolved path, so
      // walking the lexical `workspacePath` would miss an ancestor `.git` that
      // sits above the symlink's real target (e.g. `/home/user/repo-link`
      // pointing at `/srv/repo` where `/srv/.git` exists). A broken symlink at
      // workspacePath itself is treated as a refusal: we cannot prove the
      // workspace isn't inside someone's working tree, so don't stage.
      let resolvedWorkspace: string;
      try {
        resolvedWorkspace = await realpath(workspacePath);
      } catch (resolveErr) {
        throw new Error(
          `cannot auto-stage runtime files: workspace ${workspacePath} could not be resolved ` +
            `(realpath failed: ${(resolveErr as Error).message}). Refusing to stage without a ` +
            `canonical path; fix the workspace.`,
        );
      }
      const ancestor = await findAncestorGit(resolvedWorkspace);
      if (ancestor !== null) {
        throw new Error(
          `cannot auto-stage runtime files: workspace ${workspacePath} has no .git of its own ` +
            `but is inside an ancestor git repo at ${ancestor}. Create a nested clone ` +
            `(e.g. via hooks.after_create).`,
        );
      }
      return {
        stagingRootAbs: path.join(workspacePath, '.symphony-runtime'),
        stagingRootRel: '.symphony-runtime',
      };
    }
    throw err;
  }
  if (gitSt.isDirectory()) {
    // Normal clone: stage inside `.git/`, which is outside the working tree.
    // Git never recurses into `.git/` for `add`/`status`, so the file is
    // structurally untrackable — no `info/exclude` games needed, and a tracked
    // `.symphony-runtime/...` at workspace root cannot interfere.
    return {
      stagingRootAbs: path.join(workspacePath, '.git', 'symphony-runtime'),
      stagingRootRel: path.posix.join('.git', 'symphony-runtime'),
    };
  }
  if (gitSt.isFile()) {
    // Linked worktree: .git is a pointer file at /<worktree>/.git -> per-worktree
    // gitdir (typically /<main>/.git/worktrees/<name>/). The per-worktree gitdir
    // lives outside the workspace mount, so symphony cannot place the file
    // there and still have the in-VM agent reach it. Any worktree-internal path
    // is inside the working tree, where `.gitignore` negation or a tracked file
    // could still expose state to `git add -A`. Linked worktrees are
    // currently unsupported — use a non-linked workspace clone (e.g.
    // `git clone --local`) or fork scripts/vm-agent.mjs to stage runtime
    // files in whatever shape your worktree layout needs.
    throw new Error(
      `cannot auto-stage runtime files in a linked worktree (.git at ${gitPath} is a file). ` +
        `Linked worktrees are unsupported under the ACP TCP bridge transport; use a ` +
        `non-linked workspace clone or fork scripts/vm-agent.mjs.`,
    );
  }
  throw new Error(
    `cannot auto-stage runtime files: ${gitPath} is neither a directory nor a file ` +
      `(symlink, device, or other unexpected entry).`,
  );
}

/**
 * Walk up from `workspacePath` looking for an ancestor `.git` entry (file or dir).
 * Returns the absolute path of the first one found, or null when the walk reaches
 * the filesystem root without hitting one. Used to detect workspaces that, despite
 * having no `.git` of their own, are still inside the working tree of an ancestor
 * git repo.
 *
 * The caller is expected to pass an already-canonical (realpath-resolved) path:
 * git discovery follows the resolved path, so a lexical walk on a symlinked input
 * would miss the real ancestor. Once the input is canonical, every `path.dirname`
 * step stays canonical (a directory's parent is itself a directory component,
 * never a symlink), so no per-level re-resolve is needed.
 */
async function findAncestorGit(workspacePath: string): Promise<string | null> {
  const root = path.parse(workspacePath).root;
  let current = path.dirname(workspacePath);
  while (current && current !== root) {
    const candidate = path.join(current, '.git');
    try {
      await lstat(candidate);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  // Final check at the root itself.
  try {
    await lstat(path.join(root, '.git'));
    return path.join(root, '.git');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return null;
}

/**
 * Ensure `p` is a real directory we own. Creates it if missing; refuses if it exists
 * as a symlink (defense against the staging-via-symlink attack) or as a non-directory.
 */
async function ensureRealDir(p: string): Promise<void> {
  let st;
  try {
    st = await lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await mkdir(p, { recursive: false });
      return;
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to write symphony-runtime through a symlink at ${p}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`expected a directory at ${p}, found a non-directory`);
  }
}

/**
 * Additional file to copy into the VM before exec'ing the proxy. Carries
 * runtime knobs that surface through files: claude's identity (~/.claude.json)
 * and the settings.json that holds `effortLevel`. `stagedRelPath` is the POSIX
 * path within the workspace mount (relative to the in-VM cwd) and `guestPath`
 * is the absolute destination in the VM.
 *
 * deriveAcpCommand emits `mkdir -p $(dirname guestPath)` before each cp so the
 * destination directory exists regardless of whether the adapter's VM image
 * pre-creates it.
 */
export interface ExtraGuestFile {
  stagedRelPath: string;
  guestPath: string;
}

/**
 * Build the bash command symphony will exec inside the VM. For each staged
 * extra file: `mkdir -p` the destination directory, `cp` the file into place,
 * `chmod 600`. Then exec the in-VM proxy at `/opt/symphony/vm-agent.mjs`. The
 * proxy reads its config — SYMPHONY_ACP_URL, SYMPHONY_ACP_TOKEN,
 * SYMPHONY_ADAPTER_BIN, SYMPHONY_ADAPTER_ARGS — from the environment that
 * symphony sets on the `smolvm exec` invocation, dials the host's TCP ACP
 * bridge, and spawns the adapter with kernel pipes.
 *
 * Why TCP through a proxy: smolvm-exec's stdin pump does not reliably wake the
 * in-VM reader for kernel events unless host stdin keeps writing. Piping ACP
 * frames through smolvm-exec stdio caused the adapter to hang after the first
 * session/update. The TCP bridge (see src/acp-bridge.ts) bypasses that pump
 * entirely and decouples symphony from any specific sandbox tech — any sandbox
 * that can launch a process with env vars and reach the host loopback can run
 * this stack unchanged.
 *
 * Credentials are NOT staged into the VM. The host credential proxy substitutes
 * a per-VM sentinel for the real upstream token (Anthropic OAuth for claude,
 * an OpenAI API key or ChatGPT-OAuth access token for codex) on every request;
 * the VM only ever holds the sentinel + the adapter's base-URL env var.
 */
export function deriveAcpCommand(
  profile: AdapterProfile,
  extraFiles: readonly ExtraGuestFile[] = [],
): string {
  if (profile.binary.length === 0) {
    throw new Error(`adapter "${profile.id}" has an empty binary launch vector`);
  }
  const steps: string[] = [];
  for (const f of extraFiles) {
    const extraDir = path.posix.dirname(f.guestPath);
    steps.push(`mkdir -p ${shQuote(extraDir)}`);
    steps.push(`cp ${shQuote(f.stagedRelPath)} ${shQuote(f.guestPath)}`);
    steps.push(`chmod 600 ${shQuote(f.guestPath)}`);
  }
  steps.push(`exec node /opt/symphony/vm-agent.mjs`);
  return steps.join(' && ');
}

// Minimal POSIX-shell single-quoting. None of the paths we emit contain `'`, but be
// defensive in case a future binary name or path changes.
function shQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
