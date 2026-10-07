// PDF handling: download with verification, then text / section / reference
// extraction using the PDF.js build that ships inside `unpdf` (no native deps).

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config, ensureDirs } from "../config.js";
import { HttpError, request, userAgent } from "./http.js";

const PDF_MAGIC = "%PDF-";

export function isPdfBytes(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer.subarray(0, 5).toString("latin1") === PDF_MAGIC;
}

export function safeFilename(name, fallback = "paper") {
  const cleaned = String(name ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\.(pdf|PDF)$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/** A tidy file name: year-firstAuthor-keyword.pdf */
export function filenameFor(record) {
  const author = (record?.authors?.[0]?.name ?? "").split(/\s+/).at(-1) ?? "";
  const word = (String(record?.title ?? "").toLowerCase().match(/[a-z]{4,}/) ?? ["paper"])[0];
  const stem = [record?.year ?? "", author, word].filter(Boolean).join("-");
  return `${safeFilename(stem, "paper")}.pdf`;
}

/**
 * Download a PDF and prove it really is one.
 * Rejects HTML error pages, truncated files and oversized downloads.
 */
export async function downloadPdf(url, { dir = config.downloadDir, filename, maxMb = config.maxDownloadMb, signal } = {}) {
  ensureDirs();
  const targetDir = dir || config.downloadDir;
  await fsp.mkdir(targetDir, { recursive: true });

  const res = await request(url, {
    accept: "application/pdf,*/*;q=0.8",
    timeoutMs: Math.max(config.requestTimeoutMs, 60_000),
    retries: 2,
    redirect: "follow",
    signal,
    headers: { "user-agent": userAgent() },
  });

  if (!res.ok) {
    throw new HttpError(`PDF download failed: HTTP ${res.status}`, { status: res.status, url });
  }

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared && declared > maxMb * 1_048_576) {
    throw new Error(`PDF is ${(declared / 1_048_576).toFixed(1)} MB, above the ${maxMb} MB limit (raise PAPER_SEARCH_MAX_DOWNLOAD_MB to allow it).`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxMb * 1_048_576) {
    throw new Error(`PDF is larger than the ${maxMb} MB limit.`);
  }
  if (!isPdfBytes(buffer)) {
    const head = buffer.subarray(0, 200).toString("utf8").replace(/\s+/g, " ").trim();
    throw new Error(`That URL did not return a PDF (content-type: ${res.headers.get("content-type") ?? "unknown"}). It is probably a landing page or a paywall. Start of response: ${head.slice(0, 120)}`);
  }

  const name = safeFilename(filename ?? path.basename(new URL(res.url || url).pathname) ?? "paper");
  const finalName = name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
  const filePath = path.join(targetDir, finalName);
  await fsp.writeFile(filePath, buffer);

  return {
    path: filePath,
    bytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    final_url: res.url || url,
    pages: countPages(buffer),
  };
}

/** Cheap page count: count /Type /Page objects (good enough for reporting). */
function countPages(buffer) {
  try {
    const text = buffer.toString("latin1");
    const matches = text.match(/\/Type\s*\/Page[^s]/g);
    return matches ? matches.length : null;
  } catch {
    return null;
  }
}

async function loadPdfjs() {
  const unpdf = await import("unpdf");
  return unpdf;
}

/**
 * Extract text from a local PDF (or a URL that serves a PDF).
 * Returns { pages: [...], text, meta }.
 */
export async function extractText(source, { pages, maxChars = 0 } = {}) {
  const { getDocumentProxy, extractText: unpdfExtract, getMeta } = await loadPdfjs();

  let data;
  if (Buffer.isBuffer(source)) data = new Uint8Array(source);
  else if (/^https?:\/\//i.test(String(source))) {
    const res = await request(source, { accept: "application/pdf,*/*;q=0.8", timeoutMs: 60_000 });
    if (!res.ok) throw new HttpError(`Could not fetch PDF: HTTP ${res.status}`, { status: res.status, url: source });
    data = new Uint8Array(await res.arrayBuffer());
    if (!isPdfBytes(Buffer.from(data))) throw new Error("That URL did not return a PDF.");
  } else {
    data = new Uint8Array(await fsp.readFile(source));
  }

  const doc = await getDocumentProxy(data);
  const meta = await getMeta(doc).catch(() => null);

  const wanted = normalizePages(pages, doc.numPages);
  const pageTexts = [];
  for (const pageNumber of wanted) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => (typeof item.str === "string" ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pageTexts.push({ page: pageNumber, text });
  }

  let joined = pageTexts.map((p) => p.text).join("\n\n");
  if (maxChars && joined.length > maxChars) joined = `${joined.slice(0, maxChars)}…`;

  return {
    total_pages: doc.numPages,
    pages_read: wanted,
    meta: meta?.info ? pickMeta(meta.info) : undefined,
    pages: pageTexts,
    text: joined,
  };
}

function pickMeta(info) {
  const out = {};
  for (const key of ["Title", "Author", "Subject", "Keywords", "CreationDate", "Producer"]) {
    if (info[key]) out[key.toLowerCase()] = String(info[key]).slice(0, 300);
  }
  return out;
}

function normalizePages(pages, total) {
  if (!pages || pages === "all") return Array.from({ length: total }, (_, i) => i + 1);
  if (typeof pages === "string") {
    const out = new Set();
    for (const chunk of pages.split(",")) {
      const range = chunk.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (range) {
        const start = Math.max(1, Number(range[1]));
        const end = Math.min(total, Number(range[2]));
        for (let i = start; i <= end; i += 1) out.add(i);
      } else if (/^\d+$/.test(chunk.trim())) {
        const n = Number(chunk.trim());
        if (n >= 1 && n <= total) out.add(n);
      }
    }
    return out.size ? [...out].sort((a, b) => a - b) : Array.from({ length: Math.min(total, 5) }, (_, i) => i + 1);
  }
  if (Array.isArray(pages)) return pages.filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  return Array.from({ length: total }, (_, i) => i + 1);
}

// ---------------------------------------------------------------------------
// Structure recovery from the extracted text
// ---------------------------------------------------------------------------

const SECTION_PATTERNS = [
  [/\babstract\b/i, "Abstract"],
  [/\b(1\.?\s*)?introduction\b/i, "Introduction"],
  [/\b(2\.?\s*)?(related work|background|literature review)\b/i, "Background"],
  [/\b(3\.?\s*)?(method(s|ology)?|materials and methods|approach|experimental setup)\b/i, "Methods"],
  [/\b(4\.?\s*)?(results?|findings|evaluation|experiments?)\b/i, "Results"],
  [/\b(5\.?\s*)?(discussion)\b/i, "Discussion"],
  [/\b(6\.?\s*)?(conclusions?|concluding remarks|summary and conclusions)\b/i, "Conclusion"],
  [/\b(acknowledge?ments?)\b/i, "Acknowledgements"],
  [/\b(references|bibliography)\b/i, "References"],
  [/\b(appendix|supplementary material)\b/i, "Appendix"],
];

/** Split a paper's text into named sections, best effort. */
export function extractSections(text) {
  const clean = String(text ?? "");
  if (!clean.trim()) return [];

  const marks = [];
  for (const [pattern, label] of SECTION_PATTERNS) {
    const re = new RegExp(pattern.source, "gi");
    let match;
    let found = 0;
    while ((match = re.exec(clean)) !== null && found < 3) {
      // Only treat it as a heading when it starts a line-ish position.
      const before = clean.slice(Math.max(0, match.index - 2), match.index);
      if (match.index === 0 || /[\n.·]/.test(before) || /^\s/.test(before)) {
        marks.push({ index: match.index, label, length: match[0].length });
        found += 1;
      }
    }
  }

  marks.sort((a, b) => a.index - b.index);
  const unique = [];
  for (const mark of marks) {
    const last = unique.at(-1);
    if (last && last.label === mark.label) continue;
    unique.push(mark);
  }

  const sections = [];
  for (let i = 0; i < unique.length; i += 1) {
    const start = unique[i].index + unique[i].length;
    const end = i + 1 < unique.length ? unique[i + 1].index : clean.length;
    const body = clean.slice(start, end).replace(/\s+/g, " ").trim();
    if (body.length < 20) continue;
    sections.push({ name: unique[i].label, chars: body.length, text: body });
  }
  return sections;
}

/** Pull the reference list out of the text and split it into entries. */
export function extractReferences(text, { limit = 60 } = {}) {
  const clean = String(text ?? "");
  const marker = clean.search(/\b(references|bibliography)\b/i);
  if (marker === -1) return [];
  const tail = clean.slice(marker).slice(0, 60_000);
  const body = tail.replace(/^.*?\b(references|bibliography)\b/i, "").trim();

  const chunks = body
    .split(/(?=(?:\[\d{1,3}\]\s|\(\d{1,3}\)\s|(?<![\w.\-])\d{1,3}\.\s))/)
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter((c) => c.length > 25);

  return chunks.slice(0, limit).map((entry) => {
    const doi = entry.match(/10\.\d{4,9}\/[^\s,;]+/);
    const year = entry.match(/\b(1[89]\d{2}|20\d{2})\b/);
    return {
      raw: entry.slice(0, 400),
      doi: doi ? doi[0].replace(/[.,;]$/, "") : undefined,
      year: year ? Number(year[1]) : undefined,
    };
  });
}

export function fileInfo(filePath) {
  const stat = fs.statSync(filePath);
  return { path: filePath, bytes: stat.size, modified: stat.mtime.toISOString() };
}
