// IEEE Xplore — engineering and computer science conference papers and
// journals. Needs a free IEEE API key (developer.ieee.org).

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { normalizeDoi } from "../lib/ids.js";
import { config } from "../config.js";
import { make, clampLimit } from "./util.js";

const API = "https://ieeexploreapi.ieee.org/api/v1/search/articles";

export function fromIeee(article) {
  const doi = normalizeDoi(article.doi ?? "");
  const authors = (article.authors?.authors ?? []).map((a) => ({ name: a.full_name })).filter((a) => a.name);
  return make("ieee", {
    id: `ieee:${article.article_number}`,
    doi,
    title: article.title ?? "",
    authors,
    year: article.publication_year ? Number(article.publication_year) : null,
    venue: article.publication_title ?? "",
    type: /conference/i.test(article.content_type ?? "") ? "conference-paper" : "journal-article",
    publisher: article.publisher ?? "IEEE",
    abstract: article.abstract ?? "",
    url: article.html_url ?? (doi ? `https://doi.org/${doi}` : ""),
    pdf_url: article.pdf_url ?? "",
    is_oa: false,
    license: "",
    citations: article.citing_paper_count ? Number(article.citing_paper_count) : null,
    references_count: article.reference_count ? Number(article.reference_count) : null,
    fields: (article.inspec_controlled_terms ?? []).map((t) => t.term).filter(Boolean).slice(0, 8),
    keywords: (article.author_terms?.author_term ?? []).map((t) => t.term).filter(Boolean).slice(0, 12),
    ids: { ieee: article.article_number, doi: doi || undefined },
    extra: { volume: article.volume, issue: article.issue, pages: article.start_page && article.end_page ? `${article.start_page}-${article.end_page}` : undefined },
  });
}

export default {
  id: "ieee",
  label: "IEEE Xplore",
  homepage: "https://ieeexplore.ieee.org",
  coverage: "IEEE journals, conferences and standards (electrical engineering, CS, communications).",
  auth: ["IEEE_API_KEY"],
  filters: ["query", "limit"],
  notes: "Requires a free IEEE API key. Metadata only — full text usually needs an IEEE subscription.",

  async search({ query, limit = 10, signal }) {
    if (!config.keys.ieee) {
      const error = new Error("IEEE Xplore needs a free API key: add IEEE_API_KEY in the bundle settings (developer.ieee.org).");
      error.code = "MISSING_KEY";
      throw error;
    }
    const max = clampLimit(limit, 50);
    const url = `${API}?${qs({
      apikey: config.keys.ieee,
      querytext: query,
      max_records: max,
      start_record: 1,
      sort_order: "desc",
      sort_field: "relevance",
      format: "json",
    })}`;
    const data = await cached("ieee-search", [query, max], () => getJson(url, { signal }));
    return (data?.articles ?? []).map(fromIeee);
  },
};
