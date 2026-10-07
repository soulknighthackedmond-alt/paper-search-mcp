# AGENTS.md — Paper Search Plus

A self-contained MCP bundle (`.mcpb`, manifest v0.3) that gives MCP clients academic
search. Node 20.10+, ESM, no build step — the source is the shipped code.

This repo is a fork of `openags/paper-search-mcp` (Python, MIT). It is an independent
Node reimplementation with a different tool surface: 10 tools instead of ~90.

## Layout

- `manifest.json` — MCPB manifest v0.3: server entry, 10 tool definitions, 4 prompts, `user_config`.
- `server/index.js` — MCP server over stdio: tools, prompts, and the `--selftest` flag.
- `server/config.js` — settings and data paths, read from `user_config` environment variables.
- `server/sources/` — 19 source adapters plus the registry in `index.js` (fan-out, aliases, key-skip logic).
- `server/lib/` — `http.js` (timeouts, retries, backoff, per-host rate limits), `cache.js`, `ids.js`,
  `record.js` (canonical record, de-duplication, ranking), `cite.js`, `pdf.js`, `resolve.js`, `library.js`.
- `tests/` — `unit.test.mjs` (pure functions against recorded API fixtures) and `mcp.test.mjs`
  (end-to-end over stdio with the official MCP SDK client). Both run with `node --test`.

## Commands

- `npm install` — development only; the packed bundle ships `node_modules` inside itself.
- `npm test` — unit + end-to-end tests. **Needs network** (live sources).
- `npm run selftest` — query every source once and print ok/fail/skip per source.
- `npm run smoke` — record-mapping check against real API payloads.
- `npm run icon` / `npm run pack` — regenerate `icon.png`; validate the manifest and rebuild the `.mcpb`.
- `MCPB_ENTRY=<path>` — makes the end-to-end tests run against an extracted bundle instead of the repo copy.

## Conventions

- A source adapter exports `search({query, limit, yearFrom, yearTo, sort, signal})` and optionally
  `getById(identifier)` / `related(...)`, returning canonical records built with `server/sources/util.js`.
- Adding a source = one file in `server/sources/` plus one entry in the registry in `server/sources/index.js`.
- De-duplication and ranking live in one place (`server/lib/record.js`); adapters never sort or merge.
- `.mcpbignore` keeps `scripts/`, `tests/` and dotfiles out of the packed bundle.

## Gotchas (verified 2026-10-07)

- DBLP's API is behind an Anubis proof-of-work wall — unusable from a plain HTTP client, so there is no DBLP adapter.
- ChemRxiv's own API is Cloudflare-blocked; ChemRxiv preprints are read through Europe PMC instead.
- Semantic Scholar answers HTTP 429 without a key (shared anonymous pool). A key is optional but recommended.
- `download_paper` is legal open access only; Sci-Hub is deliberately not implemented.
