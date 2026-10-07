// The source registry: what exists, how to fan a query out across it, and how
// to report per-source success or failure.

import arxiv from "./arxiv.js";
import crossref from "./crossref.js";
import openalex from "./openalex.js";
import semantic from "./semantic.js";
import pubmed from "./pubmed.js";
import europepmc, { pmc } from "./europepmc.js";
import { biorxiv, medrxiv } from "./biorxiv.js";
import doaj from "./doaj.js";
import zenodo from "./zenodo.js";
import hal from "./hal.js";
import openreview from "./openreview.js";
import iacr from "./iacr.js";
import chemrxiv from "./chemrxiv.js";
import openaire from "./openaire.js";
import unpaywall from "./unpaywall.js";
import core from "./core.js";
import ieee from "./ieee.js";
import scopus from "./scopus.js";
import { describe } from "./util.js";
import { config } from "../config.js";
import { mapLimit } from "../lib/http.js";

export const SOURCES = {
  arxiv,
  crossref,
  openalex,
  "semantic-scholar": semantic,
  pubmed,
  europepmc,
  pmc,
  biorxiv,
  medrxiv,
  doaj,
  zenodo,
  hal,
  openreview,
  iacr,
  chemrxiv,
  openaire,
  unpaywall,
  core,
  ieee,
  scopus,
};

/** Aliases so an agent's near-miss still works. */
const ALIASES = {
  s2: "semantic-scholar",
  semanticscholar: "semantic-scholar",
  semantic: "semantic-scholar",
  "semantic_scholar": "semantic-scholar",
  "europe-pmc": "europepmc",
  "europe pmc": "europepmc",
  medline: "pubmed",
  nlm: "pubmed",
  "pub-med": "pubmed",
  cornell: "arxiv",
  "pubmed central": "pmc",
  "bio-rxiv": "biorxiv",
  "med-rxiv": "medrxiv",
  "chem-rxiv": "chemrxiv",
  "iacr-eprint": "iacr",
  "cryptology eprint": "iacr",
  "open-review": "openreview",
};

/** Searched when the caller does not name sources. Fast, broad and reliable. */
export const DEFAULT_SOURCES = ["openalex", "crossref", "arxiv", "europepmc", "pubmed"];

/** Everything key-free, including the slow and niche ones. */
export const ALL_SOURCES = Object.keys(SOURCES).filter((id) => id !== "unpaywall");

/** Sources whose payload is a lookup rather than a search. */
const LOOKUP_ONLY = new Set(["unpaywall"]);

export function listSources() {
  return Object.values(SOURCES).map((source) => {
    const info = describe(source);
    const reason = unavailableReason(source);
    info.available = !reason;
    info.unavailable_reason = reason || undefined;
    info.lookup_only = LOOKUP_ONLY.has(source.id);
    return info;
  });
}

/** Why a source cannot be searched right now (empty string = it can). */
export function unavailableReason(source) {
  for (const need of source.auth ?? []) {
    if (need === "email" && !config.email) return "needs a contact email in the bundle settings";
    if (need === "CORE_API_KEY" && !config.keys.core) return "needs CORE_API_KEY";
    if (need === "IEEE_API_KEY" && !config.keys.ieee) return "needs IEEE_API_KEY";
    if (need === "SCOPUS_API_KEY" && !config.keys.scopus) return "needs SCOPUS_API_KEY";
  }
  return "";
}

/** Turn a list of names (or "all"/"auto") into concrete source objects. */
export function resolveSources(names) {
  const requested = names == null || names.length === 0
    ? DEFAULT_SOURCES
    : (Array.isArray(names) ? names : [names]).flatMap((n) => String(n).split(/[,\s]+/)).filter(Boolean);

  const lowered = requested.map((n) => n.toLowerCase());
  let ids;
  if (lowered.includes("all") || lowered.includes("*") || lowered.includes("everything")) {
    ids = ALL_SOURCES;
  } else if (lowered.includes("auto") || lowered.includes("default")) {
    ids = DEFAULT_SOURCES;
  } else {
    ids = lowered.map((n) => (SOURCES[n] ? n : ALIASES[n])).filter(Boolean);
  }

  const unknown = requested.filter((n) => {
    const lower = n.toLowerCase();
    return !SOURCES[lower] && !ALIASES[lower] && !["all", "*", "everything", "auto", "default"].includes(lower);
  });

  const unique = [...new Set(ids)].filter((id) => !LOOKUP_ONLY.has(id) && SOURCES[id]);

  // Sources that cannot run right now (missing API key or email) are reported
  // instead of failing mid-search.
  const usable = [];
  const skipped = [];
  for (const id of unique) {
    const reason = unavailableReason(SOURCES[id]);
    if (reason) skipped.push({ source: id, label: SOURCES[id].label, reason });
    else usable.push(id);
  }

  return {
    sources: usable.map((id) => SOURCES[id]),
    skipped,
    unknown,
    suggestion: unknown.length
      ? `Unknown source(s): ${unknown.join(", ")}. Known ids: ${ALL_SOURCES.join(", ")}.`
      : "",
  };
}

function timeoutSignal(ms, parent) {
  const timer = AbortSignal.timeout(ms);
  return parent ? AbortSignal.any([parent, timer]) : timer;
}

/**
 * Search many sources in parallel.
 * Never throws for a single source's failure — the failure is reported next to
 * the results so the agent can say "arXiv was down" instead of nothing.
 */
export async function searchMany({
  query,
  sources = DEFAULT_SOURCES,
  limit = 10,
  yearFrom,
  yearTo,
  openAccessOnly,
  sort,
  signal,
  perSourceTimeout = config.sourceTimeoutMs,
} = {}) {
  const { sources: adapters, unknown, suggestion, skipped } = resolveSources(sources);
  if (!adapters.length) {
    return { records: [], perSource: [], skipped, unknown, suggestion: suggestion || "No usable sources were requested." };
  }

  const perSource = await mapLimit(adapters, config.maxConcurrency, async (source) => {
    const started = Date.now();
    const max = Math.min(limit * 2, config.maxResultsPerSource);
    try {
      const records = await source.search({
        query,
        limit: max,
        yearFrom,
        yearTo,
        openAccessOnly,
        sort,
        signal: timeoutSignal(perSourceTimeout, signal),
      });
      const kept = (records ?? []).filter(Boolean);
      return {
        source: source.id,
        label: source.label,
        count: kept.length,
        ms: Date.now() - started,
        records: kept,
      };
    } catch (error) {
      return {
        source: source.id,
        label: source.label,
        count: 0,
        ms: Date.now() - started,
        error: error?.code === "MISSING_KEY" ? error.message : `${error?.message ?? "failed"}${error?.hint ? ` — ${error.hint}` : ""}`,
        records: [],
      };
    }
  });

  const records = perSource.flatMap((entry) => entry.records);
  return {
    records,
    skipped,
    unknown,
    suggestion,
    perSource: perSource.map(({ records: _drop, ...rest }) => rest),
  };
}

/** Ask every usable source for one specific paper (used to enrich a record). */
export async function lookupEverywhere(identifier, { signal, sources } = {}) {
  const candidates = resolveSources(sources ?? ALL_SOURCES).sources.filter((s) => s.getById);
  const found = await mapLimit(candidates, config.maxConcurrency, async (source) => {
    try {
      const record = await source.getById(identifier, { signal: timeoutSignal(config.sourceTimeoutMs, signal) });
      return record ? { source: source.id, record } : null;
    } catch {
      return null;
    }
  });
  return found.filter(Boolean);
}
