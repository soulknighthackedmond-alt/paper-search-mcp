// Identifier handling: recognise what the user pasted and normalise it.

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>,;)\]}]+)/i;
const ARXIV_NEW_RE = /\b(\d{4}\.\d{4,5})(v\d+)?\b/;
const ARXIV_OLD_RE = /\b([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/i;
const PMID_RE = /\bpmid[:\s]*(\d{6,9})\b/i;
const PMC_RE = /\bpmc[:\s]*(\d{4,9})\b/i;
const OPENALEX_RE = /\bW\d{6,12}\b/;
const S2_RE = /\b([0-9a-f]{40})\b/i;

/** Strip a DOI down to its bare form (no URL, no prefix, lowercase). */
export function normalizeDoi(input) {
  if (!input) return "";
  let doi = String(input).trim();
  doi = doi.replace(/^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)/i, "");
  doi = doi.replace(/[.,;)\]}'"]+$/, "");
  const match = doi.match(DOI_RE);
  if (match) doi = match[1];
  return doi.trim().toLowerCase();
}

/** Accepts 2401.12345, 2401.12345v2, cs/0701001, arXiv:..., arxiv.org/abs/... */
export function normalizeArxivId(input) {
  if (!input) return "";
  let value = String(input).trim();
  value = value.replace(/^arxiv[:\s]*/i, "");
  value = value.replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "");
  value = value.replace(/\.pdf$/i, "");
  const withVersion = value.match(/^([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?$/i);
  if (withVersion) return `${withVersion[1]}${withVersion[2] ?? ""}`;
  const loose = value.match(ARXIV_NEW_RE) ?? value.match(ARXIV_OLD_RE);
  return loose ? `${loose[1]}${loose[2] ?? ""}` : "";
}

export function normalizePmid(input) {
  if (!input) return "";
  const value = String(input).trim();
  const tagged = value.match(PMID_RE);
  if (tagged) return tagged[1];
  if (/^\d{6,9}$/.test(value)) return value;
  return "";
}

export function normalizePmcid(input) {
  if (!input) return "";
  const value = String(input).trim().toUpperCase();
  const tagged = value.match(PMC_RE);
  if (tagged) return `PMC${tagged[1]}`;
  if (/^PMC\d{4,9}$/.test(value)) return value;
  return "";
}

export function stripArxivVersion(arxivId) {
  return String(arxivId ?? "").replace(/v\d+$/i, "");
}

/**
 * Work out what a free-text identifier actually is.
 * Returns { type, value } where type is one of:
 * doi | arxiv | pmid | pmcid | openalex | semantic | url | query
 */
export function detectIdentifier(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return { type: "query", value: "" };

  const doi = normalizeDoi(input);
  if (doi && /^10\.\d{4,9}\//.test(doi)) return { type: "doi", value: doi };

  const arxiv = normalizeArxivId(input);
  if (arxiv) return { type: "arxiv", value: arxiv };

  const pmcid = normalizePmcid(input);
  if (pmcid && /^PMC\d+$/i.test(input.trim())) return { type: "pmcid", value: pmcid };

  const pmid = normalizePmid(input);
  if (pmid) return { type: "pmid", value: pmid };

  const openalex = input.match(OPENALEX_RE);
  if (openalex && /^https?:\/\/openalex\.org\//i.test(input)) return { type: "openalex", value: openalex[0] };

  if (/^https?:\/\//i.test(input)) {
    if (/europepmc\.org\/article\/PMC/i.test(input)) {
      const m = input.match(/PMC\d+/i);
      if (m) return { type: "pmcid", value: m[0].toUpperCase() };
    }
    if (/pubmed\.ncbi\.nlm\.nih\.gov/i.test(input)) {
      const m = input.match(/\/(\d{6,9})/);
      if (m) return { type: "pmid", value: m[1] };
    }
    if (/openalex\.org/i.test(input)) {
      const m = input.match(OPENALEX_RE);
      if (m) return { type: "openalex", value: m[0] };
    }
    return { type: "url", value: input };
  }

  const s2 = input.match(S2_RE);
  if (s2 && input.length === 40) return { type: "semantic", value: s2[1] };

  return { type: "query", value: input };
}

// ---------------------------------------------------------------------------
// Title helpers used for de-duplication across sources.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "of", "and", "or", "for", "in", "on", "to", "with", "at",
  "by", "from", "as", "is", "are", "be", "using", "via", "into", "that", "this",
]);

/** Lowercase, strip punctuation/latex/markup, collapse whitespace. */
export function normalizeTitle(title) {
  return String(title ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function titleTokens(title) {
  return new Set(
    normalizeTitle(title)
      .split(" ")
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/** Jaccard similarity of title tokens, 0..1. */
export function titleSimilarity(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/** Stable key for a record: DOI if we have one, else a normalised title. */
export function recordKey(record) {
  if (record?.doi) return `doi:${record.doi}`;
  const ids = record?.ids ?? {};
  for (const name of ["arxiv", "pmid", "pmcid", "openalex", "semantic", "dblp", "core", "mag"]) {
    if (ids[name]) return `${name}:${ids[name]}`;
  }
  const title = normalizeTitle(record?.title);
  if (title) return `title:${title.slice(0, 120)}`;
  return `url:${record?.url ?? Math.random()}`;
}
