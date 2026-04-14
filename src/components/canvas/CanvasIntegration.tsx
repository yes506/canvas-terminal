import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as fabric from "fabric";
import { useTerminalStore, selectActiveSessionId } from "../../stores/terminalStore";
import { useCanvasStore, pushCanvasState } from "../../stores/canvasStore";
import { useCollaboratorStore } from "../../stores/collaboratorStore";
import { executeCommand } from "../collaborator/commands";
import { startImportForSession, type ImportPollHandle } from "../../lib/canvasOps";
import { renderResponseToDataUrl } from "../../lib/responseRenderer";

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const IMPORT_PROMPT = [
  "",
  "# [Canvas Terminal] Save your response to the file path below.",
  "# Any format is accepted: PNG image, SVG, HTML, Markdown, or plain text.",
  "# It will be automatically rendered as an image on the canvas.",
  "# Path: ",
].join("\n");

export function useCanvasIntegration() {
  const activeSessionId = useTerminalStore(selectActiveSessionId);
  const collabSessionId = useCollaboratorStore((s) => s.collabSessionId);
  const fabricCanvas = useCanvasStore((s) => s.fabricCanvas);
  const [isWaitingForImport, setIsWaitingForImport] = useState(false);
  const importHandleRef = useRef<ImportPollHandle | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (importHandleRef.current) {
      importHandleRef.current.cancel();
      importHandleRef.current = null;
    }
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    if (timeoutTimer.current) {
      clearTimeout(timeoutTimer.current);
      timeoutTimer.current = null;
    }
    setIsWaitingForImport(false);
  }, []);

  const renderImportedImage = useCallback(
    (dataUrl: string, filePath: string) => {
      if (!fabricCanvas) return;
      const imgEl = new Image();
      imgEl.onload = () => {
        const vpt = fabricCanvas.viewportTransform;
        const zoom = vpt[0];
        const cx = (fabricCanvas.getWidth() / 2 - vpt[4]) / zoom;
        const cy = (fabricCanvas.getHeight() / 2 - vpt[5]) / zoom;

        const img = new fabric.Image(imgEl, {
          left: cx,
          top: cy,
          originX: "center",
          originY: "center",
        });
        const maxW = 400;
        if (img.width && img.width > maxW) img.scaleToWidth(maxW);
        (img as fabric.FabricObject & { filePath?: string }).filePath = filePath;
        fabricCanvas.add(img);
        fabricCanvas.setActiveObject(img);
        fabricCanvas.renderAll();
        pushCanvasState(fabricCanvas);
      };
      imgEl.src = dataUrl;
    },
    [fabricCanvas],
  );

  const exportToTerminal = useCallback(async () => {
    if (!fabricCanvas) return;
    if (fabricCanvas.getObjects().length === 0) return;

    // Route through collaborator when active
    if (collabSessionId) {
      await executeCommand({ type: "canvas-export", raw: "/canvas-export" });
      return;
    }

    if (!activeSessionId) return;

    try {
      const dataUrl = fabricCanvas.toDataURL({
        format: "png",
        quality: 1,
        multiplier: window.devicePixelRatio,
      });
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");

      const savedPath = await invoke<string>("export_snapshot", { base64Data });
      if (!savedPath) return;

      const pasteWrapped = `\x1b[200~${savedPath}\x1b[201~\r`;

      await invoke("write_to_pty", {
        sessionId: activeSessionId,
        data: pasteWrapped,
      });
    } catch (err) {
      console.error("exportToTerminal failed:", err);
    }
  }, [fabricCanvas, activeSessionId, collabSessionId]);

  const importIntoCanvas = useCallback(async () => {
    // If already polling, cancel it
    if (isWaitingForImport) {
      stopPolling();
      return;
    }

    // Route through collaborator when active
    if (collabSessionId) {
      const agents = useCollaboratorStore.getState().agents;
      const setStatus = useCollaboratorStore.getState().setStatus;
      let targetAgent;
      if (agents.length === 0) {
        setStatus("No agents running.");
        return;
      } else if (agents.length === 1) {
        targetAgent = agents[0];
      } else {
        setStatus("Multiple agents. Specify via collaborator: /canvas-import @claude");
        return;
      }
      setIsWaitingForImport(true);
      try {
        const handle = await startImportForSession(
          targetAgent.sessionId,
          targetAgent.tool,
          (msg) => setStatus(msg),
          () => setIsWaitingForImport(false),
        );
        importHandleRef.current = handle;
      } catch (err) {
        setIsWaitingForImport(false);
        setStatus(`Import failed: ${err}`);
      }
      return;
    }

    if (!activeSessionId) return;

    try {
      // Get the import file path and current mtime baseline
      const [importPath, baselineMtime] = await invoke<[string, number | null]>(
        "check_import_file",
      );

      // Write the instruction prompt to the terminal
      await invoke("write_to_pty", {
        sessionId: activeSessionId,
        data: IMPORT_PROMPT + importPath + "\n",
      });

      // Start polling for file changes
      setIsWaitingForImport(true);

      pollTimer.current = setInterval(async () => {
        try {
          const [path, currentMtime] = await invoke<[string, number | null]>(
            "check_import_file",
          );

          if (currentMtime === null) return; // File doesn't exist yet
          if (baselineMtime !== null && currentMtime <= baselineMtime) return; // Not modified

          // File is new or updated — read it with format detection
          stopPolling();
          const [format, content] = await invoke<[string, string]>("read_import_file");

          // Clean up the import file now that we've read it
          invoke("cleanup_import_file").catch(() => {});

          let dataUrl: string;
          if (format === "png") {
            // Already a data URL for binary images (PNG/JPEG)
            dataUrl = content;
          } else {
            // Text format — render to PNG via offscreen DOM
            dataUrl = await renderResponseToDataUrl(content);
          }
          renderImportedImage(dataUrl, path);
        } catch {
          // Ignore transient read errors during polling
        }
      }, POLL_INTERVAL_MS);

      // Auto-stop after timeout
      timeoutTimer.current = setTimeout(() => {
        stopPolling();
      }, POLL_TIMEOUT_MS);
    } catch (err) {
      console.error("Import into canvas failed:", err);
      stopPolling();
    }
  }, [activeSessionId, collabSessionId, isWaitingForImport, stopPolling, renderImportedImage]);

  return { exportToTerminal, importIntoCanvas, isWaitingForImport };
}
