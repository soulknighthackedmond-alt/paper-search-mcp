// Turning whatever the user pasted into one canonical, enriched record.

import { detectIdentifier, normalizeDoi, normalizeArxivId, normalizePmid, normalizePmcid } from "./ids.js";
import { dedupe, rank, mergeRecords, toFull } from "./record.js";
import { getText } from "./http.js";
import { searchMany, lookupEverywhere, DEFAULT_SOURCES } from "../sources/index.js";
import { cached } from "./cache.js";

/** Pull a DOI / arXiv id / PMID out of a publisher landing page (Highwire meta tags). */
async function identifyFromUrl(url, signal) {
  const html = await cached("page-meta", [url], () => getText(url, { signal, timeoutMs: 15_000 }));
  const meta = (name) => {
    const patterns = [
      new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, "i"),
      new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"),
    ];
    for (const re of patterns) {
      const match = html.match(re);
      if (match) return match[1].trim();
    }
    return "";
  };
  const doi = normalizeDoi(meta("citation_doi") || meta("dc.identifier") || html.match(/10\.\d{4,9}\/[^\s"'<>]+/)?.[0] || "");
  const arxiv = normalizeArxivId(meta("citation_arxiv_id") || url);
  const pmid = normalizePmid(meta("citation_pmid") || "");
  const pmcid = normalizePmcid(meta("citation_pmcid") || "");
  const title = meta("citation_title") || html.match(/<title>([\s\S]{0,300}?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
  const pdf = meta("citation_pdf_url");
  if (doi) return { identifier: { type: "doi", value: doi }, title, pdf };
  if (arxiv) return { identifier: { type: "arxiv", value: arxiv }, title, pdf };
  if (pmcid) return { identifier: { type: "pmcid", value: pmcid }, title, pdf };
  if (pmid) return { identifier: { type: "pmid", value: pmid }, title, pdf };
  return { identifier: null, title, pdf };
}

function pickBest(records) {
  if (!records.length) return null;
  const scored = [...records].sort((a, b) => scoreOf(b) - scoreOf(a));
  return scored[0];
}

function scoreOf(record) {
  let score = 0;
  if (record.abstract) score += 3;
  if (record.doi) score += 2;
  if (record.pdf_url) score += 2;
  if (record.year) score += 1;
  if (record.authors?.length) score += 1;
  if (record.citations != null) score += 1;
  if (record.venue) score += 1;
  return score;
}

/**
 * Resolve anything — DOI, arXiv id, PMID, PMC id, OpenAlex id, publisher URL,
 * or a free-text title — into one enriched record.
 *
 * Returns { record, identifier, notes, candidates }.
 */
export async function resolvePaper(input, { signal, enrich = true, sources, allowSearch = true } = {}) {
  const notes = [];
  let identifier = detectIdentifier(input);
  let query = "";

  if (identifier.type === "url") {
    try {
      const found = await identifyFromUrl(identifier.value, signal);
      if (found.identifier) {
        notes.push(`Read ${found.identifier.type} ${found.identifier.value} from the page metadata.`);
        identifier = found.identifier;
      } else if (found.title && allowSearch) {
        notes.push("That URL had no citation metadata, so it was resolved by title instead.");
        query = found.title;
        identifier = { type: "query", value: found.title };
      } else {
        return { record: null, identifier, notes: [...notes, "Could not identify a paper at that URL."], candidates: [] };
      }
    } catch (error) {
      return { record: null, identifier, notes: [...notes, `Could not read that URL: ${error.message}`], candidates: [] };
    }
  }

  if (identifier.type === "query") {
    if (!allowSearch) {
      return { record: null, identifier, notes: [...notes, "A DOI, arXiv, PubMed or PMC id is needed here."], candidates: [] };
    }
    const { records, perSource } = await searchMany({
      query: identifier.value,
      sources: sources ?? DEFAULT_SOURCES,
      limit: 8,
      signal,
    });
    const merged = dedupe(records);
    const ranked = rank(merged, identifier.value);
    if (!ranked.length) {
      const failures = perSource.filter((s) => s.error).map((s) => `${s.source}: ${s.error}`);
      return { record: null, identifier, notes: [...notes, "No paper matched that text.", ...failures], candidates: [] };
    }
    notes.push(`Matched by title against ${perSource.filter((s) => s.count).length} source(s).`);
    const best = ranked[0];
    const enriched = enrich ? await enrichRecord(best, { signal, notes }) : best;
    return { record: enriched, identifier, notes, candidates: ranked.slice(1, 6).map(toFull) };
  }

  const found = await lookupEverywhere(identifier, { signal, sources });
  if (!found.length) {
    return { record: null, identifier, notes: [...notes, `No source recognised ${identifier.type} ${identifier.value}.`], candidates: [] };
  }
  let merged = found[0].record;
  for (const item of found.slice(1)) merged = mergeRecords(merged, item.record);
  merged = { ...merged, sources: [...new Set(found.map((f) => f.source))] };
  notes.push(`Found in ${merged.sources.join(", ")}.`);

  const enriched = enrich ? await enrichRecord(merged, { signal, notes }) : merged;
  return { record: enriched, identifier, notes, candidates: [] };
}

/** Add open-access information from Unpaywall / OpenAlex when we lack a PDF. */
export async function enrichRecord(record, { signal, notes = [] } = {}) {
  if (!record) return record;
  let out = record;

  if (record.doi) {
    try {
      const { default: unpaywall } = await import("../sources/unpaywall.js");
      const oa = await unpaywall.byDoi(record.doi);
      if (oa) {
        out = { ...out };
        if (!out.pdf_url && oa.pdf_url) out.pdf_url = oa.pdf_url;
        if (out.is_oa == null) out.is_oa = oa.is_oa;
        if (!out.license) out.license = oa.license;
        if (oa.oa_status) out.extra = { ...(out.extra ?? {}), oa_status: oa.oa_status };
        if (oa.oa_status === "closed") out.is_oa = false;
        notes.push(`Unpaywall: ${oa.oa_status || "unknown"}${oa.pdf_url ? ", free PDF available" : ""}.`);
      } else {
        notes.push("Unpaywall had no record (no contact email set, or an unknown DOI).");
      }
    } catch (error) {
      notes.push(`Unpaywall lookup failed: ${error.message}`);
    }
  }

  if (!out.pdf_url && out.ids?.openalex) {
    try {
      const { default: openalex } = await import("../sources/openalex.js");
      const work = await openalex.getById({ type: "openalex", value: out.ids.openalex }, { signal });
      if (work?.pdf_url) {
        out = { ...out, pdf_url: work.pdf_url, is_oa: out.is_oa ?? true };
        notes.push("OpenAlex supplied an open-access PDF link.");
      }
    } catch {
      /* enrichment is best-effort */
    }
  }

  return out;
}
