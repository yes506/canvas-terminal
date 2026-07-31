// Typed facade over the scoped collab-memory Tauri IPC commands.
//
// Implements the planner-committed contracts in
// `src/types/scopedCollabMemory.ts` (`ScopedMemoryIpc` / `ScopedMemoryClient`).
// Every memory IPC in the app goes through this module — raw
// `invoke("read_memory_file", …)` call sites are forbidden — so a missed
// `collabSessionId` is a compile error, not a silent runtime
// deserialization failure on the Rust side.
//
// Standalone module (NOT inside the Zustand store) so `src/lib/peerContext.ts`
// can consume it without importing the store.

import { invoke } from "@tauri-apps/api/core";
import type {
  MemoryFileEntry,
  ReportFileInfo,
  ScopedMemoryClient,
  ScopedMemoryIpc,
} from "../types/scopedCollabMemory";

export const scopedMemoryIpc: ScopedMemoryIpc = {
  readMemoryFile(collabSessionId: string, relativePath: string): Promise<string | null> {
    return invoke<string | null>("read_memory_file", { collabSessionId, relativePath });
  },

  writeMemoryFile(
    collabSessionId: string,
    relativePath: string,
    content: string,
  ): Promise<string> {
    return invoke<string>("write_memory_file", { collabSessionId, relativePath, content });
  },

  writeMemoryFileAtomic(
    collabSessionId: string,
    relativePath: string,
    content: string,
  ): Promise<string> {
    return invoke<string>("write_memory_file_atomic", {
      collabSessionId,
      relativePath,
      content,
    });
  },

  deleteMemoryFile(collabSessionId: string, relativePath: string): Promise<boolean> {
    return invoke<boolean>("delete_memory_file", { collabSessionId, relativePath });
  },

  clearMemoryDir(collabSessionId: string): Promise<void> {
    return invoke<void>("clear_memory_dir", { collabSessionId });
  },

  listMemoryFiles(collabSessionId: string): Promise<MemoryFileEntry[]> {
    return invoke<MemoryFileEntry[]>("list_memory_files", { collabSessionId });
  },

  getMemoryFileMtime(collabSessionId: string, relativePath: string): Promise<number> {
    return invoke<number>("get_memory_file_mtime", { collabSessionId, relativePath });
  },

  quarantineMemoryFile(collabSessionId: string, relativePath: string): Promise<string> {
    return invoke<string>("quarantine_memory_file", { collabSessionId, relativePath });
  },

  inspectReportFile(collabSessionId: string, relativePath: string): Promise<ReportFileInfo> {
    return invoke<ReportFileInfo>("inspect_report_file", { collabSessionId, relativePath });
  },
};

// Per-collab-session cache of the Rust-resolved session dir. Keyed by the
// RAW collabSessionId the caller holds (the Rust side sanitizes; equal raw
// ids always resolve to the same absolute path within one app process, per
// the `getMemorySessionDir` postcondition). A single global string — the
// pre-isolation shape — would leak pane A's root into pane B's prompts.
const memoryDirCacheBySession = new Map<string, string>();

export const scopedMemoryClient: ScopedMemoryClient = {
  async getMemorySessionDir(collabSessionId: string): Promise<string> {
    const cached = memoryDirCacheBySession.get(collabSessionId);
    if (cached) return cached;
    const dir = await invoke<string>("get_memory_session_dir", { collabSessionId });
    memoryDirCacheBySession.set(collabSessionId, dir);
    return dir;
  },
};

/** Test-only reset for the per-session dir cache (vitest isolation). */
export function _resetMemoryDirCacheForTests(): void {
  memoryDirCacheBySession.clear();
}
