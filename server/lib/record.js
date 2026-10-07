// The canonical paper record, plus de-duplication and ranking.
//
// Every source adapter produces this shape, so the agent sees one consistent
// object no matter where a result came from.

import { recordKey, titleSimilarity, normalizeTitle, titleTokens } from "./ids.js";

/** Create an empty canonical record. */
export function newRecord(init = {}) {
  return {
    id: "",
    doi: "",
    title: "",
    authors: [],
    year: null,
    venue: "",
    type: "",
    publisher: "",
    abstract: "",
    url: "",
    pdf_url: "",
    is_oa: null,
    license: "",
    citations: null,
    references_count: null,
    fields: [],
    keywords: [],
    ids: {},
    sources: [],
    language: "",
    ...init,
  };
}

/** Clean a source-specific author list into [{ name, orcid? }]. */
export function normalizeAuthors(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    if (!item) continue;
    if (typeof item === "string") {
      const name = item.replace(/\s+/g, " ").trim();
      if (name) out.push({ name });
      continue;
    }
    const name = String(item.name ?? item.full_name ?? item.display_name ?? "").replace(/\s+/g, " ").trim();
    if (!name) continue;
    const author = { name };
    const orcid = item.orcid ?? item.ORCID ?? "";
    if (orcid) author.orcid = String(orcid).replace(/^https?:\/\/orcid\.org\//, "");
    if (item.affiliation || item.institution) author.affiliation = String(item.affiliation ?? item.institution);
    out.push(author);
  }
  return out;
}

export function normalizeYear(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  const match = String(value).match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function cleanText(value, limit = 0) {
  if (!value) return "";
  let text = String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (limit && text.length > limit) text = `${text.slice(0, limit - 1).trimEnd()}…`;
  return text;
}

/** Merge a second record into the first, preferring richer values. */
export function mergeRecords(base, extra) {
  const out = { ...base };
  const richer = (a, b) => {
    if (!a) return b ?? a;
    if (!b) return a;
    return String(b).length > String(a).length ? b : a;
  };
  out.title = richer(out.title, extra.title);
  out.abstract = richer(out.abstract, extra.abstract);
  out.doi = out.doi || extra.doi || "";
  out.venue = richer(out.venue, extra.venue);
  out.publisher = richer(out.publisher, extra.publisher);
  out.type = out.type || extra.type || "";
  out.url = out.url || extra.url || "";
  out.pdf_url = out.pdf_url || extra.pdf_url || "";
  out.year = out.year ?? extra.year ?? null;
  if (out.is_oa === null || out.is_oa === undefined) out.is_oa = extra.is_oa ?? null;
  out.license = out.license || extra.license || "";
  if (extra.citations != null && (out.citations == null || extra.citations > out.citations)) out.citations = extra.citations;
  if (extra.references_count != null && out.references_count == null) out.references_count = extra.references_count;
  out.authors = out.authors?.length >= (extra.authors?.length ?? 0) ? out.authors : extra.authors;
  out.fields = dedupeStrings([...(out.fields ?? []), ...(extra.fields ?? [])]);
  out.keywords = dedupeStrings([...(out.keywords ?? []), ...(extra.keywords ?? [])]);
  out.sources = dedupeStrings([...(out.sources ?? []), ...(extra.sources ?? [])]);
  out.ids = { ...extra.ids, ...pruneEmpty(out.ids) };
  out.language = out.language || extra.language || "";
  return out;
}

function pruneEmpty(obj) {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v));
}

