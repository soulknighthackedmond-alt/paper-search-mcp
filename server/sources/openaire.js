// OpenAIRE — the European aggregator: publications, datasets, software and the
// projects that funded them. Uses the current Graph API.

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { normalizeDoi } from "../lib/ids.js";
import { make, clampLimit, yearFilter } from "./util.js";

const GRAPH = "https://api.openaire.eu/graph/v1/researchProducts";

function stripJats(html) {
  return String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** OpenAIRE keeps identifiers in a few different shapes — dig the DOI out. */
function doiOf(item) {
  const candidates = [];
  const push = (value) => {
    if (!value) return;
    if (typeof value === "string") candidates.push(value);
    else if (typeof value === "object") candidates.push(value.value, value.doi, value.id);
  };
  push(item.pids?.doi);
  for (const pid of item.pids?.alternateIdentifiers ?? []) push(pid);
  for (const pid of item.originalIds ?? []) push(pid);
  for (const candidate of candidates) {
    const doi = normalizeDoi(candidate);
    if (/^10\.\d{4,9}\//.test(doi)) return doi;
  }
  const joined = JSON.stringify(item.pids ?? {});
  const found = joined.match(/10\.\d{4,9}\/[^"\\]+/);
  return found ? normalizeDoi(found[0]) : "";
}

function urlsOf(item) {
  const urls = [];
  for (const instance of item.instances ?? []) {
    for (const url of instance.urls ?? []) urls.push(typeof url === "string" ? url : url?.value);
    if (instance.url) urls.push(instance.url);
  }
  return urls.filter(Boolean);
}

export function fromOpenaire(item) {
  const doi = doiOf(item);
  const urls = urlsOf(item);
  const pdf = urls.find((u) => /\.pdf($|\?)/i.test(u)) ?? "";
  const landing = urls.find((u) => !/\.pdf($|\?)/i.test(u)) ?? "";
  const access = item.bestAccessRight?.label ?? item.bestAccessRight ?? "";
  return make("openaire", {
    id: `openaire:${item.id}`,
    doi,
    title: item.mainTitle ?? "",
    authors: (item.authors ?? []).map((a) => ({ name: a.fullName ?? a.name ?? "" })).filter((a) => a.name),
    year: item.publicationDate ? Number(String(item.publicationDate).slice(0, 4)) : null,
    venue: item.container?.name ?? "",
    type: item.type === "publication" ? "journal-article" : (item.type ?? "publication"),
    publisher: item.publisher ?? "",
    abstract: stripJats(item.descriptions?.[0] ?? ""),
    url: landing || (doi ? `https://doi.org/${doi}` : `https://explore.openaire.eu/search/publication?pid=${encodeURIComponent(item.id)}`),
    pdf_url: pdf,
    is_oa: /OPEN/i.test(String(access)),
    license: item.bestAccessRight?.label ?? "",
    citations: item.indicators?.citationCount ?? item.indicators?.citedByCount ?? null,
    references_count: null,
    fields: (item.subjects ?? []).map((s) => s.subject?.value).filter(Boolean).slice(0, 6),
    keywords: (item.subjects ?? []).map((s) => s.subject?.value).filter(Boolean).slice(0, 10),
    language: item.language?.code ?? "",
    ids: { openaire: item.id, doi: doi || undefined },
    extra: { access_right: access, resource_type: item.type, sources: item.sources },
  });
}

export default {
  id: "openaire",
  label: "OpenAIRE",
  homepage: "https://explore.openaire.eu",
  coverage: "European repositories: publications, datasets, software and their funding links.",
  auth: [],
  filters: ["query", "limit", "year_from", "year_to"],
  notes: "Wide repository coverage, so it surfaces green open-access copies that journal indexes miss. Metadata quality varies.",

  async search({ query, limit = 10, yearFrom, yearTo, signal }) {
    const max = clampLimit(limit, 50);
    const url = `${GRAPH}?${qs({
      search: query,
      type: "publication",
      pageSize: max,
      page: 1,
      fromPublicationDate: yearFrom ? `${yearFrom}-01-01` : "",
      toPublicationDate: yearTo ? `${yearTo}-12-31` : "",
    })}`;
    const data = await cached("openaire-search", [url], () => getJson(url, { signal }));
    const results = data?.results ?? [];
    return yearFilter(results.map(fromOpenaire), yearFrom, yearTo);
  },
};
