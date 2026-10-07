// CORE — the largest aggregator of open-access full text (300M+ documents).
// Needs a free API key; without one the source reports itself as unavailable
// instead of failing the whole search.

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { normalizeDoi } from "../lib/ids.js";
import { config } from "../config.js";
import { make, clampLimit } from "./util.js";

const API = "https://api.core.ac.uk/v3/search/works";

export function fromCore(item) {
  const doi = normalizeDoi(item.doi ?? "");
  return make("core", {
    id: `core:${item.id}`,
    doi,
    title: item.title ?? "",
    authors: (item.authors ?? []).map((a) => ({ name: a.name ?? a })).filter((a) => a.name),
    year: item.yearPublished ?? (item.publishedDate ? Number(String(item.publishedDate).slice(0, 4)) : null),
    venue: item.publisher ?? "",
    type: item.documentType ?? "journal-article",
    publisher: item.publisher ?? "",
    abstract: item.abstract ?? "",
    url: item.links?.[0]?.url ?? item.downloadUrl ?? "",
    pdf_url: item.downloadUrl ?? "",
    is_oa: true,
    license: item.license?.name ?? "",
    citations: item.citationCount ?? null,
    fields: (item.fieldOfStudy ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean).slice(0, 6),
    keywords: (item.topics ?? []).slice(0, 8),
    language: item.language?.code ?? "",
    ids: { core: String(item.id), doi: doi || undefined, arxiv: item.arxivId },
    extra: { download_url: item.downloadUrl },
  });
}

export default {
  id: "core",
  label: "CORE",
  homepage: "https://core.ac.uk",
  coverage: "300M+ open-access documents harvested from repositories and journals worldwide.",
  auth: ["CORE_API_KEY"],
  filters: ["query", "limit"],
  notes: "Requires a free CORE API key (core.ac.uk/services/api). Gives full-text links for repository copies.",

  async search({ query, limit = 10, signal }) {
    if (!config.keys.core) {
      const error = new Error("CORE needs a free API key: add CORE_API_KEY in the bundle settings (core.ac.uk/services/api).");
      error.code = "MISSING_KEY";
      throw error;
    }
    const max = clampLimit(limit, 50);
    const url = `${API}?${qs({ q: query, limit: max })}`;
    const data = await cached("core-search", [query, max], () =>
      getJson(url, { headers: { authorization: `Bearer ${config.keys.core}` }, signal }),
    );
    return (data?.results ?? []).map(fromCore);
  },
};
