// IACR Cryptology ePrint Archive — the main preprint server for cryptography.
// No JSON API: the search page is parsed. The parser keys off the result block
// structure, so a layout change degrades to fewer results instead of an error.

import { cached } from "../lib/cache.js";
import { getText, qs } from "../lib/http.js";
import { make, clampLimit } from "./util.js";

const BASE = "https://eprint.iacr.org";

function stripTags(html) {
  return String(html ?? "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

/** Parse the result blocks of https://eprint.iacr.org/search?q=... */
export function parseSearchPage(html) {
  const text = String(html ?? "");
  const results = [];
  const blocks = text.split(/<div class="mb-4">/).slice(1);

  for (const block of blocks) {
    const idMatch = block.match(/href="\/(\d{4}\/\d{3,4})"/);
    if (!idMatch) continue;
    const id = idMatch[1];

    const title = stripTags(block.match(/<strong>([\s\S]*?)<\/strong>/)?.[1] ?? "");
    if (!title) continue;

    const authors = stripTags(block.match(/<span class="fst-italic">([\s\S]*?)<\/span>/)?.[1] ?? "")
      .split(/,\s*/)
      .map((name) => name.trim())
      .filter(Boolean);

    const abstract = stripTags(block.match(/<p class="[^"]*search-abstract[^"]*">([\s\S]*?)<\/p>/)?.[1] ?? "");
    const category = stripTags(block.match(/<small class="badge category[^"]*">([\s\S]*?)<\/small>/)?.[1] ?? "");
    const updated = block.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
    const posted = block.match(/Posted:\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? updated;

    results.push({ id, title, authors, abstract, category, posted });
  }
  return results;
}

function toRecord(item) {
  const year = Number(item.id.slice(0, 4));
  return make("iacr", {
    id: `iacr:${item.id}`,
    doi: "",
    title: item.title,
    authors: (item.authors ?? []).map((name) => ({ name })),
    year: Number.isFinite(year) ? year : null,
    venue: "IACR Cryptology ePrint Archive",
    type: "preprint",
    publisher: "IACR",
    abstract: item.abstract ?? "",
    url: `${BASE}/${item.id}`,
    pdf_url: `${BASE}/${item.id}.pdf`,
    is_oa: true,
    license: "IACR ePrint (author retains copyright)",
    citations: null,
    fields: item.category ? [item.category] : ["cryptography"],
    keywords: item.category ? [item.category] : ["cryptography"],
    ids: { iacr: item.id },
    extra: { posted: item.posted || undefined, category: item.category || undefined },
  });
}

export default {
  id: "iacr",
  label: "IACR ePrint",
  homepage: "https://eprint.iacr.org",
  coverage: "Cryptology preprints — where most new cryptography results appear first.",
  auth: [],
  filters: ["query", "limit"],
  notes: "Every entry has a free PDF. Search matches titles, authors, abstracts and keywords.",

  async search({ query, limit = 10, signal }) {
    const max = clampLimit(limit, 25);
    const url = `${BASE}/search?${qs({ q: query })}`;
    const html = await cached("iacr-search", [url], () => getText(url, { signal }));
    return parseSearchPage(html).slice(0, max).map(toRecord);
  },

  async getById({ type, value }) {
    if (type !== "iacr") return null;
    const id = String(value).replace(/^iacr:/, "").replace(/\.pdf$/, "");
    if (!/^\d{4}\/\d{3,4}$/.test(id)) return null;
    const html = await cached("iacr-entry", [id], () => getText(`${BASE}/${id}`));
    const title = stripTags(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s*[-|]\s*IACR.*$/i, "");
    const abstract = stripTags(
      html.match(/<p[^>]*class="[^"]*abstract[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1] ??
      html.match(/<h[23][^>]*>\s*Abstract\s*<\/h[23]>\s*<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ??
      "",
    );
    const authors = [...html.matchAll(/href="\/search\?q=author%3A([^"]+)"/gi)]
      .map((m) => decodeURIComponent(m[1]).replace(/\+/g, " ").trim());
    const record = toRecord({ id, title, authors, abstract, category: "", posted: "" });
    return record;
  },
};
