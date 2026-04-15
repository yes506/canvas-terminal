import { useLayoutEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  hasSession,
  createSession,
  getSession,
  reparentTo,
  parkInHost,
} from "../../lib/terminalManager";
import { consumeSessionCwd } from "../../stores/terminalStore";

/**
 * Thin hook that manages the attachment of a persistent xterm Terminal
 * (owned by terminalManager) into a React-rendered slot div.
 *
 * On mount: ensures the session exists, then reparents the terminal DOM
 * element into the slot. On unmount: parks it back in the hidden host.
 * The PTY and xterm instance survive across React unmount/remount cycles
 * (e.g. pane-tree restructuring when opening the Collaborator split).
 *
 * Uses useLayoutEffect so that park→reparent completes before the browser
 * paints, eliminating a single-frame flash of an empty slot.
 */
export function useTerminal(sessionId: string) {
  const slotRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;

    if (hasSession(sessionId)) {
      // Session already exists — just reparent into this slot
      reparentTo(sessionId, slot);
    } else {
      // First mount — create the session directly in the slot so xterm
      // measures correct cols/rows for spawn_shell.
      const cwd = consumeSessionCwd(sessionId);
      createSession(sessionId, { cwd, parentEl: slot });
      // No .then(reparentTo) needed — terminal is already in slot.
    }

    return () => {
      // Park back in host — do NOT destroy
      parkInHost(sessionId);
    };
  }, [sessionId]);

  const writeToPty = useCallback(
    (data: string) => {
      invoke("write_to_pty", { sessionId, data }).catch((err) => {
        console.error("Failed to write to PTY:", err);
      });
    },
    [sessionId],
  );

  // Expose terminal/addon refs from the manager for external consumers
  const terminalRef = {
    get current() {
      return getSession(sessionId)?.terminal ?? null;
    },
  };
  const searchAddonRef = {
    get current() {
      return getSession(sessionId)?.searchAddon ?? null;
    },
  };
  const fitAddonRef = {
    get current() {
      return getSession(sessionId)?.fitAddon ?? null;
    },
  };

  return { termRef: slotRef, terminalRef, fitAddonRef, searchAddonRef, writeToPty };
}
