import { describe, it, expect, beforeEach } from "vitest";
import { useResilienceStore } from "./resilienceStore";

function reset() {
  useResilienceStore.setState({
    phase: "healthy",
    lastSign: null,
    lastWatermark: null,
    recoveryAttempts: 0,
    boundaryCaught: false,
    lastIncidentId: null,
  });
}

describe("resilienceStore FSM", () => {
  beforeEach(reset);

  it("walks a legal edge (healthy -> suspect)", () => {
    const s = useResilienceStore.getState();
    s.transition("suspect");
    expect(useResilienceStore.getState().phase).toBe("suspect");
  });

  it("coerces an illegal transition to 'failed'", () => {
    const s = useResilienceStore.getState();
    s.transition("recovered"); // not a legal successor of 'healthy'
    expect(useResilienceStore.getState().phase).toBe("failed");
  });

  it("treats a same-phase transition as an idempotent no-op (no attempt bump)", () => {
    useResilienceStore.setState({ phase: "recovering", recoveryAttempts: 1 });
    useResilienceStore.getState().transition("recovering");
    expect(useResilienceStore.getState().phase).toBe("recovering");
    expect(useResilienceStore.getState().recoveryAttempts).toBe(1);
  });

  it("increments recoveryAttempts only when entering 'recovering'", () => {
    const s = useResilienceStore.getState();
    s.transition("suspect");
    s.transition("recovering");
    expect(useResilienceStore.getState().recoveryAttempts).toBe(1);
    s.transition("recovered"); // not 'recovering'
    expect(useResilienceStore.getState().recoveryAttempts).toBe(1);
  });

  it("returning to 'healthy' clears the incident token", () => {
    const s = useResilienceStore.getState();
    s.beginIncident();
    s.transition("suspect");
    s.transition("recovered");
    s.transition("healthy");
    expect(useResilienceStore.getState().lastIncidentId).toBeNull();
  });

  it("beginIncident mints a fresh id and clears boundaryCaught", () => {
    useResilienceStore.setState({ boundaryCaught: true });
    const id = useResilienceStore.getState().beginIncident();
    expect(typeof id).toBe("string");
    expect(useResilienceStore.getState().boundaryCaught).toBe(false);
    expect(useResilienceStore.getState().lastIncidentId).toBe(id);
  });

  it("currentIncidentId is null while healthy, exposed once non-healthy", () => {
    const s = useResilienceStore.getState();
    const id = s.beginIncident(); // phase still 'healthy'
    expect(s.currentIncidentId()).toBeNull();
    s.transition("suspect");
    expect(useResilienceStore.getState().currentIncidentId()).toBe(id);
  });

  it("recordBoundaryCaught/recordSign reject a stale incident id", () => {
    const s = useResilienceStore.getState();
    const id = s.beginIncident();
    s.recordBoundaryCaught("stale-incident");
    s.recordSign("js-fatal", "stale-incident");
    expect(useResilienceStore.getState().boundaryCaught).toBe(false);
    expect(useResilienceStore.getState().lastSign).toBeNull();
    // The matching id is honored.
    s.recordBoundaryCaught(id);
    s.recordSign("webcontent-death", id);
    expect(useResilienceStore.getState().boundaryCaught).toBe(true);
    expect(useResilienceStore.getState().lastSign).toBe("webcontent-death");
  });
});
