import {
  MousePointer2,
  Square,
  Circle,
  Triangle,
  Minus,
  MoveRight,
  Type,
  MessageSquareText,
  CornerDownRight,
  ImagePlus,
  Upload,
  Download,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import * as fabric from "fabric";
import {
  useCanvasStore,
  CANVAS_COLORS,
  pushCanvasState,
} from "../../stores/canvasStore";
import type { ShapeTool } from "../../types/canvas";

const tools: { tool: ShapeTool; icon: React.ReactNode; label: string }[] = [
  { tool: "select", icon: <MousePointer2 size={16} />, label: "Select" },
  { tool: "rectangle", icon: <Square size={16} />, label: "Rectangle" },
  { tool: "circle", icon: <Circle size={16} />, label: "Circle" },
  { tool: "triangle", icon: <Triangle size={16} />, label: "Triangle" },
  { tool: "line", icon: <Minus size={16} />, label: "Line" },
  { tool: "arrow", icon: <MoveRight size={16} />, label: "Arrow" },
  { tool: "leaderLine", icon: <CornerDownRight size={16} />, label: "Leader Line" },
  { tool: "text", icon: <Type size={16} />, label: "Text" },
  { tool: "promptText", icon: <MessageSquareText size={16} />, label: "Prompt Text" },
];

interface ToolbarProps {
  onExportToTerminal?: () => void;
  onImportIntoCanvas?: () => void;
  isWaitingForImport?: boolean;
}

export function Toolbar({ onExportToTerminal, onImportIntoCanvas, isWaitingForImport }: ToolbarProps) {
  const {
    activeTool, setActiveTool,
    strokeColor, fillColor, colorMode,
    setStrokeColor, setFillColor, setColorMode,
    fabricCanvas,
  } = useCanvasStore();

  const activeColor = colorMode === "stroke" ? strokeColor : fillColor;

  const handleColorPick = (color: string) => {
    if (colorMode === "stroke") {
      setStrokeColor(color === "transparent" ? "#cccccc" : color);
    } else {
      setFillColor(color);
    }

    if (fabricCanvas) {
      const active = fabricCanvas.getActiveObject();
      if (active) {
        if (colorMode === "stroke") {
          active.set("stroke", color === "transparent" ? "#cccccc" : color);
          if (active instanceof fabric.IText || active instanceof fabric.Textbox) {
            active.set("fill", color === "transparent" ? "#cccccc" : color);
          }
        } else {
          active.set("fill", color);
        }
        fabricCanvas.renderAll();
        pushCanvasState(fabricCanvas);
      }
    }
  };

  const handleImageInsert = async () => {
    if (!fabricCanvas) return;

    const result = await open({
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp"] }],
      multiple: false,
    });

    if (!result) return;

    // result is the full file path (e.g. /path/to/screenshot.png)
    const fullPath = typeof result === "string" ? result : result;

    // Read the file via Rust and get base64 data
    const dataUrl = await invoke<string>("read_image_as_data_url", { path: fullPath });

    const imgEl = new Image();
    imgEl.onload = () => {
      const img = new fabric.Image(imgEl, { left: 50, top: 50 });
      if (img.width && img.width > 300) img.scaleToWidth(300);
      // Store FULL path for AI CLI tools to access
      (img as fabric.FabricObject & { filePath?: string }).filePath = fullPath;
      fabricCanvas.add(img);
      fabricCanvas.setActiveObject(img);
      fabricCanvas.renderAll();
      pushCanvasState(fabricCanvas);
      setActiveTool("select");
    };
    imgEl.src = dataUrl;
  };

  return (
    <div className="flex flex-col items-center gap-1 p-2 bg-surface-light border-r border-surface-lighter w-12">
      {tools.map(({ tool, icon, label }) => (
        <button
          key={tool}
          title={label}
          className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${
            activeTool === tool
              ? "bg-surface-lighter text-white"
              : "text-text-muted hover:bg-surface-lighter hover:text-text"
          }`}
          onClick={() => setActiveTool(tool)}
        >
          {icon}
        </button>
      ))}

      {/* Image insert */}
      <button
        title="Insert Image"
        className="w-8 h-8 flex items-center justify-center rounded text-text-muted hover:bg-surface-lighter hover:text-text transition-colors"
        onClick={handleImageInsert}
      >
        <ImagePlus size={16} />
      </button>

      {/* Stroke / Fill toggle */}
      <div className="w-8 h-px bg-surface-lighter my-1" />
      <div className="flex flex-col items-center gap-1 w-full">
        <button
          title="Stroke (border) color"
          className={`w-8 h-5 rounded text-[8px] font-bold flex items-center justify-center transition-all ${
            colorMode === "stroke"
              ? "ring-1 ring-white text-white"
              : "text-text-dim hover:text-text-muted"
          }`}
          onClick={() => setColorMode("stroke")}
        >
          <div
            className="w-5 h-3 rounded-sm border-2"
            style={{ borderColor: strokeColor, backgroundColor: "transparent" }}
          />
        </button>
        <button
          title="Fill (background) color"
          className={`w-8 h-5 rounded text-[8px] font-bold flex items-center justify-center transition-all ${
            colorMode === "fill"
              ? "ring-1 ring-white text-white"
              : "text-text-dim hover:text-text-muted"
          }`}
          onClick={() => setColorMode("fill")}
        >
          <div
            className="w-5 h-3 rounded-sm"
            style={{
              backgroundColor: fillColor === "transparent" ? undefined : fillColor,
              border: fillColor === "transparent" ? "1px dashed #666" : "1px solid #666",
            }}
          />
        </button>
      </div>

      {/* Color palette */}
      <div className="grid grid-cols-2 gap-0.5 mt-1">
        {CANVAS_COLORS.map((color) => (
          <button
            key={color}
            title={color === "transparent" ? "None" : color}
            className={`w-3.5 h-3.5 rounded-sm border transition-transform ${
              activeColor === color
                ? "border-white scale-125"
                : "border-surface-lighter hover:scale-110"
            }`}
            style={{ backgroundColor: color === "transparent" ? undefined : color }}
            onClick={() => handleColorPick(color)}
          >
            {color === "transparent" && (
              <div className="w-full h-full relative flex items-center justify-center">
                <div className="w-2.5 h-px bg-red-400 rotate-45 absolute" />
              </div>
            )}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {/* Import into Canvas — request AI image and auto-render */}
      <button
        title={isWaitingForImport ? "Waiting for AI response... (click to cancel)" : "Import into Canvas"}
        className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${
          isWaitingForImport
            ? "text-green-400 animate-pulse bg-surface-lighter"
            : "text-white/60 hover:text-white hover:bg-surface-lighter"
        }`}
        onClick={onImportIntoCanvas}
      >
        <Download size={16} />
      </button>

      {/* Export to Terminal — snapshot canvas and write path to terminal */}
      <button
        title="Export to Terminal"
        className="w-8 h-8 flex items-center justify-center rounded text-white/60 hover:text-white hover:bg-surface-lighter transition-colors"
        onClick={onExportToTerminal}
      >
        <Upload size={16} />
      </button>
    </div>
  );
}
