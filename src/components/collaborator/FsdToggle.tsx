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
 * 5-segment toggle: `Off · Pilot · x1 · x2 · x3`. Phase 1 ships only `Off`
 * and `Pilot` as functional; x1/x2/x3 are rendered disabled with a tooltip
 * "available in Phase 2" per plan v5 §6.1 / @claude2 task-16 §2.3.
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

  async function onChange(next: FsdTier) {
    if (next === current) return;
    if (next !== "off" && next !== "pilot") {
      setStatus(`FSD ${next} is Phase 2 — toggle limited to Off/Pilot in Phase 1.`,
        collabSessionId, "transient");
      return;
    }
    const tierNum = next === "off" ? 0 : 1;
    try {
      const resp = await invoke<FsdSetTierResponse>("fsd_set_tier", {
        leaderSessionId, leaderHandle, tier: tierNum,
      });
      setFsdTier(leaderSessionId, leaderHandle, next, resp);
      setStatus(`FSD ${next} for ${leaderHandle}`, collabSessionId, "transient");
    } catch (e) {
      setStatus(`FSD set_tier failed: ${e}`, collabSessionId, "persistent");
    }
  }

  const segments: { value: FsdTier; label: string; phase1: boolean }[] = [
    { value: "off", label: "Off", phase1: true },
    { value: "pilot", label: "Pilot", phase1: true },
    { value: "x1", label: "x1", phase1: false },
    { value: "x2", label: "x2", phase1: false },
    { value: "x3", label: "x3", phase1: false },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="FSD tier"
      className="inline-flex items-center text-[10px] font-mono border border-surface-lighter rounded overflow-hidden shrink-0"
      title="Full-Self Driving — leader orchestrates a pool of headless assistants"
    >
      {segments.map((seg) => {
        const active = current === seg.value;
        const isDisabled = disabled || !seg.phase1;
        const tooltip = !seg.phase1
          ? `${seg.label} available in Phase 2`
          : seg.value === "off"
            ? "Disable FSD"
            : "Enable Pilot — single-CLI orchestration loop";
        return (
          <button
            key={seg.value}
            role="radio"
            aria-checked={active}
            type="button"
            onClick={() => onChange(seg.value)}
            disabled={isDisabled}
            className={`px-1.5 py-0.5 transition-colors ${
              active
                ? "bg-accent text-surface font-bold"
                : isDisabled
                  ? "text-text-dim/50 cursor-not-allowed"
                  : "text-text-dim hover:bg-surface-lighter hover:text-text"
            }`}
            title={tooltip}
          >
            {seg.label}
          </button>
        );
      })}
    </div>
  );
}
