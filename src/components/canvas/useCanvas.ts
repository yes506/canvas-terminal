import { useEffect, useRef, useCallback } from "react";
import { Canvas, type TPointerEventInfo, type TPointerEvent } from "fabric";
import * as fabric from "fabric";
import {
  useCanvasStore,
  pushCanvasState,
  undoCanvas,
  redoCanvas,
  clearCanvasHistory,
  lockHistory,
  unlockHistory,
} from "../../stores/canvasStore";
import { MIN_ZOOM, MAX_ZOOM } from "../../constants/canvas";
import type { ShapeTool } from "../../types/canvas";
import { renderResponseToDataUrl } from "../../lib/responseRenderer";
import { useToastStore } from "../../stores/toastStore";

// Mirror of MAX_IMAGE_READ_SIZE in src-tauri/src/commands/canvas.rs (20 MB).
// Drag-drop bypasses the Tauri backend, so we enforce the same ceiling here to keep
// behavior symmetric with the Toolbar file-picker path.
const MAX_DROP_TEXT_BYTES = 20 * 1024 * 1024;

const CANVAS_BG = "#2f2f2f";

// Clipboard for copy/paste (module-level so it persists across re-renders)
let clipboard: fabric.FabricObject[] = [];

// --- Helper: create arrowhead triangle ---
function createArrowHead(
  endX: number, endY: number,
  prevX: number, prevY: number,
  color: string,
): fabric.Triangle | null {
  const dx = endX - prevX;
  const dy = endY - prevY;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;
  const angle = Math.atan2(dy, dx);
  const head = new fabric.Triangle({
    left: endX,
    top: endY,
    width: 12,
    height: 12,
    fill: color,
    angle: (angle * 180) / Math.PI + 90,
    originX: "center",
    originY: "center",
    selectable: false,
    evented: false,
  });
  (head as any)._isArrowHead = true;
  return head;
}

// --- Helper: add draggable vertex controls to a polyline ---
function addVertexControls(polyline: fabric.Polyline) {
  const points = polyline.points;
  if (!points) return;

  polyline.controls = {};
  polyline.hasBorders = false;

  points.forEach((_, idx) => {
    polyline.controls[`v${idx}`] = new fabric.Control({
      positionHandler: function (
        _dim: any,
        _finalMatrix: any,
        fabricObject: any,
      ) {
        const poly = fabricObject as fabric.Polyline;
        const pt = poly.points![idx];
        const localX = pt.x - poly.pathOffset.x;
        const localY = pt.y - poly.pathOffset.y;
        return fabric.util.transformPoint(
          new fabric.Point(localX, localY),
          fabric.util.multiplyTransformMatrices(
            poly.canvas!.viewportTransform!,
            poly.calcTransformMatrix(),
          ),
        );
      },
      actionHandler: function (
        _eventData: any,
        transform: any,
        x: number,
        y: number,
      ) {
        const poly = transform.target as fabric.Polyline;
        // x, y are scene coordinates in fabric v6
        const invObjMatrix = fabric.util.invertTransform(
          poly.calcTransformMatrix(),
        );
        const local = fabric.util.transformPoint(
          new fabric.Point(x, y),
          invObjMatrix,
        );
        poly.points![idx] = {
          x: local.x + poly.pathOffset.x,
          y: local.y + poly.pathOffset.y,
        };
        poly.dirty = true;
        return true;
      },
      actionName: "modifyVertex",
      cursorStyle: "pointer",
      render: function (
        ctx: CanvasRenderingContext2D,
        left: number,
        top: number,
      ) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(left, top, 5, 0, 2 * Math.PI);
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      },
    });
  });
}

// --- Helper: find best segment index to insert a new point ---
function findInsertIndex(
  points: { x: number; y: number }[],
  px: number,
  py: number,
): number {
  let bestIdx = 1;
  let bestDist = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i].x,
      ay = points[i].y;
    const bx = points[i + 1].x,
      by = points[i + 1].y;
    const abx = bx - ax,
      aby = by - ay;
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * abx,
      cy = ay + t * aby;
    const dist = Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i + 1;
    }
  }
  return bestIdx;
}

