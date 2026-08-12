// Workflow editor — barrel re-export.
//
// The router imports `WorkflowEditorPage` from `./Workflows` for
// backwards compatibility — `Workflows.tsx` re-exports this module's
// component. New code may import directly from `./workflow-editor`.

export { WorkflowEditorPage } from "./WorkflowEditorPage";
