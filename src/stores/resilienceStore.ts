import { create } from "zustand";
import type { IResilienceStore } from "./IResilienceStore";
import type {
  RootCauseSign,
  RecoveryPhase,
  ResilienceState,
  ResourceWatermark,
  IncidentId,
} from "../lib/resilience/types";

// Monotonic per-JS-context incident token source. A reload mints a fresh JS
// context which resets this — that is intentional: incident tokens only need
// to be unique/monotonic WITHIN a context (the durable cross-reload identity is
// the RecoverySession token, not the IncidentId).
let incidentCounter = 0;

function mintIncidentId(): IncidentId {
  return `incident-${++incidentCounter}`;
}

// Legal FSM successors. Any transition not listed (and not a same-phase no-op)
// is coerced to 'failed' rather than silently applied.
const LEGAL_SUCCESSORS: Record<RecoveryPhase, RecoveryPhase[]> = {
  healthy: ["suspect"],
  suspect: ["recovering", "recovered", "failed", "healthy"],
  recovering: ["recovered", "failed"],
  recovered: ["healthy"],
  failed: ["healthy"],
};

interface ResilienceStoreState extends ResilienceState {
  beginIncident: () => IncidentId;
  recordBoundaryCaught: (incidentId: IncidentId) => void;
  recordSign: (sign: RootCauseSign, incidentId: IncidentId) => void;
  recordWatermark: (mark: ResourceWatermark) => void;
  transition: (to: RecoveryPhase) => void;
  currentIncidentId: () => IncidentId | null;
  snapshotState: () => ResilienceState;
}

export const useResilienceStore = create<ResilienceStoreState>((set, get) => ({
  phase: "healthy",
  lastSign: null,
  lastWatermark: null,
  recoveryAttempts: 0,
  boundaryCaught: false,
  lastIncidentId: null,

  beginIncident: () => {
    const id = mintIncidentId();
    // Fresh incident window: clear the prior boundary flag so a stale catch
    // can't taint the new classification.
    set({ lastIncidentId: id, boundaryCaught: false });
    return id;
  },

  recordBoundaryCaught: (incidentId) => {
    // Guard: a catch from a prior incident must not taint the current one.
    if (get().lastIncidentId !== incidentId) return;
    set({ boundaryCaught: true });
  },

  recordSign: (sign, incidentId) => {
    if (get().lastIncidentId !== incidentId) return;
    set({ lastSign: sign });
  },

  recordWatermark: (mark) => {
    set({ lastWatermark: mark });
  },

  transition: (to) => {
    const from = get().phase;
    if (to === from) return; // idempotent no-op
    const legal = LEGAL_SUCCESSORS[from]?.includes(to) ?? false;
    const applied: RecoveryPhase = legal ? to : "failed";
    set((s) => ({
      phase: applied,
      // Entering 'recovering' counts one recovery attempt.
      recoveryAttempts:
        applied === "recovering" ? s.recoveryAttempts + 1 : s.recoveryAttempts,
      // Returning to 'healthy' closes the incident window.
      lastIncidentId: applied === "healthy" ? null : s.lastIncidentId,
    }));
  },

  currentIncidentId: () => {
    const s = get();
    return s.phase === "healthy" ? null : s.lastIncidentId;
  },

  snapshotState: () => {
    const s = get();
    return {
      phase: s.phase,
      lastSign: s.lastSign,
      lastWatermark: s.lastWatermark,
      recoveryAttempts: s.recoveryAttempts,
      boundaryCaught: s.boundaryCaught,
      lastIncidentId: s.lastIncidentId,
    };
  },
}));

/**
 * IResilienceStore-typed facade over the Zustand store, so collaborators
 * (detector, orchestrator, boundary) can depend on the interface contract
 * rather than the store's full action surface.
 */
export const resilienceStore: IResilienceStore = {
  beginIncident: () => useResilienceStore.getState().beginIncident(),
  recordBoundaryCaught: (incidentId) =>
    useResilienceStore.getState().recordBoundaryCaught(incidentId),
  recordSign: (sign, incidentId) =>
    useResilienceStore.getState().recordSign(sign, incidentId),
  recordWatermark: (mark) => useResilienceStore.getState().recordWatermark(mark),
  transition: (to) => useResilienceStore.getState().transition(to),
  currentIncidentId: () => useResilienceStore.getState().currentIncidentId(),
  snapshotState: () => useResilienceStore.getState().snapshotState(),
};
