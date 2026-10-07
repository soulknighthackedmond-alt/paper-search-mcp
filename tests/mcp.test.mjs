// End-to-end test: starts the server exactly the way an MCP client does,
// over stdio, and drives it with the official SDK client.
// Live network calls are included; set PAPER_SEARCH_SKIP_LIVE=1 to skip them.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = process.env.PSP_ENTRY ?? path.join(here, "..", "server", "index.js");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "psp-test-"));
const live = process.env.PAPER_SEARCH_SKIP_LIVE !== "1";

let client;
let tools;

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, PAPER_SEARCH_DATA_DIR: dataDir, PAPER_SEARCH_CACHE_TTL_MINUTES: "5" },
    stderr: "pipe",
  });
  client = new Client({ name: "paper-search-plus-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  tools = await client.listTools();
});

after(async () => {
  await client?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const textOf = (result) => (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const jsonOf = (result) => result.structuredContent;

test("handshake advertises the tool and prompt surface", async () => {
  const names = tools.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "author_profile",
    "cite_paper",
    "download_paper",
    "find_related",
    "get_paper",
    "library",
    "list_sources",
    "read_paper",
    "search_papers",
    "server_status",
  ]);
  for (const tool of tools.tools) {
    assert.ok(tool.description.length > 60, `${tool.name} needs a useful description`);
    assert.ok(tool.inputSchema, `${tool.name} has no input schema`);
  }

  const prompts = await client.listPrompts();
  assert.deepEqual(prompts.prompts.map((p) => p.name).sort(), ["compare_papers", "literature_review", "research_gap", "summarize_paper"]);

  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /search_papers/);
  assert.match(instructions, /Sci-Hub/, "the instructions should be explicit that pirate mirrors are excluded");
});

test("list_sources describes every source and its availability", async () => {
  const result = await client.callTool({ name: "list_sources", arguments: {} });
  const data = jsonOf(result);
  assert.ok(data.sources.length >= 15);
  assert.ok(data.sources.some((s) => s.id === "arxiv" && s.available === true));
  const core = data.sources.find((s) => s.id === "core");
  assert.equal(core.available, false);
  assert.match(textOf(result), /needs: CORE_API_KEY/);
  assert.ok(!data.sources.some((s) => s.id === "dblp"), "dblp is behind a bot wall and must not be advertised");
});

test("server_status reports configuration and cache", async () => {
  const result = await client.callTool({ name: "server_status", arguments: {} });
  const data = jsonOf(result);
  assert.equal(data.server, "paper-search-plus");
  assert.equal(data.data_dir, dataDir);
  assert.ok(data.cache_stats);
  assert.ok(data.default_sources.includes("openalex"));
});

test("an unknown tool argument is rejected, not silently ignored", async () => {
  const result = await client.callTool({ name: "search_papers", arguments: { query: "x", limit: 999 } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /limit|Invalid|invalid/i);
});

test("library round-trip works against the configured data folder", async () => {
  const added = await client.callTool({ name: "library", arguments: { action: "add", identifier: "10.1038/s41586-021-03819-2", tags: ["test"] } });
  const addedData = jsonOf(added);
  assert.ok(addedData.key.startsWith("doi:"), textOf(added));
  assert.equal(addedData.total, 1);

  const listed = await client.callTool({ name: "library", arguments: { action: "list" } });
  assert.equal(jsonOf(listed).items.length, 1);

  const exported = await client.callTool({ name: "library", arguments: { action: "export", style: "bibtex" } });
  assert.match(textOf(exported), /@\w+\{/);

  const removed = await client.callTool({ name: "library", arguments: { action: "remove", key: addedData.key } });
  assert.equal(jsonOf(removed).removed, 1);
});

test("search_papers returns de-duplicated, ranked results", { skip: !live }, async () => {
  const result = await client.callTool({
    name: "search_papers",
    arguments: { query: "attention is all you need", sources: ["arxiv", "openalex", "crossref"], limit: 5 },
  });
  assert.notEqual(result.isError, true, textOf(result));
  const data = jsonOf(result);
  assert.ok(data.results.length >= 1);
  assert.ok(data.sources_searched.length === 3);
  const first = data.results[0];
  assert.ok(first.title && first.title.length > 5);
  assert.ok(first.score > 0);
  assert.ok(first.sources);
  assert.match(textOf(result), /unique paper/);
});

test("get_paper resolves an arXiv id into a full record", { skip: !live }, async () => {
  const result = await client.callTool({ name: "get_paper", arguments: { identifier: "arxiv:1706.03762" } });
  assert.notEqual(result.isError, true, textOf(result));
  const paper = jsonOf(result).paper;
  assert.match(paper.title.toLowerCase(), /attention is all you need/);
  assert.equal(paper.year, 2017);
  assert.ok(paper.authors.some((a) => /Vaswani/.test(a)));
  assert.ok(paper.ids.arxiv === "1706.03762", `ids: ${JSON.stringify(paper.ids)}`);
});

test("cite_paper formats a resolvable paper", { skip: !live }, async () => {
  const result = await client.callTool({ name: "cite_paper", arguments: { identifiers: ["arxiv:1706.03762"], style: "bibtex" } });
  assert.notEqual(result.isError, true, textOf(result));
  assert.match(textOf(result), /@\w+\{vaswani2017attention/);
});

test("search_papers reports an honest empty result", { skip: !live }, async () => {
  const result = await client.callTool({
    name: "search_papers",
    arguments: { query: "zxqvbnmplkjhgfdsa unparseable gibberish topic", sources: ["arxiv"], limit: 3 },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /No results/);
});

test("download_paper saves a real PDF and read_paper extracts it", { skip: !live }, async () => {
  const downloaded = await client.callTool({ name: "download_paper", arguments: { identifier: "arxiv:1706.03762" } });
  assert.notEqual(downloaded.isError, true, textOf(downloaded));
  const file = jsonOf(downloaded).file;
  assert.ok(fs.existsSync(file.path), `expected a file at ${file.path}`);
  assert.ok(file.bytes > 50_000, `suspiciously small PDF: ${file.bytes} bytes`);
  assert.equal(fs.readFileSync(file.path).subarray(0, 5).toString(), "%PDF-");
  assert.match(file.path, /^.*2017-Vaswani-attention\.pdf$/, "file name should come from the metadata");

  const outline = await client.callTool({ name: "read_paper", arguments: { source: file.path, mode: "outline" } });
  assert.notEqual(outline.isError, true, textOf(outline));
  const outlineData = jsonOf(outline);
  assert.ok(outlineData.total_pages >= 5, `pages: ${outlineData.total_pages}`);
  const names = outlineData.sections.map((s) => s.name);
  assert.ok(names.includes("Introduction"), `sections: ${names.join(", ")}`);
  assert.ok(names.includes("Conclusion") || names.includes("References"), `sections: ${names.join(", ")}`);

  const firstPage = await client.callTool({ name: "read_paper", arguments: { source: file.path, pages: "1", mode: "text" } });
  assert.match(textOf(firstPage), /attention/i);
  assert.deepEqual(jsonOf(firstPage).pages_read, [1]);
});
