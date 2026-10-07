// HAL — the French national open repository. Strong in mathematics, physics,
// computer science, humanities and social sciences.

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { normalizeDoi } from "../lib/ids.js";
import { make, clampLimit } from "./util.js";

const API = "https://api.archives-ouvertes.fr/search/";
const FL = [
  "docid", "title_s", "authFullName_s", "authIdHasStructure_fs", "producedDateY_i", "producedDate_s",
  "doiId_s", "uri_s", "abstract_s", "journalTitle_s", "conferenceTitle_s", "docType_s",
  "fileMain_s", "files_s", "citationNb_i", "language_s", "keyword_s", "domain_s", "publisher_s",
  "volume_s", "issue_s", "page_s", "licence_s", "arxivId_s", "pubmedId_s",
].join(",");

export function fromHal(doc) {
  const doi = normalizeDoi(doc.doiId_s ?? "");
  const isPreprint = /PREPRINT|UNDEFINED/i.test(doc.docType_s ?? "");
  return make("hal", {
    id: `hal:${doc.docid}`,
    doi,
    title: doc.title_s?.[0] ?? "",
    authors: (doc.authFullName_s ?? []).map((name) => ({ name })),
    year: doc.producedDateY_i ?? null,
    venue: doc.journalTitle_s ?? doc.conferenceTitle_s ?? "HAL",
    type: isPreprint ? "preprint" : /ART/i.test(doc.docType_s ?? "") ? "journal-article" : (doc.docType_s ?? "").toLowerCase(),
    publisher: doc.publisher_s ?? "",
    abstract: doc.abstract_s?.[0] ?? "",
    url: doc.uri_s ?? "",
    pdf_url: doc.fileMain_s ?? doc.files_s?.[0] ?? "",
    is_oa: Boolean(doc.fileMain_s ?? doc.files_s?.[0]),
    license: doc.licence_s ?? "",
    citations: doc.citationNb_i ?? null,
    fields: (doc.domain_s ?? []).slice(0, 6),
    keywords: (doc.keyword_s ?? []).slice(0, 12),
    language: doc.language_s?.[0] ?? "",
    ids: {
      hal: String(doc.docid),
      doi: doi || undefined,
      arxiv: doc.arxivId_s,
      pmid: doc.pubmedId_s,
    },
    extra: { volume: doc.volume_s, issue: doc.issue_s, pages: doc.page_s },
  });
}

export default {
  id: "hal",
  label: "HAL",
  homepage: "https://hal.science",
  coverage: "3M+ French open-access records: articles, preprints, theses, conference papers, all disciplines.",
  auth: [],
  filters: ["query", "limit"],
  notes: "Deposits are usually the accepted manuscript, so the PDF link is a legal free copy.",

  async search({ query, limit = 10, signal }) {
    const max = clampLimit(limit, 50);
    const url = `${API}?${qs({ q: query, wt: "json", rows: max, fl: FL, sort: "score desc" })}`;
    const data = await cached("hal-search", [url], () => getJson(url, { signal }));
    return (data?.response?.docs ?? []).map(fromHal);
  },
};
