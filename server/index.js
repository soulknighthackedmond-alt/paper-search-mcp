#!/usr/bin/env node
// paper-search-plus — one MCP server for academic search, retrieval, reading
// and citation, across 19 open sources.
//
// Run it:  node server/index.js
// Self-test: node server/index.js --selftest
//
// stdout is reserved for the MCP protocol; every log goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { config, configSummary, ensureDirs } from "./config.js";
import * as cache from "./lib/cache.js";
import * as library from "./lib/library.js";
import { resolvePaper } from "./lib/resolve.js";
import { dedupe, rank, toCompact, toFull, cleanText } from "./lib/record.js";
import { detectIdentifier, normalizeDoi } from "./lib/ids.js";
import { format, STYLES } from "./lib/cite.js";
import { downloadPdf, extractText, extractSections, extractReferences, filenameFor } from "./lib/pdf.js";
import { searchMany, listSources, resolveSources, SOURCES, ALL_SOURCES } from "./sources/index.js";

const SERVER_NAME = "paper-search-plus";

function log(...args) {
  process.stderr.write(`${args.join(" ")}\n`);
}

/** Every tool returns this shape: readable text + the same data as JSON. */
function ok(text, structured) {
  return {
    content: [{ type: "text", text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function fail(message, structured) {
  return {
    content: [{ type: "text", text: message }],
    ...(structured ? { structuredContent: structured } : {}),
    isError: true,
  };
}

function failureNote(perSource = []) {
  const broken = perSource.filter((s) => s.error);
  if (!broken.length) return "";
  return `\n\nNot searched:\n${broken.map((s) => `- ${s.label}: ${s.error}`).join("\n")}`;
}

function skipNote(skipped = []) {
  if (!skipped.length) return "";
  return `\n\nSkipped (not configured): ${skipped.map((s) => `${s.source} ${s.reason}`).join("; ")}.`;
}

/**
 * Download a PDF, and when the first URL fails for a preprint whose file name
 * carries a version number (bioRxiv/medRxiv), ask the details API and retry.
 */
async function downloadWithFallback(url, paper, directory, filename, signal, notes) {
  const options = { dir: directory, filename: filename ?? (paper ? filenameFor(paper) : undefined), signal };
  try {
    return await downloadPdf(url, options);
  } catch (error) {
    const doi = paper?.doi ?? "";
    const isPreprint = /^10\.1101\//.test(doi) || /biorxiv\.org|medrxiv\.org/.test(url);
    if (!isPreprint) throw error;
    const { versionedPdfUrl } = await import("./sources/biorxiv.js");
    const retryUrl = await versionedPdfUrl(doi);
    if (!retryUrl || retryUrl === url) throw error;
    const saved = await downloadPdf(retryUrl, options);
    notes.push("The first PDF link 404'd, so the exact preprint version was fetched instead.");
    return saved;
  }
}

function digestLine(record, index) {
  const authors = record.authors?.length
    ? record.authors.slice(0, 3).map((a) => a.name).join(", ") + (record.authors.length > 3 ? ` +${record.authors.length - 3}` : "")
    : "unknown authors";
  const bits = [
    `${index + 1}. ${record.title || "(no title)"}`,
    `   ${authors}${record.year ? ` · ${record.year}` : ""}${record.venue ? ` · ${record.venue}` : ""}`,
    `   ${[
      record.doi ? `doi:${record.doi}` : "",
      record.ids?.arxiv ? `arXiv:${record.ids.arxiv}` : "",
      record.ids?.pmid ? `PMID:${record.ids.pmid}` : "",
      record.citations != null ? `${record.citations} citations` : "",
      record.pdf_url ? "PDF: yes" : record.is_oa === false ? "paywalled" : "",
      `via ${(record.sources ?? []).join("/")}`,
    ].filter(Boolean).join(" | ")}`,
  ];
  return bits.join("\n");
}

function searchText(query, records, perSource, detail, skipped = []) {
  const header = `${records.length} unique paper(s) for "${query}" from ${perSource.filter((s) => !s.error).length} source(s).`;
  const body = records.map((r, i) => (detail === "full" ? `${digestLine(r, i)}\n   ${cleanText(r.abstract, 700) || "(no abstract)"}` : digestLine(r, i))).join("\n\n");
  return `${header}\n\n${body}${failureNote(perSource)}${skipNote(skipped)}`;
}

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: SERVER_NAME, version: config.version },
  {
    instructions: [
      "Academic paper search, retrieval, reading and citation across 19 open sources (arXiv, Crossref, OpenAlex, Semantic Scholar, PubMed, Europe PMC, bioRxiv, medRxiv, DBLP, DOAJ, Zenodo, HAL, OpenReview, IACR, ChemRxiv, OpenAIRE, PMC, CORE, IEEE, Scopus).",
      "Typical flow: search_papers to find candidates -> get_paper to resolve one by DOI/arXiv/PMID/URL/title -> download_paper for a free PDF -> read_paper to extract text/sections -> cite_paper for a reference list.",
      "search_papers searches a fast default set; pass sources:[\"all\"] for everything, or name specific sources. Niche sources: dblp (CS), biorxiv/medrxiv (life sciences), chemrxiv, iacr (crypto), doaj (open access only), zenodo (data/software), hal (French repositories).",
      "Results are de-duplicated across sources and ranked; each hit carries a stable id (doi:, arxiv:, pmid:) that the other tools accept directly.",
      "Sci-Hub and other pirate mirrors are deliberately not included: download_paper only returns legal open-access copies.",
    ].join(" "),
  },
);

server.registerTool(
  "search_papers",
  {
    title: "Search academic papers",
    description:
      "Search scholarly literature across many sources at once and get one de-duplicated, ranked list. Use this first for any literature question. Sources are queried in parallel and a source that is down or needs a key is reported separately instead of failing the whole search. Pass sources:[\"all\"] for every source, or pick from list_sources. Free full text only: open_access_only:true. Cite-heavy fields: sort:\"citations\".",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      query: z.string().min(2).describe("What to search for. Natural language works ('graph neural networks for drug discovery'); Boolean syntax (AND/OR, quoted phrases) is passed through to the sources that support it. PubMed syntax like 'crispr[ti] AND 2020:2024[dp]' also works when pubmed is in sources."),
      sources: z.array(z.string()).optional().describe(`Source ids to search. Omit for a fast default set (openalex, crossref, arxiv, europepmc, semantic-scholar, pubmed). Use ["all"] for all ${ALL_SOURCES.length} key-free sources.`),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum results to return after de-duplication (default 10)."),
      year_from: z.number().int().min(1500).max(2100).optional().describe("Earliest publication year."),
      year_to: z.number().int().min(1500).max(2100).optional().describe("Latest publication year."),
      open_access_only: z.boolean().optional().describe("Only papers with a free, legal full text."),
      sort: z.enum(["relevance", "citations", "date"]).optional().describe("Ranking preference (default relevance; the built-in score blends relevance, citations, recency and source trust)."),
      min_citations: z.number().int().min(0).optional().describe("Drop papers with fewer than this many citations."),
      detail: z.enum(["compact", "full"]).optional().describe("compact (default) = metadata only; full = include abstracts."),
    },
  },
  async ({ query, sources, limit = 10, year_from, year_to, open_access_only, sort, min_citations, detail = "compact" }, extra) => {
    try {
      const { records, perSource, unknown, suggestion, skipped } = await searchMany({
        query,
        sources,
        limit,
        yearFrom: year_from,
        yearTo: year_to,
        openAccessOnly: open_access_only,
        sort,
        signal: extra?.signal,
      });

      let merged = dedupe(records);
      if (min_citations) merged = merged.filter((r) => (r.citations ?? 0) >= min_citations);
      if (open_access_only) merged = merged.filter((r) => r.pdf_url || r.is_oa);
      const ranked = rank(merged, query).slice(0, limit);

      if (!ranked.length) {
        const why = perSource.filter((s) => s.error).map((s) => `${s.label}: ${s.error}`).join("; ");
        return fail(`No results for "${query}".${unknown.length ? ` ${suggestion}` : ""}${why ? ` Sources reported: ${why}` : " Try broader terms, drop year filters, or pass sources:[\"all\"]."}`);
      }

      const payload = {
        query,
        returned: ranked.length,
        duplicates_removed: records.length - merged.length,
        sources_searched: perSource.map((s) => ({ source: s.source, results: s.count, ms: s.ms, error: s.error })),
        sources_skipped: skipped.length ? skipped : undefined,
        unknown_sources: unknown.length ? unknown : undefined,
        results: ranked.map((r, i) => (detail === "full" ? { n: i + 1, ...toFull(r) } : toCompact(r, i + 1))),
      };
      return ok(searchText(query, ranked, perSource, detail, skipped), payload);
    } catch (error) {
      return fail(`Search failed: ${error.message}`);
    }
  },
);

server.registerTool(
  "get_paper",
  {
    title: "Get one paper's details",
    description:
      "Resolve a single paper into complete metadata: DOI, arXiv id, PubMed/PMC id, OpenAlex id, a publisher URL, or just a title. The record is looked up in every source that can answer, merged, and enriched with open-access status and a free PDF link when one exists legally. Accepts the ids returned by search_papers (e.g. 'doi:10.1038/...', 'arxiv:1706.03762').",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      identifier: z.string().min(2).describe("DOI, arXiv id, PMID, PMC id, OpenAlex id, paper URL, or a title to match."),
      detail: z.enum(["compact", "full"]).optional().describe("full (default) includes the abstract and all identifiers."),
      sources: z.array(z.string()).optional().describe("Restrict the lookup to these sources."),
    },
  },
  async ({ identifier, detail = "full", sources }, extra) => {
    try {
      const { record, identifier: detected, notes, candidates } = await resolvePaper(identifier, {
        signal: extra?.signal,
        sources,
      });
      if (!record) {
        return fail(`Could not resolve "${identifier}" (read as ${detected.type}). ${notes.join(" ")}${candidates?.length ? " Closest matches are in the structured output." : ""}`, { notes, candidates });
      }
      const text = [
        `${cleanText(record.title, 400)}`,
        `${record.authors?.map((a) => a.name).join(", ") || "unknown authors"}`,
        [record.year, record.venue, record.publisher].filter(Boolean).join(" · "),
        [
          record.doi ? `doi:${record.doi}` : "",
          record.ids?.arxiv ? `arXiv:${record.ids.arxiv}` : "",
          record.ids?.pmid ? `PMID:${record.ids.pmid}` : "",
          record.citations != null ? `${record.citations} citations` : "",
          record.is_oa === true ? "open access" : record.is_oa === false ? "not open access" : "",
        ].filter(Boolean).join(" | "),
        record.pdf_url ? `Free PDF: ${record.pdf_url}` : "No legal free PDF found.",
        record.url ? `Link: ${record.url}` : "",
        detail === "full" && record.abstract ? `\nAbstract: ${cleanText(record.abstract, 2000)}` : "",
        notes.length ? `\nNotes: ${notes.join(" ")}` : "",
      ].filter(Boolean).join("\n");
      return ok(text, { paper: toFull(record), identifiers: record.ids, notes, other_matches: candidates });
    } catch (error) {
      return fail(`Lookup failed: ${error.message}`);
    }
  },
);

