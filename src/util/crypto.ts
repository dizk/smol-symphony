// Crypto helpers for McpRegistry; lives outside core so mcp.ts can stay pure
// (mirrors util/clock.ts for the wall clock).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

// UTF-8 length check before timingSafeEqual: a non-ASCII attacker token can match
// the real token's JS `.length` while encoding to a different byte length, which
// would otherwise throw inside timingSafeEqual.
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