// --- Helper: update arrowhead position/angle for a line/polyline ---
function updateArrowHead(
  canvas: Canvas,
  lineObj: fabric.FabricObject,
  arrowHead: fabric.Triangle,
) {
  let endX: number, endY: number, prevX: number, prevY: number;

  if (lineObj instanceof fabric.Polyline && lineObj.points) {
    // Use scene coordinates so arrowhead stays correct after move/rotate/scale
    const pts = getPolylineScenePoints(lineObj);
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2] || pts[0];
    endX = last.x;
    endY = last.y;
    prevX = prev.x;
    prevY = prev.y;
  } else if (lineObj instanceof fabric.Line) {
    endX = lineObj.x2!;
    endY = lineObj.y2!;
    prevX = lineObj.x1!;
    prevY = lineObj.y1!;
  } else {
    return;
  }

  const dx = endX - prevX;
  const dy = endY - prevY;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  const angle = Math.atan2(dy, dx);
  arrowHead.set({
    left: endX,
    top: endY,
    angle: (angle * 180) / Math.PI + 90,
  });
  arrowHead.setCoords();
  canvas.renderAll();
}

// --- Helper: get Line endpoints in scene coordinates (handles moved/rotated lines) ---
function getLineScenePoints(
  line: fabric.Line,
): [{ x: number; y: number }, { x: number; y: number }] {
  const lp = line.calcLinePoints();
  const matrix = line.calcTransformMatrix();
  const p1 = fabric.util.transformPoint(
    new fabric.Point(lp.x1, lp.y1),
    matrix,
  );
  const p2 = fabric.util.transformPoint(
    new fabric.Point(lp.x2, lp.y2),
    matrix,
  );
  return [
    { x: p1.x, y: p1.y },
    { x: p2.x, y: p2.y },
  ];
}

// --- Helper: get Polyline points in scene coordinates (handles moved/rotated polylines) ---
function getPolylineScenePoints(
  poly: fabric.Polyline,
): { x: number; y: number }[] {
  const matrix = poly.calcTransformMatrix();
  return poly.points!.map((p) => {
    const lx = p.x - poly.pathOffset.x;
    const ly = p.y - poly.pathOffset.y;
    const sp = fabric.util.transformPoint(new fabric.Point(lx, ly), matrix);
    return { x: sp.x, y: sp.y };
  });
}

// --- Helper: convert a fabric.Line to a Polyline with a new joint point ---
function convertLineToPolyline(
  canvas: Canvas,
  line: fabric.Line,
  jointX: number,
  jointY: number,
): fabric.Polyline {
  const [start, end] = getLineScenePoints(line);
  const stroke = line.stroke as string;
  const strokeWidth = line.strokeWidth ?? 2;
  const lineType = (line as any)._lineType || "line";
  const arrowHead = (line as any)._arrowHead as fabric.Triangle | undefined;

  // Insert joint between the two endpoints
  const newPoints = [start, { x: jointX, y: jointY }, end];

  canvas.remove(line);

  const polyline = new fabric.Polyline(newPoints, {
    stroke,
    strokeWidth,
    fill: "transparent",
    selectable: true,
    evented: true,
    objectCaching: false,
  });
  (polyline as any)._lineType = lineType;
  (polyline as any).customLabel = "";

  if (arrowHead) {
    (polyline as any)._arrowHead = arrowHead;
    updateArrowHead(canvas, polyline, arrowHead);
  }

  addVertexControls(polyline);
  canvas.add(polyline);
  canvas.setActiveObject(polyline);
  return polyline;
}

// --- Helper: add a joint point to an existing polyline ---
function addJointToPolyline(
  canvas: Canvas,
  polyline: fabric.Polyline,
  jointX: number,
  jointY: number,
): fabric.Polyline {
  const points = getPolylineScenePoints(polyline);
  const stroke = polyline.stroke as string;
  const strokeWidth = polyline.strokeWidth ?? 2;
  const lineType = (polyline as any)._lineType || "line";
  const arrowHead = (polyline as any)._arrowHead as
    | fabric.Triangle
    | undefined;

  const insertIdx = findInsertIndex(points, jointX, jointY);
  points.splice(insertIdx, 0, { x: jointX, y: jointY });

  canvas.remove(polyline);

  const newPoly = new fabric.Polyline(points, {
    stroke,
    strokeWidth,
    fill: "transparent",
    selectable: true,
    evented: true,
    objectCaching: false,
  });
  (newPoly as any)._lineType = lineType;
  (newPoly as any).customLabel = "";

  if (arrowHead) {
    (newPoly as any)._arrowHead = arrowHead;
    updateArrowHead(canvas, newPoly, arrowHead);
  }

  addVertexControls(newPoly);
  canvas.add(newPoly);
  canvas.setActiveObject(newPoly);
  return newPoly;
}

