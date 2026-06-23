import type { WebglGrant } from "./types";

/**
 * IWebglContextBudget — WebGL context cap allocator.
 *
 * Cohesion source: owns the global cap on simultaneous xterm WebGL
 * contexts. Each main terminal creates one context (terminalManager.ts
 * `new WebglAddon`); WebKit caps live contexts and over-allocation feeds
 * the memory pressure that triggers jettison. This allocator hands main
 * terminals a grant; on denial the caller falls back to the DOM renderer
 * (the same path terminalManager already takes on context-loss).
 */
export interface IWebglContextBudget {
  /**
   * Responsibility: Request a WebGL context slot for a terminal session.
   * Pipeline-position: terminalManager.createTerminal -> THIS -> WebglAddon load (or DOM fallback)
   * Inputs:
   *   - sessionId: string — the main terminal requesting a context
   * Outputs: WebglGrant — granted flag + reason; granted===false means the
   *   caller must use the DOM renderer.
   * Side-effects: increments the active-context count when granted.
   * Preconditions: called once per terminal before loading the WebGL addon;
   *   the session does not already hold a grant.
   * Postconditions: granted===true ⇒ activeCount() increased by 1 and is
   *   <= the configured cap; granted===false ⇒ activeCount() unchanged.
   * Failure-modes: None. (cap exhaustion is a denial via granted:false, not
   *   a throw)
   * Collaborators: None.
   */
  acquire(sessionId: string): WebglGrant;

  /**
   * Responsibility: Return a previously-granted context slot to the pool.
   * Pipeline-position: terminalManager.dispose / context-loss -> THIS -> (slot freed)
   * Inputs:
   *   - sessionId: string — a session that previously received granted:true
   * Outputs: void.
   * Side-effects: decrements the active-context count.
   * Preconditions: None enforced — releasing an unknown/ungranted session is
   *   tolerated.
   * Postconditions: a slot held by sessionId is freed; idempotent — a second
   *   release for the same session does not double-decrement.
   * Failure-modes: None.
   * Collaborators: None.
   */
  release(sessionId: string): void;

  /**
   * Responsibility: Report the number of live granted contexts.
   * Pipeline-position: IWatermarkSampler.sample -> THIS -> ResourceWatermark.webglContexts
   * Inputs: None.
   * Outputs: number — current active grants (0..cap).
   * Side-effects: None.
   * Preconditions: None.
   * Postconditions: equals (acquire grants) − (releases); never negative.
   * Failure-modes: None.
   * Collaborators: None.
   */
  activeCount(): number;
}
