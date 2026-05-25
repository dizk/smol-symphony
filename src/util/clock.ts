// Wall-clock helpers. Lives outside the functional-core lint group (see
// eslint.config.js) so core modules can import these instead of touching
// `Date.now()` / `new Date()` directly. Production defaults flow through
// `realClock` / `isoFromClock`; tests pin time by passing a stub `now()` to
// whatever core resource exposes the injection seam.

/** A monotonic-ish ms reading. `Date.now()` is the production default. */
export type ClockNow = () => number;

/** Production default: real wall clock. Adapter-layer, by design. */
export const realClock: ClockNow = () => Date.now();

/** Format an injected clock's reading as an ISO 8601 string. */
export function isoFromClock(now: ClockNow): string {
  return new Date(now()).toISOString();
}
