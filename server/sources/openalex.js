// OpenAlex — the widest free index (works, authors, institutions, citation
// graph). No key required; an email or a free API key raises the quota.

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { normalizeDoi } from "../lib/ids.js";
import { config } from "../config.js";
import { make, clampLimit, yearFilter } from "./util.js";

const API = "https://api.openalex.org";
const WORK_SELECT = [
  "id", "doi", "title", "display_name", "publication_year", "publication_date", "type",
  "authorships", "primary_location", "best_oa_location", "locations", "open_access",
  "cited_by_count", "referenced_works_count", "abstract_inverted_index", "keywords",
  "topics", "language", "ids", "biblio", "is_retracted", "is_paratext",
].join(",");

function auth() {
  const params = {};
  if (config.email) params.mailto = config.email;
  if (config.keys.openalex) params.api_key = config.keys.openalex;
  return params;
}

/** OpenAlex stores abstracts as an inverted index — turn it back into text. */
export function fromInvertedIndex(index) {
  if (!index) return "";
  const slots = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) slots[position] = word;
  }
  return slots.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function venueOf(work) {
  const loc = work.primary_location ?? {};
  const source = loc.source ?? {};
  return source.display_name ?? source.host_organization_name ?? "";
}

function bestPdf(work) {
  const best = work.best_oa_location ?? {};
  if (best.pdf_url) return best.pdf_url;
  const primary = work.primary_location ?? {};
  if (primary.pdf_url) return primary.pdf_url;
  for (const loc of work.locations ?? []) {
    if (loc.pdf_url && loc.is_oa) return loc.pdf_url;
  }
  return "";
}

