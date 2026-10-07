// Shared helpers for source adapters.

import { newRecord, cleanText } from "../lib/record.js";

/** Build a canonical record and stamp the source on it. */
export function make(sourceId, fields = {}) {
  const record = newRecord(fields);
  record.sources = [sourceId];
  record.title = cleanText(record.title, 600);
  record.abstract = cleanText(record.abstract, 4000);
  record.venue = cleanText(record.venue, 300);
  return record;
}

/** Sources describe themselves here; `list_sources` reports it verbatim. */
export function describe(source) {
  return {
    id: source.id,
    label: source.label,
    covers: source.coverage,
    homepage: source.homepage,
    needs: source.auth ?? [],
    filters: source.filters ?? ["query", "limit", "year_from", "year_to"],
    notes: source.notes ?? "",
  };
}

export function clampLimit(limit, max = 50, fallback = 10) {
  const n = Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : fallback;
  return Math.min(Math.max(n, 1), max);
}

/** True when a record falls inside the requested year window. */
export function inYearRange(record, yearFrom, yearTo) {
  if (!record.year) return true;
  if (yearFrom && record.year < yearFrom) return false;
  if (yearTo && record.year > yearTo) return false;
  return true;
}

export function yearFilter(records, yearFrom, yearTo) {
  if (!yearFrom && !yearTo) return records;
  return records.filter((r) => inYearRange(r, yearFrom, yearTo));
}