function dedupeStrings(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = String(item).toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Collapse duplicates coming from different sources.
 * Two records are the same paper when they share a DOI, a strong title match,
 * or the same arXiv/PubMed id.
 */
export function dedupe(records, { titleThreshold = 0.9 } = {}) {
  const byKey = new Map();
  const order = [];

  for (const record of records) {
    if (!record?.title) continue;
    const key = recordKey(record);
    let target = byKey.get(key);

    if (!target) {
      // Fall back to fuzzy title matching against what we already have.
      const tokens = titleTokens(record.title);
      for (const candidate of order) {
        if (record.doi && candidate.doi && record.doi !== candidate.doi) continue;
        const sameYear = !record.year || !candidate.year || Math.abs(record.year - candidate.year) <= 1;
        if (!sameYear) continue;
        const candidateTokens = titleTokens(candidate.title);
        if (Math.abs(tokens.size - candidateTokens.size) > 4) continue;
        if (titleSimilarity(record.title, candidate.title) >= titleThreshold) {
          target = candidate;
          break;
        }
      }
    }

    if (target) {
      const merged = mergeRecords(target, record);
      Object.assign(target, merged);
    } else {
      const copy = { ...record };
      byKey.set(key, copy);
      order.push(copy);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const SOURCE_TRUST = {
  crossref: 1.0,
  openalex: 0.98,
  pubmed: 0.96,
  europepmc: 0.95,
  arxiv: 0.9,
  "semantic-scholar": 0.88,
  dblp: 0.85,
  ieee: 0.85,
  scopus: 0.85,
  doaj: 0.8,
  pmc: 0.8,
  openreview: 0.78,
  biorxiv: 0.75,
  medrxiv: 0.75,
  zenodo: 0.7,
  hal: 0.7,
  openaire: 0.68,
  iacr: 0.7,
  core: 0.65,
};

const STOPWORDS = new Set([
  "a", "an", "the", "of", "and", "or", "for", "in", "on", "to", "with", "at", "by",
  "from", "as", "is", "are", "be", "using", "via", "into", "that", "this", "how",
  "what", "why", "can", "does", "do", "review", "study", "paper", "papers",
]);

export function queryTerms(query) {
  return [...new Set(
    normalizeTitle(query)
      .split(" ")
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  )];
}

/** Cheap BM25-ish relevance of a record against the query terms. */
export function relevance(record, terms) {
  if (!terms?.length) return 0;
  const title = normalizeTitle(record.title);
  const abstract = normalizeTitle(record.abstract);
  const venue = normalizeTitle(record.venue);
  const keywords = normalizeTitle((record.keywords ?? []).join(" "));

  let score = 0;
  for (const term of terms) {
    const stem = term.length > 5 ? term.slice(0, term.length - 2) : term;
    const hit = (haystack, weight) => {
      if (!haystack) return 0;
      if (haystack.includes(term)) return weight;
      if (stem.length > 3 && haystack.includes(stem)) return weight * 0.6;
      return 0;
    };
    score += hit(title, 4);
    score += hit(keywords, 2);
    score += hit(abstract, 1);
    score += hit(venue, 0.5);
  }
  return score / terms.length;
}

export function trustOf(record) {
  const list = record.sources ?? [];
  if (!list.length) return 0.5;
  return Math.max(...list.map((s) => SOURCE_TRUST[s] ?? 0.6));
}

/**
 * Rank by relevance, citation impact, recency, source trust and open access.
 * Returns a new array; `score` and `why` are attached to each record.
 */
export function rank(records, query, { now = new Date().getFullYear(), weights = {} } = {}) {
  const w = { relevance: 1, citations: 0.18, recency: 0.25, trust: 0.35, oa: 0.12, ...weights };
  const terms = queryTerms(query);
  const maxCitations = Math.max(1, ...records.map((r) => r.citations ?? 0));

  const scored = records.map((record) => {
    const rel = relevance(record, terms);
    const citeScore = Math.log10(1 + (record.citations ?? 0)) / Math.log10(1 + maxCitations);
    const age = record.year ? Math.max(0, now - record.year) : 12;
    const recency = Math.exp(-age / 12);
    const trust = trustOf(record);
    const oa = record.pdf_url ? 1 : record.is_oa ? 0.5 : 0;

    const score =
      w.relevance * rel + w.citations * citeScore + w.recency * recency + w.trust * trust + w.oa * oa;

    const why = [];
    if (rel >= 0.6) why.push("matches the query terms");
    if ((record.citations ?? 0) >= Math.max(20, maxCitations * 0.25)) why.push(`${record.citations} citations`);
    if (record.pdf_url) why.push("open-access PDF");
    else if (record.is_oa) why.push("open access");
    if (record.year && record.year >= now - 3) why.push("recent");

    return { ...record, score: Number(score.toFixed(4)), why };
  });

  scored.sort((a, b) => b.score - a.score || (b.citations ?? 0) - (a.citations ?? 0));
  return scored;
}

/** Trim a record for listing (keeps token cost low). */
export function toCompact(record, index) {
  const out = {
    n: index,
    title: cleanText(record.title, 300),
    authors: shortAuthors(record.authors),
    year: record.year,
    venue: cleanText(record.venue, 120) || undefined,
    citations: record.citations ?? undefined,
    open_access: record.pdf_url ? "pdf" : record.is_oa ? "yes" : record.is_oa === false ? "no" : undefined,
    doi: record.doi || undefined,
    id: bestId(record),
    sources: (record.sources ?? []).join(",") || undefined,
    score: record.score,
    why: record.why?.length ? record.why.join(", ") : undefined,
  };
  return prune(out);
}

export function shortAuthors(authors, max = 4) {
  if (!authors?.length) return "";
  const names = authors.map((a) => surname(a.name));
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} et al. (${names.length} authors)`;
}

function surname(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  if (/^[A-Z]{2,}$/.test(parts.at(-1))) return `${parts.at(-2) ?? ""} ${parts.at(-1)}`.trim();
  return parts.at(-1);
}

export function bestId(record) {
  if (record.doi) return `doi:${record.doi}`;
  for (const [name, value] of Object.entries(record.ids ?? {})) {
    if (value) return `${name}:${value}`;
  }
  return record.url || "";
}

function prune(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

/** Full record for `detail: "full"` — keeps abstracts, drops empty fields. */
export function toFull(record) {
  return prune({
    title: cleanText(record.title, 600),
    authors: (record.authors ?? []).map((a) => a.name),
    year: record.year,
    venue: cleanText(record.venue, 300),
    type: record.type,
    publisher: record.publisher,
    abstract: cleanText(record.abstract, 2500),
    doi: record.doi,
    url: record.url,
    pdf_url: record.pdf_url,
    open_access: record.is_oa,
    license: record.license,
    citations: record.citations,
    references_count: record.references_count,
    fields: record.fields?.length ? record.fields : undefined,
    keywords: record.keywords?.length ? record.keywords : undefined,
    ids: Object.keys(record.ids ?? {}).length ? prune(record.ids) : undefined,
    sources: record.sources,
    score: record.score,
    why: record.why,
  });
}
