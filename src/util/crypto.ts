// Crypto helpers used by McpRegistry. Lives outside the functional-core lint
// group so `mcp.ts` can stay in `core` without touching `node:crypto` directly
// — same pattern as `util/clock.ts` for the wall clock.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

/** Fresh base64url bearer token (24 bytes of entropy). */
export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Constant-time string compare. UTF-8 encodes both sides and rejects mismatched
 * byte lengths before `timingSafeEqual` (which throws on length mismatch). A
 * non-ASCII attacker token can match a real token's JS-string `.length` while
 * encoding to a different byte length, so the length check is required.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
