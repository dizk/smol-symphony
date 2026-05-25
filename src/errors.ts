// Foundation-layer error types shared across workflow config parsing.
//
// Lives here (not in workflow.ts) so config-layer modules like
// actions/parsing.ts can throw the same error type without importing the
// workflow module — which would create a config ⇄ config cycle and pull the
// full workflow loader into the parser's dependency graph.

export class WorkflowError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}
