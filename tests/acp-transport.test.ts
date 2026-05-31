import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTransportError } from '../src/agent/acp.js';

describe('isTransportError', () => {
  it('classifies the issue-135 ECONNRESET message as transport, not refusal', () => {
    // Verbatim from .symphony/logs/135.jsonl — the message that was mislabelled
    // "agent turn refusal" and looped the issue.
    assert.equal(
      isTransportError('Internal error: API Error: Unable to connect to API (ECONNRESET)'),
      true,
    );
  });

  it('matches the common connection-fault families', () => {
    for (const m of [
      'read ECONNRESET',
      'connect ETIMEDOUT 1.2.3.4:443',
      'connect ECONNREFUSED',
      'write EPIPE',
      'socket hang up',
      'fetch failed',
      'other side closed',
      'terminated',
    ]) {
      assert.equal(isTransportError(m), true, `expected transport: ${m}`);
    }
  });

  it('does NOT classify a genuine auth failure or model refusal as transport', () => {
    // A 401 is an auth fault, not a connection reset — it must stay a non-transport
    // outcome so the two are distinguishable in the run log (the breaker now counts
    // both as consecutive failures regardless, so this is purely about honest labels).
    assert.equal(
      isTransportError('Failed to authenticate. API Error: 401 Invalid authentication credentials'),
      false,
    );
    assert.equal(isTransportError('the model declined to answer'), false);
    assert.equal(isTransportError('max output tokens reached'), false);
  });
});
