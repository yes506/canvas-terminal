import { useRef, useState, useEffect, useCallback } from "react";
import { useCanvas } from "./useCanvas";
import * as fabric from "fabric";
import {
  Undo2, Redo2, Trash2, ZoomIn, ZoomOut, Camera, MonitorDown,
  ArrowDownToLine, ArrowDown, ArrowUpToLine, ArrowUp, Share2,
  Download,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import html2canvas from "html2canvas";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  useCanvasStore,
  undoCanvas,
  redoCanvas,
  lockHistory,
  unlockHistory,
  pushCanvasState,
} from "../../stores/canvasStore";
import { MIN_ZOOM, MAX_ZOOM } from "../../constants/canvas";

interface LayerContextMenu {
  x: number;
  y: number;
  target: fabric.FabricObject;
}

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
  };

  const addImageToCanvas = (dataUrl: string) => {
    if (!fabricCanvas) return;
    const imgEl = new Image();
    imgEl.onload = () => {
      const img = new fabric.Image(imgEl, { left: 50, top: 50 });
      // Scale down to fit within 400px wide
      const maxW = 400;
      if (img.width && img.width > maxW) {
        img.scaleToWidth(maxW);
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
      const dataUrl = fabricCanvas.toDataURL({
        format: "png",
        quality: 1,
        multiplier: window.devicePixelRatio,
      });
      addImageToCanvas(dataUrl);
    } catch (err) {
      console.error("Canvas capture failed:", err);
    } finally {
      isCapturing.current = false;
    }
  };

  const handleCaptureFullWindow = async () => {
    if (isCapturing.current) return;
    isCapturing.current = true;

    try {
      const appRoot = document.querySelector<HTMLElement>("#root");
      if (!appRoot) return;

      // html2canvas natively clones canvas elements via drawImage().
      // For WebGL canvases (xterm.js), this requires preserveDrawingBuffer=true
      // on the WebGL addon — see useTerminal.ts where it's enabled.
      const screenshot = await html2canvas(appRoot, {
        backgroundColor: null,
        scale: window.devicePixelRatio,
        useCORS: true,
      });
      const dataUrl = screenshot.toDataURL("image/png");
      addImageToCanvas(dataUrl);
    } catch (err) {
      console.error("Full window capture failed:", err);
    } finally {
      isCapturing.current = false;
    }
  };

  const [snapshotToast, setSnapshotToast] = useState<string | null>(null);

  const handleExportForAI = async () => {
    if (!fabricCanvas) return;

    const dataUrl = fabricCanvas.toDataURL({
      format: "png",
      quality: 1,
      multiplier: window.devicePixelRatio,
    });

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