server.registerTool(
  "list_sources",
  {
    title: "List available sources",
    description:
      "Show every source this server can search: what it covers, whether it needs an API key or email, which filters it supports, and whether it is currently usable. Call this when you are unsure which sources suit a question, or when a source reported a missing key.",
    annotations: { readOnlyHint: true },
    inputSchema: {},
  },
  async () => {
    const sources = listSources();
    const lines = sources.map((s) => {
      const needs = s.needs.length ? ` [needs: ${s.needs.join(", ")}]` : "";
      const state = s.available ? "" : " (unavailable: missing key/email)";
      return `- ${s.id} — ${s.label}${needs}${state}\n  ${s.covers}\n  filters: ${s.filters.join(", ")}${s.notes ? `\n  ${s.notes}` : ""}`;
    });
    return ok(`${sources.length} sources:\n\n${lines.join("\n")}\n\nSearch a subset with sources:["arxiv","openalex"], or everything with sources:["all"].`, {
      sources,
      defaults: resolveSources(undefined).sources.map((s) => s.id),
    });
  },
);

server.registerTool(
  "download_paper",
  {
    title: "Download a free PDF",
    description:
      "Find and save a legal open-access PDF for a paper, then verify it really is a PDF (publisher landing pages and paywalls are rejected rather than saved). Give a DOI, arXiv/PubMed id, URL, or title. Returns the saved path, size, page count and sha256. Nothing is downloaded from pirate mirrors.",
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      identifier: z.string().min(2).describe("DOI, arXiv id, PMID, PMC id, paper URL or title."),
      url: z.string().optional().describe("Download exactly this PDF URL instead of resolving an identifier."),
      filename: z.string().optional().describe("File name to use (a sensible one is derived from the metadata by default)."),
      directory: z.string().optional().describe("Folder to save into. Defaults to the download folder from the bundle settings."),
    },
  },
  async ({ identifier, url, filename, directory }, extra) => {
    try {
      let target = url;
      let paper = null;
      let notes = [];
      if (!target) {
        const resolved = await resolvePaper(identifier, { signal: extra?.signal });
        paper = resolved.record;
        notes = resolved.notes;
        if (!paper) return fail(`Could not identify a paper from "${identifier}". ${notes.join(" ")}`);
        target = paper.pdf_url;
        if (!target && paper.ids?.pmcid) {
          target = `https://www.ebi.ac.uk/europepmc/webservices/rest/${paper.ids.pmcid}/fullTextPDF`;
        }
        if (!target && paper.ids?.arxiv) {
          target = `https://arxiv.org/pdf/${paper.ids.arxiv}`;
        }
        if (!target) {
          return fail(
            `No legal free PDF found for "${cleanText(paper.title, 200)}".${paper.is_oa === false ? " This paper is paywalled." : ""} Ask the user for access through their library, or read the abstract with get_paper.`,
            { paper: toFull(paper) },
          );
        }
      }
      const saved = await downloadWithFallback(target, paper, directory, filename, extra?.signal, notes);
      const text = [
        `Saved ${saved.bytes >= 1_048_576 ? `${(saved.bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(saved.bytes / 1024)} KB`} to ${saved.path}`,
        saved.pages ? `${saved.pages} pages` : "",
        `sha256 ${saved.sha256.slice(0, 16)}…`,
        paper ? `Paper: ${cleanText(paper.title, 200)}` : `From: ${saved.final_url}`,
        "Next: read_paper on that path to get the text, or cite_paper for a reference entry.",
      ].filter(Boolean).join("\n");
      return ok(text, { file: saved, paper: paper ? toFull(paper) : undefined });
    } catch (error) {
      return fail(`Download failed: ${error.message}`);
    }
  },
);

