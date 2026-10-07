// Unpaywall — resolves a DOI to a legal open-access copy. Used by get_paper
// and download_paper to find a free PDF when the index has no direct link.
// Needs an email (free, instant, no key).

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { normalizeDoi } from "../lib/ids.js";
import { config, hasEmail } from "../config.js";

const API = "https://api.unpaywall.org/v2";

export function fromUnpaywall(data) {
  const best = data.best_oa_location ?? {};
  return {
    doi: normalizeDoi(data.doi ?? ""),
    title: data.title ?? "",
    year: data.year ?? null,
    journal: data.journal_name ?? "",
    publisher: data.publisher ?? "",
    is_oa: Boolean(data.is_oa),
    oa_status: data.oa_status ?? "",
    license: best.license ?? "",
    pdf_url: best.url_for_pdf ?? "",
    landing_url: best.url ?? best.url_for_landing_page ?? "",
    host: best.host_type ?? "",
    version: best.version ?? "",
    all_locations: (data.oa_locations ?? []).slice(0, 6).map((loc) => ({
      host: loc.host_type,
      version: loc.version,
      license: loc.license,
      pdf_url: loc.url_for_pdf,
      url: loc.url_for_landing_page ?? loc.url,
    })),
    authors: (data.z_authors ?? []).map((a) => ({ name: [a.given, a.family].filter(Boolean).join(" ") })).filter((a) => a.name),
  };
}

export default {
  id: "unpaywall",
  label: "Unpaywall",
  homepage: "https://unpaywall.org",
  coverage: "Not a search index — it maps a DOI to a legal free copy (50M+ OA locations).",
  auth: ["email"],
  filters: ["doi"],
  notes: "Requires a contact email in the bundle settings. Used automatically to find free PDFs.",

  async byDoi(doi) {
    const clean = normalizeDoi(doi);
    if (!clean || !hasEmail()) return null;
    const url = `${API}/${encodeURIComponent(clean)}?${qs({ email: config.email })}`;
    const data = await cached("unpaywall", [url], () => getJson(url));
    return data?.doi ? fromUnpaywall(data) : null;
  },

  async search({ query }) {
    // Unpaywall is a lookup service; searching it means "find the OA copy of this DOI".
    const result = await this.byDoi(query);
    if (!result) return [];
    const { make } = await import("./util.js");
    return [
      make("unpaywall", {
        id: `doi:${result.doi}`,
        doi: result.doi,
        title: result.title,
        authors: result.authors,
        year: result.year,
        venue: result.journal,
        publisher: result.publisher,
        type: "journal-article",
        url: result.landing_url,
        pdf_url: result.pdf_url,
        is_oa: result.is_oa,
        license: result.license,
        ids: { doi: result.doi },
        extra: { oa_status: result.oa_status, version: result.version, host: result.host },
      }),
    ];
  },
};
