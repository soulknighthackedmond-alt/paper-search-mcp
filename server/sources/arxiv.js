// arXiv — Atom API, no key, the canonical preprint server for physics,
// mathematics, computer science, statistics and quantitative biology.

import { cached } from "../lib/cache.js";
import { getText } from "../lib/http.js";
import { normalizeArxivId, stripArxivVersion, normalizeDoi } from "../lib/ids.js";
import { make, clampLimit, yearFilter } from "./util.js";

const API = "https://export.arxiv.org/api/query";

function buildQuery(query, yearFrom, yearTo) {
  const raw = String(query ?? "").trim();
  // Pass field-prefixed queries through untouched (ti:, au:, abs:, cat:, all:).
  const hasField = /\b(?:ti|au|abs|cat|all|co|jr|rn|id):/i.test(raw);
  let base;
  if (hasField) {
    base = raw;
  } else {
    const terms = raw
      .split(/\s+/)
      .map((t) => t.replace(/["'()]/g, ""))
      .filter(Boolean);
    base = terms.length ? terms.map((t) => `all:${t}`).join(" AND ") : "all:*";
  }
  if (yearFrom || yearTo) {
    const from = yearFrom ? `${yearFrom}0101` : "19910101";
    const to = yearTo ? `${yearTo}1231` : "29991231";
    base = `(${base}) AND submittedDate:[${from} TO ${to}]`;
  }
  return base;
}

function parseAtom(xml) {
  const entries = [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  return entries.map((entry) => {
    const pick = (re) => {
      const m = entry.match(re);
      return m ? m[1].trim() : "";
    };
    const rawId = pick(/<id>([\s\S]*?)<\/id>/);
    const id = normalizeArxivId(rawId) || stripArxivVersion(rawId.split("/").pop() ?? "");
    const bareId = stripArxivVersion(id);
    const version = /v\d+$/i.test(id) ? id.match(/v\d+$/i)[0] : "";
    const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
    const categories = [...entry.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1]);
    const primary = entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/);
    const pdf = entry.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/) ?? entry.match(/<link[^>]*href="([^"]+)"[^>]*title="pdf"/);
    const doi = pick(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/);
    const comment = pick(/<arxiv:comment[^>]*>([\s\S]*?)<\/arxiv:comment>/);
    const journalRef = pick(/<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/);
    const published = pick(/<published>([\s\S]*?)<\/published>/);

    return make("arxiv", {
      id: `arxiv:${id}`,
      doi: normalizeDoi(doi),
      title: pick(/<title>([\s\S]*?)<\/title>/).replace(/\s+/g, " "),
      authors: authors.map((name) => ({ name })),
      year: published ? Number(published.slice(0, 4)) : null,
      venue: journalRef || "arXiv preprint",
      type: "preprint",
      publisher: "arXiv",
      abstract: pick(/<summary>([\s\S]*?)<\/summary>/).replace(/\s+/g, " "),
      url: `https://arxiv.org/abs/${id}`,
      pdf_url: pdf ? pdf[1].replace(/^http:/, "https:") : `https://arxiv.org/pdf/${id}`,
      is_oa: true,
      license: "arXiv (author licence)",
      fields: categories.slice(0, 8),
      keywords: categories.slice(0, 8),
      ids: { arxiv: bareId, doi: normalizeDoi(doi) || undefined },
      extra: { comment: comment || undefined, published, version: version || undefined, primary_category: primary?.[1] },
    });
  });
}

export default {
  id: "arxiv",
  label: "arXiv",
  homepage: "https://arxiv.org",
  coverage: "Preprints in physics, mathematics, computer science, statistics, economics, quantitative biology.",
  auth: [],
  filters: ["query", "limit", "year_from", "year_to", "sort"],
  notes: "Full text is always free. Needs a 3s gap between requests (handled automatically).",

  async search({ query, limit = 10, yearFrom, yearTo, sort = "relevance", signal }) {
    const max = clampLimit(limit, 50);
    const sortBy = sort === "date" || sort === "recent" ? "submittedDate" : "relevance";
    const search = buildQuery(query, yearFrom, yearTo);
    const url = `${API}?${new URLSearchParams({
      search_query: search,
      start: "0",
      max_results: String(Math.min(max * 2, 100)),
      sortBy,
      sortOrder: "descending",
    })}`;
    const xml = await cached("arxiv-search", [url], () => getText(url, { signal }));
    const records = parseAtom(xml);
    return yearFilter(records, yearFrom, yearTo).slice(0, max);
  },

  async getById({ type, value }) {
    if (type !== "arxiv") return null;
    const id = normalizeArxivId(value);
    if (!id) return null;
    const xml = await cached("arxiv-id", [id], () => getText(`${API}?id_list=${encodeURIComponent(id)}`));
    return parseAtom(xml)[0] ?? null;
  },
};
