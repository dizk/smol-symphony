// Shared shell-out IO/capture shapes for the run log. Lives in the foundation
// layer so domain modules (e.g. actions/executor) and the workspace adapter
// share a single shape without crossing the adapters↛inward boundary. The
// `Hook*` names are a holdover from the retired workflow-hook surface; today
// the only consumers are the typed `actions:` executor and the per-issue run
// log (whose `channel: "hook"` stream carries action stdout/stderr).

import type { RunResult, RunCapture } from './util/process.js';

// Result of a captured shell-out. Aliased to the unified RunResult since the
// actions executor and every other shell-out share the same shape.
export type HookResult = RunResult;

// Optional streaming capture. `onChunk` fires for every stdout/stderr burst the
// command produces; `onResult` fires once with the final outcome. The runner
// uses this to mirror typed-action output into the per-issue JSONL run log in
// real time. The buffered stdout/stderr in HookResult is preserved for callers
// that don't care.
export type HookCapture = RunCapture;
