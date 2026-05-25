#!/usr/bin/env node
// Diff-size gate: keeps each PR (and thus each dispatched issue) small.
// Fails when a PR's net change exceeds the budget, unless overridden.
//   BASE_REF        base to diff against (default: origin/main)
//   MAX_DIFF_LINES  added+removed line budget (default: 400)
//   MAX_DIFF_FILES  changed-file budget (default: 12)
//   SIZE_OVERRIDE   "true" to bypass (wire to a `size:override` PR label in CI)
// Generated/vendored paths are excluded from the count.
import { execSync } from 'node:child_process';

const BASE = process.env.BASE_REF || 'origin/main';
const MAX_LINES = Number(process.env.MAX_DIFF_LINES || 400);
const MAX_FILES = Number(process.env.MAX_DIFF_FILES || 12);
const OVERRIDE = process.env.SIZE_OVERRIDE === 'true';
const EXCLUDE =
  /(^|\/)(package-lock\.json|dist\/|node_modules\/|\.dependency-cruiser-known-violations\.json)/;

let numstat;
try {
  numstat = execSync(`git diff --numstat ${BASE}...HEAD`, { encoding: 'utf8' });
} catch (err) {
  // Base not available locally (e.g. shallow checkout without the base ref).
  // Don't block — CI fetches the base; local pre-push just skips.
  console.log(`diff-size: base '${BASE}' not resolvable, skipping (${err.message.split('\n')[0]})`);
  process.exit(0);
}

let files = 0;
let lines = 0;
const detail = [];
for (const row of numstat.trim().split('\n').filter(Boolean)) {
  const [a, d, path] = row.split('\t');
  if (!path || EXCLUDE.test(path)) continue;
  const add = a === '-' ? 0 : Number(a);
  const del = d === '-' ? 0 : Number(d);
  files += 1;
  lines += add + del;
  detail.push([add + del, path]);
}

console.log(
  `diff-size: ${lines} changed lines across ${files} files (budget: ${MAX_LINES} lines / ${MAX_FILES} files, base ${BASE})`,
);
const over = files > MAX_FILES || lines > MAX_LINES;
if (over && !OVERRIDE) {
  console.error(
    `\n✖ PR exceeds the size budget. Split it (symphony.propose_issue for the remainder) ` +
      `or add the 'size:override' label for a justified large change.\nLargest files:`,
  );
  detail.sort((x, y) => y[0] - x[0]);
  for (const [n, p] of detail.slice(0, 15)) console.error(`   ${n}\t${p}`);
  process.exit(1);
}
if (over) console.log('(over budget, but SIZE_OVERRIDE set — allowing)');
console.log('✔ diff-size ok');
