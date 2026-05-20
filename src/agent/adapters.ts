// Registry of ACP adapters symphony knows how to launch end-to-end.
//
// Each profile encodes everything symphony needs to ship a working adapter into the
// per-issue smolvm without per-workflow bash boilerplate:
//
//   - hostCredentialPath : the file on the host (relative to $HOME) that authenticates
//                          the adapter. Symphony reads this and stages it into the
//                          workspace before VM boot.
//   - guestCredentialPath: the absolute path inside the VM where the adapter expects
//                          to find that file. Symphony's auto-generated acp launch
//                          command copies the staged file here at startup.
//   - binary             : the executable inside the VM that speaks ACP.
//
// To add a new adapter (e.g. opencode), populate the profile and add it to ADAPTERS.
// Unprofiled adapters are not supported at runtime — symphony always auto-stages the
// host credential and execs the in-VM proxy.
//
// IMPORTANT: every host path here is treated as private. Symphony reads the file,
// stages a copy into the workspace, and chmods the copy to 0600. The original host
// file is never exposed via a bind mount.

import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir, chmod, lstat, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type AcpAdapterId = 'claude' | 'codex';

/**
 * How a chosen `acp.model` is surfaced to a specific adapter. Either an env var, extra
 * argv passed to the adapter binary, or both. Adapters that take the model through a
 * non-CLI/non-env channel (a config file, a session-init RPC) would need their own
 * branch in the runner; that's why this returns a structured value rather than baking
 * the mechanism into the registry.
 */
export interface ModelInjection {
  env?: Record<string, string>;
  extraArgs?: string[];
}

/**
 * Same shape as ModelInjection but for the reasoning-effort selector. Surfaced
 * separately because not every adapter exposes one (claude has no equivalent today)
 * and because effort + model are independent knobs the runner merges into a single
 * launch shape.
 */
export interface EffortInjection {
  env?: Record<string, string>;
  extraArgs?: string[];
}

export interface AdapterProfile {
  id: AcpAdapterId;
  /** Path under $HOME on the host where the credential file lives. */
  hostCredentialPath: string;
  /** Absolute path inside the VM where the adapter expects to find the credential. */
  guestCredentialPath: string;
  /**
   * ACP adapter launch command, split into argv. Each token is shell-quoted before
   * being emitted into the `bash -lc` string, so future profiles with multi-token
   * commands (e.g. `['opencode', 'acp']`) compose without shell-injection risk.
   */
  binary: readonly string[];
  /**
   * Map an `acp.model` string into the env vars / extra argv this adapter needs to
   * actually select the model. Called only when `acp.model` is non-null; profiles can
   * assume a non-empty string. Return shape lets new adapters pick whatever mechanism
   * they natively support (e.g. opencode could pass `--model` here).
   */
  modelInjection(model: string): ModelInjection;
  /**
   * Map an `acp.effort` string into env / extra argv. Called only when effort is
   * non-null. Adapters with no reasoning-effort knob return an empty object; the
   * runner then contributes nothing extra to the launch. codex-acp emits
   * `-c model_reasoning_effort="<value>"`; claude-agent-acp has no equivalent today.
   */
  effortInjection(effort: string): EffortInjection;
}

