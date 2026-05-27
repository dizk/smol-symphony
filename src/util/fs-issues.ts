// Tiny fs port for issue-file IO. Lives outside the functional-core lint
// group (see eslint.config.js) so core modules can take an injected `IssueFs`
// instead of importing `node:fs/promises` directly. Production defaults flow
// through `realIssueFs`; tests pin behavior by passing a stub. Mirrors the
// clock seam in `src/util/clock.ts`.

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';

/**
 * Minimal fs surface used by `src/issues.ts`. The shape matches the subset of
 * `node:fs/promises` actually called (mkdir/readdir/stat/writeFile) so the
 * core module never touches the node module directly. `stat` returns just
 * enough for the directory check; ENOENT detection still works via the
 * `(err as NodeJS.ErrnoException).code` check on the caller side.
 */
export interface IssueFs {
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
}

/** Production default: `node:fs/promises`-backed. Adapter-layer, by design. */
export const realIssueFs: IssueFs = {
  async mkdir(p, opts) {
    await mkdir(p, opts);
  },
  readdir(p) {
    return readdir(p);
  },
  stat(p) {
    return stat(p);
  },
  async writeFile(p, data, encoding) {
    await writeFile(p, data, encoding);
  },
};
