export type ShapeTool =
  | "select"
  | "rectangle"
  | "circle"
  | "triangle"
  | "line"
  | "arrow"
  | "text"
  | "freehand";

export interface CanvasShape {
  id: string;
  type: ShapeTool;
  left: number;
  top: number;
  width?: number;
  height?: number;
  radius?: number;
  label?: string;
  points?: { x: number; y: number }[];
}

export interface SerializedCanvas {
  shapes: CanvasShape[];
  annotations: { text: string; x: number; y: number }[];
  connections: {
    from: string;
    to: string;
    label?: string;
  }[];
}
