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
  renderMode?: "styled" | "preview" | "text-only";
}

interface HtmlRenderOptions {
  backgroundColor?: string;
  width?: number;
  padding?: number;
  pageHeight?: number;
  customStyles?: string;
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

async function nextAnimationFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
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

  return renderHtmlToPages(html);
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

    const sheetPages = await renderHtmlToPages(styledHtml);
    pages.push(...sheetPages.map((page) => ({
      ...page,
      pageNumber: pages.length + page.pageNumber,
    })));
  }

  return pages;
}

async function renderCsv(data: ArrayBuffer): Promise<DocumentPage[]> {
  const text = new TextDecoder().decode(data);
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(text, { type: "string" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const htmlTable = XLSX.utils.sheet_to_html(sheet);

  return renderHtmlToPages(htmlTable);
}

async function captureElementAsPages(
  element: HTMLElement,
  bgColor: string,
  pageHeight: number,
): Promise<DocumentPage[]> {
  const elWidth = Math.max(element.scrollWidth, element.offsetWidth);
  const elHeight = Math.max(element.scrollHeight, element.offsetHeight);

  if (elHeight <= pageHeight) {
    const canvas = await html2canvas(element, {
      backgroundColor: bgColor,
      scale: window.devicePixelRatio,
      useCORS: true,
      width: elWidth,
      height: elHeight,
    });
    return [{ dataUrl: canvas.toDataURL("image/png"), pageNumber: 1 }];
  }

  // Content taller than one page — use a clipping viewport to paginate
  const viewport = document.createElement("div");
  viewport.style.cssText = [
    "position:fixed",
    "top:-9999px",
    "left:-9999px",
    `width:${elWidth}px`,
    `height:${pageHeight}px`,
    `background:${bgColor}`,
    "overflow:hidden",
  ].join(";");

  // Re-parent the element into the viewport wrapper
  const parent = element.parentElement;
  const nextSibling = element.nextSibling;
  element.style.transformOrigin = "top left";
  viewport.appendChild(element);
  document.body.appendChild(viewport);

  try {
    const totalPages = Math.max(Math.ceil(elHeight / pageHeight), 1);
    const pages: DocumentPage[] = [];

    for (let i = 0; i < totalPages; i++) {
      element.style.transform = `translateY(-${i * pageHeight}px)`;
      await nextAnimationFrame();

      const canvas = await html2canvas(viewport, {
        backgroundColor: bgColor,
        scale: window.devicePixelRatio,
        useCORS: true,
        width: elWidth,
        height: pageHeight,
        windowWidth: elWidth,
        windowHeight: pageHeight,
      });
      pages.push({ dataUrl: canvas.toDataURL("image/png"), pageNumber: i + 1 });
    }

    return pages;
  } finally {
    // Restore element to original DOM position
    element.style.transform = "";
    element.style.transformOrigin = "";
    if (parent) {
      parent.insertBefore(element, nextSibling);
    }
    document.body.removeChild(viewport);
  }
}

async function renderHwp(data: ArrayBuffer): Promise<DocumentPage[]> {
  try {
    const { Viewer } = await import("hwp.js");

    const container = document.createElement("div");
    container.style.cssText =
      "position:fixed;top:-9999px;left:-9999px;width:900px;background:#ffffff;overflow:visible;";
    document.body.appendChild(container);

    try {
      new Viewer(container, new Uint8Array(data), { type: "array" });

      // hwp.js renders synchronously in the constructor, but give the
      // browser one frame to lay out the elements before measuring.
      await nextAnimationFrame();
      await new Promise((r) => setTimeout(r, 300));

      // hwp.js creates one page div per section (data-page-number attr).
      // A single section may contain content taller than one visual page,
      // so we paginate each page element individually.
      const pageElements = container.querySelectorAll("[data-page-number]:not(.hwpjs-observer)");
      const A4_HEIGHT = 1123; // A4 at 96dpi ≈ 1123px

      if (pageElements.length > 0) {
        const allPages: DocumentPage[] = [];
        for (let i = 0; i < pageElements.length; i++) {
          const pageEl = pageElements[i] as HTMLElement;
          const sectionPages = await captureElementAsPages(pageEl, "#ffffff", A4_HEIGHT);
          allPages.push(...sectionPages.map((p) => ({
            ...p,
            pageNumber: allPages.length + p.pageNumber,
          })));
        }
        return allPages;
      }

      // Fallback: paginate the full container
      const contentEl = container.querySelector("div[style*='overflow']") as HTMLElement || container;
      const fallbackPages = await captureElementAsPages(contentEl, "#ffffff", A4_HEIGHT);
      return fallbackPages;
    } finally {
      document.body.removeChild(container);
    }
  } catch (err) {
    const errorMsg = `# Unable to render HWP file\n\nThe document could not be parsed. Error: ${err instanceof Error ? err.message : String(err)}`;
    const dataUrl = await renderResponseToDataUrl(errorMsg);
    return [{ dataUrl, pageNumber: 1 }];
  }
}

async function renderHtmlToPages(
  htmlContent: string,
  options: HtmlRenderOptions = {},
): Promise<DocumentPage[]> {
  const {
    backgroundColor = "#1e1e1e",
    width = 900,
    padding = 24,
    pageHeight = 1280,
  } = options;

  const viewport = document.createElement("div");
  viewport.style.cssText = [
    "position:fixed",
    "top:-9999px",
    "left:-9999px",
    `width:${width}px`,
    `height:${pageHeight}px`,
    `padding:${padding}px`,
    `background:${backgroundColor}`,
    "overflow:hidden",
    "box-sizing:border-box",
  ].join(";");

  const style = document.createElement("style");
  style.textContent = options.customStyles ?? RENDER_STYLES;
  viewport.appendChild(style);

  const inner = document.createElement("div");
  inner.innerHTML = htmlContent;
  inner.style.transformOrigin = "top left";
  viewport.appendChild(inner);

  document.body.appendChild(viewport);

  try {
    await nextAnimationFrame();

    const pageContentHeight = Math.max(pageHeight - padding * 2, 1);
    const innerHeight = Math.max(inner.scrollHeight, inner.offsetHeight, pageContentHeight);
    const pageCount = Math.max(Math.ceil(innerHeight / pageContentHeight), 1);
    const pages: DocumentPage[] = [];

    for (let i = 0; i < pageCount; i++) {
      inner.style.transform = `translateY(-${i * pageContentHeight}px)`;
      await nextAnimationFrame();

      const canvas = await html2canvas(viewport, {
        backgroundColor,
        scale: window.devicePixelRatio,
        useCORS: true,
        width,
        height: pageHeight,
        windowWidth: width,
        windowHeight: pageHeight,
      });

      pages.push({ dataUrl: canvas.toDataURL("image/png"), pageNumber: i + 1 });
    }

    return pages;
  } finally {
    document.body.removeChild(viewport);
  }
}

function collectElementsByLocalName(root: ParentNode, localName: string): Element[] {
  const matches: Element[] = [];
  const allElements = root.querySelectorAll("*");

  for (const element of allElements) {
    if (element.localName === localName) {
      matches.push(element);
    }
  }

  return matches;
}

// --- HWPX styled rendering types & constants ---

interface HwpxCharStyle {
  fontSize?: string;
  fontWeight?: string;
  fontStyle?: string;
  color?: string;
  textDecoration?: string;
  fontFamily?: string;
}

interface HwpxParaStyle {
  textAlign?: string;
  lineHeight?: string;
  textIndent?: string;
  marginLeft?: string;
  marginRight?: string;
  marginTop?: string;
  marginBottom?: string;
}

interface HwpxStyles {
  charStyles: Map<number, HwpxCharStyle>;
  paraStyles: Map<number, HwpxParaStyle>;
  fonts: Map<string, Map<number, string>>;
}

const HWPX_DOC_STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root { color: #000; font-family: '맑은 고딕', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans CJK KR', sans-serif; font-size: 10pt; line-height: 1.6; }
  p { margin: 0.15em 0; min-height: 1em; }
  table { border-collapse: collapse; width: 100%; margin: 0.3em 0; }
  td, th { border: 1px solid #000; padding: 4px 6px; vertical-align: top; font-size: inherit; }
  img { max-width: 100%; }
`;

const CJK_FONT_FALLBACK = "'맑은 고딕','Malgun Gothic','Apple SD Gothic Neo','Noto Sans CJK KR',sans-serif";

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseHwpxHeader(headerXml: string): HwpxStyles {
  const doc = new DOMParser().parseFromString(headerXml, "application/xml");
  if (doc.querySelector("parsererror")) {
    return { charStyles: new Map(), paraStyles: new Map(), fonts: new Map() };
  }

  // 1. Parse fontfaces → Map<lang, Map<id, faceName>>
  const fonts = new Map<string, Map<number, string>>();
  for (const fontface of collectElementsByLocalName(doc, "fontface")) {
    const lang = fontface.getAttribute("lang") || "HANGUL";
    const langMap = new Map<number, string>();
    for (const font of collectElementsByLocalName(fontface, "font")) {
      const id = parseInt(font.getAttribute("id") || "0", 10);
      const face = font.getAttribute("face") || "";
      if (face) langMap.set(id, face);
    }
    fonts.set(lang, langMap);
  }

  // 2. Parse charProperties → Map<id, HwpxCharStyle>
  const charStyles = new Map<number, HwpxCharStyle>();
  for (const charPr of collectElementsByLocalName(doc, "charPr")) {
    const id = parseInt(charPr.getAttribute("id") || "0", 10);
    const height = charPr.getAttribute("height");
    const textColor = charPr.getAttribute("textColor");
    const hasBold = collectElementsByLocalName(charPr, "bold").length > 0;
    const hasItalic = collectElementsByLocalName(charPr, "italic").length > 0;

    const underlineEl = collectElementsByLocalName(charPr, "underline")[0];
    const underlineType = underlineEl?.getAttribute("type") || "NONE";
    const hasUnderline = underlineType !== "NONE" && underlineType !== "";

    const strikeEl = collectElementsByLocalName(charPr, "strikeout")[0];
    const strikeShape = strikeEl?.getAttribute("shape") || "NONE";
    const hasStrike = strikeShape !== "NONE" && strikeShape !== "";

    const decorations: string[] = [];
    if (hasUnderline) decorations.push("underline");
    if (hasStrike) decorations.push("line-through");

    // Resolve font face via fontRef → fontfaces lookup
    const fontRefEl = collectElementsByLocalName(charPr, "fontRef")[0];
    let fontFamily: string | undefined;
    if (fontRefEl) {
      const hangulId = parseInt(fontRefEl.getAttribute("hangul") || "0", 10);
      const latinId = parseInt(fontRefEl.getAttribute("latin") || "0", 10);
      const hangulFont = fonts.get("HANGUL")?.get(hangulId);
      const latinFont = fonts.get("LATIN")?.get(latinId);
      const primaryFont = hangulFont || latinFont;
      if (primaryFont) {
        fontFamily = `'${primaryFont}',${CJK_FONT_FALLBACK}`;
      }
    }

    charStyles.set(id, {
      fontSize: height ? `${parseInt(height, 10) / 100}pt` : undefined,
      fontWeight: hasBold ? "bold" : undefined,
      fontStyle: hasItalic ? "italic" : undefined,
      color: textColor && textColor !== "#000000" && textColor !== "none" ? textColor : undefined,
      textDecoration: decorations.length > 0 ? decorations.join(" ") : undefined,
      fontFamily,
    });
  }

  // 3. Parse paraProperties → Map<id, HwpxParaStyle>
  const paraStyles = new Map<number, HwpxParaStyle>();
  for (const paraPr of collectElementsByLocalName(doc, "paraPr")) {
    const id = parseInt(paraPr.getAttribute("id") || "0", 10);

    const alignEl = collectElementsByLocalName(paraPr, "align")[0];
    const horizontal = alignEl?.getAttribute("horizontal");

    const lineSpacingEl = collectElementsByLocalName(paraPr, "lineSpacing")[0];
    const lsType = lineSpacingEl?.getAttribute("type") || "PERCENT";
    const lsValue = parseInt(lineSpacingEl?.getAttribute("value") || "160", 10);

    const marginEl = collectElementsByLocalName(paraPr, "margin")[0];
    const indent = parseInt(marginEl?.getAttribute("indent") || "0", 10);
    const left = parseInt(marginEl?.getAttribute("left") || "0", 10);
    const right = parseInt(marginEl?.getAttribute("right") || "0", 10);
    const prev = parseInt(marginEl?.getAttribute("prev") || "0", 10);
    const next = parseInt(marginEl?.getAttribute("next") || "0", 10);

    // HWP margin/indent units: hundredths of a point (same as height)
    const toPoint = (v: number) => v !== 0 ? `${v / 100}pt` : undefined;

    let textAlign: string | undefined;
    if (horizontal) {
      const alignMap: Record<string, string> = {
        LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFY: "justify",
      };
      textAlign = alignMap[horizontal];
    }

    paraStyles.set(id, {
      textAlign,
      lineHeight: lsType === "PERCENT" && lsValue !== 160 ? String(lsValue / 100) : undefined,
      textIndent: toPoint(indent),
      marginLeft: toPoint(left),
      marginRight: toPoint(right),
      marginTop: toPoint(prev),
      marginBottom: toPoint(next),
    });
  }

  return { charStyles, paraStyles, fonts };
}

function charStyleToCss(style: HwpxCharStyle): string {
  const parts: string[] = [];
  if (style.fontSize) parts.push(`font-size:${style.fontSize}`);
  if (style.fontWeight) parts.push(`font-weight:${style.fontWeight}`);
  if (style.fontStyle) parts.push(`font-style:${style.fontStyle}`);
  if (style.color) parts.push(`color:${style.color}`);
  if (style.textDecoration) parts.push(`text-decoration:${style.textDecoration}`);
  if (style.fontFamily) parts.push(`font-family:${style.fontFamily}`);
  return parts.join(";");
}

function paraStyleToCss(style: HwpxParaStyle): string {
  const parts: string[] = [];
  if (style.textAlign) parts.push(`text-align:${style.textAlign}`);
  if (style.lineHeight) parts.push(`line-height:${style.lineHeight}`);
  if (style.textIndent) parts.push(`text-indent:${style.textIndent}`);
  if (style.marginLeft) parts.push(`margin-left:${style.marginLeft}`);
  if (style.marginRight) parts.push(`margin-right:${style.marginRight}`);
  if (style.marginTop) parts.push(`margin-top:${style.marginTop}`);
  if (style.marginBottom) parts.push(`margin-bottom:${style.marginBottom}`);
  return parts.join(";");
}

function extractRunText(runEl: Element): string {
  const parts: string[] = [];
  for (const t of collectElementsByLocalName(runEl, "t")) {
    // Walk child nodes to handle <tab/> and <lineBreak/> inline elements
    for (const child of Array.from(t.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        parts.push(escapeHtmlText(child.textContent ?? ""));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const ln = el.localName;
        if (ln === "tab") parts.push("&emsp;");
        else if (ln === "lineBreak" || ln === "linebreak") parts.push("<br/>");
      }
    }
  }
  return parts.join("");
}

function isInsideTableCell(el: Element): boolean {
  let parent = el.parentElement;
  while (parent) {
    if (parent.localName === "tc" || parent.localName === "tbl") return true;
    parent = parent.parentElement;
  }
  return false;
}

function convertParagraphToHtml(
  para: Element,
  styles: HwpxStyles,
  images: Map<string, string>,
): string {
  const paraPrId = parseInt(para.getAttribute("paraPrIDRef") || "-1", 10);
  const paraStyle = styles.paraStyles.get(paraPrId);
  const paraCss = paraStyle ? paraStyleToCss(paraStyle) : "";
  const paraStyleAttr = paraCss ? ` style="${paraCss}"` : "";

  // Use direct children only to avoid collecting runs from nested table cells
  const runs = directChildrenByLocalName(para, "run");
  const runHtmlParts: string[] = [];

  for (const run of runs) {
    if (collectElementsByLocalName(run, "secPr").length > 0) continue;

    // Handle tables nested inside runs
    const tables = directChildrenByLocalName(run, "tbl");
    if (tables.length > 0) {
      for (const tbl of tables) {
        runHtmlParts.push(convertTableToHtml(tbl, styles, images));
      }
      continue;
    }

    // Handle embedded images
    const pics = collectElementsByLocalName(run, "pic");
    if (pics.length > 0) {
      for (const pic of pics) {
        const imgHtml = convertPicToHtml(pic, images);
        if (imgHtml) runHtmlParts.push(imgHtml);
      }
      continue;
    }

    const charPrId = parseInt(run.getAttribute("charPrIDRef") || "-1", 10);
    const charStyle = styles.charStyles.get(charPrId);
    const text = extractRunText(run);

    if (!text) continue;

    if (charStyle) {
      const css = charStyleToCss(charStyle);
      if (css) {
        runHtmlParts.push(`<span style="${css}">${text}</span>`);
      } else {
        runHtmlParts.push(text);
      }
    } else {
      runHtmlParts.push(text);
    }
  }

  if (runHtmlParts.length > 0) {
    return `<p${paraStyleAttr}>${runHtmlParts.join("")}</p>`;
  }
  return `<p${paraStyleAttr}>&nbsp;</p>`;
}

function convertSectionToStyledHtml(
  sectionXml: string,
  styles: HwpxStyles,
  images: Map<string, string>,
): string {
  const doc = new DOMParser().parseFromString(sectionXml, "application/xml");
  if (doc.querySelector("parsererror")) return "";

  const htmlParts: string[] = [];
  const paragraphs = collectElementsByLocalName(doc, "p");

  for (const para of paragraphs) {
    // Skip paragraphs that are inside table cells — they are handled by convertTableToHtml
    if (isInsideTableCell(para)) continue;

    htmlParts.push(convertParagraphToHtml(para, styles, images));
  }

  return htmlParts.join("\n");
}

function directChildrenByLocalName(parent: Element, localName: string): Element[] {
  const matches: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (child.localName === localName) matches.push(child);
  }
  return matches;
}

function convertTableToHtml(tbl: Element, styles: HwpxStyles, images: Map<string, string>): string {
  const rows = directChildrenByLocalName(tbl, "tr");
  if (rows.length === 0) return "";

  const rowHtmlParts: string[] = [];
  for (const row of rows) {
    const cells = directChildrenByLocalName(row, "tc");
    const cellHtmlParts: string[] = [];

    for (const cell of cells) {
      const cellParas = collectElementsByLocalName(cell, "p");
      const cellContentParts: string[] = [];

      for (const para of cellParas) {
        cellContentParts.push(convertParagraphToHtml(para, styles, images));
      }

      cellHtmlParts.push(`<td>${cellContentParts.join("") || "&nbsp;"}</td>`);
    }

    rowHtmlParts.push(`<tr>${cellHtmlParts.join("")}</tr>`);
  }

  return `<table>${rowHtmlParts.join("")}</table>`;
}

function convertPicToHtml(pic: Element, images: Map<string, string>): string | null {
  // Look for binItem reference inside the picture element
  const binItems = collectElementsByLocalName(pic, "binItem");
  for (const binItem of binItems) {
    const src = binItem.getAttribute("src") || "";
    if (src && images.has(src)) {
      return `<img src="${images.get(src)}" style="max-width:100%;height:auto;"/>`;
    }
  }
  // Try to find fileRef or imgRef patterns
  const imgRefs = collectElementsByLocalName(pic, "img");
  for (const imgRef of imgRefs) {
    const binaryItemId = imgRef.getAttribute("binaryItemIDRef") || "";
    if (binaryItemId && images.has(binaryItemId)) {
      return `<img src="${images.get(binaryItemId)}" style="max-width:100%;height:auto;"/>`;
    }
  }
  return null;
}

async function extractHwpxImages(zip: import("jszip")): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  const binDataFiles = Object.keys(zip.files).filter(
    (name) => /^BinData\//i.test(name) && !zip.files[name].dir,
  );

  for (const filePath of binDataFiles) {
    try {
      const blob = await zip.file(filePath)!.async("blob");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      // Store with multiple key variants for flexible lookup
      const fileName = filePath.replace(/^BinData\//i, "");
      images.set(filePath, dataUrl);
      images.set(fileName, dataUrl);
      // Also store without extension for ID-based lookups
      const nameNoExt = fileName.replace(/\.[^.]+$/, "");
      images.set(nameNoExt, dataUrl);
    } catch {
      // Skip unreadable image files
    }
  }

  return images;
}

// Preserved for text-only fallback
function extractHwpxSectionText(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return "";

  const paragraphs = collectElementsByLocalName(doc, "p");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const textRuns = collectElementsByLocalName(paragraph, "t")
      .map((node) => node.textContent ?? "")
      .join("")
      .trim();
    if (textRuns) lines.push(textRuns);
  }

  return lines.join("\n\n").trim();
}

function buildPlainTextHtml(text: string): string {
  const escapedText = escapeHtmlText(text);
  return `<pre style="white-space:pre-wrap;word-break:break-word;color:#333;font-family:${CJK_FONT_FALLBACK};font-size:10pt;line-height:1.6;margin:0;">${escapedText}</pre>`;
}

interface HwpxRenderResult {
  pages: DocumentPage[];
  renderMode: "styled" | "preview" | "text-only";
}

async function renderHwpx(data: ArrayBuffer): Promise<HwpxRenderResult> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(data);

    // Find section files
    const sectionFiles = Object.keys(zip.files)
      .filter((name) => /Contents\/section\d+\.xml$/i.test(name))
      .sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
      );

    // Try styled rendering first
    if (sectionFiles.length > 0) {
      // Load header.xml for style definitions
      const headerFile = zip.file("Contents/header.xml") || zip.file("header.xml");
      let styles: HwpxStyles = { charStyles: new Map(), paraStyles: new Map(), fonts: new Map() };
      if (headerFile) {
        const headerXml = await headerFile.async("string");
        styles = parseHwpxHeader(headerXml);
      }

      // Extract embedded images from BinData/
      const images = await extractHwpxImages(zip);

      const pages: DocumentPage[] = [];
      let hasStyledContent = false;

      for (const sectionFile of sectionFiles) {
        const xml = await zip.file(sectionFile)!.async("string");

        // Try styled HTML conversion
        const styledHtml = convertSectionToStyledHtml(xml, styles, images);
        if (styledHtml) {
          hasStyledContent = true;
          const sectionPages = await renderHtmlToPages(styledHtml, {
            backgroundColor: "#ffffff",
            customStyles: HWPX_DOC_STYLES,
          });
          pages.push(...sectionPages.map((page) => ({
            ...page,
            pageNumber: pages.length + page.pageNumber,
          })));
        }
      }

      if (hasStyledContent && pages.length > 0) {
        return { pages, renderMode: "styled" };
      }
    }

    // Fallback 1: embedded preview image (better visual fidelity than text-only)
    const preview = zip.file("Preview/PrvImage.png") || zip.file("Preview/PrvImage.jpg");
    if (preview) {
      const blob = await preview.async("blob");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      return { pages: [{ dataUrl, pageNumber: 1 }], renderMode: "preview" };
    }

    // Fallback 2: text-only extraction
    if (sectionFiles.length > 0) {
      const textPages: DocumentPage[] = [];
      for (const sectionFile of sectionFiles) {
        const xml = await zip.file(sectionFile)!.async("string");
        const extractedText = extractHwpxSectionText(xml);
        if (!extractedText) continue;

        const html = buildPlainTextHtml(extractedText);
        const sectionPages = await renderHtmlToPages(html, {
          backgroundColor: "#ffffff",
          customStyles: HWPX_DOC_STYLES,
        });
        textPages.push(...sectionPages.map((page) => ({
          ...page,
          pageNumber: textPages.length + page.pageNumber,
        })));
      }

      if (textPages.length > 0) {
        return { pages: textPages, renderMode: "text-only" };
      }
    }

    // Last resort
    const errorMsg = "# HWPX Document\n\nThis HWPX file does not contain a preview image and text extraction was not possible.";
    const dataUrl = await renderResponseToDataUrl(errorMsg);
    return { pages: [{ dataUrl, pageNumber: 1 }], renderMode: "text-only" };
  } catch (err) {
    const errorMsg = `# Unable to render HWPX file\n\nError: ${err instanceof Error ? err.message : String(err)}`;
    const dataUrl = await renderResponseToDataUrl(errorMsg);
    return { pages: [{ dataUrl, pageNumber: 1 }], renderMode: "text-only" };
  }
}

export async function renderDocument(
  base64Data: string,
  format: DocumentFormat,
): Promise<DocumentRenderResult> {
  const data = base64ToArrayBuffer(base64Data);
  let pages: DocumentPage[];
  let renderMode: DocumentRenderResult["renderMode"];

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
    case "hwpx": {
      const result = await renderHwpx(data);
      pages = result.pages;
      renderMode = result.renderMode;
      break;
    }
    default:
      throw new Error(`Unsupported document format: ${format}`);
  }

  return { pages, format, pageCount: pages.length, renderMode };
}
