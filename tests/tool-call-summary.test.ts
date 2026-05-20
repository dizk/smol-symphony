// Tests for the tool-call summarizers used by the AcpClient session update handlers.
//
// The dashboard's session row shows `last_message`, which for tool calls is whatever
// these helpers return. Previously it was raw JSON of the entire update object — see
// the json-tool-calls-in-ui issue for the example we are replacing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeToolCall,
  summarizeToolCallUpdate,
} from '../src/agent/tool-call-summary.js';

describe('summarizeToolCall', () => {
  it('uses the ACP-provided title when present', () => {
    const line = summarizeToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Read package.json',
      kind: 'read',
    });
    assert.equal(line, 'Read package.json');
  });

  it('falls back to claudeCode._meta.toolName when title is missing', () => {
    const line = summarizeToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-2',
      _meta: { claudeCode: { toolName: 'Bash' } },
    });
    assert.equal(line, 'Bash');
  });

  it('falls back to kind, then toolCallId, then "tool"', () => {
    assert.equal(
      summarizeToolCall({ sessionUpdate: 'tool_call', toolCallId: 'tc-3', kind: 'execute' }),
      'execute',
    );
    assert.equal(
      summarizeToolCall({ sessionUpdate: 'tool_call', toolCallId: 'tc-4' }),
      'tc-4',
    );
    assert.equal(summarizeToolCall({ sessionUpdate: 'tool_call' }), 'tool');
  });

  it('appends a single location hint to the tool name', () => {
    const line = summarizeToolCall({
      sessionUpdate: 'tool_call',
      title: 'Edit',
      locations: [{ path: 'src/app.ts', line: 12 }],
    });
    assert.equal(line, 'Edit (src/app.ts)');
  });

  it('annotates multiple locations with a count suffix', () => {
    const line = summarizeToolCall({
      sessionUpdate: 'tool_call',
      title: 'Edit',
      locations: [
        { path: 'a.ts' },
        { path: 'b.ts' },
        { path: 'c.ts' },
      ],
    });
    assert.equal(line, 'Edit (a.ts +2)');
  });

  it('tolerates malformed input without throwing', () => {
    assert.equal(summarizeToolCall(null), 'tool');
    assert.equal(summarizeToolCall(undefined), 'tool');
    assert.equal(summarizeToolCall('not an object'), 'tool');
  });
});

describe('summarizeToolCallUpdate', () => {
  it('renders the regression case from the issue as a readable line', () => {
    // The exact shape from the issue description.
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      _meta: { claudeCode: { toolName: 'Bash' } },
      content: [
        {
          type: 'content',
          content: { type: 'text', text: '```console\nDone\nIn Progress\nTodo\n```' },
        },
      ],
    };
    const line = summarizeToolCallUpdate(update);
    // The status, tool name, and a collapsed snippet of the result text should all be
    // present; the raw JSON braces of the previous implementation must not appear.
    assert.match(line, /Bash/);
    assert.match(line, /completed/);
    assert.match(line, /Done In Progress Todo/);
    assert.ok(!line.includes('{"'), `unexpected JSON in line: ${line}`);
  });

  it('puts the tool name before the status', () => {
    const line = summarizeToolCallUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-2',
      title: 'Read foo.ts',
      status: 'in_progress',
    });
    assert.equal(line, 'Read foo.ts in_progress');
  });

  it('renders without a snippet when content is empty', () => {
    const line = summarizeToolCallUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-3',
      status: 'completed',
      _meta: { claudeCode: { toolName: 'Bash' } },
    });
    assert.equal(line, 'Bash completed');
  });

  it('truncates very long snippets', () => {
    const longText = 'x'.repeat(500);
    const line = summarizeToolCallUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-4',
      title: 'Bash',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: longText } }],
    });
    assert.ok(line.length <= 140, `line too long: ${line.length}`);
    assert.ok(line.endsWith('…'), `expected ellipsis truncation, got: ${line}`);
  });

  it('skips diff and terminal content blocks for the snippet but still labels the call', () => {
    const line = summarizeToolCallUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-5',
      title: 'Edit',
      status: 'completed',
      content: [
        { type: 'diff', oldText: 'a', newText: 'b', path: 'x.ts' },
        { type: 'terminal', terminalId: 't1' },
      ],
    });
    assert.equal(line, 'Edit completed');
  });

  it('falls back to a stable label when nothing is present', () => {
    assert.equal(
      summarizeToolCallUpdate({ sessionUpdate: 'tool_call_update' }),
      'tool_call_update',
    );
  });
});
