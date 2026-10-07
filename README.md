# Paper Search Plus

An MCP bundle (`.mcpb`) that gives an assistant real academic search: **19 sources, one de-duplicated ranked list, free PDFs, full-text reading and citations** — installed in one click, with no Python, no `pip`, no API keys required.

It is a ground-up Node implementation inspired by [`openags/paper-search-mcp`](https://github.com/openags/paper-search-mcp) (MIT). Same idea, different tool surface: **10 well-designed tools instead of ~90 per-source ones**, plus de-duplication, ranking, caching, retries, partial-failure reporting and legal open-access retrieval.

---

## Install

Download the latest `paper-search-plus-*.mcpb` from the [Releases page](https://github.com/soulknighthackedmond-alt/paper-search-mcp/releases/latest) — or build it yourself with `npm install && npm run pack`. It is a single file with no installer.

- **More AI** — Settings → Connectors → install from file, then pick the `.mcpb`.
- **Claude Desktop** — Settings → Extensions → Advanced settings → Install extension, then pick the `.mcpb` (or drag it onto the window).

Requirements: Node.js 20.10 or newer on the machine (the bundle ships every dependency inside itself; nothing is installed at run time and nothing is fetched from the network except the academic APIs themselves).

After installing, open the extension's settings and fill in **Contact email** — that is the only setting worth caring about. It puts Crossref, OpenAlex, NCBI and Unpaywall into their fast "polite pool" and unlocks free-PDF lookup. Every other setting is optional.

---

## Why this instead of the Python original

| | paper-search-mcp (Python) | Paper Search Plus |
|---|---|---|
| Install | `pip install`, `.env` file, keys for many sources | one `.mcpb`, zero runtime setup |
| Tool surface | ~90 tools (`search_arxiv`, `download_pubmed`, `read_biorxiv`, …) | 10 tools; one search covers every source |
| Cross-source results | per-source lists, duplicates everywhere | merged, de-duplicated by DOI/title, ranked by relevance + citations + recency + trust |
| Failures | one broken source fails the call | parallel fan-out with per-source timeouts; broken sources are reported next to the results |
| Rate limits | none | per-host limits, retries with backoff, `Retry-After` honoured |
| Repeated searches | repeat the network cost | local 24 h cache; second search is instant |
| PDF handling | downloads whatever comes back | verifies magic bytes, size and content type; rejects paywall HTML |
| Reading | dumps the whole text | page ranges, section detection, reference extraction |
| Citations | BibTeX-ish | BibTeX, RIS, APA 7, MLA 9, Chicago, Harvard, Vancouver, GB/T 7714, CSL-JSON |
| Sci-Hub | included | deliberately excluded — legal open access only |

---

## Tools

| Tool | What it does |
|---|---|
| `search_papers` | Fan out across sources in parallel, de-duplicate, rank. Filters: year range, open access only, minimum citations, sort by relevance/citations/date, `sources:["all"]`. |
| `get_paper` | Resolve a DOI, arXiv id, PubMed/PMC id, OpenAlex id, publisher URL or plain title into one complete record, enriched with open-access status and a free PDF link. |
| `list_sources` | Every source, what it covers, which filters it supports, whether it needs a key, and whether it is currently usable. |
| `download_paper` | Resolve the best legal open-access PDF, download it, verify it, and return the path, size, page count and sha256. |
| `read_paper` | Page-by-page text, detected sections (abstract → conclusion), parsed reference list, or just an outline. Works from a path, a URL or an identifier. Falls back to PMC full-text XML when no PDF exists. |
| `cite_paper` | Reference entries in 9 styles, with unique BibTeX keys, for one or many papers. |
| `find_related` | Citation graph: `citing` (what came after), `references` (what it builds on), `similar` (recommended work). Merges OpenAlex and Semantic Scholar. |
| `author_profile` | h-index, i10, citation totals, affiliations and most-cited papers. |
| `library` | Local reading list: add, list, search, remove, export to BibTeX/RIS, stats. Stays on the machine. |
| `server_status` | Configuration, cache usage, and `test_sources` — a live reachability check of every source. |

### Prompts

`literature_review`, `summarize_paper`, `compare_papers`, `research_gap` — each one drives the tools in the right order and insists that claims come from retrieved papers.

---

## Sources

Key-free and searched by default: **OpenAlex, Crossref, arXiv, Europe PMC, PubMed**.

Key-free, opt-in via `sources:[...]` or `sources:["all"]`: **PMC, bioRxiv, medRxiv, ChemRxiv, IACR ePrint, OpenReview, DOAJ, Zenodo, HAL, OpenAIRE, Semantic Scholar, Unpaywall** (lookup only).

Need a free key (skipped cleanly when absent): **CORE** (`CORE_API_KEY`), **IEEE Xplore** (`IEEE_API_KEY`), **Scopus** (`SCOPUS_API_KEY`). Optional keys that only raise limits: `NCBI_API_KEY`, `OPENALEX_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY`.

### Deliberately not included

- **Sci-Hub and other pirate mirrors.** `download_paper` returns legal open-access copies only.
- **Google Scholar.** Scraping it violates its terms and breaks constantly; Crossref/OpenAlex/Semantic Scholar cover the same literature legally.
- **DBLP.** Its API is behind an Anubis proof-of-work bot wall that a plain HTTP client cannot pass (verified 2026-10-07). CS coverage comes from OpenAlex, Crossref, Semantic Scholar and arXiv instead.
- **ChemRxiv's own API.** Cloudflare-protected (verified 2026-10-07); ChemRxiv preprints are reached through Europe PMC, which indexes them.

---

## Settings

| Setting | Default | Effect |
|---|---|---|
| Contact email | empty | Polite-pool access + Unpaywall free-PDF lookup. Recommended. |
| Folder for downloaded PDFs | `~/.paper-search-plus/papers` | Where `download_paper` writes. |
| Cache search results | on | 24 h local cache of results and metadata. |
| Maximum PDF size (MB) | 80 | Refuses anything larger. |
| `SEMANTIC_SCHOLAR_API_KEY` | empty | Makes Semantic Scholar fast instead of rate limited. |
| `CORE_API_KEY` | empty | Adds 300M+ open-access documents. |
| `NCBI_API_KEY` | empty | PubMed 10 req/s instead of 3. |
| `OPENALEX_API_KEY` | empty | Higher OpenAlex quota. |
| `IEEE_API_KEY` | empty | Adds IEEE journals and conferences. |
| `SCOPUS_API_KEY` | empty | Adds Scopus records. |

Data lives in `~/.paper-search-plus/` (`cache/`, `papers/`, `library.json`). Nothing else is written, and no data is sent anywhere except the academic APIs named above.

---

## Development

```bash
npm install          # only needed to develop; the shipped bundle is self-contained
npm test             # unit tests + end-to-end MCP protocol tests (live network)
npm run selftest     # query every source once and print what answered
npm run smoke        # record-mapping check against real API payloads
npm run icon         # regenerate icon.png
npm run pack         # validate the manifest and rebuild the .mcpb
```

### Layout

```
manifest.json          MCPB manifest (0.3): server, tools, prompts, user_config
icon.png               256x256 generated logo
server/
  index.js             MCP server: 10 tools, 4 prompts, stdio transport
  config.js            settings and paths from environment/user_config
  lib/
    http.js            fetch with timeouts, retries, backoff, per-host rate limits
    cache.js           disk + memory TTL cache
    ids.js             DOI/arXiv/PMID/PMC/OpenAlex detection and title matching
    record.js          canonical record, de-duplication, ranking, projections
    cite.js            9 citation styles
    pdf.js             download + verify + text/section/reference extraction
    resolve.js         identifier → enriched canonical record
    library.js         local reading list
  sources/             19 adapters + registry (fan-out, aliases, skip logic)
tests/                 unit.test.mjs, mcp.test.mjs
scripts/               icon generator, packer, record-mapping check
```

Every adapter implements `search({query, limit, yearFrom, yearTo, sort, signal})` and optionally `getById(identifier)` / `related(...)`, and returns canonical records. Adding a source is one file plus one line in `server/sources/index.js`.

---

## Licence and attribution

MIT. The design and feature set follow [`openags/paper-search-mcp`](https://github.com/openags/paper-search-mcp), MIT licensed, Copyright (c) 2025 OPENAGS; this bundle is an independent Node implementation. See `LICENSE`.

Every source keeps its own terms — Crossref, OpenAlex, NCBI, Unpaywall and Semantic Scholar all ask that you identify yourself with a contact email, which is why the setting exists.
