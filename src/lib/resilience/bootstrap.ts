// Resilience bootstrap (webcontent-death-recovery nodes 12 + 12b + 15).
//
// Phase A (pre-render, awaited by main.tsx before the first ReactDOM render):
//   1. register `window.__ct_probe` — the Rust focus-probe watchdog evals it;
//      a live context answers with an IMMEDIATE heartbeat tick (whose durable
//      forward is what the watchdog observes) — no extra IPC;
//   2. read the durable DeathEvidence BEFORE the first new beat overwrites
//      the durable last-beat (IWebContentWatchdog.readDeathEvidence contract);
//   3. probe the durable pending RecoverySession and, when present, seed
//      `isReloadInProgress()` so the very first mounts suppress teardown;
//   4. start the Heartbeat + the debounced topology-persist triggers;
//   5. when a recovery is pending: kick `resumeAfterReload()` (NOT awaited —
//      its adoption barrier depends on post-render mounts) and wait only
//      until the barrier is ARMED, i.e. `restoreShell()` has seeded the
//      stores. The first render then mounts the RESTORED tabs, so the
//      default-tab effect (tabs.length === 0) never fires and no orphan
//      shell is spawned.
//
// Phase B happens inside `resumeAfterReload()` itself: barrier → reattach →
// clear (see RecoveryOrchestrator).

import { heartbeat } from "./Heartbeat";
import { webContentWatchdog } from "./WebContentWatchdog";
import { recoverySessionClient } from "./RecoverySessionClient";
import { topologySnapshotService } from "./TopologySnapshotService";
import {
  recoveryOrchestrator,
  seedReloadInProgress,
  adoptionBarrierArmed,
} from "./RecoveryOrchestrator";
import { resilienceConfig } from "./config";
import type { DeathEvidence } from "./types";
import { useTerminalStore } from "../../stores/terminalStore";
import { useCollaboratorStore } from "../../stores/collaboratorStore";

declare global {
  interface Window {
    /** Liveness probe hook eval'd by the Rust focus-probe watchdog. */
    __ct_probe?: () => void;
  }
}

/** Benign evidence used when the transport read fails — an EXPECTED resume
 *  takes its sign from the pending session's decision, not from evidence, so
 *  nulls here never mislabel the recovery (types.ts round-5 caveat). */
const EMPTY_EVIDENCE: DeathEvidence = {
  observedTermination: false,
  lastGoodBeatAt: null,
  gapMs: null,
  launchCount: 0,
  reloadedSinceLastBeat: false,
};

// ---------------------------------------------------------------------------
// Shared debounced topology persist (plan node 15)
// ---------------------------------------------------------------------------

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced capture→persist of the full topology snapshot. Called from BOTH
 * stores' mutation paths (rev-2 3-way MED: `capture()` reads collaborator
 * agents from collaboratorStore, so an agent-only change — spawn, status,
 * rename, publish opt-in — must also refresh the durable snapshot or the
 * last persisted state before a WebContent death is stale). Suppressed while
 * a recovery is in flight so a half-restored shell can't clobber the very
 * snapshot being restored.
 */
export function scheduleTopologyPersist(): void {
  if (recoveryOrchestrator.isReloadInProgress()) return;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (recoveryOrchestrator.isReloadInProgress()) return;
    void topologySnapshotService
      .capture()
      .then((snapshot) => topologySnapshotService.persist(snapshot))
      .catch(() => {
        // Persist is proactive best-effort; the next mutation retries.
      });
  }, resilienceConfig.persistDebounceMs);
}

function startTopologyPersistTriggers(): void {
  useTerminalStore.subscribe((state, prev) => {
    if (state.tabs !== prev.tabs || state.activeTabId !== prev.activeTabId) {
      scheduleTopologyPersist();
    }
  });
  useCollaboratorStore.subscribe((state, prev) => {
    if (state.agents !== prev.agents) {
      scheduleTopologyPersist();
    }
  });
}

// ---------------------------------------------------------------------------
// Phase A entry
// ---------------------------------------------------------------------------

let bootstrapRan = false;

/**
 * Run resilience Phase A. Resolves when it is safe to render: either no
 * recovery is pending, or the pending recovery's `restoreShell()` has seeded
 * the stores (adoption barrier armed). Never rejects — a resilience failure
 * must not take down the app it protects; it degrades to a normal boot.
 */
export async function runResilienceBootstrap(): Promise<void> {
  if (bootstrapRan) return; // idempotent (StrictMode/test double-invoke)
  bootstrapRan = true;

  try {
    // (1) Probe hook first — the watchdog may probe at any focus event.
    window.__ct_probe = () => heartbeat.recordTick();

    // (2) Evidence BEFORE the first new beat overwrites the durable last-beat.
    const evidence = await webContentWatchdog
      .readDeathEvidence()
      .catch(() => EMPTY_EVIDENCE);

    // (3) Pending-recovery probe + pre-render suppression seed.
    const pending = await recoverySessionClient.loadPending().catch(() => null);
    seedReloadInProgress(pending !== null);

    // (4) Diagnostics + proactive persistence start now.
    heartbeat.start();
    startTopologyPersistTriggers();

    if (!pending) return;

    // (5) Expected resume: kick Phase B (unawaited — its barrier resolves
    // only after the restored panes mount post-render) and wait just for
    // the store-seeding half so the first render shows the restored shell.
    void recoveryOrchestrator
      .resumeAfterReload(evidence)
      .then((outcome) => {
        console.info(
          `[resilience] recovery ${outcome.phase}: restored=${outcome.restoredSessions} ` +
            `lost=[${outcome.lostSessions.join(", ")}] in ${outcome.elapsedMs}ms`,
        );
      })
      .catch((err) => {
        console.error("[resilience] resumeAfterReload failed:", err);
      });
    await adoptionBarrierArmed();
  } catch (err) {
    // Fail open: render normally; diagnostics may be degraded.
    console.error("[resilience] bootstrap degraded:", err);
  }
}

/** Test-only reset (vitest isolation for the module-level run-once flag). */
export function _resetBootstrapForTests(): void {
  bootstrapRan = false;
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}
