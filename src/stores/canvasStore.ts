import { create } from "zustand";
import type { Canvas } from "fabric";
import type { ShapeTool } from "../types/canvas";

export const CANVAS_COLORS = [
  "transparent",
  "#666666", "#888888", "#aaaaaa", "#cccccc", "#e0e0e0", "#ffffff",
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6",
];

// Undo/redo history
const undoStack: string[] = [];
const redoStack: string[] = [];
let historyLocked = false;

export function clearCanvasHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  historyLocked = false;
  useCanvasStore.setState({ canUndo: false, canRedo: false });
}

export function lockHistory() {
  historyLocked = true;
}

export function unlockHistory() {
  historyLocked = false;
}

export function pushCanvasState(canvas: Canvas) {
  if (historyLocked) return;
  undoStack.push(JSON.stringify((canvas.toJSON as (props?: string[]) => unknown)(["filePath", "markdownSource"])));
  redoStack.length = 0;
  if (undoStack.length > 50) undoStack.shift();
  useCanvasStore.setState({
    canUndo: undoStack.length > 0,
    canRedo: false,
  });
}

export function undoCanvas(canvas: Canvas) {
  if (undoStack.length === 0) return;
  redoStack.push(JSON.stringify((canvas.toJSON as (props?: string[]) => unknown)(["filePath", "markdownSource"])));
  const prev = undoStack.pop()!;
  historyLocked = true;
  canvas.loadFromJSON(prev).then(() => {
    canvas.renderAll();
    historyLocked = false;
    useCanvasStore.setState({
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
    });
  });
}

export function redoCanvas(canvas: Canvas) {
  if (redoStack.length === 0) return;
  undoStack.push(JSON.stringify((canvas.toJSON as (props?: string[]) => unknown)(["filePath", "markdownSource"])));
  const next = redoStack.pop()!;
  historyLocked = true;
  canvas.loadFromJSON(next).then(() => {
    canvas.renderAll();
    historyLocked = false;
    useCanvasStore.setState({
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
    });
  });
}

export type ColorMode = "stroke" | "fill";

interface CanvasState {
  activeTool: ShapeTool;
  setActiveTool: (tool: ShapeTool) => void;
  strokeColor: string;
  fillColor: string;
  colorMode: ColorMode;
  setStrokeColor: (color: string) => void;
  setFillColor: (color: string) => void;
  setColorMode: (mode: ColorMode) => void;
  fabricCanvas: Canvas | null;
  setFabricCanvas: (canvas: Canvas | null) => void;
  drawerOpen: boolean;
  toggleDrawer: () => void;
  canUndo: boolean;
  canRedo: boolean;
  zoomLevel: number;
  setZoomLevel: (level: number) => void;
  /** Viewport pan offset — updated on pan/zoom for overlay positioning */
  viewportPan: { x: number; y: number };
  setViewportPan: (x: number, y: number) => void;
}

export const useCanvasStore = create<CanvasState>((set) => ({
  activeTool: "select",
  setActiveTool: (tool) => set({ activeTool: tool }),
  strokeColor: "#cccccc",
  fillColor: "transparent",
  colorMode: "stroke",
  setStrokeColor: (color) => set({ strokeColor: color }),
  setFillColor: (color) => set({ fillColor: color }),
  setColorMode: (mode) => set({ colorMode: mode }),
  fabricCanvas: null,
  setFabricCanvas: (canvas) => set({ fabricCanvas: canvas }),
  drawerOpen: false,
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
  canUndo: false,
  canRedo: false,
  zoomLevel: 1,
  setZoomLevel: (level) => set({ zoomLevel: level }),
  viewportPan: { x: 0, y: 0 },
  setViewportPan: (x, y) =>
    set((s) => {
      if (s.viewportPan.x === x && s.viewportPan.y === y) return s;
      return { viewportPan: { x, y } };
    }),
}));
