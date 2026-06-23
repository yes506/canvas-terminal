// Barrel for the resilience / recovery subsystem interface contracts.
// Interface-only (system-lane skeleton); no implementations are exported.
export type * from "./types";
export type { IHeartbeat } from "./IHeartbeat";
export type { IWebContentWatchdog } from "./IWebContentWatchdog";
export type { IWatermarkSampler } from "./IWatermarkSampler";
export type { IDeathDetector } from "./IDeathDetector";
export type { ITopologySnapshot } from "./ITopologySnapshot";
export type { IPtyReattachClient } from "./IPtyReattachClient";
export type { IRecoveryOrchestrator } from "./IRecoveryOrchestrator";
export type { IRecoverySession } from "./IRecoverySession";
export type { IWebglContextBudget } from "./IWebglContextBudget";
export type { IScrollbackPolicy } from "./IScrollbackPolicy";
