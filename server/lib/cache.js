// Small disk-backed cache so a repeated search is instant and costs no quota.
// Entries are JSON files named after a hash of the request, written atomically.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config, ensureDirs } from "../config.js";

const memory = new Map();
let hits = 0;
let misses = 0;

function keyFor(namespace, parts) {
  const hash = crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  return `${namespace}-${hash}`;
}

function fileFor(key) {
  return path.join(config.cacheDir, `${key}.json`);
}

/** Look up a cached value; returns undefined when missing or stale. */
export function get(namespace, parts) {
  if (!config.cacheEnabled) return undefined;
  const key = keyFor(namespace, parts);
  const ttl = config.cacheTtlMinutes * 60_000;

  const mem = memory.get(key);
  if (mem && Date.now() - mem.at < ttl) {
    hits += 1;
    return mem.value;
  }

  try {
    const raw = fs.readFileSync(fileFor(key), "utf8");
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.at < ttl) {
      memory.set(key, parsed);
      hits += 1;
      return parsed.value;
    }
    fs.rmSync(fileFor(key), { force: true });
  } catch {
    /* miss */
  }
  misses += 1;
  return undefined;
}

export function set(namespace, parts, value) {
  if (!config.cacheEnabled) return value;
  const key = keyFor(namespace, parts);
  const entry = { at: Date.now(), value };
  memory.set(key, entry);
  try {
    ensureDirs();
    const file = fileFor(key);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, file);
  } catch {
    /* cache is best-effort */
  }
  return value;
}

/** `await cached("crossref", [query], () => fetchStuff())` */
export async function cached(namespace, parts, producer) {
  const found = get(namespace, parts);
  if (found !== undefined) return found;
  const value = await producer();
  if (value !== undefined) set(namespace, parts, value);
  return value;
}

export function stats() {
  let files = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(config.cacheDir)) {
      if (!name.endsWith(".json")) continue;
      files += 1;
      bytes += fs.statSync(path.join(config.cacheDir, name)).size;
    }
  } catch {
    /* no cache dir yet */
  }
  return {
    enabled: config.cacheEnabled,
    ttl_minutes: config.cacheTtlMinutes,
    entries_on_disk: files,
    size_mb: Number((bytes / 1_048_576).toFixed(2)),
    session_hits: hits,
    session_misses: misses,
    dir: config.cacheDir,
  };
}

export function clear() {
  let removed = 0;
  memory.clear();
  try {
    for (const name of fs.readdirSync(config.cacheDir)) {
      if (!name.endsWith(".json")) continue;
      fs.rmSync(path.join(config.cacheDir, name), { force: true });
      removed += 1;
    }
  } catch {
    /* nothing to clear */
  }
  return { removed_entries: removed };
}