server.registerTool(
  "read_paper",
  {
    title: "Read a paper's full text",
    description:
      "Extract the text of a paper: give a local PDF path, a PDF URL, or an identifier (it downloads the free copy first). Returns page-by-page text, detected sections (abstract, methods, results, discussion, conclusion, references) and optionally the reference list. Use pages to read only part of a long paper. If there is no legal PDF but the paper is in PMC, the open-access full text XML is used instead.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      source: z.string().min(2).describe("Local PDF path, PDF URL, DOI, arXiv id, PMID, PMC id or title."),
      pages: z.string().optional().describe("Pages to read: 'all' (default), '3', '1-5', '2,7,9'. Use this on long papers to save context."),
      mode: z.enum(["text", "sections", "references", "outline"]).optional().describe("text (default) = page text plus a section outline; sections = section texts only; references = parsed reference list; outline = headings only."),
      max_chars: z.number().int().min(500).max(200_000).optional().describe("Cap the returned characters (default 40000)."),
    },
  },
  async ({ source, pages, mode = "text", max_chars = 40_000 }, extra) => {
    try {
      const looksLikeFile = /\.pdf$/i.test(source) && !/^https?:\/\//i.test(source);
      const looksLikeUrl = /^https?:\/\//i.test(source);
      let pdfSource = source;
      let paper = null;
      let notes = [];

      if (!looksLikeFile && !(looksLikeUrl && /\.pdf($|\?)/i.test(source))) {
        const resolved = await resolvePaper(source, { signal: extra?.signal });
        paper = resolved.record;
        notes = resolved.notes;
        if (!paper) return fail(`Could not identify a paper from "${source}". ${notes.join(" ")}`);

        if (paper.pdf_url) {
          const saved = await downloadPdf(paper.pdf_url, { filename: filenameFor(paper), signal: extra?.signal });
          pdfSource = saved.path;
          notes.push(`Downloaded the free PDF to ${saved.path}.`);
        } else if (paper.ids?.pmcid) {
          const { default: europepmc } = await import("./sources/europepmc.js");
          const xml = await europepmc.fullText(paper.ids.pmcid ? { type: "pmcid", value: paper.ids.pmcid } : { type: "pmcid", value: "" });
          if (xml) {
            const text = String(xml).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            const sections = extractSections(text);
            return ok(
              `${cleanText(paper.title, 200)}\nOpen-access full text from PubMed Central (${text.length} characters).${notes.length ? `\nNotes: ${notes.join(" ")}` : ""}\n\n${text.slice(0, max_chars)}`,
              { paper: toFull(paper), source: "europepmc-fulltext", text: text.slice(0, max_chars), sections },
            );
          }
        } else {
          return fail(`No legal full text is available for "${cleanText(paper.title, 200)}" (no open-access PDF and not in PubMed Central). get_paper still returns the metadata and abstract.`, { paper: toFull(paper), notes });
        }
      }

      const extracted = await extractText(pdfSource, { pages });
      const sections = extractSections(extracted.text);
      const references = mode === "references" || mode === "outline" ? extractReferences(extracted.text, { limit: 60 }) : [];

      let text;
      if (mode === "outline") {
        text = `Outline of ${cleanText(paper?.title ?? extracted.meta?.title ?? pdfSource, 200)} (${extracted.total_pages} pages):\n${sections.map((s) => `- ${s.name} (${s.chars} chars)`).join("\n")}`;
      } else if (mode === "sections") {
        text = sections.map((s) => `## ${s.name}\n${s.text.slice(0, 12_000)}`).join("\n\n").slice(0, max_chars);
      } else if (mode === "references") {
        text = references.map((r, i) => `${i + 1}. ${r.raw}${r.doi ? ` [doi:${r.doi}]` : ""}`).join("\n").slice(0, max_chars);
      } else {
        const outline = sections.length ? `Sections found: ${sections.map((s) => s.name).join(", ")}\n\n` : "";
        text = `${outline}${extracted.text}`.slice(0, max_chars);
      }

      const head = [
        paper ? cleanText(paper.title, 200) : (extracted.meta?.title ?? source),
        `${extracted.total_pages} pages, read ${extracted.pages_read.length}`,
        notes.length ? `Notes: ${notes.join(" ")}` : "",
      ].filter(Boolean).join(" · ");

      return ok(`${head}\n\n${text}`, {
        paper: paper ? toFull(paper) : undefined,
        total_pages: extracted.total_pages,
        pages_read: extracted.pages_read,
        sections: sections.map((s) => ({ name: s.name, chars: s.chars })),
        references: references.length ? references : undefined,
        text: text.slice(0, max_chars),
      });
    } catch (error) {
      return fail(`Could not read that paper: ${error.message}`);
    }
  },
);

