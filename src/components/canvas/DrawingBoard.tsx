import { useRef } from "react";
import { useCanvas } from "./useCanvas";
import { Undo2, Redo2, Trash2, ZoomIn, ZoomOut, Camera } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  useCanvasStore,
  undoCanvas,
  redoCanvas,
  lockHistory,
  unlockHistory,
  pushCanvasState,
} from "../../stores/canvasStore";
import { MIN_ZOOM, MAX_ZOOM } from "../../constants/canvas";

export function DrawingBoard() {
  const { canvasRef, containerRef } = useCanvas();
  const fabricCanvas = useCanvasStore((s) => s.fabricCanvas);
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);
  const zoomLevel = useCanvasStore((s) => s.zoomLevel);
  const setZoomLevel = useCanvasStore((s) => s.setZoomLevel);
  const isCapturing = useRef(false);

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

  const handleCapture = async () => {
    if (!fabricCanvas || isCapturing.current) return;
    isCapturing.current = true;

    try {
      // Capture canvas drawing using fabric's native toDataURL (works with any renderer)
      const dataUrl = fabricCanvas.toDataURL({
        format: "png",
        quality: 1,
        multiplier: window.devicePixelRatio,
      });
      const base64 = dataUrl.split(",")[1];

      const filePath = await save({
        filters: [{ name: "PNG Image", extensions: ["png"] }],
        defaultPath: `canvas-${Date.now()}.png`,
      });

      if (filePath && base64) {
        await invoke("save_binary_file", { path: filePath, base64Data: base64 });
      }
    } catch (err) {
      console.error("Capture failed:", err);
    } finally {
      isCapturing.current = false;
    }
  };

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden canvas-drawer" tabIndex={0}>
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
          title="Capture Canvas"
          className="p-1.5 rounded text-text-muted hover:text-text hover:bg-surface-lighter transition-colors"
          onClick={handleCapture}
        >
          <Camera size={14} />
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
    </div>
  );
}
