// A small personal library: papers you asked to keep, stored as JSON next to
// the cache. Also exports BibTeX/RIS so it drops straight into Zotero.

import fs from "node:fs";
import path from "node:path";
import { config, ensureDirs } from "../config.js";
import { recordKey, normalizeTitle } from "./ids.js";
import { toFull, cleanText } from "./record.js";
import { format } from "./cite.js";

function load() {
  try {
    const raw = fs.readFileSync(config.libraryPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.items) ? parsed : { items: [] };
  } catch {
    return { items: [] };
  }
}

function save(state) {
  ensureDirs();
  const tmp = `${config.libraryPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, config.libraryPath);
  return state;
}

export function add(record, { tags = [], note = "" } = {}) {
  const state = load();
  const key = recordKey(record);
  const existing = state.items.find((item) => item.key === key);
  const entry = {
    key,
    added: existing?.added ?? new Date().toISOString(),
    updated: new Date().toISOString(),
    tags: [...new Set([...(existing?.tags ?? []), ...tags])],
    note: note || existing?.note || "",
    record: {
      ...toFull(record),
      ids: record.ids,
      authors_list: record.authors,
      venue: record.venue,
      type: record.type,
      publisher: record.publisher,
      references_count: record.references_count,
    },
  };
  if (existing) Object.assign(existing, entry);
  else state.items.push(entry);
  save(state);
  return { key, total: state.items.length, added: !existing };
}

export function list({ query = "", tag = "", limit = 20 } = {}) {
  const state = load();
  let items = state.items;
  if (tag) items = items.filter((item) => (item.tags ?? []).includes(tag));
  if (query) {
    const needle = normalizeTitle(query);
    items = items.filter((item) => normalizeTitle(item.record?.title ?? "").includes(needle));
  }
  return items
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 200)));
}

export function remove(key) {
  const state = load();
  const before = state.items.length;
  state.items = state.items.filter((item) => item.key !== key && normalizeTitle(item.record?.title ?? "") !== normalizeTitle(key));
  save(state);
  return { removed: before - state.items.length, total: state.items.length };
}

export function exportAll(style = "bibtex") {
  const state = load();
  const taken = new Set();
  const pieces = [];
  for (const item of state.items) {
    const record = {
      ...item.record,
      authors: item.record.authors_list ?? item.record.authors ?? [],
      keywords: item.tags ?? [],
    };
    pieces.push(format(record, style, taken));
  }
  return pieces.join(style === "bibtex" ? "\n\n" : "\n");
}

export function stats() {
  const state = load();
  const tags = new Map();
  for (const item of state.items) {
    for (const tag of item.tags ?? []) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  return {
    total: state.items.length,
    path: config.libraryPath,
    tags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([tag, count]) => ({ tag, count })),
    newest: state.items.slice(-3).map((item) => ({ title: cleanText(item.record?.title, 120), added: item.added })),
  };
}
