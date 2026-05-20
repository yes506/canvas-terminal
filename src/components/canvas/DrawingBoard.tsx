import { useRef, useState, useEffect, useCallback } from "react";
import { useCanvas } from "./useCanvas";
import * as fabric from "fabric";
import {
  Undo2, Redo2, Trash2, ZoomIn, ZoomOut, Camera, MonitorDown,
  ArrowDownToLine, ArrowDown, ArrowUpToLine, ArrowUp, Share2,
  Download,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { exportCanvasToDataUrl } from "../../lib/canvasOps";
import {
  useCanvasStore,
  undoCanvas,
  redoCanvas,
  lockHistory,
  unlockHistory,
  pushCanvasState,
} from "../../stores/canvasStore";
import { useToastStore } from "../../stores/toastStore";
import { MIN_ZOOM, MAX_ZOOM } from "../../constants/canvas";

interface LayerContextMenu {
  x: number;
  y: number;
  target: fabric.FabricObject;
}

// localStorage flag so the "first capture will trigger a system prompt"
// rationale toast fires exactly once per browser profile — but only after
// a non-permission-denied outcome, so a first-attempt deny still gets the
// gentler explanation on retry (handled inside handleCaptureFullWindow's
// finally branch).
const RATIONALE_KEY = "canvas-terminal:capture-permission-warned";

export function DrawingBoard() {
  const { canvasRef, containerRef } = useCanvas();
  const fabricCanvas = useCanvasStore((s) => s.fabricCanvas);
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);
  const zoomLevel = useCanvasStore((s) => s.zoomLevel);
  const setZoomLevel = useCanvasStore((s) => s.setZoomLevel);
  const isCapturing = useRef(false);
  const [layerMenu, setLayerMenu] = useState<LayerContextMenu | null>(null);
  const layerMenuRef = useRef<HTMLDivElement>(null);

  // Dismiss layer context menu on outside click
  useEffect(() => {
    if (!layerMenu) return;
    const dismiss = (e: MouseEvent) => {
      if (layerMenuRef.current?.contains(e.target as Node)) return;
      setLayerMenu(null);
    };
    window.addEventListener("mousedown", dismiss);
    return () => window.removeEventListener("mousedown", dismiss);
  }, [layerMenu]);

  // Listen for fabric right-click on objects
  useEffect(() => {
    if (!fabricCanvas) return;
    const handleRightClick = (opt: fabric.TPointerEventInfo<fabric.TPointerEvent>) => {
      const e = opt.e as MouseEvent;
      if (e.button !== 2) return;
      e.preventDefault();
      e.stopPropagation();

      // Use fabric's pre-resolved target (set during internal _cacheTransformEventData).
      // Re-calling findTarget can miss objects whose evented flag is false.
      const target = opt.target ?? fabricCanvas.findTarget(opt.e);
      if (!target) {
        setLayerMenu(null);
        return;
      }
      const menuW = 180;
      const menuH = 140;
      const x = Math.min(e.clientX, window.innerWidth - menuW);
      const y = Math.min(e.clientY, window.innerHeight - menuH);
      fabricCanvas.setActiveObject(target);
      fabricCanvas.renderAll();
      setLayerMenu({ x, y, target });
    };
    fabricCanvas.on("mouse:down", handleRightClick);
    return () => {
      fabricCanvas.off("mouse:down", handleRightClick);
    };
  }, [fabricCanvas]);

  const handleLayerAction = useCallback(
    (action: "sendToBack" | "sendBackwards" | "bringToFront" | "bringForward") => {
      if (!fabricCanvas || !layerMenu) return;
      const { target } = layerMenu;
      switch (action) {
        case "sendToBack":
          fabricCanvas.sendObjectToBack(target);
          break;
        case "sendBackwards":
          fabricCanvas.sendObjectBackwards(target);
          break;
        case "bringToFront":
          fabricCanvas.bringObjectToFront(target);
          break;
        case "bringForward":
          fabricCanvas.bringObjectForward(target);
          break;
      }
      fabricCanvas.renderAll();
      pushCanvasState(fabricCanvas);
      setLayerMenu(null);
    },
    [fabricCanvas, layerMenu],
  );

  const handleSaveImage = useCallback(async () => {
    if (!layerMenu) return;
    const target = layerMenu.target;
    setLayerMenu(null);

    // Get the image data URL from the fabric object
    const dataUrl = target.toDataURL({ format: "png", multiplier: 1 });
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");

    const filePath = await save({
      filters: [{ name: "PNG Image", extensions: ["png"] }],
      defaultPath: "image.png",
    });
    if (!filePath) return;

    try {
      await invoke("save_binary_file", { path: filePath, base64Data });
      setSnapshotToast(`Saved: ${filePath}`);
      setTimeout(() => setSnapshotToast(null), 3000);
    } catch (err) {
      console.error("Save image failed:", err);
    }
  }, [layerMenu]);

  const handleClear = () => {
    if (!fabricCanvas) return;
    if (fabricCanvas.getObjects().length === 0) return;
    if (window.confirm("Clear all drawings on the canvas?")) {
      lockHistory();
      try {
        fabricCanvas.clear();
        fabricCanvas.backgroundColor = "#2f2f2f";
        fabricCanvas.renderAll();
      } finally {
        unlockHistory();
      }
      pushCanvasState(fabricCanvas);
    }
  };

  const handleZoom = (direction: "in" | "out" | "reset") => {
    if (!fabricCanvas) return;
    let newZoom: number;
    if (direction === "reset") {
      newZoom = 1;
      fabricCanvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    } else {
      const factor = direction === "in" ? 1.2 : 1 / 1.2;
      newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fabricCanvas.getZoom() * factor));
      const center = fabricCanvas.getCenterPoint();
      fabricCanvas.zoomToPoint(center, newZoom);
    }
    fabricCanvas.renderAll();
    setZoomLevel(newZoom);
    const vpt = fabricCanvas.viewportTransform;
    useCanvasStore.getState().setViewportPan(vpt[4], vpt[5]);
  };

  // Insertion path for full-window/canvas screenshots. Preserves the source
  // bitmap at full resolution and only display-scales via Fabric's scaleX/
  // scaleY. Why this matters: monospace terminal text rows are ~10–11 CSS px
  // tall; a destructive `scaleToWidth(400)` bilinearly aliases adjacent rows
  // together, and the subsequent `multiplier=dpr` export upsamples those
  // collisions instead of recovering them. Display-scaling keeps the full-res
  // source so the export samples from the original pixels. `objectCaching:
  // false` prevents Fabric from pre-baking a low-res cached bitmap on first
  // render. Integer-snap left/top avoids a mild bilinear pass from sub-pixel
  // placement.
  //
  // `sourceScale` is the device-pixels-per-CSS-pixel factor that produced the
  // source bitmap — must match the `scale`/`multiplier` used at capture. Pass
  // `dpr` for `exportCanvasToDataUrl` (multiplier=dpr) and `dpr*2` for the
  // fullwindow `html2canvas(scale: dpr*2)` path. Without this, the helper
  // would compute the source's CSS width incorrectly for higher-density
  // captures and clamp/scale the displayed image to the wrong size.
  const addCapturedScreenshotToCanvas = (dataUrl: string, sourceScale: number) => {
    if (!fabricCanvas) return;
    const imgEl = new Image();
    imgEl.onload = () => {
      const naturalCssW = imgEl.naturalWidth / sourceScale;
      const displayW = Math.min(naturalCssW, 900);
      const img = new fabric.Image(imgEl, {
        left: 50,
        top: 50,
        objectCaching: false,
      });
      if (img.width && img.width > 0) {
        const s = displayW / img.width;
        img.scaleX = s;
        img.scaleY = s;
      }
      fabricCanvas.add(img);
      fabricCanvas.setActiveObject(img);
      fabricCanvas.renderAll();
      pushCanvasState(fabricCanvas);
    };
    imgEl.src = dataUrl;
  };

  const handleCaptureCanvas = () => {
    if (!fabricCanvas || isCapturing.current) return;
    isCapturing.current = true;

    try {
      const dataUrl = exportCanvasToDataUrl(fabricCanvas);
      // exportCanvasToDataUrl already produces a full-resolution bitmap
      // (multiplier=dpr); preserve that source via the screenshot path
      // instead of re-downscaling it through scaleToWidth(400).
      addCapturedScreenshotToCanvas(dataUrl, window.devicePixelRatio);
    } catch (err) {
      console.error("Canvas capture failed:", err);
    } finally {
      isCapturing.current = false;
    }
  };

  // Replaces the prior html2canvas (DOM-clone) path. html2canvas could not
  // see the native Tauri child webview that hosts the browser drawer — its
  // pixels live in the OS compositor, not in the DOM — so captures showed a
  // black rectangle where the browser was. The native capture below reads
  // the compositor framebuffer via a Rust IPC (`capture_main_window_png`)
  // and gets the webview content + correct occlusion in one shot.
  //
  // The Rust side returns { pngBase64, sourceScale } so the helper below
  // can recover the source's CSS width correctly across multi-display
  // moves where window.devicePixelRatio would otherwise drift from the
  // actual capture scale.
  const handleCaptureFullWindow = async () => {
    if (isCapturing.current) return;
    isCapturing.current = true;

    // One-time rationale shown BEFORE the first invocation. macOS will
    // surface a Screen Recording prompt the first time the Rust side calls
    // CGRequestScreenCaptureAccess(); the system prompt's wording is fixed
    // by Apple (the NSScreenCaptureUsageDescription Info.plist key likely
    // doesn't customize it for this specific category), so the in-app
    // toast is the load-bearing rationale.
    const showedRationale = localStorage.getItem(RATIONALE_KEY) === "1";
    if (!showedRationale) {
      setSnapshotToast(
        "First capture: macOS will ask for Screen Recording permission. " +
        "Grant it, then fully quit (Cmd+Q) and relaunch Canvas Terminal."
      );
      // Give the user time to read before the system prompt slams in.
      await new Promise((r) => setTimeout(r, 3500));
      setSnapshotToast(null);
    }

    let suppressRationaleNextTime = true;
    try {
      const { pngBase64, sourceScale } = await invoke<{
        pngBase64: string;
        sourceScale: number;
      }>("capture_main_window_png");
      addCapturedScreenshotToCanvas(`data:image/png;base64,${pngBase64}`, sourceScale);
    } catch (err) {
      const msg = String(err);
      if (msg.startsWith("PERMISSION_DENIED:")) {
        // Permission denied — keep the gentle rationale path available on
        // retry. Without this guard, a first-attempt deny would mean the
        // user never sees the rationale toast again.
        suppressRationaleNextTime = false;
        setSnapshotToast(msg.slice("PERMISSION_DENIED:".length).trim());
        setTimeout(() => setSnapshotToast(null), 6000);
      } else {
        console.error("Full window capture failed:", err);
        setSnapshotToast("Capture failed — see console for details");
        setTimeout(() => setSnapshotToast(null), 6000);
      }
    } finally {
      if (suppressRationaleNextTime) {
        localStorage.setItem(RATIONALE_KEY, "1");
      }
      isCapturing.current = false;
    }
  };

  const [snapshotToast, setSnapshotToast] = useState<string | null>(null);

  const handleExportForAI = async () => {
    if (!fabricCanvas) return;

    const dataUrl = exportCanvasToDataUrl(fabricCanvas);

    // Strip the data:image/png;base64, prefix
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");

    try {
      const savedPath = await invoke<string>("export_snapshot", { base64Data });
      await writeText(savedPath);
      setSnapshotToast(savedPath);
      setTimeout(() => setSnapshotToast(null), 3000);
    } catch (err) {
      console.error("Export for AI failed:", err);
    }
  };

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden canvas-drawer" tabIndex={0} onContextMenu={(e) => e.preventDefault()}>
      <canvas ref={canvasRef} />

      {/* Floating action bar */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-surface-light/95 backdrop-blur border border-surface-lighter rounded-lg px-2 py-1 shadow z-10">
        <button
          title="Undo (Cmd+Z)"
          disabled={!canUndo}
          className="p-1.5 rounded text-text-muted hover:text-text hover:bg-surface-lighter transition-colors disabled:opacity-25 disabled:cursor-default"
          onClick={() => fabricCanvas && undoCanvas(fabricCanvas)}
        >
          <Undo2 size={14} />
        </button>
        <button
          title="Redo (Cmd+Shift+Z)"
          disabled={!canRedo}
          className="p-1.5 rounded text-text-muted hover:text-text hover:bg-surface-lighter transition-colors disabled:opacity-25 disabled:cursor-default"
          onClick={() => fabricCanvas && redoCanvas(fabricCanvas)}
        >
          <Redo2 size={14} />
        </button>
        <div className="w-px h-4 bg-surface-lighter mx-1" />
        <button
          title="Zoom Out"
          className="p-1.5 rounded text-text-muted hover:text-text hover:bg-surface-lighter transition-colors"
          onClick={() => handleZoom("out")}
        >
          <ZoomOut size={14} />
        </button>
        <button
          title="Reset Zoom"
          className="px-1.5 py-0.5 rounded text-[10px] text-text-muted hover:text-text hover:bg-surface-lighter transition-colors font-mono min-w-[40px] text-center"
          onClick={() => handleZoom("reset")}
        >
          {Math.round(zoomLevel * 100)}%
        </button>
        <button
          title="Zoom In"
          className="p-1.5 rounded text-text-muted hover:text-text hover:bg-surface-lighter transition-colors"
          onClick={() => handleZoom("in")}
        >
          <ZoomIn size={14} />
        </button>
        <div className="w-px h-4 bg-surface-lighter mx-1" />
        <button
          title="Capture Canvas Only"
          className="p-1.5 rounded text-text-muted hover:text-text hover:bg-surface-lighter transition-colors"
          onClick={handleCaptureCanvas}
        >
          <Camera size={14} />
        </button>
        <button
          title="Capture Full Window"
          className="p-1.5 rounded text-text-muted hover:text-text hover:bg-surface-lighter transition-colors"
          onClick={handleCaptureFullWindow}
        >
          <MonitorDown size={14} />
        </button>
        <div className="w-px h-4 bg-surface-lighter mx-1" />
        <button
          title="Export for AI (saves snapshot & copies path)"
          className="p-1.5 rounded text-text-muted hover:text-text hover:bg-surface-lighter transition-colors"
          onClick={handleExportForAI}
        >
          <Share2 size={14} />
        </button>
        <div className="w-px h-4 bg-surface-lighter mx-1" />
        <button
          title="Clear Canvas"
          className="p-1.5 rounded text-text-dim hover:text-red-400 hover:bg-surface-lighter transition-colors"
          onClick={handleClear}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Snapshot export toast */}
      {snapshotToast && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-surface-light/95 backdrop-blur border border-surface-lighter rounded-lg px-3 py-2 shadow z-10 text-xs text-text-muted max-w-[90%]">
          <span className="text-green-400">{snapshotToast.startsWith("Saved:") ? "" : "Copied to clipboard: "}</span>
          <code className="text-text">{snapshotToast}</code>
        </div>
      )}

      {/* Global toast (markdown import/export status, future shortcuts) */}
      <GlobalToast />

      {/* Layer order context menu */}
      {layerMenu && (
        <div
          ref={layerMenuRef}
          className="fixed z-50 bg-surface-light border border-surface-lighter rounded-lg shadow-lg py-1 min-w-[170px]"
          style={{ left: layerMenu.x, top: layerMenu.y }}
        >
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-text hover:bg-surface-lighter transition-colors text-left"
            onClick={() => handleLayerAction("bringToFront")}
          >
            <ArrowUpToLine size={12} />
            Bring to Front
          </button>
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-text hover:bg-surface-lighter transition-colors text-left"
            onClick={() => handleLayerAction("bringForward")}
          >
            <ArrowUp size={12} />
            Bring Forward
          </button>
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-text hover:bg-surface-lighter transition-colors text-left"
            onClick={() => handleLayerAction("sendBackwards")}
          >
            <ArrowDown size={12} />
            Send Backward
          </button>
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-text hover:bg-surface-lighter transition-colors text-left"
            onClick={() => handleLayerAction("sendToBack")}
          >
            <ArrowDownToLine size={12} />
            Send to Back
          </button>
          {layerMenu.target instanceof fabric.Image && (
            <>
              <div className="h-px bg-surface-lighter my-1" />
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-text hover:bg-surface-lighter transition-colors text-left"
                onClick={handleSaveImage}
              >
                <Download size={12} />
                Save Image As...
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function GlobalToast() {
  const message = useToastStore((s) => s.message);
  if (!message) return null;
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-surface-light/95 backdrop-blur border border-surface-lighter rounded-lg px-3 py-2 shadow z-10 text-xs text-text max-w-[90%]">
      {message}
    </div>
  );
}
