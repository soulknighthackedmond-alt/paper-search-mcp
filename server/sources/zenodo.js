// Zenodo — CERN's open repository: papers, preprints, datasets, software and
// reports, all with a DOI and (almost always) a downloadable file.

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { normalizeDoi } from "../lib/ids.js";
import { make, clampLimit } from "./util.js";

const API = "https://zenodo.org/api/records";

export function fromZenodo(hit) {
  const md = hit.metadata ?? {};
  const files = hit.files ?? [];
  const pdfFile = files.find((f) => /\.pdf$/i.test(f.key ?? "")) ?? files.find((f) => /pdf/i.test(f.type ?? ""));
  const doi = normalizeDoi(hit.doi ?? md.doi ?? "");
  return make("zenodo", {
    id: `zenodo:${hit.id}`,
    doi,
    title: md.title ?? "",
    authors: (md.creators ?? []).map((c) => ({ name: c.name })).filter((a) => a.name),
    year: md.publication_date ? Number(String(md.publication_date).slice(0, 4)) : null,
    venue: md.journal?.title ?? md.imprint?.journal_title ?? "Zenodo",
    type: md.resource_type?.type === "publication" ? (md.resource_type?.subtype ?? "publication") : (md.resource_type?.type ?? "dataset"),
    publisher: md.imprint?.publisher ?? "Zenodo",
    abstract: String(md.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    url: hit.links?.self_html ?? `https://zenodo.org/records/${hit.id}`,
    pdf_url: pdfFile?.links?.self ?? "",
    is_oa: true,
    license: md.license?.id ?? md.license?.title ?? "",
    citations: null,
    fields: [],
    keywords: (md.keywords ?? []).slice(0, 12),
    language: md.language ?? "",
    ids: { zenodo: String(hit.id), doi: doi || undefined },
    extra: {
      files: files.slice(0, 8).map((f) => ({ key: f.key, size: f.size, url: f.links?.self })),
      version: md.version,
      access: hit.access?.right ?? md.access_right,
    },
  });
}

export default {
  id: "zenodo",
  label: "Zenodo",
  homepage: "https://zenodo.org",
  coverage: "Open repository from CERN: publications, preprints, datasets, software, presentations.",
  auth: [],
  filters: ["query", "limit"],
  notes: "Great for data, code and reports that never appear in a journal index. Everything has a DOI and a direct download.",

  async search({ query, limit = 10, signal }) {
    const max = clampLimit(limit, 50);
    const url = `${API}?${qs({ q: query, size: max, sort: "bestmatch" })}`;
    const data = await cached("zenodo-search", [url], () => getJson(url, { signal }));
    return (data?.hits?.hits ?? []).map(fromZenodo);
  },
};
