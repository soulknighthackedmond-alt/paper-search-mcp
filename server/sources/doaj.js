// DOAJ — the Directory of Open Access Journals. Everything here is open access
// by definition, which makes it the best "free full text only" filter.

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { normalizeDoi } from "../lib/ids.js";
import { make, clampLimit, yearFilter } from "./util.js";

const API = "https://doaj.org/api/search/articles";

function buildQuery(query) {
  const raw = String(query ?? "").trim();
  if (/[a-z_]+\s*:/.test(raw)) return raw; // already DOAJ/Elasticsearch syntax
  const escaped = raw.replace(/"/g, '\\"');
  return `bibjson.title:("${escaped}") OR bibjson.abstract:("${escaped}") OR bibjson.keywords:("${escaped}")`;
}

export function fromDoaj(result) {
  const bib = result.bibjson ?? {};
  const doi = normalizeDoi((bib.identifier ?? []).find((i) => i.type === "doi")?.id ?? "");
  const fulltext = (bib.link ?? []).filter((l) => /fulltext/i.test(l.type ?? ""));
  const pdf = fulltext.find((l) => /\.pdf($|\?)/i.test(l.url ?? ""))?.url ?? "";
  const journal = bib.journal ?? {};
  const license = (journal.license ?? []).map((l) => l.type).filter(Boolean).join(", ");
  return make("doaj", {
    id: `doi:${doi || result.id}`,
    doi,
    title: bib.title ?? "",
    authors: (bib.author ?? []).map((a) => ({ name: a.name ?? [a.given, a.family].filter(Boolean).join(" ") })).filter((a) => a.name),
    year: bib.year ? Number(bib.year) : null,
    venue: journal.title ?? "",
    type: "journal-article",
    publisher: journal.publisher ?? "",
    abstract: bib.abstract ?? "",
    url: fulltext[0]?.url ?? (doi ? `https://doi.org/${doi}` : ""),
    pdf_url: pdf,
    is_oa: true,
    license,
    citations: null,
    fields: (bib.subject ?? []).slice(0, 6).map((s) => s.term).filter(Boolean),
    keywords: (bib.keywords ?? []).slice(0, 12),
    language: journal.language?.[0] ?? "",
    ids: { doi: doi || undefined, doaj: result.id },
    extra: {
      issn: journal.issn?.print ?? journal.issn?.electronic,
      publisher: journal.publisher,
      oa_start: journal.oa_start,
    },
  });
}

export default {
  id: "doaj",
  label: "DOAJ",
  homepage: "https://doaj.org",
  coverage: "20k+ vetted open-access journals across every discipline — every article is free to read.",
  auth: [],
  filters: ["query", "limit", "year_from", "year_to"],
  notes: "Use this when you only want work you can legally download and read in full.",

  async search({ query, limit = 10, yearFrom, yearTo, signal }) {
    const max = clampLimit(limit, 50);
    let search = buildQuery(query);
    if (yearFrom || yearTo) search = `(${search}) AND bibjson.year:[${yearFrom ?? 1900} TO ${yearTo ?? 2100}]`;
    const url = `${API}/${encodeURIComponent(search)}?${qs({ pageSize: max, page: 1 })}`;
    const data = await cached("doaj-search", [url], () => getJson(url, { signal }));
    return yearFilter((data?.results ?? []).map(fromDoaj), yearFrom, yearTo);
  },
};
