// Scopus (Elsevier) — the largest curated abstract and citation database.
// Needs an Elsevier API key; abstracts additionally need an institutional
// entitlement, so this source returns metadata only.

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { normalizeDoi } from "../lib/ids.js";
import { config } from "../config.js";
import { make, clampLimit } from "./util.js";

const API = "https://api.elsevier.com/content/search/scopus";

export function fromScopus(entry) {
  const doi = normalizeDoi(entry["prism:doi"] ?? "");
  const creators = (entry.author ?? []).map((a) => ({ name: a.authname })).filter((a) => a.name);
  return make("scopus", {
    id: `scopus:${entry.eid ?? doi}`,
    doi,
    title: entry["dc:title"] ?? "",
    authors: creators,
    year: entry["prism:coverDate"] ? Number(String(entry["prism:coverDate"]).slice(0, 4)) : null,
    venue: entry["prism:publicationName"] ?? "",
    type: entry.subtypeDescription ?? "journal-article",
    publisher: entry["prism:publisher"] ?? "",
    abstract: entry["dc:description"] ?? "",
    url: entry.link?.find((l) => l["@ref"] === "scopus")?.["@href"] ?? (doi ? `https://doi.org/${doi}` : ""),
    pdf_url: "",
    is_oa: entry.openaccessFlag === "1" ? true : null,
    citations: entry["citedby-count"] ? Number(entry["citedby-count"]) : null,
    fields: (entry["authkeywords"]?.author_keyword ?? []).slice(0, 8),
    keywords: (entry["authkeywords"]?.author_keyword ?? []).slice(0, 12),
    ids: { scopus: entry.eid, doi: doi || undefined, pmid: entry["pubmed-id"] },
    extra: {
      volume: entry["prism:volume"],
      issue: entry["prism:issueIdentifier"],
      pages: entry["prism:pageRange"],
      open_access: entry.openaccessFlag === "1",
    },
  });
}

export default {
  id: "scopus",
  label: "Scopus",
  homepage: "https://www.scopus.com",
  coverage: "90M+ curated records with citation data across science, technology, medicine and social science.",
  auth: ["SCOPUS_API_KEY"],
  filters: ["query", "limit"],
  notes: "Requires an Elsevier API key (dev.elsevier.com). Most institutional keys also unlock abstracts.",

  async search({ query, limit = 10, signal }) {
    if (!config.keys.scopus) {
      const error = new Error("Scopus needs an Elsevier API key: add SCOPUS_API_KEY in the bundle settings (dev.elsevier.com).");
      error.code = "MISSING_KEY";
      throw error;
    }
    const max = clampLimit(limit, 50);
    const url = `${API}?${qs({ query, count: max, start: 0, httpAccept: "application/json" })}`;
    const data = await cached("scopus-search", [query, max], () =>
      getJson(url, {
        signal,
        headers: { "X-ELS-APIKey": config.keys.scopus, accept: "application/json" },
      }),
    );
    const entries = data?.["search-results"]?.entry ?? [];
    return entries.filter((e) => e["dc:title"]).map(fromScopus);
  },
};
