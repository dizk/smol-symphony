// Production-side adapter for `PredicateEnv` (issue 96). Backs
// `branchExists` with `git rev-parse --verify --quiet` (via the unified
// `runProcess`) and `pathExists` with `fs.stat`. Lives outside the
// functional-core lint group so `src/actions/predicates.ts` can stay free of
// `node:fs/promises` and `runProcess` direct imports; the runner threads
// `defaultPredicateEnv` into the executor.

import { stat } from 'node:fs/promises';
import { runProcess } from '../util/process.js';
import type { PredicateEnv } from './types.js';

export const defaultPredicateEnv: PredicateEnv = {
  async branchExists(ref, workspacePath) {
    // `--verify --quiet` keeps both streams empty on the happy path; the
    // tiny default byte clamp is plenty and `appendErrorToStderr: false`
    // skips stderr decoration for the missing-ref case (the common one).
    const r = await runProcess(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`],
      { cwd: workspacePath, appendErrorToStderr: false },
    );
    return r.exit_code === 0;
  },
  async pathExists(absPath) {
    try {
      const st = await stat(absPath);
      return st.isFile() || st.isDirectory();
    } catch {
      return false;
    }
  },
};