export const ADAPTERS: Record<AcpAdapterId, AdapterProfile> = {
  claude: {
    id: 'claude',
    hostCredentialPath: '.claude/.credentials.json',
    guestCredentialPath: '/root/.claude/.credentials.json',
    binary: ['claude-agent-acp'],
    // claude-agent-acp reads ANTHROPIC_MODEL on startup (see acp-agent.js getAvailableModels:
    // ANTHROPIC_MODEL > settings.model > default). The adapter resolves aliases like
    // "opus" or "claude-sonnet-4-5" against the SDK's model list, so anything the user
    // would type into Claude Code works here.
    modelInjection: (model) => ({ env: { ANTHROPIC_MODEL: model } }),
    // claude-agent-acp has no reasoning-effort knob today. Accept the field for
    // schema symmetry but contribute nothing to the launch.
    effortInjection: () => ({}),
  },
  codex: {
    id: 'codex',
    hostCredentialPath: '.codex/auth.json',
    guestCredentialPath: '/root/.codex/auth.json',
    binary: ['codex-acp'],
    // codex-acp takes config overrides via `-c key=value` where value is parsed as TOML
    // (raw-string fallback on parse failure). We always emit a quoted TOML string so
    // model names containing dots or hyphens don't surprise the TOML parser.
    modelInjection: (model) => ({ extraArgs: ['-c', `model=${JSON.stringify(model)}`] }),
    // codex's reasoning effort is set via the same `-c key=value` mechanism. Accepted
    // values include `minimal | low | medium | high | xhigh` (confirmed against the
    // codex Rust binary). JSON.stringify guards against future enum values containing
    // characters TOML's bare-key parser would choke on.
    effortInjection: (effort) => ({
      extraArgs: ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`],
    }),
  },
};

export function isKnownAdapter(id: string): id is AcpAdapterId {
  return id === 'claude' || id === 'codex';
}

export function profileFor(id: AcpAdapterId): AdapterProfile {
  return ADAPTERS[id];
}

/** Absolute path on the host where the adapter's credential file lives. */
export function hostCredentialAbsPath(profile: AdapterProfile): string {
  return path.join(os.homedir(), profile.hostCredentialPath);
}

/**
 * Compute where in the workspace symphony will stage the adapter's credential.
 *
 * Strategy by workspace shape (resolved at stage time, not by this helper):
 *   - `.git/` is a directory  → `<ws>/.git/symphony-runtime/credentials/<id>`
 *     Files under `.git/` are git's private area; `git add`/`git status` never
 *     recurse into it, so even an agent that runs `git add -A` cannot commit
 *     the credential. No `info/exclude` games needed.
 *   - `.git` does not exist   → `<ws>/.symphony-runtime/credentials/<id>`
 *     There's no git in this workspace, so no commit/add semantics to worry
 *     about. Falls back to a workspace-root path.
 *   - `.git` is a file (linked worktree) → refused at stage time. The
 *     per-worktree gitdir lives outside the workspace mount, so symphony
 *     cannot place the credential where the in-VM agent can see it without
 *     re-introducing the working-tree-leak risk. Linked worktrees are
 *     unsupported under the TCP bridge transport; use a non-linked workspace
 *     clone or fork scripts/vm-agent.js.
 *
 * Returned path is relative to `workspacePath` and slash-joined (POSIX) so it
 * works as-is in the in-VM acp launch command, regardless of host OS path
 * separator.
 */
export interface StagedCredentialPaths {
  /** Absolute path on the host (where stageCredential actually writes). */
  absPath: string;
  /** POSIX path relative to workspacePath (used in the in-VM launch command). */
  relPath: string;
}

/** Verify the host credential file exists and is readable. Used at startup validation. */
export async function assertHostCredentialReadable(profile: AdapterProfile): Promise<void> {
  const p = hostCredentialAbsPath(profile);
  try {
    await access(p, fsConstants.R_OK);
  } catch (err) {
    throw new Error(
      `adapter "${profile.id}" requires a host credential at ${p}, but it is missing or unreadable: ${
        (err as Error).message
      }`,
    );
  }
}

/**
 * Copy the host's credential file into the workspace's runtime staging area, chmod 600.
 * Re-runs every attempt so a host-side token rotation is picked up automatically.
 *
 * Defense layers, in order:
 *   1. `resolveStagingLocation` picks a path OUTSIDE the working tree when git is
 *      present (`.git/symphony-runtime/...`) so `git add -A`, a tracked file at
 *      `.symphony-runtime/`, or a `.gitignore` negation cannot expose the secret.
 *      Linked worktrees are refused (see resolveStagingLocation comment).
 *   2. `ensureRealDir` walks each parent we materialize and refuses if any exists
 *      as a symlink or non-directory.
 *   3. `rm + copyFile(COPYFILE_EXCL)` closes the local race on the leaf path:
 *      after explicit cleanup, the create is strict and fails if anything raced
 *      back in.
 *   4. Post-write `realpath` check confirms the file landed at the expected
 *      absolute path. On mismatch (a parent was swapped for a symlink between
 *      ensureRealDir and copyFile), we unlink the staging path itself — which
 *      removes a symlink without following it — and refuse. We deliberately do
 *      NOT touch whatever the symlink resolved to, since that file is by
 *      definition attacker-chosen.
 */
export async function stageCredential(
  workspacePath: string,
  profile: AdapterProfile,
): Promise<StagedCredentialPaths> {
  const src = hostCredentialAbsPath(profile);
  const { stagingRootAbs, stagingRootRel } = await resolveStagingLocation(workspacePath);
  const credsDir = path.join(stagingRootAbs, 'credentials');
  await ensureRealDir(stagingRootAbs);
  await ensureRealDir(credsDir);

  const dst = path.join(credsDir, profile.id);
  await rm(dst, { force: true, recursive: false });
  await copyFile(src, dst, fsConstants.COPYFILE_EXCL);
  await chmod(dst, 0o600);

  const expectedReal = path.join(
    await realpath(workspacePath),
    stagingRootRel,
    'credentials',
    profile.id,
  );
  const actualReal = await realpath(dst);
  if (actualReal !== expectedReal) {
    // Unlinking dst removes the symlink itself (does not follow). Leaked
    // credential at actualReal is left in place because we cannot prove
    // ownership; operator must inspect.
    await rm(dst, { force: true }).catch(() => undefined);
    throw new Error(
      `staging path redirected: wrote to ${actualReal}, expected ${expectedReal}. ` +
        `A symlink raced in during staging; manually inspect and remove any leaked ` +
        `credential at the actual path before retrying.`,
    );
  }

  const relPath = path.posix.join(stagingRootRel, 'credentials', profile.id);
  return { absPath: dst, relPath };
}

/**
 * Decide where to stage credentials based on workspace shape. See StagedCredentialPaths
 * for the policy. Returns absolute + relative (POSIX, relative to workspacePath)
 * paths to the staging root directory; the caller composes `credentials/<id>` under it.
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
      // process with the host filesystem visible) would then stage the
      // credential in the parent's index. Detect that and refuse.
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
          `cannot auto-stage credentials: workspace ${workspacePath} could not be resolved ` +
            `(realpath failed: ${(resolveErr as Error).message}). Refusing to stage without a ` +
            `canonical path; fix the workspace.`,
        );
      }
      const ancestor = await findAncestorGit(resolvedWorkspace);
      if (ancestor !== null) {
        throw new Error(
          `cannot auto-stage credentials: workspace ${workspacePath} has no .git of its own ` +
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
    // Git never recurses into `.git/` for `add`/`status`, so the credential is
    // structurally untrackable — no `info/exclude` games needed, and a tracked
    // `.symphony-runtime/credentials/<id>` at workspace root cannot interfere.
    return {
      stagingRootAbs: path.join(workspacePath, '.git', 'symphony-runtime'),
      stagingRootRel: path.posix.join('.git', 'symphony-runtime'),
    };
  }
  if (gitSt.isFile()) {
    // Linked worktree: .git is a pointer file at /<worktree>/.git -> per-worktree
    // gitdir (typically /<main>/.git/worktrees/<name>/). The per-worktree gitdir
    // lives outside the workspace mount, so symphony cannot place the credential
    // there and still have the in-VM agent reach it. Any worktree-internal path
    // is inside the working tree, where `.gitignore` negation or a tracked file
    // could still expose the secret to `git add -A`. Linked worktrees are
    // currently unsupported — use a non-linked workspace clone (e.g.
    // `git clone --local`) or fork scripts/vm-agent.js to stage credentials in
    // whatever shape your worktree layout needs.
    throw new Error(
      `cannot auto-stage credentials in a linked worktree (.git at ${gitPath} is a file). ` +
        `Linked worktrees are unsupported under the ACP TCP bridge transport; use a ` +
        `non-linked workspace clone or fork scripts/vm-agent.js.`,
    );
  }
  throw new Error(
    `cannot auto-stage credentials: ${gitPath} is neither a directory nor a file ` +
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
 * Build the bash command symphony will exec inside the VM. Wipes the adapter's state
 * directory, re-creates it, copies the staged credential (`stagedRelPath`, a POSIX path
 * relative to the in-VM cwd which equals the workspace mount) into place, chmods it, and
 * execs the in-VM proxy at `/opt/symphony/vm-agent.mjs`. The proxy reads its config —
 * SYMPHONY_ACP_URL, SYMPHONY_ACP_TOKEN, SYMPHONY_ADAPTER_BIN, SYMPHONY_ADAPTER_ARGS —
 * from the environment that symphony sets on the `smolvm exec` invocation, dials the
 * host's TCP ACP bridge, and spawns the adapter with kernel pipes.
 *
 * Why TCP through a proxy: smolvm-exec's stdin pump does not reliably wake the in-VM
 * reader for kernel events unless host stdin keeps writing. Piping ACP frames through
 * smolvm-exec stdio caused the adapter to hang after the first session/update. The TCP
 * bridge (see src/acp-bridge.ts) bypasses that pump entirely and decouples symphony from
 * any specific sandbox tech — any sandbox that can launch a process with env vars and
 * reach the host loopback can run this stack unchanged.
 *
 * Wiping `guestDir` (e.g. `/root/.claude` or `/root/.codex`) on every exec is defense in
 * depth: the per-issue VM is destroyed after each attempt already, but a freshly-baked
 * image may carry state from build verification steps (e.g. `claude --version` writes
 * settings to /root/.claude). The scrub guarantees a clean slate. The VM's workspace
 * mount is separate from `guestDir`, so this scrub never touches operator data.
 *
 * Every interpolated path is run through shQuote so future profiles with spaces or
 * metacharacters compose safely. `stagedRelPath` comes from `stageCredential`, which
 * picks a path outside the working tree when git is present.
 */
export function deriveAcpCommand(profile: AdapterProfile, stagedRelPath: string): string {
  if (profile.binary.length === 0) {
    throw new Error(`adapter "${profile.id}" has an empty binary launch vector`);
  }
  const guestDir = path.posix.dirname(profile.guestCredentialPath);
  const guestPath = profile.guestCredentialPath;
  return [
    `rm -rf ${shQuote(guestDir)}`,
    `mkdir -p ${shQuote(guestDir)}`,
    `cp ${shQuote(stagedRelPath)} ${shQuote(guestPath)}`,
    `chmod 600 ${shQuote(guestPath)}`,
    `exec node /opt/symphony/vm-agent.mjs`,
  ].join(' && ');
}

// Minimal POSIX-shell single-quoting. None of the paths we emit contain `'`, but be
// defensive in case a future binary name or path changes.
function shQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
