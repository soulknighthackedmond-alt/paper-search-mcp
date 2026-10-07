// OpenReview — conference submissions and reviews (ICLR, NeurIPS, ACL, ...).
// Useful for peer-review text and for papers that only exist as submissions.

import { cached } from "../lib/cache.js";
import { getJson, qs } from "../lib/http.js";
import { normalizeDoi } from "../lib/ids.js";
import { make, clampLimit } from "./util.js";

const API = "https://api2.openreview.net";

const value = (content, key) => {
  const raw = content?.[key];
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "object" && "value" in raw) return raw.value;
  return raw;
};

export function fromOpenReview(note) {
  const content = note.content ?? {};
  const authors = value(content, "authors") ?? [];
  const venue = value(content, "venue") ?? value(content, "venueid") ?? "";
  const keywords = value(content, "keywords") ?? [];
  const date = note.pdate ?? note.cdate ?? note.tcdate;
  return make("openreview", {
    id: `openreview:${note.id}`,
    doi: normalizeDoi(value(content, "doi") ?? ""),
    title: value(content, "title") ?? "",
    authors: (Array.isArray(authors) ? authors : [authors]).filter(Boolean).map((name) => ({ name })),
    year: date ? new Date(Number(date)).getUTCFullYear() : null,
    venue: String(venue).replace(/\(.*\)/, "").trim(),
    type: "conference-paper",
    publisher: "OpenReview",
    abstract: value(content, "abstract") ?? "",
    url: `https://openreview.net/forum?id=${note.forum ?? note.id}`,
    pdf_url: `https://openreview.net/pdf?id=${note.id}`,
    is_oa: true,
    citations: null,
    fields: [],
    keywords: (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean).slice(0, 12),
    ids: { openreview: note.id, forum: note.forum ?? note.id },
    extra: {
      invitations: (note.invitations ?? []).slice(0, 2),
      pdf_available: note.pdf !== undefined || true,
    },
  });
}

export default {
  id: "openreview",
  label: "OpenReview",
  homepage: "https://openreview.net",
  coverage: "Submissions, accepted papers and public reviews from ICLR, NeurIPS, ICML, ACL and friends.",
  auth: [],
  filters: ["query", "limit"],
  notes: "Every paper has a free PDF, and the reviews are public — useful for judging how solid a result is.",

  async search({ query, limit = 10, signal }) {
    const max = clampLimit(limit, 50);
    const url = `${API}/notes/search?${qs({ term: query, limit: max, type: "terms", content: "all", source: "all" })}`;
    const data = await cached("openreview-search", [url], () => getJson(url, { signal }));
    let notes = (data?.notes ?? []).filter((n) => value(n.content, "title"));
    if (!notes.length) {
      // 'terms' requires every word; fall back to the longest single term.
      const longest = String(query).split(/\s+/).filter((w) => w.length > 3).sort((a, b) => b.length - a.length)[0];
      if (longest && longest !== query) {
        const relaxedUrl = `${API}/notes/search?${qs({ term: longest, limit: max, type: "terms", content: "all", source: "all" })}`;
        const relaxed = await cached("openreview-search", [relaxedUrl], () => getJson(relaxedUrl, { signal }));
        notes = (relaxed?.notes ?? []).filter((n) => value(n.content, "title"));
      }
    }
    return notes.map(fromOpenReview);
  },
};
