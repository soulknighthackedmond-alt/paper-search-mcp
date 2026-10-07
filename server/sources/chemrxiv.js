// ChemRxiv — chemistry preprints.
//
// chemrxiv.org's own API sits behind a Cloudflare browser challenge that a
// plain HTTP client cannot pass, so the records come from Europe PMC, which
// indexes every ChemRxiv preprint. Metadata, abstract and DOI are complete;
// the PDF itself lives on chemrxiv.org.

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { fromEuropePmc } from "./europepmc.js";
import { clampLimit, yearFilter } from "./util.js";

const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";

export default {
  id: "chemrxiv",
  label: "ChemRxiv",
  homepage: "https://chemrxiv.org",
  coverage: "Chemistry preprints (organic, physical, materials, computational, chemical biology).",
  auth: [],
  filters: ["query", "limit", "year_from", "year_to"],
  notes: "Indexed through Europe PMC because chemrxiv.org blocks non-browser clients. Open the landing page for the PDF.",

  async search({ query, limit = 10, yearFrom, yearTo, signal }) {
    const max = clampLimit(limit, 50);
    const parts = ["SRC:PPR", 'PUBLISHER:"ChemRxiv"', `(${query})`];
    if (yearFrom || yearTo) parts.push(`(PUB_YEAR:[${yearFrom ?? 1990} TO ${yearTo ?? 2100}])`);
    const url = `${EPMC}/search?${qs({ query: parts.join(" AND "), format: "json", pageSize: max, resultType: "core" })}`;
    const data = await cached("chemrxiv-search", [url], () => getJson(url, { signal }));
    const records = (data?.resultList?.result ?? []).map((result) => {
      const record = fromEuropePmc(result);
      record.sources = ["chemrxiv"];
      record.venue = "ChemRxiv";
      record.type = "preprint";
      record.publisher = "ChemRxiv";
      record.is_oa = true;
      record.extra = { ...(record.extra ?? {}), landing_page: record.url };
      if (!record.pdf_url) {
        // No PDF that a plain HTTP client can fetch; keep the landing page.
        record.url = record.doi ? `https://doi.org/${record.doi}` : record.url;
      }
      return record;
    });
    return yearFilter(records, yearFrom, yearTo);
  },
};
