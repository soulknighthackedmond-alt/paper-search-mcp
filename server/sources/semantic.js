// Semantic Scholar Graph API — good relevance ranking, citation context and
// "similar papers". Works without a key (shared pool); a key raises the limit.

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { normalizeDoi } from "../lib/ids.js";
import { config } from "../config.js";
import { make, clampLimit, yearFilter } from "./util.js";

const API = "https://api.semanticscholar.org/graph/v1";
const FIELDS = [
  "title", "abstract", "year", "venue", "publicationVenue", "authors", "externalIds",
  "openAccessPdf", "citationCount", "influentialCitationCount", "referenceCount",
  "publicationTypes", "fieldsOfStudy", "s2FieldsOfStudy", "url", "tldr", "publicationDate",
  "journal", "isOpenAccess",
].join(",");

function headers() {
  return config.keys.semanticScholar ? { "x-api-key": config.keys.semanticScholar } : {};
}

export function fromSemantic(paper) {
  const ids = paper.externalIds ?? {};
  const doi = normalizeDoi(ids.DOI ?? "");
  const authors = (paper.authors ?? []).map((a) => ({ name: a.name })).filter((a) => a.name);
  return make("semantic-scholar", {
    id: `s2:${paper.paperId}`,
    doi,
    title: paper.title ?? "",
    authors,
    year: paper.year ?? null,
    venue: paper.venue || paper.publicationVenue?.name || paper.journal?.name || "",
    type: (paper.publicationTypes ?? [])[0] ?? "journal-article",
    publisher: paper.journal?.publisher ?? "",
    abstract: paper.abstract ?? paper.tldr?.text ?? "",
    url: paper.url ?? (doi ? `https://doi.org/${doi}` : ""),
    pdf_url: paper.openAccessPdf?.url ?? "",
    is_oa: paper.isOpenAccess ?? (paper.openAccessPdf ? true : null),
    license: paper.openAccessPdf?.license ?? "",
    citations: paper.citationCount ?? null,
    references_count: paper.referenceCount ?? null,
    fields: (paper.fieldsOfStudy ?? []).slice(0, 6),
    keywords: (paper.s2FieldsOfStudy ?? []).map((f) => f.category).filter(Boolean).slice(0, 8),
    ids: {
      semantic: paper.paperId,
      doi: doi || undefined,
      arxiv: ids.ArXiv,
      pmid: ids.PubMed,
      pmcid: ids.PubMedCentral,
      mag: ids.MAG,
      dblp: ids.DBLP,
      acl: ids.ACL,
    },
    extra: {
      tldr: paper.tldr?.text,
      influential_citations: paper.influentialCitationCount,
      publication_date: paper.publicationDate,
      volume: paper.journal?.volume,
      pages: paper.journal?.pages,
    },
  });
}

function idPath(identifier) {
  const { type, value } = identifier;
  if (type === "doi") return `DOI:${normalizeDoi(value)}`;
  if (type === "arxiv") return `ARXIV:${value}`;
  if (type === "pmid") return `PMID:${value}`;
  if (type === "pmcid") return `PMCID:${value}`;
  if (type === "semantic") return value;
  return null;
}

export default {
  id: "semantic-scholar",
  label: "Semantic Scholar",
  homepage: "https://www.semanticscholar.org",
  coverage: "200M+ papers across all fields, with AI-generated one-line summaries and citation context.",
  auth: [],
  filters: ["query", "limit", "year_from", "year_to", "sort"],
  notes: "The free shared pool is rate limited (~1 request/second) and often busy, so this source is not in the default set; adding a free S2 API key makes it fast and reliable. It is still used automatically for 'similar papers'.",

  async search({ query, limit = 10, yearFrom, yearTo, sort, signal }) {
    const max = clampLimit(limit, 50);
    const url = `${API}/paper/search?${qs({
      query,
      limit: max,
      fields: FIELDS,
      year: yearFrom || yearTo ? `${yearFrom ?? 1900}-${yearTo ?? 2100}` : "",
      sort: sort === "citations" ? "citationCount:desc" : "",
    })}`;
    const data = await cached("s2-search", [url], () => getJson(url, { headers: headers(), signal }));
    return yearFilter((data?.data ?? []).map(fromSemantic), yearFrom, yearTo);
  },

  async getById(identifier) {
    const path = idPath(identifier);
    if (!path) return null;
    const url = `${API}/paper/${path}?fields=${FIELDS}`;
    const data = await cached("s2-paper", [url], () => getJson(url, { headers: headers() }));
    return data?.paperId ? fromSemantic(data) : null;
  },

  async related({ identifier, mode, limit = 10, signal }) {
    const path = idPath(identifier);
    if (!path) return [];
    const max = clampLimit(limit, 50);
    if (mode === "similar") {
      const url = `${API}/recommendations/v1/papers/forpaper/${path}?${qs({ limit: max, fields: FIELDS })}`;
      const data = await cached("s2-recommend", [url], () =>
        getJson(url, { headers: headers(), signal }),
      );
      return (data?.recommendedPapers ?? []).map(fromSemantic);
    }
    if (mode === "citing" || mode === "references") {
      const key = mode === "citing" ? "citations" : "references";
      const url = `${API}/paper/${path}/${key}?${qs({ limit: max, fields: FIELDS })}`;
      const data = await cached(`s2-${key}`, [url], () =>
        getJson(url, { headers: headers(), signal }),
      );
      const list = (data?.data ?? []).map((item) => item.citingPaper ?? item.citedPaper).filter(Boolean);
      return list.map(fromSemantic);
    }
    return [];
  },
};