server.registerTool(
  "cite_paper",
  {
    title: "Format citations",
    description: `Turn one or more papers into reference entries. Give identifiers (DOI, arXiv id, PMID, URL or title) and pick a style. Styles: ${Object.keys(STYLES).join(", ")}. Multiple papers in bibtex mode get unique citation keys.`,
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      identifiers: z.array(z.string()).min(1).describe("Papers to cite — one or more DOIs, arXiv ids, PMIDs, URLs or titles."),
      style: z.enum(Object.keys(STYLES)).optional().describe("Citation style (default bibtex)."),
      numbered: z.boolean().optional().describe("Prefix each entry with a number (useful for Vancouver/GB-T style lists)."),
    },
  },
  async ({ identifiers, style = "bibtex", numbered = false }, extra) => {
    const entries = [];
    const failed = [];
    for (const identifier of identifiers) {
      try {
        const { record } = await resolvePaper(identifier, { signal: extra?.signal, enrich: false });
        if (record) entries.push(record);
        else failed.push(identifier);
      } catch (error) {
        failed.push(`${identifier} (${error.message})`);
      }
    }
    if (!entries.length) return fail(`Could not resolve any of: ${identifiers.join(", ")}.`);

    const taken = new Set();
    const text = entries
      .map((record, i) => {
        const formatted = format(record, style, taken);
        return numbered ? `${i + 1}. ${formatted}` : formatted;
      })
      .join(style === "bibtex" || style === "ris" ? "\n\n" : "\n");

    return ok(`${text}${failed.length ? `\n\nCould not resolve: ${failed.join(", ")}` : ""}`, {
      style,
      count: entries.length,
      citations: entries.map((record) => ({ title: record.title, doi: record.doi, formatted: format(record, style, new Set()) })),
      failed,
    });
  },
);

