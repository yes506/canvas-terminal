import type { Canvas } from "fabric";
import * as fabric from "fabric";

interface ShapeInfo {
  id: number;
  type: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
}

interface ConnectionInfo {
  fromId: number | null;
  toId: number | null;
  fromLabel: string;
  toLabel: string;
}

interface AnnotationInfo {
  text: string;
  x: number;
  y: number;
}

interface ImageInfo {
  fileName: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function serializeCanvas(canvas: Canvas): string {
  const objects = canvas.getObjects();

  const shapeObjects: fabric.FabricObject[] = [];
  const textObjects: (fabric.IText | fabric.Textbox)[] = [];
  const lines: fabric.Line[] = [];
  const images: ImageInfo[] = [];

  for (const obj of objects) {
    if (obj instanceof fabric.IText || obj instanceof fabric.Textbox) {
      textObjects.push(obj);
    } else if (obj instanceof fabric.Line) {
      lines.push(obj);
    } else if (obj instanceof fabric.Image) {
      const bounds = obj.getBoundingRect();
      const imgObj = obj as fabric.FabricObject & { filePath?: string };
      images.push({
        fileName: imgObj.filePath || "image",
        x: Math.round(bounds.left),
        y: Math.round(bounds.top),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    } else if (
      obj instanceof fabric.Rect ||
      obj instanceof fabric.Circle ||
      obj instanceof fabric.Triangle
    ) {
      shapeObjects.push(obj);
    }
  }

  // Build shapes with label detection
  const shapes: ShapeInfo[] = [];
  const usedTextIndices = new Set<number>();
  let shapeId = 1;

  for (const obj of shapeObjects) {
    const bounds = obj.getBoundingRect();
    const customObj = obj as fabric.FabricObject & { customLabel?: string };

    let label = customObj.customLabel || "";

    if (!label) {
      for (let i = 0; i < textObjects.length; i++) {
        if (usedTextIndices.has(i)) continue;
        const textObj = textObjects[i];
        const textBounds = textObj.getBoundingRect();
        const intersects =
          textBounds.left < bounds.left + bounds.width &&
          textBounds.left + textBounds.width > bounds.left &&
          textBounds.top < bounds.top + bounds.height &&
          textBounds.top + textBounds.height > bounds.top;
        if (intersects) {
          label = textObj.text ?? "";
          usedTextIndices.add(i);
          break;
        }
      }
    }

    shapes.push({
      id: shapeId++,
      type: obj.constructor.name,
      label,
      x: Math.round(bounds.left),
      y: Math.round(bounds.top),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      radius: obj instanceof fabric.Circle ? Math.round(obj.radius ?? 0) : undefined,
    });
  }

  // Non-overlapping text → annotations
  const annotations: AnnotationInfo[] = [];
  for (let i = 0; i < textObjects.length; i++) {
    if (usedTextIndices.has(i)) continue;
    const obj = textObjects[i];
    const text = obj.text ?? "";
    if (text.trim()) {
      annotations.push({
        text,
        x: Math.round(obj.left ?? 0),
        y: Math.round(obj.top ?? 0),
      });
    }
  }

  // Connections from lines
  const connections: ConnectionInfo[] = lines.map((line) => {
    const left = line.left ?? 0;
    const top = line.top ?? 0;
    const origLeft = Math.min(line.x1 ?? 0, line.x2 ?? 0);
    const origTop = Math.min(line.y1 ?? 0, line.y2 ?? 0);
    const offsetX = left - origLeft;
    const offsetY = top - origTop;

    const absX1 = (line.x1 ?? 0) + offsetX;
    const absY1 = (line.y1 ?? 0) + offsetY;
    const absX2 = (line.x2 ?? 0) + offsetX;
    const absY2 = (line.y2 ?? 0) + offsetY;

    const from = findNearestShape(absX1, absY1, shapes);
    const to = findNearestShape(absX2, absY2, shapes);

    return {
      fromId: from?.id ?? null,
      toId: to?.id ?? null,
      fromLabel: from?.label || `point (${Math.round(absX1)}, ${Math.round(absY1)})`,
      toLabel: to?.label || `point (${Math.round(absX2)}, ${Math.round(absY2)})`,
    };
  });

  return buildPrompt(shapes, connections, annotations, images);
}

function findNearestShape(
  x: number,
  y: number,
  shapes: ShapeInfo[],
  threshold = 80
): ShapeInfo | null {
  let nearest: ShapeInfo | null = null;
  let minDist = threshold;

  for (const shape of shapes) {
    const cx = shape.x + shape.width / 2;
    const cy = shape.y + shape.height / 2;
    const dist = Math.sqrt(Math.pow(x - cx, 2) + Math.pow(y - cy, 2));
    if (dist < minDist) {
      minDist = dist;
      nearest = shape;
    }
  }

  return nearest;
}

function buildPrompt(
  shapes: ShapeInfo[],
  connections: ConnectionInfo[],
  annotations: AnnotationInfo[],
  images: ImageInfo[]
): string {
  const parts: string[] = [];

  parts.push("I have a diagram with the following elements:");
  parts.push("");

  if (shapes.length > 0) {
    parts.push("Shapes:");
    for (const s of shapes) {
      const label = s.label ? ` "${s.label}"` : "";
      if (s.radius) {
        parts.push(`- [${s.id}] Circle${label} at position (${s.x}, ${s.y}), radius ${s.radius}`);
      } else {
        parts.push(`- [${s.id}] ${s.type}${label} at position (${s.x}, ${s.y}), size ${s.width}x${s.height}`);
      }
    }
    parts.push("");
  }

  if (connections.length > 0) {
    parts.push("Connections:");
    for (const c of connections) {
      parts.push(`- Arrow from "${c.fromLabel}" to "${c.toLabel}"`);
    }
    parts.push("");
  }

  if (images.length > 0) {
    parts.push("Images:");
    for (const img of images) {
      parts.push(`- Image "${img.fileName}" at position (${img.x}, ${img.y}), size ${img.width}x${img.height}`);
    }
    parts.push("");
  }

  if (annotations.length > 0) {
    parts.push("Annotations:");
    for (const a of annotations) {
      parts.push(`- "${a.text}" at position (${a.x}, ${a.y})`);
    }
    parts.push("");
  }

  return parts.join("\n");
}
