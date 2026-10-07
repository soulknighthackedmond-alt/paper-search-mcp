// Europe PMC — life sciences and medicine, including preprint servers.
// No key, rich records (abstracts, MeSH, OA full-text links, citation counts).

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { normalizeDoi, normalizePmid, normalizePmcid } from "../lib/ids.js";
import { make, clampLimit, yearFilter } from "./util.js";

const API = "https://www.ebi.ac.uk/europepmc/webservices/rest";

export function fromEuropePmc(result) {
  const journal = result.journalInfo?.journal ?? {};
  const urls = result.fullTextUrlList?.fullTextUrl ?? [];
  const pdfUrl =
    urls.find((u) => /pdf/i.test(u.documentStyle ?? "") && /open access|free/i.test(u.availability ?? ""))?.url ??
    urls.find((u) => /pdf/i.test(u.documentStyle ?? ""))?.url ??
    "";
  const doi = normalizeDoi(result.doi ?? "");
  const pmcid = normalizePmcid(result.pmcid ?? result.fullTextIdList?.fullTextId?.[0] ?? "");
  const isPreprint = result.source === "PPR";
  const isOa = result.isOpenAccess === "Y" || /^(Y|true)$/i.test(String(result.isOpenAccess ?? ""));

  return make(isPreprint ? "europepmc-preprint" : "europepmc", {
    id: `pmid:${result.pmid ?? result.id}`,
    doi,
    title: result.title ?? "",
    authors: (result.authorList?.author ?? []).map((a) => ({
      name: a.fullName ?? [a.firstName, a.lastName].filter(Boolean).join(" "),
      affiliation: a.affiliation ?? undefined,
    })).filter((a) => a.name),
    year: result.journalInfo?.yearOfPublication ?? (result.firstPublicationDate ? Number(String(result.firstPublicationDate).slice(0, 4)) : null),
    venue: journal.title ?? result.bookOrReportDetails?.publisher ?? (isPreprint ? "Preprint" : ""),
    type: isPreprint ? "preprint" : (result.pubTypeList?.pubType?.[0] ?? "journal-article"),
    publisher: result.bookOrReportDetails?.publisher ?? journal.publisher ?? "",
    abstract: result.abstractText ?? "",
    url: result.pmid
      ? `https://europepmc.org/article/${result.source ?? "MED"}/${result.pmid}`
      : `https://europepmc.org/article/${result.source ?? "MED"}/${result.id}`,
    pdf_url: pdfUrl,
    is_oa: isPreprint ? true : isOa,
    license: result.license ?? "",
    citations: result.citedByCount ?? null,
    fields: (result.meshHeadingList?.meshHeading ?? []).slice(0, 8).map((m) => m.descriptorName).filter(Boolean),
    keywords: (result.keywordList?.keyword ?? []).slice(0, 12),
    language: result.language ?? "",
    ids: {
      pmid: normalizePmid(result.pmid ?? ""),
      pmcid: pmcid || undefined,
      doi: doi || undefined,
      arxiv: undefined,
    },
    extra: {
      volume: journal.volume,
      issue: journal.issue,
      pages: result.pageInfo,
      has_full_text: result.inEPMC === "Y" || result.inPMC === "Y",
      preprint_source: isPreprint ? (result.bookOrReportDetails?.publisher ?? result.publisher ?? "") : undefined,
    },
  });
}

async function searchEuropePmc({ query, limit, yearFrom, yearTo, sourceFilter, sort, signal }) {
  const max = clampLimit(limit, 50);
  const parts = [];
  if (sourceFilter) parts.push(sourceFilter);
  parts.push(`(${query})`);
  if (yearFrom || yearTo) {
    parts.push(`(PUB_YEAR:[${yearFrom ?? 1800} TO ${yearTo ?? 2100}])`);
  }
  const url = `${API}/search?${qs({
    query: parts.join(" AND "),
    format: "json",
    pageSize: max,
    resultType: "core",
    sort: sort === "citations" ? "CITED desc" : sort === "date" ? "P_PDATE_D desc" : "",
  })}`;
  const data = await cached("europepmc-search", [url], () => getJson(url, { signal }));
  return yearFilter((data?.resultList?.result ?? []).map(fromEuropePmc), yearFrom, yearTo);
}

export default {
  id: "europepmc",
  label: "Europe PMC",
  homepage: "https://europepmc.org",
  coverage: "Life sciences and medicine: PubMed records plus Agricola, preprints and OA full text.",
  auth: [],
  filters: ["query", "limit", "year_from", "year_to", "sort"],
  notes: "Same corpus as PubMed but with abstracts, MeSH terms, citation counts and OA PDF links in one call.",

  async search({ query, limit = 10, yearFrom, yearTo, sort, signal }) {
    return searchEuropePmc({ query, limit, yearFrom, yearTo, sort, signal });
  },

  async getById(identifier) {
    const { type, value } = identifier;
    if (!["pmid", "pmcid", "doi"].includes(type)) return null;
    const query = type === "pmid" ? `EXT_ID:${value} AND SRC:MED`
      : type === "pmcid" ? `PMCID:${value}`
        : `DOI:"${normalizeDoi(value)}"`;
    const url = `${API}/search?${qs({ query, format: "json", pageSize: 1, resultType: "core" })}`;
    const data = await cached("europepmc-get", [url], () => getJson(url));
    const first = data?.resultList?.result?.[0];
    return first ? fromEuropePmc(first) : null;
  },

  /** OA full text as XML/plain text, used by read_paper when no PDF exists. */
  async fullText(identifier) {
    const { type, value } = identifier;
    if (type !== "pmcid") return null;
    const url = `${API}/${value}/fullTextXML`;
    const text = await cached("europepmc-fulltext", [value], async () => {
      const { getText } = await import("../lib/http.js");
      return getText(url);
    });
    return text;
  },
};

/** A PMC-only view of the same API — full-text OA biomedical literature. */
export const pmc = {
  id: "pmc",
  label: "PubMed Central",
  homepage: "https://www.ncbi.nlm.nih.gov/pmc/",
  coverage: "Open-access full text of biomedical and life-science articles (PMC subset of Europe PMC).",
  auth: [],
  filters: ["query", "limit", "year_from", "year_to"],
  notes: "Every hit here is free full text.",

  async search({ query, limit = 10, yearFrom, yearTo, signal }) {
    return searchEuropePmc({ query, limit, yearFrom, yearTo, sourceFilter: "SRC:PMC", signal });
  },
};
