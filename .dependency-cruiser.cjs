// Hexagonal / ports-and-adapters rule for smol-symphony.
// Run: npx depcruise src --ts-config tsconfig.json --output-type err
//
// Roles (by path):
//   foundation  pure types + generic utils everything may import
//   config      workflow parsing/validation
//   domain      core reconciler/action logic — talks to infra ONLY through injected ports
//   adapters    concrete infra (gh, git, smolvm, tracker, acp, logs) implementing ports
//   application composition root: wires adapters into domain
//   entry       process entrypoints + dashboard
//
// Invariant: dependencies point inward. domain must NOT import adapters/application/entry;
// adapters must NOT import domain/application/entry; only application may import adapters.
const foundation  = 'src/(types|logging|errors|workspace-types)\.ts$|src/util/[^/]+\.ts$|src/(actions|reconciler|trackers)/types\.ts$|src/reconciler/(cache|bake-plan|pr-decide)\.ts$';
const config      = 'src/workflow\.ts$|src/actions/parsing\.ts$';
const domain      = 'src/reconciler/(vm|workspace|pr)\.ts$|src/actions/(executor|predicates|templating|cache|index)\.ts$|src/(mcp|issues|prompt)\.ts$';
const adapters    = 'src/trackers/local\.ts$|src/agent/(smolvm|adapters|acp|tool-call-summary)\.ts$|src/(acp-bridge|runlog|memory|workspace)\.ts$|src/reconciler/bake\.ts$';
const application = 'src/orchestrator\\.ts$|src/reconciler/index\\.ts$|src/agent/(runner|integration)\\.ts$';
const entry       = 'src/(http|http-handlers|http-disk)\\.ts$|src/bin/symphony\\.ts$';
const any = (...xs) => xs.join('|');

module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', comment: 'no import cycles',
      from: {}, to: { circular: true } },
    { name: 'domain↛adapters', severity: 'error',
      comment: 'CORE: domain must reach infra only through injected ports, never import a concrete adapter',
      from: { path: domain }, to: { path: adapters } },
    { name: 'domain↛app/entry', severity: 'error',
      comment: 'domain may not depend on its wiring or entrypoints',
      from: { path: domain }, to: { path: any(application, entry) } },
    { name: 'adapters↛inward', severity: 'error',
      comment: 'adapters implement ports; they must not import domain/application/entry',
      from: { path: adapters }, to: { path: any(domain, application, entry) } },
    { name: 'config↛up', severity: 'error',
      from: { path: config }, to: { path: any(domain, adapters, application, entry) } },
    { name: 'foundation↛up', severity: 'error',
      from: { path: foundation }, to: { path: any(config, domain, adapters, application, entry) } },
    { name: 'application↛entry', severity: 'error',
      from: { path: application }, to: { path: entry } },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
  },
};
