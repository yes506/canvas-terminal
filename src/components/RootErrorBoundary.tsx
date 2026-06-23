import { Component, type ErrorInfo, type ReactNode } from "react";
import type { IResilienceBoundary } from "./IResilienceBoundary";
import type { RecoveryView, SignClassification } from "../lib/resilience/types";
import { resilienceStore } from "../stores/resilienceStore";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * RootErrorBoundary — concrete IResilienceBoundary. Wraps the app root and acts
 * as the sign DISCRIMINATOR: a top-level throw caught here is hypothesis B
 * (js-fatal) and recovery can be in-tree; a blank screen WITHOUT this firing
 * means the JS context itself died (hypothesis A — owned by the watchdog).
 *
 * The React class wiring (getDerivedStateFromError / componentDidCatch) calls
 * the behavioral methods. onTopLevelError must never itself throw — a throwing
 * boundary unmounts the root and reproduces the very symptom under repair.
 */
export class RootErrorBoundary
  extends Component<Props, State>
  implements IResilienceBoundary
{
  state: State = { error: null };
  private lastErrorMessage: string | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Delegate the classification + store wiring to the behavioral method.
    this.onTopLevelError(error, info);
  }

  onTopLevelError(error: Error, info: ErrorInfo): SignClassification {
    void info; // component stack is not persisted; available for future diagnostics
    // Reuse the open incident if one exists, else mint one. currentIncidentId
    // returns null while 'healthy', so move to 'suspect' after minting so the
    // incident is exposed and the catch correlates to it.
    let incidentId = resilienceStore.currentIncidentId();
    if (incidentId === null) {
      incidentId = resilienceStore.beginIncident();
      resilienceStore.transition("suspect");
    }
    resilienceStore.recordBoundaryCaught(incidentId);
    resilienceStore.recordSign("js-fatal", incidentId);
    this.lastErrorMessage = error.message;
    return {
      sign: "js-fatal",
      confidence: 0.95,
      rationale: `RootErrorBoundary caught a top-level throw: ${error.message}`,
      incidentId,
    };
  }

  renderFallback(view: RecoveryView): ReactNode {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full text-text-dim text-xs font-mono gap-2 p-4">
        <p className="text-red-400 font-bold">Application error ({view.sign})</p>
        {view.lastError && (
          <p className="text-red-300 max-w-md text-center break-all">
            {view.lastError}
          </p>
        )}
        <p className="text-text-dim">phase: {view.phase}</p>
        {view.canRetry && (
          <button
            className="mt-2 px-3 py-1 rounded border border-surface-lighter hover:bg-surface-lighter text-text transition-colors"
            onClick={() => {
              this.lastErrorMessage = null;
              this.setState({ error: null });
            }}
          >
            Recover
          </button>
        )}
      </div>
    );
  }

  render(): ReactNode {
    if (this.state.error) {
      const snap = resilienceStore.snapshotState();
      const view: RecoveryView = {
        phase: snap.phase,
        sign: snap.lastSign ?? "js-fatal",
        lastError: this.lastErrorMessage,
        canRetry: true,
      };
      return this.renderFallback(view);
    }
    return this.props.children;
  }
}
