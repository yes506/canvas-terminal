import { invoke } from "@tauri-apps/api/core";
import { useCollaboratorStore } from "../../stores/collaboratorStore";
import type { FsdSetTierResponse, FsdTier } from "../../types/fsd";

interface FsdToggleProps {
  leaderSessionId: string;
  leaderHandle: string;
  /** Disable while the leader's PTY is still spawning. */
  disabled?: boolean;
}

/**
 * Auto-Pilot toggle — single switch (ON / OFF).
 *
 * Phase 1 ships only `off` and `pilot`. The user-facing label is "Auto-Pilot"
 * (the `pilot` wire identifier and `tier=1` numeric encoding stay unchanged
 * in the FsdTier union, the Rust enum, and the IPC). The previous 5-segment
 * radiogroup `Off · Pilot · x1 · x2 · x3` was replaced with a single switch
 * so the OFF state is the toggle's off state rather than a sibling segment.
 *
 * Defensive: any non-`off` tier reads as enabled, so persisted x1/x2/x3 state
 * (Phase 2+) doesn't visually lie. Click toggles strictly between `off` and
 * `pilot`. Phase 2 will reintroduce a tier picker beside this switch.
 */
export function FsdToggle({ leaderSessionId, leaderHandle, disabled }: FsdToggleProps) {
  const fsdState = useCollaboratorStore(
    (s) => s.fsdByLeaderSessionId[leaderSessionId] ?? null,
  );
  const setFsdTier = useCollaboratorStore((s) => s.setFsdTier);
  const setStatus = useCollaboratorStore((s) => s.setStatus);
  const collabSessionId = useCollaboratorStore.getState().agents
    .find((a) => a.sessionId === leaderSessionId)?.collabSessionId ?? "";
  const current: FsdTier = fsdState?.tier ?? "off";
  const enabled = current !== "off";

  async function onToggle() {
    if (disabled) return;
    const next: FsdTier = enabled ? "off" : "pilot";
    const tierNum = next === "off" ? 0 : 1;
    try {
      const resp = await invoke<FsdSetTierResponse>("fsd_set_tier", {
        leaderSessionId, leaderHandle, tier: tierNum,
      });
      setFsdTier(leaderSessionId, leaderHandle, next, resp);
      setStatus(
        `FSD Auto-Pilot ${next === "pilot" ? "on" : "off"} for @${leaderHandle}`,
        collabSessionId,
        "transient",
      );
    } catch (e) {
      setStatus(`FSD Auto-Pilot toggle failed: ${e}`, collabSessionId, "persistent");
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="Auto-Pilot toggle"
      onClick={onToggle}
      disabled={disabled}
      title={
        disabled
          ? "Auto-Pilot — waiting for the agent to be ready"
          : enabled
            ? "Click to turn Auto-Pilot off"
            : "Click to turn Auto-Pilot on — leader orchestrates a pool of headless assistants"
      }
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono border rounded transition-colors shrink-0 ${
        disabled
          ? "border-surface-lighter text-text-dim/50 cursor-not-allowed"
          : enabled
            ? "border-accent bg-accent text-surface font-bold hover:bg-accent/90"
            : "border-surface-lighter text-text-dim hover:bg-surface-lighter hover:text-text"
      }`}
    >
      <span aria-hidden="true">{enabled ? "●" : "○"}</span>
      <span>Auto-Pilot {enabled ? "ON" : "OFF"}</span>
    </button>
  );
}
