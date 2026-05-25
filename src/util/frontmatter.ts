// Single source of truth for YAML front-matter parsing across the orchestrator.
//
// Replaces four divergent copies that previously lived in workflow.ts,
// trackers/local.ts, http.ts (two copies — full parser + regex fast path), and
// agent/runner.ts. Edge cases like CRLF, indented `---` inside multiline YAML
// hook scripts, and quoted/multiline values now live in one place.

import { parse as parseYaml } from 'yaml';

export interface FrontMatter {
  // Decoded front-matter map. Empty when the file has no front matter.
  fields: Record<string, unknown>;
  // Trimmed body after the closing fence — or the whole file when there's no
  // fence (or when lenient parsing falls back from a malformed fence).
  body: string;
  // True when a valid `---` … `---` block was decoded. Distinguishes "no
  // front matter" from "empty front matter".
  hadFence: boolean;
}

export type FrontMatterErrorCode = 'unterminated' | 'invalid_yaml' | 'not_a_map';

export class FrontMatterError extends Error {
  constructor(public code: FrontMatterErrorCode, message: string) {
    super(message);
    this.name = 'FrontMatterError';
  }
}

// First and closing fences must be exactly `---` (with optional trailing
// whitespace), unindented. Otherwise an indented `---` inside a multiline YAML
// hook script would be mistaken for the closing fence.
function isFence(line: string | undefined): boolean {
  return /^---\s*$/.test(line ?? '');
}

// Parses YAML front matter or throws FrontMatterError. Use when the caller
// wants to reject malformed input — workflow loader, tracker reader.
export function parseFrontMatter(text: string): FrontMatter {
  if (!text.startsWith('---')) {
    return { fields: {}, body: text.trim(), hadFence: false };
  }
  const lines = text.split(/\r?\n/);
  if (!isFence(lines[0])) {
    return { fields: {}, body: text.trim(), hadFence: false };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isFence(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) {
    throw new FrontMatterError('unterminated', 'unterminated YAML front matter');
  }
  const fmText = lines.slice(1, endIdx).join('\n');
  const body = lines.slice(endIdx + 1).join('\n').trim();
  let parsed: unknown;
  try {
    parsed = fmText.trim().length === 0 ? {} : parseYaml(fmText);
  } catch (err) {
    throw new FrontMatterError('invalid_yaml', `invalid YAML front matter: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FrontMatterError('not_a_map', 'YAML front matter must decode to a map');
  }
  return { fields: parsed as Record<string, unknown>, body, hadFence: true };
}

// Same as parseFrontMatter but never throws. Malformed input degrades to
// `{ fields: {}, body: text.trim(), hadFence: false }` so callers that only
// need the body (HTTP detail page, PR-body builder) still render something
// sensible for hand-edited files.
export function parseFrontMatterLenient(text: string): FrontMatter {
  try {
    return parseFrontMatter(text);
  } catch {
    return { fields: {}, body: text.trim(), hadFence: false };
  }
}