server.registerTool(
  "find_related",
  {
    title: "Find related papers",
    description:
      "Walk the citation graph around a paper: mode 'citing' = papers that cite it (follow the field forward), 'references' = what it cites (go back to the foundations), 'similar' = machine-recommended related work. Works with any DOI, arXiv id, PMID or title. Combines OpenAlex and Semantic Scholar, de-duplicated.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      identifier: z.string().min(2).describe("DOI, arXiv id, PMID, URL or title of the paper to start from."),
      mode: z.enum(["citing", "references", "similar"]).optional().describe("Which direction to walk (default citing)."),
      limit: z.number().int().min(1).max(50).optional().describe("How many related papers to return (default 10)."),
      detail: z.enum(["compact", "full"]).optional().describe("compact (default) or full with abstracts."),
    },
  },
  async ({ identifier, mode = "citing", limit = 10, detail = "compact" }, extra) => {
    try {
      const { record, identifier: detected, notes } = await resolvePaper(identifier, { signal: extra?.signal });
      if (!record) return fail(`Could not identify that paper. ${notes.join(" ")}`);

      const { default: openalex } = await import("./sources/openalex.js");
      const { default: semantic } = await import("./sources/semantic.js");
      const target = {
        type: record.ids?.openalex ? "openalex" : record.doi ? "doi" : record.ids?.arxiv ? "arxiv" : record.ids?.pmid ? "pmid" : null,
        value: record.ids?.openalex ?? record.doi ?? record.ids?.arxiv ?? record.ids?.pmid,
      };

      const results = [];
      const errors = [];
      if (target.type) {
        const tasks = [
          openalex.related({ identifier: target, mode, limit, signal: extra?.signal }).catch((e) => { errors.push(`OpenAlex: ${e.message}`); return []; }),
          semantic.related({ identifier: { type: target.type, value: target.value }, mode, limit, signal: extra?.signal }).catch((e) => { errors.push(`Semantic Scholar: ${e.message}`); return []; }),
        ];
        const [a, b] = await Promise.all(tasks);
        results.push(...a, ...b);
      }

      const merged = dedupe(results);
      if (!merged.length) {
        return fail(`No ${mode} papers found for "${cleanText(record.title, 200)}".${errors.length ? ` ${errors.join("; ")}` : ""}`, { paper: toFull(record) });
      }
      const ranked = rank(merged, record.title).slice(0, limit);
      const label = mode === "citing" ? "Papers citing" : mode === "references" ? "Papers cited by" : "Papers similar to";
      return ok(`${label} "${cleanText(record.title, 160)}" (${ranked.length} of ${merged.length} unique):\n\n${ranked.map((r, i) => digestLine(r, i)).join("\n\n")}`, {
        paper: { title: record.title, doi: record.doi, id: record.ids },
        mode,
        results: ranked.map((r, i) => (detail === "full" ? { n: i + 1, ...toFull(r) } : toCompact(r, i + 1))),
        errors: errors.length ? errors : undefined,
      });
    } catch (error) {
      return fail(`Related-work lookup failed: ${error.message}`);
    }
  },
);

