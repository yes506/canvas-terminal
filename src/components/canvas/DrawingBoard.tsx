import { useCanvas } from "./useCanvas";
import { Undo2, Redo2, Trash2 } from "lucide-react";
import {
  useCanvasStore,
  undoCanvas,
  redoCanvas,
} from "../../stores/canvasStore";

export function DrawingBoard() {
  const { canvasRef, containerRef } = useCanvas();
  const fabricCanvas = useCanvasStore((s) => s.fabricCanvas);
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);

  const handleClear = () => {
    if (!fabricCanvas) return;
    if (fabricCanvas.getObjects().length === 0) return;
    if (window.confirm("Clear all drawings on the canvas?")) {
      fabricCanvas.clear();
      fabricCanvas.backgroundColor = "#f0f0f0";
      fabricCanvas.renderAll();
    }
  };

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden canvas-drawer" tabIndex={0}>
      <canvas ref={canvasRef} />

      {/* Floating action bar */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-white/90 backdrop-blur border border-gray-200 rounded-lg px-2 py-1 shadow z-10">
        <button
          title="Undo (Cmd+Z)"
          disabled={!canUndo}
          className="p-1.5 rounded text-gray-500 hover:text-black hover:bg-gray-100 transition-colors disabled:opacity-25 disabled:cursor-default"
          onClick={() => fabricCanvas && undoCanvas(fabricCanvas)}
        >
          <Undo2 size={14} />
        </button>
        <button
          title="Redo (Cmd+Shift+Z)"
          disabled={!canRedo}
          className="p-1.5 rounded text-gray-500 hover:text-black hover:bg-gray-100 transition-colors disabled:opacity-25 disabled:cursor-default"
          onClick={() => fabricCanvas && redoCanvas(fabricCanvas)}
        >
          <Redo2 size={14} />
        </button>
        <div className="w-px h-4 bg-gray-200 mx-1" />
        <button
          title="Clear Canvas"
          className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
          onClick={handleClear}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
