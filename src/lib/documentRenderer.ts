import html2canvas from "html2canvas";
import { RENDER_STYLES, renderResponseToDataUrl } from "./responseRenderer";

export type DocumentFormat =
  | "pdf"
  | "docx"
  | "xlsx"
  | "xls"
  | "csv"
  | "tsv"
  | "hwp"
  | "hwpx";

export interface DocumentPage {
  dataUrl: string;
  pageNumber: number;
}

export interface DocumentRenderResult {
  pages: DocumentPage[];
  format: DocumentFormat;
  pageCount: number;
}

const SUPPORTED_EXTENSIONS: DocumentFormat[] = [
  "pdf", "docx", "xlsx", "xls", "csv", "tsv", "hwp", "hwpx",
];

export function getDocumentExtensions(): string[] {
  return [...SUPPORTED_EXTENSIONS];
}

export function isDocumentFile(ext: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(ext.toLowerCase() as DocumentFormat);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function renderPdf(data: ArrayBuffer): Promise<DocumentPage[]> {
  const pdfjsLib = await import("pdfjs-dist");

  // Use bundled worker
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages: DocumentPage[] = [];
  const scale = 2; // High DPI rendering

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d")!;

    // White background for PDF pages
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    pages.push({ dataUrl: canvas.toDataURL("image/png"), pageNumber: i });
  }

  return pages;
}

async function renderDocx(data: ArrayBuffer): Promise<DocumentPage[]> {
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml({ arrayBuffer: data });
  const html = result.value;

  const dataUrl = await renderHtmlToDataUrl(html);
  return [{ dataUrl, pageNumber: 1 }];
}

async function renderXlsx(data: ArrayBuffer): Promise<DocumentPage[]> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(data, { type: "array" });
  const pages: DocumentPage[] = [];

  for (let i = 0; i < workbook.SheetNames.length; i++) {
    const sheetName = workbook.SheetNames[i];
    const sheet = workbook.Sheets[sheetName];
    const htmlTable = XLSX.utils.sheet_to_html(sheet);

    const styledHtml = `
      <div style="margin-bottom: 8px; font-weight: bold; color: #e0e0e0; font-size: 14px;">
        Sheet: ${sheetName}
      </div>
      ${htmlTable}
    `;

    const dataUrl = await renderHtmlToDataUrl(styledHtml);
    pages.push({ dataUrl, pageNumber: i + 1 });
  }

  return pages;
}

