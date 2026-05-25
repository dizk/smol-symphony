// Pure string helper for deriving filename-safe identifiers used as workspace keys
// and runlog file stems. Lives in the foundation layer so adapters (runlog) and other
// domain modules (issues) can depend on it without crossing the adapters↛inward
// boundary that previously routed both through `src/workspace.ts`.
//
// SPEC §5.5 Invariant 3: only [A-Za-z0-9._-] survive; everything else collapses to `_`.

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}
