import { useEffect, useRef, useCallback } from "react";
import { Canvas, type TPointerEventInfo, type TPointerEvent } from "fabric";
import * as fabric from "fabric";
import {
  useCanvasStore,
  pushCanvasState,
  undoCanvas,
  redoCanvas,
  clearCanvasHistory,
} from "../../stores/canvasStore";
import { MIN_ZOOM, MAX_ZOOM } from "../../constants/canvas";
import type { ShapeTool } from "../../types/canvas";

const CANVAS_BG = "#2f2f2f";

// Clipboard for copy/paste (module-level so it persists across re-renders)
let clipboard: fabric.FabricObject[] = [];

export function useCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isDrawing = useRef(false);
  const startPoint = useRef({ x: 0, y: 0 });
  const activeShape = useRef<fabric.FabricObject | null>(null);
  const drawStrokeColor = useRef("#cccccc");
  const prevSize = useRef({ width: 0, height: 0 });

  // Panning state
  const isPanning = useRef(false);
  const lastPanPoint = useRef({ x: 0, y: 0 });
  const spacePressed = useRef(false);

  // Polyline state
  const polyPoints = useRef<{ x: number; y: number }[]>([]);
  const polyPreviewLine = useRef<fabric.Line | null>(null);
  const isPolyDrawing = useRef(false);

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

  const finishPolyline = useCallback((canvas: Canvas, isArrow: boolean) => {
    if (polyPoints.current.length < 2) {
      if (polyPreviewLine.current) {
        canvas.remove(polyPreviewLine.current);
        polyPreviewLine.current = null;
      }
      polyPoints.current = [];
      isPolyDrawing.current = false;
      canvas.renderAll();
      return;
    }

    if (polyPreviewLine.current) {
      canvas.remove(polyPreviewLine.current);
      polyPreviewLine.current = null;
    }

    if (isArrow && polyPoints.current.length >= 2) {
      const pts = polyPoints.current;
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      const dx = last.x - prev.x;
      const dy = last.y - prev.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        const angle = Math.atan2(dy, dx);
        const head = new fabric.Triangle({
          left: last.x,
          top: last.y,
          width: 12,
          height: 12,
          fill: drawStrokeColor.current,
          angle: (angle * 180) / Math.PI + 90,
          originX: "center",
          originY: "center",
          selectable: false,
          evented: false,
        });
        canvas.add(head);
      }
    }

    polyPoints.current = [];
    isPolyDrawing.current = false;
    pushCanvasState(canvas);
    canvas.renderAll();
  }, []);

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

        // Keep the old viewport center stable in the new viewport
        const centerSceneX = (oldW / 2 - vpt[4]) / oldZoom;
        const centerSceneY = (oldH / 2 - vpt[5]) / oldZoom;
        const panX = width / 2 - centerSceneX * newZoom;
        const panY = height / 2 - centerSceneY * newZoom;

        c.setViewportTransform([newZoom, 0, 0, newZoom, panX, panY]);
        useCanvasStore.getState().setZoomLevel(newZoom);
      }

      prevSize.current = { width, height };
      c.renderAll();
    };

    const observer = new ResizeObserver(resize);
    if (containerRef.current) observer.observe(containerRef.current);
    resize();

    pushCanvasState(canvas);
    canvas.on("object:modified", () => pushCanvasState(canvas));
    canvas.on("object:removed", () => pushCanvasState(canvas));

    // --- Handle image drop ---
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      if (!e.dataTransfer?.files.length) return;

      const file = e.dataTransfer.files[0];
      if (!file.type.startsWith("image/")) return;

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const imgEl = new Image();
        imgEl.onload = () => {
          const img = new fabric.Image(imgEl, {
            left: e.offsetX ?? 100,
            top: e.offsetY ?? 100,
          });
          // Scale to reasonable size (max 300px wide)
          const maxW = 300;
          if (img.width && img.width > maxW) {
            img.scaleToWidth(maxW);
          }
          // Store file path — Tauri webview may expose full path via .path
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
      // Pan with space+click or middle mouse button
      const rawEvent = opt.e as MouseEvent;
      if (spacePressed.current || rawEvent.button === 1) {
        isPanning.current = true;
        lastPanPoint.current = { x: rawEvent.clientX, y: rawEvent.clientY };
        canvas.defaultCursor = "grabbing";
        return;
      }

      // Only handle left-click for drawing/selection (right-click handled by context menu)
      if (rawEvent.button !== 0) return;

      const tool = activeToolRef.current;
      if (tool === "select") return;

      const pointer = canvas.getScenePoint(opt.e);
      const stroke = strokeRef.current;
      const fill = fillRef.current;
      drawStrokeColor.current = stroke;

      // Multi-joint line/arrow
      if (tool === "line" || tool === "arrow") {
        if (!isPolyDrawing.current) {
          isPolyDrawing.current = true;
          polyPoints.current = [{ x: pointer.x, y: pointer.y }];
        } else {
          polyPoints.current.push({ x: pointer.x, y: pointer.y });
          polyPreviewLine.current = null;
        }

        const last = polyPoints.current[polyPoints.current.length - 1];
        const preview = new fabric.Line(
          [last.x, last.y, last.x, last.y],
          { stroke, strokeWidth: 2, selectable: false, evented: false }
        );
        canvas.add(preview);
        polyPreviewLine.current = preview;
        canvas.renderAll();
        return;
      }

      // Simple shapes
      isDrawing.current = true;
      startPoint.current = { x: pointer.x, y: pointer.y };

      let shape: fabric.FabricObject | null = null;

      switch (tool) {
        case "rectangle":
          shape = new fabric.Rect({
            left: pointer.x, top: pointer.y, width: 0, height: 0,
            fill, stroke, strokeWidth: 2,
          });
          break;
        case "circle":
          shape = new fabric.Circle({
            left: pointer.x, top: pointer.y, radius: 0,
            fill, stroke, strokeWidth: 2,
            originX: "center", originY: "center",
          });
          break;
        case "triangle":
          shape = new fabric.Triangle({
            left: pointer.x, top: pointer.y, width: 0, height: 0,
            fill, stroke, strokeWidth: 2,
          });
          break;
        case "text": {
          const text = new fabric.IText("Type here", {
            left: pointer.x, top: pointer.y, fontSize: 16,
            fill: stroke, fontFamily: "monospace",
          });
          canvas.add(text);
          canvas.setActiveObject(text);
          text.enterEditing();
          setActiveToolRef.current("select");
          pushCanvasState(canvas);
          return;
        }
      }

      if (shape) {
        (shape as fabric.FabricObject & { customLabel?: string }).customLabel = "";
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
        return;
      }

      const pointer = canvas.getScenePoint(opt.e);

      if (isPolyDrawing.current && polyPreviewLine.current) {
        polyPreviewLine.current.set({ x2: pointer.x, y2: pointer.y } as Partial<fabric.Line>);
        polyPreviewLine.current.setCoords();
        canvas.renderAll();
        return;
      }

      if (!isDrawing.current || !activeShape.current) return;
      const shape = activeShape.current;
      const sx = startPoint.current.x;
      const sy = startPoint.current.y;

      if (shape instanceof fabric.Rect || shape instanceof fabric.Triangle) {
        shape.set({
          left: Math.min(pointer.x, sx), top: Math.min(pointer.y, sy),
          width: Math.abs(pointer.x - sx), height: Math.abs(pointer.y - sy),
        });
      } else if (shape instanceof fabric.Circle) {
        const radius = Math.sqrt(Math.pow(pointer.x - sx, 2) + Math.pow(pointer.y - sy, 2));
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
      if (isPolyDrawing.current) return;
      if (!isDrawing.current) return;
      isDrawing.current = false;
      if (activeShape.current) {
        activeShape.current.setCoords();
        activeShape.current = null;
        pushCanvasState(canvas);
      }
    });

    canvas.on("mouse:dblclick", (opt: TPointerEventInfo<TPointerEvent>) => {
      if (isPolyDrawing.current) {
        finishPolyline(canvas, activeToolRef.current === "arrow");
        return;
      }

      const target = canvas.findTarget(opt.e);
      if (target && !(target instanceof fabric.IText) && !(target instanceof fabric.Textbox)) {
        const bounds = target.getBoundingRect();
        const label = new fabric.IText("Label", {
          left: bounds.left + bounds.width / 2,
          top: bounds.top + bounds.height / 2,
          fontSize: 14, fill: "#d0d0d0", fontFamily: "monospace",
          originX: "center", originY: "center", textAlign: "center",
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
        if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
          e.preventDefault();
          spacePressed.current = true;
          c.defaultCursor = "grab";
          c.selection = false;
          c.forEachObject((obj) => {
            obj.evented = false;
          });
        }
      }

      if (isPolyDrawing.current && (e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault();
        if (e.key === "Escape") {
          if (polyPreviewLine.current) c.remove(polyPreviewLine.current);
          polyPreviewLine.current = null;
          polyPoints.current = [];
          isPolyDrawing.current = false;
          c.renderAll();
        } else {
          finishPolyline(c, activeToolRef.current === "arrow");
        }
        return;
      }

      // Arrow keys = move selected object(s), Shift = 10px steps
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        const active = c.getActiveObject();
        if (!active) return;
        if (active instanceof fabric.IText && active.isEditing) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        switch (e.key) {
          case "ArrowUp":    active.top! -= step; break;
          case "ArrowDown":  active.top! += step; break;
          case "ArrowLeft":  active.left! -= step; break;
          case "ArrowRight": active.left! += step; break;
        }
        active.setCoords();
        c.renderAll();
        pushCanvasState(c);
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        const active = c.getActiveObject();
        if (!active) return;
        // Don't delete while editing text
        if (active instanceof fabric.IText && active.isEditing) return;
        // Handle ActiveSelection (multi-select cluster)
        if (active instanceof fabric.ActiveSelection) {
          const objects = active.getObjects();
          c.discardActiveObject();
          objects.forEach((obj) => c.remove(obj));
        } else {
          c.remove(active);
          c.discardActiveObject();
        }
        c.renderAll();
        pushCanvasState(c);
      }

      // Copy (Cmd/Ctrl+C)
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && !e.shiftKey) {
        const canvasEl = canvasRef.current;
        if (canvasEl && canvasEl.closest(".canvas-drawer")?.contains(document.activeElement as Node | null)) {
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
              // All cloned — no action needed yet, paste will use clipboard
            });
          });
        }
      }

      // Paste (Cmd/Ctrl+V)
      if ((e.metaKey || e.ctrlKey) && e.key === "v" && !e.shiftKey) {
        const canvasEl = canvasRef.current;
        if (canvasEl && canvasEl.closest(".canvas-drawer")?.contains(document.activeElement as Node | null)) {
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
                // Update clipboard positions so next paste offsets further
                clipboard = clones;
              }
            });
          });
        }
      }

      if (e.key === "Escape") {
        c.discardActiveObject();
        c.renderAll();
        setActiveToolRef.current("select");
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        const canvasEl = canvasRef.current;
        if (canvasEl && canvasEl.closest(".canvas-drawer")?.contains(document.activeElement as Node | null)) {
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
        if (canvasEl && canvasEl.closest(".canvas-drawer")?.contains(document.activeElement as Node | null)) {
          e.preventDefault();
          e.stopPropagation();
          undoCanvas(c);
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "z" && e.shiftKey) {
        const canvasEl = canvasRef.current;
        if (canvasEl && canvasEl.closest(".canvas-drawer")?.contains(document.activeElement as Node | null)) {
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
        // Zoom toward cursor
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
          (y - vpt[5]) / vpt[3]
        );
        canvas.zoomToPoint(point, newZoom);
        canvas.renderAll();
        useCanvasStore.getState().setZoomLevel(newZoom);
      } else {
        // Pan with scroll wheel
        const vpt = canvas.viewportTransform;
        vpt[4] -= e.deltaX;
        vpt[5] -= e.deltaY;
        canvas.setViewportTransform(vpt);
        canvas.renderAll();
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
  }, [finishPolyline]);

  useEffect(() => {
    const cleanup = initCanvas();
    return () => cleanup?.();
  }, [initCanvas]);

  // Reset polyline and update selection mode on tool change
  useEffect(() => {
    if (!fabricRef.current) return;
    const c = fabricRef.current;

    if (isPolyDrawing.current) {
      if (polyPreviewLine.current) {
        c.remove(polyPreviewLine.current);
        polyPreviewLine.current = null;
      }
      if (polyPoints.current.length >= 2) {
        pushCanvasState(c);
      }
      polyPoints.current = [];
      isPolyDrawing.current = false;
    }

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
