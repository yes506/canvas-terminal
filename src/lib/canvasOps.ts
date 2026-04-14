import { invoke } from "@tauri-apps/api/core";
import { useCanvasStore, pushCanvasState } from "../stores/canvasStore";
import { renderResponseToDataUrl } from "./responseRenderer";
import * as fabric from "fabric";

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const IMPORT_PROMPT = [
  "",
  "# [Canvas Terminal] Save your response to the file path below.",
  "# Any format is accepted: PNG image, SVG, HTML, Markdown, or plain text.",
  "# It will be automatically rendered as an image on the canvas.",
  "# Path: ",
].join("\n");

/**
 * Export the current canvas as a PNG snapshot and return the saved file path.
 * Returns null if the canvas is empty or unavailable.
 */
export async function exportCanvasSnapshot(): Promise<string | null> {
  const fabricCanvas = useCanvasStore.getState().fabricCanvas;
  if (!fabricCanvas || fabricCanvas.getObjects().length === 0) return null;

  const dataUrl = fabricCanvas.toDataURL({
    format: "png",
    quality: 1,
    multiplier: window.devicePixelRatio,
  });
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
  const savedPath = await invoke<string>("export_snapshot", { base64Data });
  return savedPath || null;
}

export interface ImportPollHandle {
  cancel: () => void;
}

export interface ImportOptions {
  /** Per-agent suffix for unique import paths (multi-agent concurrent imports). */
  suffix?: string;
  /** Custom send function — routes through the collaborator store for context injection. */
  sendFn?: (prompt: string) => Promise<void>;
}

/**
 * Send the import prompt to a PTY session and start polling for the response file.
 * When the AI tool writes its response, it's rendered onto the canvas.
 *
 * When `options.sendFn` is provided, the prompt is sent through the collaborator
 * store (which prepends context headers) instead of raw `inject_into_pty`.
 * When `options.suffix` is provided, a unique import path is used so multiple
 * agents can write concurrently without clobbering each other's files.
 */
export async function startImportForSession(
  sessionId: string,
  tool: string | null,
  onStatus: (msg: string) => void,
  onDone?: () => void,
  options?: ImportOptions,
): Promise<ImportPollHandle> {
  const suffix = options?.suffix;
  const checkArgs = suffix != null ? { suffix } : {};

  const [importPath, baselineMtime] = await invoke<[string, number | null]>(
    "check_import_file",
    checkArgs,
  );

  // Send the prompt with the import path to the agent
  const prompt = IMPORT_PROMPT + importPath;
  if (options?.sendFn) {
    await options.sendFn(prompt);
  } else {
    await invoke("inject_into_pty", { sessionId, text: prompt, tool });
  }
  onStatus(`Import prompt sent. Waiting for file at ${importPath}...`);

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }

  pollTimer = setInterval(async () => {
    if (stopped) return;
    try {
      const [, currentMtime] = await invoke<[string, number | null]>(
        "check_import_file",
        checkArgs,
      );
      if (currentMtime === null) return;
      if (baselineMtime !== null && currentMtime <= baselineMtime) return;

      stop();
      const [format, content] = await invoke<[string, string]>(
        "read_import_file",
        checkArgs,
      );

      // Clean up the import file now that we've read it
      invoke("cleanup_import_file", checkArgs).catch(() => {});

      let dataUrl: string;
      if (format === "png") {
        dataUrl = content;
      } else {
        dataUrl = await renderResponseToDataUrl(content);
      }

      renderImportedImageOnCanvas(dataUrl, importPath);
      onStatus("Import complete — image added to canvas.");
      onDone?.();
    } catch {
      // Transient errors during polling
    }
  }, POLL_INTERVAL_MS);

  timeoutTimer = setTimeout(() => {
    stop();
    onStatus("Import timed out (5 minutes).");
    onDone?.();
  }, POLL_TIMEOUT_MS);

  return { cancel: stop };
}

function renderImportedImageOnCanvas(dataUrl: string, filePath: string) {
  const fabricCanvas = useCanvasStore.getState().fabricCanvas;
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
}