export function fromOpenAlex(work) {
  const oa = work.open_access ?? {};
  const best = work.best_oa_location ?? {};
  return make("openalex", {
    id: `openalex:${(work.id ?? "").split("/").pop()}`,
    doi: normalizeDoi(work.doi ?? ""),
    title: work.title ?? work.display_name ?? "",
    authors: (work.authorships ?? []).map((a) => {
      const out = { name: a.author?.display_name ?? a.raw_author_name ?? "" };
      if (a.author?.orcid) out.orcid = String(a.author.orcid).replace(/^https?:\/\/orcid\.org\//, "");
      const inst = (a.institutions ?? [])[0]?.display_name ?? a.raw_affiliation_strings?.[0];
      if (inst) out.affiliation = inst;
      return out;
    }).filter((a) => a.name),
    year: work.publication_year ?? null,
    venue: venueOf(work),
    type: work.type ?? "",
    publisher: work.primary_location?.source?.host_organization_name ?? "",
    abstract: fromInvertedIndex(work.abstract_inverted_index),
    url: work.primary_location?.landing_page_url || work.doi || work.id || "",
    pdf_url: bestPdf(work),
    is_oa: typeof oa.is_oa === "boolean" ? oa.is_oa : null,
    license: best.license ?? work.primary_location?.license ?? "",
    citations: work.cited_by_count ?? null,
    references_count: work.referenced_works_count ?? null,
    fields: (work.topics ?? []).slice(0, 5).map((t) => t.display_name).filter(Boolean),
    keywords: (work.keywords ?? []).slice(0, 10).map((k) => k.display_name).filter(Boolean),
    language: work.language ?? "",
    ids: {
      openalex: (work.id ?? "").split("/").pop(),
      doi: normalizeDoi(work.doi ?? "") || undefined,
      pmid: work.ids?.pmid ? String(work.ids.pmid).split("/").pop() : undefined,
      pmcid: work.ids?.pmcid ? String(work.ids.pmcid).split("/").pop() : undefined,
      mag: work.ids?.mag,
    },
    extra: {
      volume: work.biblio?.volume,
      issue: work.biblio?.issue,
      pages: [work.biblio?.first_page, work.biblio?.last_page].filter(Boolean).join("-") || undefined,
      retracted: work.is_retracted || undefined,
      oa_status: oa.oa_status,
    },
  });
}

function workPath(identifier) {
  const { type, value } = identifier;
  if (type === "openalex") return `/works/${value}`;
  if (type === "doi") return `/works/doi:${encodeURIComponent(normalizeDoi(value))}`;
  if (type === "pmid") return `/works/pmid:${value}`;
  if (type === "pmcid") return `/works/pmcid:${value}`;
  return null;
}

export default {
  id: "openalex",
  label: "OpenAlex",
  homepage: "https://openalex.org",
  coverage: "250M+ works across every discipline, with the full citation graph, OA locations and author records.",
  auth: [],
  filters: ["query", "limit", "year_from", "year_to", "open_access_only", "type", "sort"],
  notes: "Best single source for citation counts, OA PDF links and 'who cites this'. Free API key optional (raises the daily quota).",

  async search({ query, limit = 10, yearFrom, yearTo, openAccessOnly, type, sort = "relevance", signal }) {
    const max = clampLimit(limit, 50);
    const filters = [];
    if (yearFrom) filters.push(`from_publication_date:${yearFrom}-01-01`);
    if (yearTo) filters.push(`to_publication_date:${yearTo}-12-31`);
    if (openAccessOnly) filters.push("is_oa:true");
    if (type) filters.push(`type:${type}`);
    filters.push("is_paratext:false");
    const url = `${API}/works?${qs({
      search: query,
      per_page: Math.min(max * 2, 100),
      select: WORK_SELECT,
      sort: sort === "citations" ? "cited_by_count:desc" : sort === "date" ? "publication_date:desc" : "relevance_score:desc",
      filter: filters.join(","),
      ...auth(),
    })}`;
    const data = await cached("openalex-search", [url], () => getJson(url, { signal }));
    return yearFilter((data?.results ?? []).map(fromOpenAlex), yearFrom, yearTo).slice(0, max);
  },

  async getById(identifier) {
    const path = workPath(identifier);
    if (!path) return null;
    const data = await cached("openalex-work", [path], () => getJson(`${API}${path}?${qs(auth())}`));
    return data?.id ? fromOpenAlex(data) : null;
  },

  async related({ identifier, mode, limit = 10, signal }) {
    const max = clampLimit(limit, 50);
    const path = workPath(identifier);
    if (!path) return [];
    const work = await cached("openalex-work", [path], () => getJson(`${API}${path}?${qs(auth())}`));
    if (!work?.id) return [];

    if (mode === "citing") {
      const url = `${API}/works?${qs({
        filter: `cites:${work.id.split("/").pop()}`,
        per_page: max,
        select: WORK_SELECT,
        sort: "cited_by_count:desc",
        ...auth(),
      })}`;
      const data = await cached("openalex-citing", [work.id, max], () => getJson(url, { signal }));
      return (data?.results ?? []).map(fromOpenAlex);
    }

    if (mode === "references") {
      const ids = (work.referenced_works ?? []).slice(0, max);
      if (!ids.length) return [];
      const url = `${API}/works?${qs({
        filter: `openalex_id:${ids.map((i) => i.split("/").pop()).join("|")}`,
        per_page: max,
        select: WORK_SELECT,
        ...auth(),
      })}`;
      const data = await cached("openalex-refs", [work.id, max], () => getJson(url, { signal }));
      return (data?.results ?? []).map(fromOpenAlex);
    }

    if (mode === "similar") {
      const ids = (work.related_works ?? []).slice(0, max);
      if (!ids.length) return [];
      const url = `${API}/works?${qs({
        filter: `openalex_id:${ids.map((i) => i.split("/").pop()).join("|")}`,
        per_page: max,
        select: WORK_SELECT,
        ...auth(),
      })}`;
      const data = await cached("openalex-similar", [work.id, max], () => getJson(url, { signal }));
      return (data?.results ?? []).map(fromOpenAlex);
    }

    return [];
  },

  /** Author lookup with h-index and top works. */
  async author({ name, limit = 10, signal }) {
    const max = clampLimit(limit, 50);
    const search = await cached("openalex-author-search", [name], () =>
      getJson(`${API}/authors?${qs({ search: name, per_page: 5, ...auth() })}`, { signal }),
    );
    const candidate = search?.results?.[0];
    if (!candidate) return null;
    const authorId = candidate.id.split("/").pop();
    const works = await cached("openalex-author-works", [authorId, max], () =>
      getJson(
        `${API}/works?${qs({
          filter: `author.id:${authorId}`,
          per_page: max,
          select: WORK_SELECT,
          sort: "cited_by_count:desc",
          ...auth(),
        })}`,
        { signal },
      ),
    );
    return {
      id: authorId,
      name: candidate.display_name,
      orcid: candidate.orcid ? String(candidate.orcid).replace(/^https?:\/\/orcid\.org\//, "") : undefined,
      works_count: candidate.works_count,
      cited_by_count: candidate.cited_by_count,
      h_index: candidate.summary_stats?.h_index,
      i10_index: candidate.summary_stats?.i10_index,
      two_year_mean_citedness: candidate.summary_stats?.["2yr_mean_citedness"],
      affiliations: (candidate.affiliations ?? []).slice(0, 5).map((a) => ({
        name: a.institution?.display_name,
        years: a.years?.length ? `${Math.min(...a.years)}-${Math.max(...a.years)}` : undefined,
      })),
      top_works: (works?.results ?? []).map(fromOpenAlex),
    };
  },
};