async function renderCsv(data: ArrayBuffer): Promise<DocumentPage[]> {
  const text = new TextDecoder().decode(data);
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(text, { type: "string" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const htmlTable = XLSX.utils.sheet_to_html(sheet);

  const dataUrl = await renderHtmlToDataUrl(htmlTable);
  return [{ dataUrl, pageNumber: 1 }];
}

async function renderHwp(data: ArrayBuffer): Promise<DocumentPage[]> {
  try {
    const { Viewer } = await import("hwp.js");

    // Use A4-width container (210mm ≈ 794px at 96dpi) with overflow visible
    const container = document.createElement("div");
    container.style.cssText =
      "position:fixed;top:-9999px;left:-9999px;width:900px;background:#ffffff;overflow:visible;";
    document.body.appendChild(container);

    try {
      // HWP Viewer renders into the container
      new Viewer(container, new Uint8Array(data), { type: "array" });

      // Wait for rendering to complete
      await new Promise((r) => setTimeout(r, 500));

      // Try to capture individual page elements for multi-page support
      // hwp.js sets [data-page-number] on page divs AND child .hwpjs-observer elements.
      // Select only the page containers (which are NOT .hwpjs-observer).
      const pageElements = container.querySelectorAll("[data-page-number]:not(.hwpjs-observer)");
      if (pageElements.length > 0) {
        const pages: DocumentPage[] = [];
        for (let i = 0; i < pageElements.length; i++) {
          const pageEl = pageElements[i] as HTMLElement;
          const canvas = await html2canvas(pageEl, {
            backgroundColor: "#ffffff",
            scale: window.devicePixelRatio,
            useCORS: true,
            width: Math.max(pageEl.scrollWidth, pageEl.offsetWidth),
            height: Math.max(pageEl.scrollHeight, pageEl.offsetHeight),
          });
          pages.push({ dataUrl: canvas.toDataURL("image/png"), pageNumber: i + 1 });
        }
        return pages;
      }

      // Fallback: capture the full container with dynamic sizing
      const captureWidth = Math.max(container.scrollWidth, container.offsetWidth);
      const captureHeight = Math.max(container.scrollHeight, container.offsetHeight);
      const canvas = await html2canvas(container, {
        backgroundColor: "#ffffff",
        scale: window.devicePixelRatio,
        useCORS: true,
        width: captureWidth,
        height: captureHeight,
        windowWidth: captureWidth,
      });
      const dataUrl = canvas.toDataURL("image/png");
      return [{ dataUrl, pageNumber: 1 }];
    } finally {
      document.body.removeChild(container);
    }
  } catch (err) {
    const errorMsg = `# Unable to render HWP file\n\nThe document could not be parsed. Error: ${err instanceof Error ? err.message : String(err)}`;
    const dataUrl = await renderResponseToDataUrl(errorMsg);
    return [{ dataUrl, pageNumber: 1 }];
  }
}

async function renderHtmlToDataUrl(htmlContent: string): Promise<string> {
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;top:-9999px;left:-9999px;width:900px;padding:24px;background:#1e1e1e;overflow:visible;";

  const style = document.createElement("style");
  style.textContent = RENDER_STYLES;
  container.appendChild(style);

  const inner = document.createElement("div");
  inner.innerHTML = htmlContent;
  container.appendChild(inner);

  document.body.appendChild(container);

  try {
    // Measure actual content size to avoid clipping
    const captureWidth = Math.max(container.scrollWidth, container.offsetWidth);
    const captureHeight = Math.max(container.scrollHeight, container.offsetHeight);
    const canvas = await html2canvas(container, {
      backgroundColor: "#1e1e1e",
      scale: window.devicePixelRatio,
      useCORS: true,
      width: captureWidth,
      height: captureHeight,
      windowWidth: captureWidth,
    });
    return canvas.toDataURL("image/png");
  } finally {
    document.body.removeChild(container);
  }
}

async function renderHwpx(data: ArrayBuffer): Promise<DocumentPage[]> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(data);

    // Try extracting the embedded preview image first (most HWPX files include one)
    const preview = zip.file("Preview/PrvImage.png") || zip.file("Preview/PrvImage.jpg");
    if (preview) {
      const blob = await preview.async("blob");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      return [{ dataUrl, pageNumber: 1 }];
    }

    // Fallback: extract text from section XML files and render as HTML
    const sectionFiles = Object.keys(zip.files)
      .filter((name) => /Contents\/section\d+\.xml$/i.test(name))
      .sort();

    if (sectionFiles.length > 0) {
      let extractedText = "";
      for (const sectionFile of sectionFiles) {
        const xml = await zip.file(sectionFile)!.async("string");
        // Extract text content from OWPML XML tags
        const textMatches = xml.match(/<hp:t[^>]*>([^<]*)<\/hp:t>/g);
        if (textMatches) {
          for (const match of textMatches) {
            const text = match.replace(/<[^>]+>/g, "");
            extractedText += text;
          }
          extractedText += "\n";
        }
      }

      if (extractedText.trim()) {
        const html = `<pre style="white-space:pre-wrap;word-break:break-word;color:#d4d4d4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;">${extractedText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
        const dataUrl = await renderHtmlToDataUrl(html);
        return [{ dataUrl, pageNumber: 1 }];
      }
    }

    // Last resort: show unsupported message
    const errorMsg = "# HWPX Document\n\nThis HWPX file does not contain a preview image and text extraction was not possible.";
    const dataUrl = await renderResponseToDataUrl(errorMsg);
    return [{ dataUrl, pageNumber: 1 }];
  } catch (err) {
    const errorMsg = `# Unable to render HWPX file\n\nError: ${err instanceof Error ? err.message : String(err)}`;
    const dataUrl = await renderResponseToDataUrl(errorMsg);
    return [{ dataUrl, pageNumber: 1 }];
  }
}

export async function renderDocument(
  base64Data: string,
  format: DocumentFormat,
): Promise<DocumentRenderResult> {
  const data = base64ToArrayBuffer(base64Data);
  let pages: DocumentPage[];

  switch (format) {
    case "pdf":
      pages = await renderPdf(data);
      break;
    case "docx":
      pages = await renderDocx(data);
      break;
    case "xlsx":
    case "xls":
      pages = await renderXlsx(data);
      break;
    case "csv":
    case "tsv":
      pages = await renderCsv(data);
      break;
    case "hwp":
      pages = await renderHwp(data);
      break;
    case "hwpx":
      pages = await renderHwpx(data);
      break;
    default:
      throw new Error(`Unsupported document format: ${format}`);
  }

  return { pages, format, pageCount: pages.length };
}
