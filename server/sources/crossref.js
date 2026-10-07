// Crossref — the DOI registration agency. Best coverage of journal metadata,
// no key needed; a contact email puts us in the polite pool.

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { normalizeDoi } from "../lib/ids.js";
import { config, hasEmail } from "../config.js";
import { make, clampLimit, yearFilter } from "./util.js";

const API = "https://api.crossref.org/works";
const SELECT = [
  "DOI", "title", "author", "issued", "published-print", "published-online", "container-title",
  "short-container-title", "abstract", "type", "publisher", "is-referenced-by-count",
  "references-count", "URL", "link", "license", "subject", "volume", "issue", "page",
  "ISSN", "ISBN", "subtitle", "editor", "alternative-id", "article-number", "published",
].join(",");

function stripJats(abstract) {
  return String(abstract ?? "")
    .replace(/<jats:title[^>]*>[\s\S]*?<\/jats:title>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function yearOf(item) {
  const parts =
    item.issued?.["date-parts"]?.[0] ??
    item["published-print"]?.["date-parts"]?.[0] ??
    item["published-online"]?.["date-parts"]?.[0];
  return parts?.[0] ?? null;
}

function authorsOf(item) {
  const list = item.author ?? item.editor ?? [];
  return list
    .map((a) => {
      const name = a.name ?? [a.given, a.family].filter(Boolean).join(" ");
      if (!name) return null;
      const out = { name };
      if (a.ORCID) out.orcid = String(a.ORCID).replace(/^https?:\/\/orcid\.org\//, "");
      if (a.affiliation?.length) out.affiliation = a.affiliation.map((x) => x.name).filter(Boolean).join("; ");
      return out;
    })
    .filter(Boolean);
}

function pdfLink(item) {
  const links = item.link ?? [];
  const pdf = links.find((l) => (l["content-type"] ?? "").includes("pdf"));
  return pdf?.["URL"] ?? "";
}

function oaStatus(item) {
  const licenses = item.license ?? [];
  if (!licenses.length) return { is_oa: null, license: "" };
  const url = licenses[0]?.URL ?? "";
  const creative = /creativecommons\.org/i.test(url);
  return { is_oa: creative ? true : null, license: url.replace(/^https?:\/\/(www\.)?/, "") };
}

export function fromCrossref(item) {
  const oa = oaStatus(item);
  const container = item["container-title"]?.[0] ?? item["short-container-title"]?.[0] ?? "";
  const title = (item.title?.[0] ?? item.subtitle?.[0] ?? "").replace(/\s+/g, " ");
  return make("crossref", {
    id: `doi:${normalizeDoi(item.DOI)}`,
    doi: normalizeDoi(item.DOI),
    title,
    authors: authorsOf(item),
    year: yearOf(item),
    venue: container,
    type: item.type ?? "",
    publisher: item.publisher ?? "",
    abstract: stripJats(item.abstract),
    url: item.URL || (item.DOI ? `https://doi.org/${normalizeDoi(item.DOI)}` : ""),
    pdf_url: pdfLink(item),
    is_oa: oa.is_oa,
    license: oa.license,
    citations: item["is-referenced-by-count"] ?? null,
    references_count: item["references-count"] ?? null,
    fields: (item.subject ?? []).slice(0, 8),
    keywords: (item.subject ?? []).slice(0, 8),
    language: item.language ?? "",
    ids: { doi: normalizeDoi(item.DOI) },
    extra: { volume: item.volume, issue: item.issue, pages: item.page, issn: item.ISSN?.[0] },
  });
}

/**
 * Crossref registers figures, tables, peer-review reports and other fragments
 * as separate DOIs. They are never what someone searching for a paper wants.
 */
export function isFragment(item) {
  const type = String(item.type ?? "").toLowerCase();
  if (["component", "peer-review", "grant"].includes(type)) return true;
  const title = (item.title?.[0] ?? "").trim();
  if (/^(figure|fig\.?|table|scheme|chart|equation|appendix|supplementary\s+(material|file|data))\b/i.test(title)) return true;
  if (!title && !item.author?.length) return true;
  return false;
}

export default {
  id: "crossref",
  label: "Crossref",
  homepage: "https://www.crossref.org",
  coverage: "150M+ registered records: journal articles, books, chapters, conference papers, datasets, preprints.",
  auth: [],
  filters: ["query", "limit", "year_from", "year_to", "type", "sort"],
  notes: "Authoritative DOI metadata and citation counts. Setting an email in the bundle settings gets you the faster polite pool.",

  async search({ query, limit = 10, yearFrom, yearTo, type, sort = "relevance", signal }) {
    const max = clampLimit(limit, 50);
    // Crossref ranks figures, tables and peer reviews of a paper above the
    // paper itself, so ask for extra rows and filter the fragments out.
    const rows = Math.min(max * 3, 100);
    const filters = [];
    if (yearFrom) filters.push(`from-pub-date:${yearFrom}-01-01`);
    if (yearTo) filters.push(`until-pub-date:${yearTo}-12-31`);
    if (type) filters.push(`type:${type}`);
    const url = `${API}?${qs({
      "query.bibliographic": query,
      rows,
      select: SELECT,
      sort: sort === "citations" ? "is-referenced-by-count" : sort === "date" ? "published" : "relevance",
      order: "desc",
      mailto: hasEmail() ? config.email : "",
      filter: filters.join(","),
    })}`;
    const data = await cached("crossref-search", [url], () => getJson(url, { signal }));
    const items = (data?.message?.items ?? []).filter((item) => !isFragment(item));
    return yearFilter(items.map(fromCrossref), yearFrom, yearTo).slice(0, max);
  },

  async getById({ type, value }) {
    if (type !== "doi") return null;
    const doi = normalizeDoi(value);
    if (!doi) return null;
    const data = await cached("crossref-doi", [doi], () =>
      getJson(`${API}/${encodeURIComponent(doi)}?${qs({ mailto: hasEmail() ? config.email : "" })}`),
    );
    const item = data?.message;
    return item ? fromCrossref(item) : null;
  },
};