server.registerTool(
  "author_profile",
  {
    title: "Look up an author",
    description:
      "Find a researcher and their most-cited work: h-index, i10-index, total citations, affiliations over time and top papers (OpenAlex author records).",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      name: z.string().min(2).describe("Author name, e.g. 'Yoshua Bengio'."),
      limit: z.number().int().min(1).max(50).optional().describe("How many top papers to list (default 10)."),
    },
  },
  async ({ name, limit = 10 }, extra) => {
    try {
      const { default: openalex } = await import("./sources/openalex.js");
      const author = await openalex.author({ name, limit, signal: extra?.signal });
      if (!author) return fail(`No author found for "${name}". Try the full name as it appears on papers.`);
      const text = [
        `${author.name}${author.orcid ? ` (ORCID ${author.orcid})` : ""}`,
        `${author.works_count ?? "?"} works · ${author.cited_by_count ?? "?"} citations · h-index ${author.h_index ?? "?"} · i10 ${author.i10_index ?? "?"}`,
        author.affiliations?.length ? `Affiliations: ${author.affiliations.map((a) => `${a.name}${a.years ? ` (${a.years})` : ""}`).join("; ")}` : "",
        "",
        `Most-cited papers:\n${author.top_works.map((r, i) => digestLine(r, i)).join("\n\n")}`,
      ].filter(Boolean).join("\n");
      return ok(text, author);
    } catch (error) {
      return fail(`Author lookup failed: ${error.message}`);
    }
  },
);

server.registerTool(
  "library",
  {
    title: "Your saved papers",
    description:
      "A local reading list stored on this machine. action 'add' saves a paper (by identifier or from a search result), 'list' shows what is saved, 'search' filters it, 'remove' deletes one, 'export' writes the whole library as BibTeX/RIS/APA text, 'stats' summarises it. Nothing leaves the machine.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      action: z.enum(["add", "list", "search", "remove", "export", "stats"]).describe("What to do."),
      identifier: z.string().optional().describe("For 'add': DOI, arXiv id, PMID, URL or title."),
      key: z.string().optional().describe("For 'remove': the library key or the paper title."),
      query: z.string().optional().describe("For 'search': text to match in saved titles."),
      tag: z.string().optional().describe("For 'list'/'search': only papers with this tag."),
      tags: z.array(z.string()).optional().describe("For 'add': tags to attach."),
      note: z.string().optional().describe("For 'add': a note to keep with the paper."),
      style: z.enum(Object.keys(STYLES)).optional().describe("For 'export': citation style (default bibtex)."),
      limit: z.number().int().min(1).max(200).optional().describe("For 'list'/'search': how many to show (default 20)."),
    },
  },
  async ({ action, identifier, key, query, tag, tags, note, style = "bibtex", limit = 20 }, extra) => {
    try {
      if (action === "add") {
        if (!identifier) return fail("library add needs an identifier (DOI, arXiv id, title or URL).");
        const { record, notes } = await resolvePaper(identifier, { signal: extra?.signal });
        if (!record) return fail(`Could not resolve "${identifier}". ${notes.join(" ")}`);
        const result = library.add(record, { tags, note });
        return ok(`${result.added ? "Added" : "Updated"} "${cleanText(record.title, 160)}" in your library (${result.total} saved).`, { ...result, paper: toFull(record) });
      }
      if (action === "list" || action === "search") {
        const items = library.list({ query: action === "search" ? (query ?? "") : "", tag: tag ?? "", limit });
        if (!items.length) return ok("Your library is empty. Add a paper with library action:add identifier:\"10.1038/...\".", { items: [] });
        return ok(items.map((item, i) => `${i + 1}. ${cleanText(item.record?.title, 180)}${item.record?.year ? ` (${item.record.year})` : ""}\n   key: ${item.key}${item.tags?.length ? ` | tags: ${item.tags.join(", ")}` : ""}`).join("\n\n"), { items });
      }
      if (action === "remove") {
        if (!key) return fail("library remove needs key (the library key or the title).");
        const result = library.remove(key);
        return ok(result.removed ? `Removed ${result.removed} entry (${result.total} left).` : `Nothing matched "${key}".`, result);
      }
      if (action === "export") {
        const text = library.exportAll(style);
        if (!text.trim()) return ok("Your library is empty.", { style, entries: 0 });
        return ok(text, { style, entries: text.split(style === "bibtex" ? "@" : "\n").length - 1 });
      }
      return ok(`Library: ${library.stats().total} papers saved at ${library.stats().path}.`, library.stats());
    } catch (error) {
      return fail(`Library action failed: ${error.message}`);
    }
  },
);

