// bioRxiv and medRxiv — the life-science and clinical preprint servers.
// Keyword search goes through Europe PMC (which indexes every preprint);
// exact DOI lookups go straight to the bioRxiv API, which knows the version.

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { normalizeDoi } from "../lib/ids.js";
import { fromEuropePmc } from "./europepmc.js";
import { make, clampLimit, yearFilter } from "./util.js";

const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const SERVERS = {
  biorxiv: { id: "biorxiv", label: "bioRxiv", publisher: "bioRxiv", coverage: "Preprints in the life sciences (biology, neuroscience, genomics, ecology)." },
  medrxiv: { id: "medrxiv", label: "medRxiv", publisher: "medRxiv", coverage: "Preprints in clinical and health research." },
};

function fromDetails(server, item) {
  const doi = normalizeDoi(item.doi ?? "");
  const version = item.version ? String(item.version) : "1";
  return make(server.id, {
    id: `doi:${doi}`,
    doi,
    title: item.title ?? "",
    authors: String(item.authors ?? "")
      .split(/;\s*/)
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ name })),
    year: item.date ? Number(String(item.date).slice(0, 4)) : null,
    venue: `${server.label} preprint`,
    type: "preprint",
    publisher: server.publisher,
    abstract: item.abstract ?? "",
    url: `https://www.${server.id}.org/content/${doi}v${version}`,
    pdf_url: `https://www.${server.id}.org/content/${doi}v${version}.full.pdf`,
    is_oa: true,
    license: item.license ?? "",
    citations: null,
    fields: item.category ? [item.category] : [],
    keywords: item.category ? [item.category] : [],
    ids: { doi },
    extra: {
      version,
      posted: item.date,
      category: item.category,
      published_in: item.published && item.published !== "NA" ? item.published : undefined,
    },
  });
}

function build(server) {
  return {
    id: server.id,
    label: server.label,
    homepage: `https://www.${server.id}.org`,
    coverage: server.coverage,
    auth: [],
    filters: ["query", "limit", "year_from", "year_to"],
    notes: "Always open access and free to download. A DOI lookup returns the exact version and the published journal version when one exists.",

    async search({ query, limit = 10, yearFrom, yearTo, signal }) {
      const max = clampLimit(limit, 50);
      const parts = [`SRC:PPR`, `PUBLISHER:"${server.publisher}"`, `(${query})`];
      if (yearFrom || yearTo) parts.push(`(PUB_YEAR:[${yearFrom ?? 1990} TO ${yearTo ?? 2100}])`);
      const url = `${EPMC}/search?${qs({ query: parts.join(" AND "), format: "json", pageSize: max, resultType: "core" })}`;
      const data = await cached(`epmc-${server.id}`, [url], () => getJson(url, { signal }));
      const records = (data?.resultList?.result ?? []).map((r) => {
        const record = fromEuropePmc(r);
        record.sources = [server.id];
        if (!record.pdf_url && record.doi) {
          record.pdf_url = `https://www.${server.id}.org/content/${record.doi}v1.full.pdf`;
        }
        return record;
      });
      return yearFilter(records, yearFrom, yearTo);
    },

    async getById({ type, value }) {
      if (type !== "doi") return null;
      const doi = normalizeDoi(value);
      if (!doi) return null;
      const data = await cached(`${server.id}-details`, [doi], () =>
        getJson(`https://api.${server.id}.org/details/${server.id}/${encodeURIComponent(doi)}`),
      );
      const item = data?.collection?.[0];
      return item ? fromDetails(server, item) : null;
    },
  };
}

export const biorxiv = build(SERVERS.biorxiv);
export const medrxiv = build(SERVERS.medrxiv);
export default biorxiv;

/**
 * The exact PDF URL for a bioRxiv/medRxiv DOI. The file name needs the
 * preprint's version number, which only the details API knows.
 */
export async function versionedPdfUrl(doi) {
  const clean = normalizeDoi(doi);
  if (!clean) return "";
  for (const server of ["biorxiv", "medrxiv"]) {
    try {
      const data = await cached(`${server}-details`, [clean], () =>
        getJson(`https://api.${server}.org/details/${server}/${encodeURIComponent(clean)}`),
      );
      const item = data?.collection?.[0];
      if (item?.version) return `https://www.${server}.org/content/${clean}v${item.version}.full.pdf`;
    } catch {
      /* try the other server */
    }
  }
  return "";
}
