import { useEffect } from "react";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { save, open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useCanvasStore } from "../stores/canvasStore";
import {
  useTerminalStore,
  getTerminalInstance,
  getActiveSessionId,
} from "../stores/terminalStore";

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Never interfere with IME composition (Korean, Japanese, Chinese)
      if (e.isComposing || e.keyCode === 229) return;

      const mod = e.metaKey || e.ctrlKey;

      // Escape to close search (no mod needed)
      if (e.key === "Escape") {
        const { searchVisible, setSearchVisible } = useTerminalStore.getState();
        if (searchVisible) {
          setSearchVisible(false);
          const sid = getActiveSessionId();
          if (sid) getTerminalInstance(sid)?.focus();
        }
        return;
      }

      if (!mod) return;

      const state = useTerminalStore.getState();
      const {
        tabs,
        activeTabId,
        addTab,
        removeTab,
        setActiveTab,
        increaseFontSize,
        decreaseFontSize,
        resetFontSize,
        toggleSearch,
        splitPane,
        navigatePane,
        toggleMaximizePane,
        undoCloseTab,
      } = state;

      const activeSessionId = getActiveSessionId();

      switch (e.key) {
        // --- Tab management ---
        case "t": {
          e.preventDefault();
          addTab();
          break;
        }
        case "w": {
          e.preventDefault();
          if (activeTabId && tabs.length > 1) {
            removeTab(activeTabId);
          }
          break;
        }

        // --- Undo close tab: Cmd+Z ---
        case "z": {
          const el = document.activeElement;
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            break; // Let native undo work in text inputs
          }
          e.preventDefault();
          undoCloseTab();
          break;
        }

        // --- Tab switching: Cmd+1-9 ---
        case "1": case "2": case "3": case "4": case "5":
        case "6": case "7": case "8": case "9": {
          e.preventDefault();
          const idx = parseInt(e.key) - 1;
          if (idx < tabs.length) {
            setActiveTab(tabs[idx].id);
          }
          break;
        }

        // --- Tab switching: Cmd+Shift+[ / ] ---
        case "[": {
          if (!e.shiftKey) break;
          e.preventDefault();
          if (!activeTabId || tabs.length < 2) break;
          const curIdx = tabs.findIndex((t) => t.id === activeTabId);
          const prevIdx = (curIdx - 1 + tabs.length) % tabs.length;
          setActiveTab(tabs[prevIdx].id);
          break;
        }
        case "]": {
          if (!e.shiftKey) break;
          e.preventDefault();
          if (!activeTabId || tabs.length < 2) break;
          const curIdx = tabs.findIndex((t) => t.id === activeTabId);
          const nextIdx = (curIdx + 1) % tabs.length;
          setActiveTab(tabs[nextIdx].id);
          break;
        }

        // --- Split panes ---
        case "d": {
          e.preventDefault();
          if (e.shiftKey) {
            splitPane("horizontal");
          } else {
            splitPane("vertical");
          }
          break;
        }

        // --- Pane navigation: Cmd+Opt+Arrow ---
        case "ArrowLeft":
        case "ArrowUp": {
          if (!e.altKey) break;
          e.preventDefault();
          navigatePane("prev");
          break;
        }
        case "ArrowRight":
        case "ArrowDown": {
          if (!e.altKey) break;
          e.preventDefault();
          navigatePane("next");
          break;
        }

        // --- Maximize pane: Cmd+Shift+Enter ---
        case "Enter": {
          e.preventDefault();
          if (e.shiftKey) {
            toggleMaximizePane();
          } else {
            // Fullscreen
            const win = getCurrentWindow();
            const isFs = await win.isFullscreen();
            await win.setFullscreen(!isFs);
          }
          break;
        }

        // --- Copy / Paste ---
        case "c": {
          if (!activeSessionId) break;
          const term = getTerminalInstance(activeSessionId);
          if (!term) break;
          const selection = term.getSelection();
          if (selection) {
            e.preventDefault();
            await writeText(selection);
          }
          break;
        }
        case "v": {
          e.preventDefault();
          if (!activeSessionId) break;
          try {
            const text = await readText();
            if (text) {
              await invoke("write_to_pty", {
                sessionId: activeSessionId,
                data: text,
              });
            }
          } catch {
            // Clipboard may be empty
          }
          break;
        }

        // --- Font size ---
        case "=": {
          e.preventDefault();
          increaseFontSize();
          break;
        }
        case "-": {
          e.preventDefault();
          decreaseFontSize();
          break;
        }
        case "0": {
          e.preventDefault();
          resetFontSize();
          break;
        }

        // --- Find ---
        case "f": {
          e.preventDefault();
          toggleSearch();
          break;
        }

        // --- Canvas save/load ---
        case "s": {
          e.preventDefault();
          const canvas = useCanvasStore.getState().fabricCanvas;
          if (!canvas) break;
          const filePath = await save({
            filters: [{ name: "Canvas", extensions: ["canvas.json"] }],
            defaultPath: "untitled.canvas.json",
          });
          if (filePath) {
            const json = JSON.stringify(canvas.toJSON(), null, 2);
            await invoke("save_canvas", { path: filePath, data: json });
          }
          break;
        }
        case "o": {
          e.preventDefault();
          const result = await open({
            filters: [{ name: "Canvas", extensions: ["canvas.json", "json"] }],
            multiple: false,
          });
          if (result) {
            const path = typeof result === "string" ? result : result;
            const json = await invoke<string>("load_canvas", { path });
            const canvas = useCanvasStore.getState().fabricCanvas;
            if (canvas && json) {
              canvas.loadFromJSON(json).then(() => canvas.renderAll());
            }
          }
          break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
