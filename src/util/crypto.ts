// Crypto port + production adapter (issue 96). `McpRegistry` reaches
// `randomBytes` / `timingSafeEqual` through this seam so its core stays free
// of `node:crypto` and `node:buffer` direct imports; tests pin a
// deterministic `CryptoEnv` to assert against fixed token values.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

/**
 * Crypto operations the MCP registry needs. `newToken` returns a fresh
 * per-dispatch bearer token; `constantTimeEqual` is the wrong-token check
 * that has to compare equal-length buffers in constant time so a timing
 * sidechannel can't leak the secret prefix.
 */
export interface CryptoEnv {
  /** Fresh bearer token. Production: 24 random bytes, base64url-encoded. */
  newToken(): string;
  /**
   * Constant-time equality between two UTF-8 strings. Returns false for
   * mismatched byte lengths up front; equal-length pairs go through
   * `timingSafeEqual` so per-byte timing doesn't leak the matching prefix.
   */
  constantTimeEqual(a: string, b: string): boolean;
}

/**
 * Production adapter. We compare BYTE lengths after UTF-8 encoding, not JS
 * string `.length` (which counts UTF-16 code units). An attacker-supplied
 * non-ASCII token can match the real token's code-unit count while encoding
 * to a different byte length; passing those buffers to `timingSafeEqual`
 * would throw `Input buffers must have the same byte length`, surfacing as
 * an HTTP 500 instead of a clean wrong-token rejection.
 */
export const realCrypto: CryptoEnv = {
  newToken: () => randomBytes(24).toString('base64url'),
  constantTimeEqual: (a, b) => {
    const aBuf = Buffer.from(a, 'utf8');
    const bBuf = Buffer.from(b, 'utf8');
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
  },
};
