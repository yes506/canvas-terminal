import type { IWatermarkSampler } from "./IWatermarkSampler";
import type { IWebglContextBudget } from "./IWebglContextBudget";
import type { IResilienceStore } from "../../stores/IResilienceStore";
import type { ResourceWatermark } from "./types";
import { webglContextBudget } from "./WebglContextBudget";
import { resilienceStore } from "../../stores/resilienceStore";
import { useTerminalStore } from "../../stores/terminalStore";
import type { PaneNode } from "../../types/terminal";

// Cumulative WebGL context-loss counter — a secondary signal for gpu-loss.
// Owned here (the watermark trail) and incremented from the xterm WebGL
// onContextLoss path when that wiring lands; defaults 0 so the field is always
// a valid number even before any loss is observed.
let webglContextLossCount = 0;

/** Record one observed WebGL context-loss event (called from the renderer). */
export function recordWebglContextLoss(): void {
  webglContextLossCount += 1;
}

function readJsHeapUsedBytes(): number | null {
  // performance.memory is Chromium/WebKit-only and non-standard; degrade to
  // null where it is unavailable rather than throw.
  const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } })
    .memory;
  return typeof mem?.usedJSHeapSize === "number" ? mem.usedJSHeapSize : null;
}

function countCollaboratorLeaves(node: PaneNode): number {
  if (node.type === "leaf") return node.kind === "collaborator" ? 1 : 0;
  return (
    countCollaboratorLeaves(node.children[0]) +
    countCollaboratorLeaves(node.children[1])
  );
}

/**
 * Concrete IWatermarkSampler — captures + logs the memory/GPU/tab-count
 * watermarks that CORRELATE with WebContent jettison. It contextualizes (never
 * confirms) hypothesis A; positive death confirmation is the watchdog's.
 */
export class WatermarkSampler implements IWatermarkSampler {
  private readonly budget: IWebglContextBudget;
  private readonly store: IResilienceStore;

  constructor(
    budget: IWebglContextBudget = webglContextBudget,
    store: IResilienceStore = resilienceStore,
  ) {
    this.budget = budget;
    this.store = store;
  }

  sample(): ResourceWatermark {
    const tabs = useTerminalStore.getState().tabs;
    const collaboratorPanes = tabs.reduce(
      (sum, t) => sum + countCollaboratorLeaves(t.paneTree),
      0,
    );
    return {
      jsHeapUsedBytes: readJsHeapUsedBytes(),
      webglContexts: this.budget.activeCount(),
      webglContextLosses: webglContextLossCount,
      terminalTabs: tabs.length,
      collaboratorPanes,
      sampledAt: Date.now(),
    };
  }

  log(mark: ResourceWatermark): void {
    // Logging must never destabilize the app it observes — swallow failures.
    try {
      console.debug("[resilience] watermark", mark);
      this.store.recordWatermark(mark);
    } catch {
      /* swallowed */
    }
  }
}

/** Shared singleton. */
export const watermarkSampler = new WatermarkSampler();