server.registerTool(
  "server_status",
  {
    title: "Server status and self-test",
    description:
      "Check the configuration (folders, contact email, which API keys are set), cache usage and whether each source is currently reachable. action 'test_sources' runs a live query against the key-free sources and reports which ones answer — use it to diagnose 'no results' problems. action 'clear_cache' empties the local result cache.",
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      action: z.enum(["status", "test_sources", "clear_cache"]).optional().describe("Default status."),
      sources: z.array(z.string()).optional().describe("For test_sources: limit the check to these sources."),
    },
  },
  async ({ action = "status", sources }, extra) => {
    try {
      if (action === "clear_cache") {
        const result = cache.clear();
        return ok(`Cache cleared (${result.removed_entries} entries removed).`, result);
      }
      if (action === "test_sources") {
        const { perSource } = await searchMany({
          query: "deep learning",
          sources: sources ?? "all",
          limit: 3,
          signal: extra?.signal,
          perSourceTimeout: 20_000,
        });
        const lines = perSource.map((s) => `${s.error ? "FAIL" : "ok  "} ${s.source.padEnd(18)} ${s.error ?? `${s.count} results in ${s.ms}ms`}`);
        const working = perSource.filter((s) => !s.error).length;
        return ok(`${working}/${perSource.length} sources answered a live query:\n\n${lines.join("\n")}`, { per_source: perSource, config: configSummary() });
      }
      const status = {
        server: SERVER_NAME,
        ...configSummary(),
        cache_stats: cache.stats(),
        library: library.stats(),
        sources_total: Object.keys(SOURCES).length,
        default_sources: resolveSources(undefined).sources.map((s) => s.id),
      };
      return ok(
        [
          `${SERVER_NAME} v${config.version} — ${status.sources_total} sources, ${status.library.total} saved papers.`,
          `Data folder: ${status.data_dir}`,
          `Downloads: ${status.download_dir}`,
          `Contact email: ${status.email}`,
          `Cache: ${status.cache} (${status.cache_stats.entries_on_disk} entries, ${status.cache_stats.size_mb} MB)`,
          `API keys: ${Object.entries(status.api_keys).map(([k, v]) => `${k}=${v}`).join(", ")}`,
        ].join("\n"),
        status,
      );
    } catch (error) {
      return fail(`Status check failed: ${error.message}`);
    }
  },
);

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const promptText = (role, text) => ({ messages: [{ role, content: { type: "text", text } }] });

server.registerPrompt(
  "literature_review",
  {
    title: "Literature review",
    description: "Plan and run a multi-source literature review on a topic, ending in a cited summary.",
    argsSchema: {
      topic: z.string().describe("The topic or research question."),
      depth: z.enum(["quick", "standard", "deep"]).optional().describe("How much searching to do."),
      year_from: z.string().optional().describe("Earliest year to include."),
    },
  },
  ({ topic, depth = "standard", year_from }) =>
    promptText(
      "user",
      [
        `Do a ${depth} literature review on: ${topic}${year_from ? ` (papers from ${year_from} onwards)` : ""}.`,
        "",
        "Steps:",
        `1. search_papers with sources:["all"]${year_from ? `, year_from:${year_from}` : ""} and limit 25.`,
        "2. Note which sources failed and say so.",
        "3. Group the results by approach or theme, not by source.",
        "4. For the 3-5 most important papers, call get_paper and, where a free PDF exists, read_paper to check the actual claims.",
        "5. Use find_related mode:\"citing\" on the single most central paper to see what came after it.",
        "6. Finish with: what is settled, what is contested, what is missing, and a cite_paper bibtex list of everything you relied on.",
      ].join("\n"),
    ),
);

