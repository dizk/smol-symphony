// PROTOTYPE: functional-core / imperative-shell enforcement.
//   shell files  -> complexity budgets (cap leaked logic; force decisions into the core)
//   core files   -> purity rules (no IO imports, no IO globals, no clock/random)
// Run: npx eslint src
import tsParser from '@typescript-eslint/parser';

const shell = [
  // application / wiring (the imperative shell proper)
  'src/orchestrator.ts', 'src/agent/runner.ts', 'src/reconciler/index.ts', 'src/agent/integration.ts',
  'src/actions/executor.ts', // run-side of planActions/runEffects split (issue 68)
  // adapters (IO wrappers — should stay thin too)
  'src/trackers/local.ts', 'src/agent/smolvm.ts', 'src/agent/adapters.ts', 'src/agent/acp.ts',
  'src/agent/tool-call-summary.ts', 'src/acp-bridge.ts', 'src/runlog.ts', 'src/memory.ts',
  'src/reconciler/bake.ts', 'src/workflow-loader.ts',
  // entry
  'src/http.ts', 'src/http-disk.ts', 'src/bin/symphony.ts',
];

const core = [
  'src/reconciler/pr.ts', 'src/reconciler/vm.ts', 'src/reconciler/workspace.ts',
  'src/reconciler/cache.ts',
  'src/actions/effects.ts', 'src/actions/predicates.ts', 'src/actions/templating.ts',
  'src/actions/parsing.ts', 'src/actions/cache.ts', 'src/actions/index.ts',
  'src/workflow.ts', 'src/issues.ts', 'src/prompt.ts', 'src/workspace.ts', 'src/mcp.ts',
  'src/http-handlers.ts',
];

export default [
  { ignores: ['dist/**', 'node_modules/**', 'tests/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tsParser, ecmaVersion: 2023, sourceType: 'module' },
  },
  // ---- imperative shell: stay thin ----
  {
    files: shell,
    rules: {
      complexity: ['warn', 10],
      'max-depth': ['warn', 4],
      'max-statements': ['warn', 20],
      'max-lines-per-function': ['warn', { max: 80, skipComments: true }],
      'max-nested-callbacks': ['warn', 4],
    },
  },
  // ---- functional core: stay pure ----
  {
    files: core,
    rules: {
      'no-restricted-globals': ['warn', { name: 'process', message: 'core must not read process/env; inject config' },
        { name: 'fetch', message: 'core must not do network IO; use an injected port' }],
      'no-restricted-imports': ['warn', { paths: [
          { name: 'node:fs', message: 'no fs in core' }, { name: 'node:fs/promises', message: 'no fs in core' },
          { name: 'node:child_process', message: 'no process spawning in core' },
          { name: 'node:net', message: 'no net in core' }, { name: 'node:http', message: 'no http in core' },
          { name: 'node:crypto', message: 'no crypto IO in core' }, { name: 'node:timers/promises', message: 'no timers in core' },
        ], patterns: [{ group: ['*/util/process*', '*/agent/smolvm*', '*/acp-bridge*', '*/trackers/local*'], message: 'core must not import an adapter; use an injected port' }] }],
      'no-restricted-syntax': ['warn',
        { selector: "NewExpression[callee.name='Date']", message: 'core must be deterministic; inject a clock (see pr.ts now())' },
        { selector: "MemberExpression[object.name='Date'][property.name='now']", message: 'inject a clock' },
        { selector: "MemberExpression[object.name='Math'][property.name='random']", message: 'core must be deterministic; inject randomness' },
      ],
    },
  },
];
