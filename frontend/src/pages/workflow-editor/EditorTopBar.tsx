// EditorTopBar — the top chrome of the workflow editor.
//
// + Add Node (popup), workflow breadcrumb, name + description inline
// editing, Active/Paused toggle, Save (dirty-aware), Execute (busy-aware).
// Lifted out of Workflows.tsx so the editor page can compose it cleanly.

import { Button } from "../../components/ui/Button";
import { PlayIcon, PlusIcon, SaveIcon } from "../../components/ui/Icon";
import { cn } from "../../lib/cn";

interface Props {
  workflowId: string;
  workflowName: string;
  description: string;
  enabled: boolean;
  dirty: boolean;
  saving: boolean;
  runBusy: boolean;
  pollActive: boolean;
  onBack: () => void;
  onAddNode: () => void;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
  onSave: () => void;
  onRun: () => void;
  onToggleEnabled: () => void;
}

export function EditorTopBar({
  workflowId,
  workflowName,
  description,
  enabled,
  dirty,
  saving,
  runBusy,
  pollActive,
  onBack,
  onAddNode,
  onNameChange,
  onDescriptionChange,
  onSave,
  onRun,
  onToggleEnabled,
}: Props) {
  const callSign = `Wf-${workflowId.slice(0, 6)}`;
  return (
    <div className="bg-gradient-to-b from-panel to-panel/80 border-b border-border flex items-center gap-3 px-4 h-12 flex-shrink-0 shadow-sm">
      <button
        type="button"
        onClick={onAddNode}
        className="mono-caps text-[10px] h-7 px-3 bg-brass/10 text-brass border border-brass/30 hover:bg-brass/20 flex items-center gap-1.5"
      >
        <PlusIcon size={11} /> Add Node
      </button>
      <button
        type="button"
        onClick={onBack}
        className="text-textMuted hover:text-text mono-caps text-[10px] flex items-center gap-1 ml-1"
      >
        ← workflows
      </button>
      <span className="text-textFaint">/</span>
      <span className="mono-caps text-[9px] text-brass tracking-wider">
        {callSign}
      </span>
      <input
        value={workflowName}
        onChange={(e) => onNameChange(e.target.value)}
        className="bg-transparent text-text font-medium text-[13px] outline-none focus:bg-panelAlt px-1 -mx-1 min-w-0 max-w-xs"
        placeholder="workflow name…"
      />
      {dirty && (
        <span className="mono-caps text-[9px] text-brass">unsaved</span>
      )}
      {saving && (
        <span className="mono-caps text-[9px] text-textFaint">saving…</span>
      )}
      <div className="flex-1" />
      <input
        value={description}
        onChange={(e) => onDescriptionChange(e.target.value)}
        placeholder="description…"
        className="bg-transparent text-textMuted text-[11px] outline-none focus:bg-panelAlt px-2 -mx-2 min-w-0 max-w-md text-right"
      />
      <div className="flex-1" />
      <button
        type="button"
        onClick={onToggleEnabled}
        className={cn(
          "mono-caps text-[10px] px-2.5 h-7 border flex items-center gap-1.5",
          enabled
            ? "bg-teal/10 text-teal border-teal/30"
            : "bg-panelAlt text-textMuted border-border",
        )}
      >
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            enabled ? "bg-teal" : "bg-textFaint",
          )}
        />
        {enabled ? "Active" : "Paused"}
      </button>
      <Button
        variant="secondary"
        size="sm"
        onClick={onSave}
        disabled={saving || !dirty}
      >
        <SaveIcon size={11} />
        {saving ? "saving" : "Save"}
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={onRun}
        disabled={runBusy || pollActive}
      >
        <PlayIcon size={11} />
        {pollActive ? "running…" : runBusy ? "starting…" : "Execute"}
      </Button>
    </div>
  );
}