server.registerPrompt(
  "summarize_paper",
  {
    title: "Summarise a paper",
    description: "Read a paper properly and summarise it, distinguishing what it claims from what it shows.",
    argsSchema: {
      identifier: z.string().describe("DOI, arXiv id, PMID, URL or title."),
      focus: z.string().optional().describe("What to focus on (e.g. methodology, results, limitations)."),
    },
  },
  ({ identifier, focus }) =>
    promptText(
      "user",
      [
        `Read and summarise this paper: ${identifier}${focus ? ` — focus on ${focus}` : ""}.`,
        "",
        "1. get_paper to get the metadata and abstract.",
        "2. download_paper, then read_paper with mode:\"sections\" (or pages if it is long) to get the actual text.",
        "3. Report: the question, the method, the data, the headline result with numbers, the stated limitations, and what the paper does NOT show.",
        "4. Flag anything the abstract claims that the text does not support.",
        "5. End with a cite_paper entry for the paper.",
      ].join("\n"),
    ),
);

server.registerPrompt(
  "compare_papers",
  {
    title: "Compare papers",
    description: "Compare two or more papers on the same question and say which is stronger and why.",
    argsSchema: {
      identifiers: z.string().describe("Two or more identifiers separated by commas or newlines."),
      question: z.string().optional().describe("The question they are all answering."),
    },
  },
  ({ identifiers, question }) =>
    promptText(
      "user",
      [
        `Compare these papers${question ? ` on the question: ${question}` : ""}:`,
        identifiers,
        "",
        "For each: get_paper for metadata, download_paper + read_paper for the methods and results sections.",
        "Then produce a table: paper, method, data/sample, key result, limitations, venue and year, citations.",
        "Finish with which one you would trust most, and why — and what evidence would change that answer.",
      ].join("\n"),
    ),
);

server.registerPrompt(
  "research_gap",
  {
    title: "Find a research gap",
    description: "Look for an under-explored angle in a field, grounded in the retrieved literature.",
    argsSchema: {
      topic: z.string().describe("The field or topic."),
      constraint: z.string().optional().describe("Any constraint (e.g. methods available, dataset, timescale)."),
    },
  },
  ({ topic, constraint }) =>
    promptText(
      "user",
      [
        `Find research gaps in: ${topic}${constraint ? `, given this constraint: ${constraint}` : ""}.`,
        "",
        "1. search_papers with sources:[\"all\"], sort:\"citations\" to find the foundational work, then again sorted by date for the last two years.",
        "2. find_related mode:\"references\" on the most-cited paper to map the foundations, then mode:\"citing\" to see where the field went.",
        "3. Look for: questions asked in the last two years but not answered, methods used in neighbouring fields but not here, and claims repeated without new evidence.",
        "4. Propose three concrete, testable gaps. For each, name the papers that establish the gap and what a study would need to do to close it. Do not invent citations — every claim must come from a retrieved paper.",
      ].join("\n"),
    ),
);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function selfTest() {
  log(`${SERVER_NAME} v${config.version} self-test`);
  log(`node ${process.version} · data dir ${config.dataDir}`);
  const { perSource, skipped } = await searchMany({ query: "transformer attention", sources: "all", limit: 2, perSourceTimeout: 25_000 });
  let working = 0;
  let attempted = 0;
  for (const entry of perSource) {
    attempted += 1;
    if (entry.error) log(`FAIL  ${entry.source.padEnd(18)} ${entry.error}`);
    else {
      working += 1;
      log(`ok    ${entry.source.padEnd(18)} ${entry.count} results in ${entry.ms}ms`);
    }
  }
  for (const entry of skipped ?? []) log(`skip  ${entry.source.padEnd(18)} ${entry.reason}`);
  log(`${working}/${attempted} sources answered a live query (${skipped?.length ?? 0} skipped as unconfigured)`);
  process.exitCode = working >= Math.ceil(attempted / 2) ? 0 : 1;
}

async function main() {
  ensureDirs();
  if (process.argv.includes("--selftest")) {
    await selfTest();
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`${SERVER_NAME} v${config.version} ready (${Object.keys(SOURCES).length} sources, data dir ${config.dataDir})`);
}

main().catch((error) => {
  log(`Fatal: ${error?.stack ?? error}`);
  process.exit(1);
});
