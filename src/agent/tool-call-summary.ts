// Human-readable summaries for ACP tool_call / tool_call_update notifications.
//
// ACP's `sessionUpdate` notifications for `tool_call` and `tool_call_update` carry a
// structured object that includes the tool's human-readable `title`, a `kind`, a
// `status`, a `content` array of result blocks, optional `locations`, and an
// adapter-specific `_meta` (Claude Code stamps `_meta.claudeCode.toolName`). The
// previous implementation rendered these by JSON-stringifying the whole object, so
// the dashboard's session row showed lines like:
//
//   completed: {"_meta":{"claudeCode":{"toolName":"Bash"}},"content":[{"content": …
//
// That's the issue this module fixes. The functions below pick out the useful fields
// and assemble a short line — e.g. "Bash completed — Done In Progress Todo" — so the
// operator can see at a glance what the agent just did.

const MAX_LINE_LEN = 140;
const MAX_SNIPPET_LEN = 80;

type UnknownRecord = Record<string, unknown>;

function isPlainObject(v: unknown): v is UnknownRecord {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function readClaudeToolName(update: UnknownRecord): string {
  const meta = update._meta;
  if (!isPlainObject(meta)) return '';
  const claudeCode = meta.claudeCode;
  if (!isPlainObject(claudeCode)) return '';
  const name = claudeCode.toolName;
  return typeof name === 'string' ? name : '';
}

// Walk the content array and return the first text snippet, whitespace-collapsed.
// ToolCallContent has three shapes: { type: "content", content: <ContentBlock> },
// { type: "diff", ... }, { type: "terminal", ... }. We surface text from the
// "content" variant; diff/terminal fall through and the caller renders without a
// snippet.
function firstTextSnippet(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const item of content) {
    if (!isPlainObject(item)) continue;
    const inner = item.type === 'content' && isPlainObject(item.content) ? item.content : item;
    if (!isPlainObject(inner)) continue;
    if (inner.type === 'text' && typeof inner.text === 'string') {
      const text = collapseWhitespace(inner.text);
      if (text) return text;
    }
  }
  return '';
}

function readLocationHint(update: UnknownRecord): string {
  const locs = update.locations;
  if (!Array.isArray(locs) || locs.length === 0) return '';
  const first = locs[0];
  if (!isPlainObject(first) || typeof first.path !== 'string') return '';
  const more = locs.length - 1;
  return more > 0 ? `${first.path} +${more}` : first.path;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + '…';
}

function toolName(update: UnknownRecord): string {
  const title = typeof update.title === 'string' ? update.title.trim() : '';
  if (title) return title;
  const claudeName = readClaudeToolName(update);
  if (claudeName) return claudeName;
  const kind = typeof update.kind === 'string' ? update.kind : '';
  if (kind) return kind;
  const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';
  return id;
}

/** Format an ACP `tool_call` session update for the session row / event log. */
export function summarizeToolCall(update: unknown): string {
  const obj = isPlainObject(update) ? update : {};
  const name = toolName(obj) || 'tool';
  const location = readLocationHint(obj);
  const head = location ? `${name} (${location})` : name;
  return clip(head, MAX_LINE_LEN);
}

/** Format an ACP `tool_call_update` session update for the session row / event log. */
export function summarizeToolCallUpdate(update: unknown): string {
  const obj = isPlainObject(update) ? update : {};
  const status = typeof obj.status === 'string' ? obj.status : '';
  const name = toolName(obj);
  const head = [name, status].filter((s) => s.length > 0).join(' ');
  const snippet = clip(firstTextSnippet(obj.content), MAX_SNIPPET_LEN);
  const base = head || 'tool_call_update';
  const line = snippet ? `${base} — ${snippet}` : base;
  return clip(line, MAX_LINE_LEN);
}
