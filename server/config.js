// Configuration for paper-search-plus.
//
// Every value comes from the bundle's user_config (injected as environment
// variables by the MCP client) or from the environment directly, so the server
// can also be run by hand:  node server/index.js

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const env = process.env;

function str(name, fallback = "") {
  const v = env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : fallback;
}

function num(name, fallback) {
  const v = Number.parseFloat(str(name));
  return Number.isFinite(v) ? v : fallback;
}

function bool(name, fallback = false) {
  const v = str(name).toLowerCase();
  if (v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v);
}

/** Expand a leading ~ and normalise separators so Windows paths behave. */
export function expandPath(p) {
  if (!p) return p;
  let out = p;
  if (out === "~") out = os.homedir();
  else if (out.startsWith("~/") || out.startsWith("~\\")) {
    out = path.join(os.homedir(), out.slice(2));
  }
  return path.resolve(out);
}

const dataDir = expandPath(str("PAPER_SEARCH_DATA_DIR", path.join(os.homedir(), ".paper-search-plus")));

export const config = {
  version: "1.0.0",
  // Contact address. Sent to Crossref / OpenAlex / NCBI / Unpaywall so calls
  // land in their "polite pool" instead of the anonymous, throttled one.
  email: str("PAPER_SEARCH_EMAIL", str("UNPAYWALL_EMAIL", "")),
  dataDir,
  downloadDir: expandPath(str("PAPER_SEARCH_DOWNLOAD_DIR", path.join(dataDir, "papers"))),
  cacheDir: path.join(dataDir, "cache"),
  libraryPath: path.join(dataDir, "library.json"),
  cacheEnabled: bool("PAPER_SEARCH_CACHE", true),
  cacheTtlMinutes: num("PAPER_SEARCH_CACHE_TTL_MINUTES", 60 * 24),
  requestTimeoutMs: num("PAPER_SEARCH_TIMEOUT_MS", 20_000),
  sourceTimeoutMs: num("PAPER_SEARCH_SOURCE_TIMEOUT_MS", 25_000),
  maxConcurrency: Math.max(1, Math.round(num("PAPER_SEARCH_MAX_CONCURRENCY", 8))),
  maxResultsPerSource: Math.max(1, Math.round(num("PAPER_SEARCH_MAX_RESULTS_PER_SOURCE", 50))),
  maxDownloadMb: num("PAPER_SEARCH_MAX_DOWNLOAD_MB", 80),
  // Optional API keys — every one of them unlocks something, none is required.
  keys: {
    semanticScholar: str("SEMANTIC_SCHOLAR_API_KEY", str("S2_API_KEY", "")),
    core: str("CORE_API_KEY", ""),
    ncbi: str("NCBI_API_KEY", ""),
    openalex: str("OPENALEX_API_KEY", ""),
    ieee: str("IEEE_API_KEY", ""),
    scopus: str("SCOPUS_API_KEY", ""),
    springer: str("SPRINGER_API_KEY", ""),
  },
};

export function ensureDirs() {
  for (const dir of [config.dataDir, config.downloadDir, config.cacheDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* created elsewhere or read-only; callers degrade gracefully */
    }
  }
}

/** True when the user has given us a contact address (polite-pool APIs). */
export function hasEmail() {
  return /@/.test(config.email);
}

/** A short, non-secret summary used by the `server_status` tool. */
export function configSummary() {
  const keyState = Object.fromEntries(
    Object.entries(config.keys).map(([k, v]) => [k, v ? "set" : "not set"]),
  );
  return {
    version: config.version,
    data_dir: config.dataDir,
    download_dir: config.downloadDir,
    email: hasEmail() ? config.email : "(not set — Crossref/OpenAlex/NCBI use the slower anonymous pool)",
    cache: config.cacheEnabled ? `on, ${config.cacheTtlMinutes} min TTL` : "off",
    timeout_ms: config.requestTimeoutMs,
    max_download_mb: config.maxDownloadMb,
    api_keys: keyState,
  };
}
