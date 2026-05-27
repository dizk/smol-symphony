// Hook-shaped IO result types. Lives in the foundation layer so domain modules
// (e.g. actions/executor) and the workspace adapter share a single shape without
// crossing the adapters↛inward boundary.

import type { RunResult, RunCapture } from './util/process.js';

// Hook-shaped result. Aliased to the unified RunResult since hook callers and
// every other shell-out share the same shape; the `ran: false` convention
// (no hook configured) is encoded by the caller returning `null` rather than
// by a field on this type.
export type HookResult = RunResult;

// Optional streaming capture for hook execution. `onChunk` fires for every stdout/stderr
// burst the hook produces; `onResult` fires once with the final outcome. The orchestrator
// uses this to mirror hook output into the per-issue JSONL run log in real time. The
// existing buffered stdout/stderr in HookResult is preserved for callers that don't care.
export type HookCapture = RunCapture;