export function useCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isDrawing = useRef(false);
  const startPoint = useRef({ x: 0, y: 0 });
  const activeShape = useRef<fabric.FabricObject | null>(null);
  const drawStrokeColor = useRef("#cccccc");
  const prevSize = useRef({ width: 0, height: 0 });

  // Track the tool used when drawing started (so mouseup knows even if tool changed mid-drag)
  const drawingTool = useRef<ShapeTool>("select");

  // Panning state
  const isPanning = useRef(false);
  const lastPanPoint = useRef({ x: 0, y: 0 });
  const spacePressed = useRef(false);

  const activeTool = useCanvasStore((s) => s.activeTool);
  const strokeColor = useCanvasStore((s) => s.strokeColor);
  const fillColor = useCanvasStore((s) => s.fillColor);
  const setActiveTool = useCanvasStore((s) => s.setActiveTool);
  const setFabricCanvas = useCanvasStore((s) => s.setFabricCanvas);

  const activeToolRef = useRef<ShapeTool>(activeTool);
  activeToolRef.current = activeTool;
  const strokeRef = useRef(strokeColor);
  strokeRef.current = strokeColor;
  const fillRef = useRef(fillColor);
  fillRef.current = fillColor;
  const setActiveToolRef = useRef(setActiveTool);
  setActiveToolRef.current = setActiveTool;
  const setFabricCanvasRef = useRef(setFabricCanvas);
  setFabricCanvasRef.current = setFabricCanvas;

  const initCanvas = useCallback(() => {
    if (!canvasRef.current || fabricRef.current) return;

      const canvas = new Canvas(canvasRef.current, {
      backgroundColor: CANVAS_BG,
      selection: false,
      preserveObjectStacking: true,
      selectionColor: "rgba(255, 255, 255, 0.1)",
      selectionBorderColor: "#999999",
      selectionLineWidth: 1,
      fireRightClick: true,
      stopContextMenu: true,
    });

    fabricRef.current = canvas;
    setFabricCanvasRef.current(canvas);

    // Resize: adjust viewport transform to maintain content proportions
    const resize = () => {
      if (!containerRef.current || !fabricRef.current) return;
      const { width, height } = containerRef.current.getBoundingClientRect();
      if (width === 0 || height === 0) return;

      const c = fabricRef.current;
      const oldW = prevSize.current.width;
      const oldH = prevSize.current.height;

      c.setDimensions({ width, height });

      if (oldW > 0 && oldH > 0 && (oldW !== width || oldH !== height)) {
        const scale = Math.min(width / oldW, height / oldH);
        const vpt = c.viewportTransform;
        const oldZoom = vpt[0];
        const newZoom = oldZoom * scale;

        const centerSceneX = (oldW / 2 - vpt[4]) / oldZoom;
        const centerSceneY = (oldH / 2 - vpt[5]) / oldZoom;
        const panX = width / 2 - centerSceneX * newZoom;
        const panY = height / 2 - centerSceneY * newZoom;

        c.setViewportTransform([newZoom, 0, 0, newZoom, panX, panY]);
        useCanvasStore.getState().setZoomLevel(newZoom);
        useCanvasStore.getState().setViewportPan(panX, panY);
      }

      prevSize.current = { width, height };
      c.renderAll();
    };

    const observer = new ResizeObserver(resize);
    if (containerRef.current) observer.observe(containerRef.current);
    resize();

    pushCanvasState(canvas);
    canvas.on("object:modified", (opt: any) => {
      // Refresh polyline bounding box after vertex drag (without remove/replace
      // which would corrupt fabric's internal transform state)
      if (
        opt.transform?.action === "modifyVertex" &&
        opt.target instanceof fabric.Polyline
      ) {
        const poly = opt.target as fabric.Polyline;
        // Recalculate dimensions while preserving the polyline's scene position.
        // setBoundingBox(false) updates pathOffset & dimensions but not left/top;
        // we then reposition via setPositionByOrigin so every point keeps its
        // original scene coordinate (even if the polyline was previously moved).
        const oldCenter = poly.getCenterPoint();
        const oldPO = { x: poly.pathOffset.x, y: poly.pathOffset.y };
        (poly as any).setBoundingBox(false);
        poly.setPositionByOrigin(
          new fabric.Point(
            oldCenter.x + (poly.pathOffset.x - oldPO.x),
            oldCenter.y + (poly.pathOffset.y - oldPO.y),
          ),
          "center",
          "center",
        );
        poly.setCoords();
        const arrowHead = (poly as any)._arrowHead as
          | fabric.Triangle
          | undefined;
        if (arrowHead) {
          updateArrowHead(canvas, poly, arrowHead);
        }
      }
      pushCanvasState(canvas);
    });
    canvas.on("object:removed", () => pushCanvasState(canvas));

    // --- Handle image / markdown drop ---
    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      if (!e.dataTransfer?.files.length) return;

      const file = e.dataTransfer.files[0];
      const isMarkdown =
        file.type === "text/markdown" || /\.md$/i.test(file.name);

      if (file.type.startsWith("image/")) {
        // Existing image flow — unchanged.
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const imgEl = new Image();
          imgEl.onload = () => {
            const img = new fabric.Image(imgEl, {
              left: e.offsetX ?? 100,
              top: e.offsetY ?? 100,
            });
            const maxW = 300;
            if (img.width && img.width > maxW) {
              img.scaleToWidth(maxW);
            }
            const fullPath = (file as File & { path?: string }).path || file.name;
            (img as fabric.FabricObject & { filePath?: string }).filePath = fullPath;
            canvas.add(img);
            canvas.setActiveObject(img);
            canvas.renderAll();
            pushCanvasState(canvas);
          };
          imgEl.src = dataUrl;
        };
        reader.readAsDataURL(file);
        return;
      }

      if (!isMarkdown) return;

      if (file.size > MAX_DROP_TEXT_BYTES) {
        useToastStore
          .getState()
          .showToast("Markdown file too large (max 20 MB).");
        return;
      }

      try {
        const text = await file.text();
        // Force format: "markdown" — extension (.md / text/markdown) already
        // disambiguates intent, so detectFormat()'s heuristics don't apply.
        const dataUrl = await renderResponseToDataUrl(text, {
          sanitize: true,
          format: "markdown",
        });
        const imgEl = new Image();
        imgEl.onload = () => {
          const img = new fabric.Image(imgEl, {
            left: e.offsetX ?? 100,
            top: e.offsetY ?? 100,
          });
          const maxW = 600;
          if (img.width && img.width > maxW) img.scaleToWidth(maxW);
          // Concrete metadata-attach — required for Cmd+Shift+S export to round-trip.
          (
            img as fabric.FabricObject & {
              markdownSource?: string;
              filePath?: string;
            }
          ).markdownSource = text;
          (
            img as fabric.FabricObject & {
              markdownSource?: string;
              filePath?: string;
            }
          ).filePath = file.name;
          canvas.add(img);
          canvas.setActiveObject(img);
          canvas.renderAll();
          pushCanvasState(canvas);
        };
        imgEl.src = dataUrl;
      } catch (err) {
        console.error("Markdown drop failed:", err);
        useToastStore.getState().showToast("Failed to import Markdown file.");
      }
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener("drop", handleDrop);
      container.addEventListener("dragover", handleDragOver);
    }

    // --- Mouse handlers ---

    canvas.on("mouse:down", (opt: TPointerEventInfo<TPointerEvent>) => {
      const rawEvent = opt.e as MouseEvent;

      // Pan with space+click or middle mouse button
      if (spacePressed.current || rawEvent.button === 1) {
        isPanning.current = true;
        lastPanPoint.current = { x: rawEvent.clientX, y: rawEvent.clientY };
        canvas.defaultCursor = "grabbing";
        return;
      }

      if (rawEvent.button !== 0) return;

      const tool = activeToolRef.current;
      if (tool === "select") return;

      const pointer = canvas.getScenePoint(opt.e);
      const stroke = strokeRef.current;
      const fill = fillRef.current;
      drawStrokeColor.current = stroke;
      drawingTool.current = tool;

      // --- Line / Arrow / Leader Line: drag-to-draw ---
      if (tool === "line" || tool === "arrow" || tool === "leaderLine") {
        isDrawing.current = true;
        startPoint.current = { x: pointer.x, y: pointer.y };

        const line = new fabric.Line(
          [pointer.x, pointer.y, pointer.x, pointer.y],
          {
            stroke,
            strokeWidth: 2,
            fill: "transparent",
            selectable: false,
            evented: false,
          },
        );
        canvas.add(line);
        activeShape.current = line;
        return;
      }

      // --- Simple shapes ---
      isDrawing.current = true;
      startPoint.current = { x: pointer.x, y: pointer.y };

      let shape: fabric.FabricObject | null = null;

      switch (tool) {
        case "rectangle":
          shape = new fabric.Rect({
            left: pointer.x,
            top: pointer.y,
            width: 0,
            height: 0,
            fill,
            stroke,
            strokeWidth: 2,
          });
          break;
        case "circle":
          shape = new fabric.Circle({
            left: pointer.x,
            top: pointer.y,
            radius: 0,
            fill,
            stroke,
            strokeWidth: 2,
            originX: "center",
            originY: "center",
          });
          break;
        case "triangle":
          shape = new fabric.Triangle({
            left: pointer.x,
            top: pointer.y,
            width: 0,
            height: 0,
            fill,
            stroke,
            strokeWidth: 2,
          });
          break;
        case "text": {
          const text = new fabric.IText("Type here", {
            left: pointer.x,
            top: pointer.y,
            fontSize: 16,
            fill: stroke,
            fontFamily: "monospace",
          });
          canvas.add(text);
          canvas.setActiveObject(text);
          text.enterEditing();
          setActiveToolRef.current("select");
          pushCanvasState(canvas);
          isDrawing.current = false;
          return;
        }
        case "promptText": {
          const promptText = new fabric.IText("[PROMPT] Prompt here", {
            left: pointer.x,
            top: pointer.y,
            fontSize: 16,
            fill: "#e879f9",
            fontFamily: "sans-serif",
            fontStyle: "italic",
            backgroundColor: "rgba(168, 85, 247, 0.15)",
            padding: 6,
          });
          canvas.add(promptText);
          canvas.setActiveObject(promptText);
          promptText.enterEditing();
          // Select only the placeholder text after the [PROMPT] prefix
          promptText.selectionStart = 9;
          promptText.selectionEnd = 20;
          setActiveToolRef.current("select");
          pushCanvasState(canvas);
          isDrawing.current = false;
          return;
        }
      }

      if (shape) {
        (
          shape as fabric.FabricObject & { customLabel?: string }
        ).customLabel = "";
        canvas.add(shape);
        activeShape.current = shape;
      }
    });

    canvas.on("mouse:move", (opt: TPointerEventInfo<TPointerEvent>) => {
      // Handle panning
      if (isPanning.current) {
        const e = opt.e as MouseEvent;
        const vpt = canvas.viewportTransform;
        vpt[4] += e.clientX - lastPanPoint.current.x;
        vpt[5] += e.clientY - lastPanPoint.current.y;
        canvas.setViewportTransform(vpt);
        lastPanPoint.current = { x: e.clientX, y: e.clientY };
        useCanvasStore.getState().setViewportPan(vpt[4], vpt[5]);
        return;
      }

      if (!isDrawing.current || !activeShape.current) return;

      const pointer = canvas.getScenePoint(opt.e);
      const shape = activeShape.current;

      // Line-type tools: update endpoint
      if (shape instanceof fabric.Line) {
        shape.set({
          x2: pointer.x,
          y2: pointer.y,
        } as Partial<fabric.Line>);
        shape.setCoords();
        canvas.renderAll();
        return;
      }

      // Shape tools: update dimensions
      const sx = startPoint.current.x;
      const sy = startPoint.current.y;

      if (shape instanceof fabric.Rect || shape instanceof fabric.Triangle) {
        shape.set({
          left: Math.min(pointer.x, sx),
          top: Math.min(pointer.y, sy),
          width: Math.abs(pointer.x - sx),
          height: Math.abs(pointer.y - sy),
        });
      } else if (shape instanceof fabric.Circle) {
        const radius = Math.sqrt(
          Math.pow(pointer.x - sx, 2) + Math.pow(pointer.y - sy, 2),
        );
        shape.set({ radius, left: sx, top: sy });
      }

      canvas.renderAll();
    });

    canvas.on("mouse:up", () => {
      if (isPanning.current) {
        isPanning.current = false;
        canvas.defaultCursor = spacePressed.current
          ? "grab"
          : activeToolRef.current === "select"
            ? "default"
            : "crosshair";
        return;
      }

      if (!isDrawing.current) return;
      isDrawing.current = false;

      const tool = drawingTool.current;
      const shape = activeShape.current;

      // --- Finalize line-type tools ---
      if (shape && shape instanceof fabric.Line) {
        const x1 = shape.x1!,
          y1 = shape.y1!;
        const x2 = shape.x2!,
          y2 = shape.y2!;

        // Skip if too small (accidental click)
        if (Math.abs(x2 - x1) < 3 && Math.abs(y2 - y1) < 3) {
          canvas.remove(shape);
          activeShape.current = null;
          return;
        }

        // Mark the line type and make selectable
        (shape as any)._lineType = tool;
        shape.set({ selectable: true, evented: true });
        (shape as any).customLabel = "";

        // Add arrowhead for arrow and leader line
        if (tool === "arrow" || tool === "leaderLine") {
          const head = createArrowHead(
            x2,
            y2,
            x1,
            y1,
            drawStrokeColor.current,
          );
          if (head) {
            (shape as any)._arrowHead = head;
            canvas.add(head);
          }
        }

        // Add text label for leader line
        if (tool === "leaderLine") {
          // Position text near the start point (label end)
          const offsetX = x2 > x1 ? -8 : 8;
          const text = new fabric.IText("Label", {
            left: x1 + offsetX,
            top: y1 - 20,
            fontSize: 14,
            fill: drawStrokeColor.current,
            fontFamily: "monospace",
            originX: x2 > x1 ? "right" : "left",
          });
          canvas.add(text);
          canvas.setActiveObject(text);
          text.enterEditing();
          text.selectAll();
          setActiveToolRef.current("select");
        }

        shape.setCoords();
        activeShape.current = null;
        pushCanvasState(canvas);
        return;
      }

      // --- Finalize shape tools ---
      if (shape) {
        shape.setCoords();
        activeShape.current = null;
        pushCanvasState(canvas);
      }
    });

    canvas.on("mouse:dblclick", (opt: TPointerEventInfo<TPointerEvent>) => {
      const target = canvas.findTarget(opt.e);
      const pointer = canvas.getScenePoint(opt.e);

      // --- Joint editing: double-click on a line/polyline in select mode ---
      if (activeToolRef.current === "select" && target) {
        // fabric.Line → convert to Polyline with new joint
        if (target instanceof fabric.Line && (target as any)._lineType) {
          lockHistory();
          try {
            convertLineToPolyline(canvas, target, pointer.x, pointer.y);
          } finally {
            unlockHistory();
          }
          pushCanvasState(canvas);
          return;
        }

        // fabric.Polyline → add joint point
        if (
          target instanceof fabric.Polyline &&
          !(target instanceof fabric.Polygon) &&
          (target as any)._lineType
        ) {
          lockHistory();
          try {
            addJointToPolyline(canvas, target, pointer.x, pointer.y);
          } finally {
            unlockHistory();
          }
          pushCanvasState(canvas);
          return;
        }
      }

      // --- Shape label: double-click on a shape to add centered label ---
      if (
        target &&
        !(target instanceof fabric.IText) &&
        !(target instanceof fabric.Textbox) &&
        !((target as any)._lineType) &&
        !((target as any)._isArrowHead)
      ) {
        const bounds = target.getBoundingRect();
        const label = new fabric.IText("Label", {
          left: bounds.left + bounds.width / 2,
          top: bounds.top + bounds.height / 2,
          fontSize: 14,
          fill: "#d0d0d0",
          fontFamily: "monospace",
          originX: "center",
          originY: "center",
          textAlign: "center",
        });
        canvas.add(label);
        canvas.setActiveObject(label);
        label.enterEditing();
        label.selectAll();
      }
    });

    // Keyboard shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!fabricRef.current) return;
      const c = fabricRef.current;

      // Space = pan mode
      if (e.key === " " && !spacePressed.current && !e.repeat) {
        const active = document.activeElement;
        if (
          !(
            active instanceof HTMLInputElement ||
            active instanceof HTMLTextAreaElement
          )
        ) {
          e.preventDefault();
          spacePressed.current = true;
          c.defaultCursor = "grab";
          c.selection = false;
          c.forEachObject((obj) => {
            obj.evented = false;
          });
        }
      }

      // Guard: only handle canvas shortcuts when focus is inside the canvas area
      const canvasDrawer = canvasRef.current?.closest(".canvas-drawer");
      const focusInCanvas = canvasDrawer?.contains(document.activeElement as Node | null);

      // Arrow keys = move selected object(s), Shift = 10px steps
      if (
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)
      ) {
        if (!focusInCanvas) return;
        const active = c.getActiveObject();
        if (!active) return;
        if (active instanceof fabric.IText && active.isEditing) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        switch (e.key) {
          case "ArrowUp":
            active.top! -= step;
            break;
          case "ArrowDown":
            active.top! += step;
            break;
          case "ArrowLeft":
            active.left! -= step;
            break;
          case "ArrowRight":
            active.left! += step;
            break;
        }
        active.setCoords();
        c.renderAll();
        pushCanvasState(c);
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (!focusInCanvas) return;
        const active = c.getActiveObject();
        if (!active) return;
        if (active instanceof fabric.IText && active.isEditing) return;
        if (active instanceof fabric.ActiveSelection) {
          const objects = active.getObjects();
          c.discardActiveObject();
          objects.forEach((obj) => {
            // Also remove linked arrowhead
            const arrowHead = (obj as any)._arrowHead;
            if (arrowHead) c.remove(arrowHead);
            c.remove(obj);
          });
        } else {
          const arrowHead = (active as any)._arrowHead;
          if (arrowHead) c.remove(arrowHead);
          c.remove(active);
          c.discardActiveObject();
        }
        c.renderAll();
        pushCanvasState(c);
      }

      // Copy (Cmd/Ctrl+C)
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && !e.shiftKey) {
        const canvasEl = canvasRef.current;
        if (
          canvasEl &&
          canvasEl
            .closest(".canvas-drawer")
            ?.contains(document.activeElement as Node | null)
        ) {
          const active = c.getActiveObject();
          if (!active) return;
          if (active instanceof fabric.IText && active.isEditing) return;
          e.preventDefault();
          e.stopPropagation();
          clipboard = [];
          const objects =
            active instanceof fabric.ActiveSelection
              ? active.getObjects()
              : [active];
          let remaining = objects.length;
          objects.forEach((obj) => {
            obj.clone().then((cloned: fabric.FabricObject) => {
              clipboard.push(cloned);
              remaining--;
            });
          });
        }
      }

      // Paste (Cmd/Ctrl+V)
      if ((e.metaKey || e.ctrlKey) && e.key === "v" && !e.shiftKey) {
        const canvasEl = canvasRef.current;
        if (
          canvasEl &&
          canvasEl
            .closest(".canvas-drawer")
            ?.contains(document.activeElement as Node | null)
        ) {
          if (clipboard.length === 0) return;
          e.preventDefault();
          e.stopPropagation();
          c.discardActiveObject();
          const clones: fabric.FabricObject[] = [];
          let remaining = clipboard.length;
          clipboard.forEach((obj) => {
            obj.clone().then((cloned: fabric.FabricObject) => {
              cloned.set({
                left: (cloned.left ?? 0) + 20,
                top: (cloned.top ?? 0) + 20,
              });
              c.add(cloned);
              clones.push(cloned);
              remaining--;
              if (remaining === 0) {
                if (clones.length === 1) {
                  c.setActiveObject(clones[0]);
                } else {
                  const sel = new fabric.ActiveSelection(clones, { canvas: c });
                  c.setActiveObject(sel);
                }
                c.renderAll();
                pushCanvasState(c);
                clipboard = clones;
              }
            });
          });
        }
      }

      if (e.key === "Escape") {
        if (isDrawing.current) {
          isDrawing.current = false;
          activeShape.current = null;
        }
        c.discardActiveObject();
        c.renderAll();
        setActiveToolRef.current("select");
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        const canvasEl = canvasRef.current;
        if (
          canvasEl &&
          canvasEl
            .closest(".canvas-drawer")
            ?.contains(document.activeElement as Node | null)
        ) {
          e.preventDefault();
          e.stopPropagation();
          const objs = c.getObjects();
          if (objs.length > 0) {
            c.discardActiveObject();
            const sel = new fabric.ActiveSelection(objs, { canvas: c });
            c.setActiveObject(sel);
            c.renderAll();
          }
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        const canvasEl = canvasRef.current;
        if (
          canvasEl &&
          canvasEl
            .closest(".canvas-drawer")
            ?.contains(document.activeElement as Node | null)
        ) {
          e.preventDefault();
          e.stopPropagation();
          undoCanvas(c);
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "z" && e.shiftKey) {
        const canvasEl = canvasRef.current;
        if (
          canvasEl &&
          canvasEl
            .closest(".canvas-drawer")
            ?.contains(document.activeElement as Node | null)
        ) {
          e.preventDefault();
          e.stopPropagation();
          redoCanvas(c);
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!fabricRef.current) return;
      if (e.key === " ") {
        spacePressed.current = false;
        const c = fabricRef.current;
        const isSelect = activeToolRef.current === "select";
        c.defaultCursor = isSelect ? "default" : "crosshair";
        c.selection = isSelect;
        c.forEachObject((obj) => {
          obj.selectable = isSelect;
          obj.evented = isSelect;
        });
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);

    // --- Zoom with Cmd/Ctrl + mouse wheel, pan with plain wheel ---
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      if (e.metaKey || e.ctrlKey) {
        const direction = e.deltaY < 0 ? 1 : -1;
        const zoomFactor = direction > 0 ? 1.1 : 1 / 1.1;
        let newZoom = canvas.getZoom() * zoomFactor;
        newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));

        const rect = container!.getBoundingClientRect();
        const x = (e.clientX - rect.left) / canvas.getRetinaScaling();
        const y = (e.clientY - rect.top) / canvas.getRetinaScaling();
        const vpt = canvas.viewportTransform;
        const point = new fabric.Point(
          (x - vpt[4]) / vpt[0],
          (y - vpt[5]) / vpt[3],
        );
        canvas.zoomToPoint(point, newZoom);
        canvas.renderAll();
        useCanvasStore.getState().setZoomLevel(newZoom);
        const updatedVpt = canvas.viewportTransform;
        useCanvasStore.getState().setViewportPan(updatedVpt[4], updatedVpt[5]);
      } else {
        const vpt = canvas.viewportTransform;
        vpt[4] -= e.deltaX;
        vpt[5] -= e.deltaY;
        canvas.setViewportTransform(vpt);
        canvas.renderAll();
        useCanvasStore.getState().setViewportPan(vpt[4], vpt[5]);
      }
    };

    if (container) {
      container.addEventListener("wheel", handleWheel, { passive: false });
    }

    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      if (container) {
        container.removeEventListener("wheel", handleWheel);
        container.removeEventListener("drop", handleDrop);
        container.removeEventListener("dragover", handleDragOver);
      }
      canvas.dispose();
      fabricRef.current = null;
      setFabricCanvasRef.current(null);
      clearCanvasHistory();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const cleanup = initCanvas();
    return () => cleanup?.();
  }, [initCanvas]);

  // Update selection mode on tool change
  useEffect(() => {
    if (!fabricRef.current) return;
    const c = fabricRef.current;

    const isSelect = activeTool === "select";
    c.selection = isSelect;
    c.forEachObject((obj) => {
      obj.selectable = isSelect;
      obj.evented = isSelect;
    });
    c.defaultCursor = isSelect ? "default" : "crosshair";
    c.renderAll();
  }, [activeTool]);

  return { canvasRef, containerRef, fabricRef };
}
