import { describe, it, expect, beforeEach } from "vitest";
import { useToastStore } from "./toastStore";

describe("useToastStore", () => {
  beforeEach(() => {
    // Reset state between tests.
    useToastStore.setState({ message: null });
  });

  it("sets message and clears after the TTL", async () => {
    useToastStore.getState().showToast("hi", 50);
    expect(useToastStore.getState().message).toBe("hi");
    await new Promise((r) => setTimeout(r, 80));
    expect(useToastStore.getState().message).toBe(null);
  });

  it("uses a generation counter so a stale TTL timer cannot clear a fresh toast", async () => {
    useToastStore.getState().showToast("A", 100);
    // Show B before A's timer fires. B's timer is longer than A's remaining time.
    await new Promise((r) => setTimeout(r, 30));
    useToastStore.getState().showToast("B", 1000);
    expect(useToastStore.getState().message).toBe("B");
    // Wait long enough that A's original timer would have fired (100 ms total).
    await new Promise((r) => setTimeout(r, 100));
    // Without the gen counter, A's timer would have cleared B here. With it, B persists.
    expect(useToastStore.getState().message).toBe("B");
  });
});
