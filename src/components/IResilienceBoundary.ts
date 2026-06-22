import type { ErrorInfo, ReactNode } from "react";
import type { RecoveryView, SignClassification } from "../lib/resilience/types";

/**
 * IResilienceBoundary — root error-boundary behavioral contract.
 *
 * Cohesion source: the contract behind RootErrorBoundary.tsx, which wraps
 * <App/> in main.tsx (today it is unwrapped — only PaneTree has a pane-level
 * boundary). It is the sign DISCRIMINATOR: if a top-level throw is caught
 * here the incident is hypothesis B (js-fatal) and recovery can be in-tree;
 * if the screen blanks WITHOUT this firing, the JS context itself died
 * (hypothesis A, WebContent jettison). The React class implementing this
 * supplies getDerivedStateFromError/componentDidCatch around these methods.
 */
export interface IResilienceBoundary {
  /**
   * Responsibility: Capture a top-level render/runtime throw as sign 'js-fatal'.
   * Pipeline-position: React error propagation -> THIS -> IDeathDetector.classifySign
   * Inputs:
   *   - error: Error — the thrown value React surfaced to the boundary
   *   - info: ErrorInfo — React component stack for the throw
   * Outputs: SignClassification — sign 'js-fatal' with the error summarized
   *   in rationale.
   * Side-effects: records the sign (marks boundaryCaught=true for the
   *   detector) and the error message for the fallback view.
   * Preconditions: invoked from componentDidCatch within the boundary.
   * Postconditions: a subsequent classifySign call in this incident sees
   *   boundaryCaught=true; the fallback view's lastError is populated.
   * Failure-modes: None. (must never itself throw — a throwing boundary
   *   would unmount the root and produce the very symptom under repair)
   * Collaborators: IResilienceStore.recordSign
   */
  onTopLevelError(error: Error, info: ErrorInfo): SignClassification;

  /**
   * Responsibility: Render the recovery fallback UI for the blanked tree.
   * Pipeline-position: IResilienceStore.snapshotState -> THIS -> (user sees recover action)
   * Inputs:
   *   - view: RecoveryView — phase + sign + lastError + canRetry
   * Outputs: ReactNode — the fallback element (status + a recover/retry control).
   * Side-effects: None (pure render); the recover control, when clicked,
   *   delegates to the orchestrator — that side-effect is the handler's, not
   *   this method's.
   * Preconditions: called only while the boundary holds an error state.
   * Postconditions: returned node reflects `view`; offers a retry control iff
   *   view.canRetry.
   * Failure-modes: None. (total over RecoveryView)
   * Collaborators: IRecoveryOrchestrator.shouldRecover (via the retry handler)
   */
  renderFallback(view: RecoveryView): ReactNode;
}
