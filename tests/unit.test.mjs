// Unit tests for the pure logic: identifiers, de-duplication, ranking,
// citation styles, PDF text structure and every payload mapper.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectIdentifier, normalizeDoi, normalizeArxivId, normalizePmid, normalizePmcid,
  titleSimilarity, recordKey, normalizeTitle,
} from "../server/lib/ids.js";
import { dedupe, rank, toCompact, toFull, mergeRecords, newRecord, cleanText, shortAuthors, relevance } from "../server/lib/record.js";
import { format, bibtexKey, parseName, apaName, vancouverName, STYLES } from "../server/lib/cite.js";
import { safeFilename, filenameFor, extractSections, extractReferences, isPdfBytes } from "../server/lib/pdf.js";
import { fromInvertedIndex, fromOpenAlex } from "../server/sources/openalex.js";
import { parsePubmedArticle } from "../server/sources/pubmed.js";
import { fromEuropePmc } from "../server/sources/europepmc.js";
import { parseSearchPage } from "../server/sources/iacr.js";
import { isFragment, fromCrossref } from "../server/sources/crossref.js";
import { resolveSources, listSources, SOURCES, DEFAULT_SOURCES } from "../server/sources/index.js";

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

test("detectIdentifier recognises the common shapes", () => {
  assert.deepEqual(detectIdentifier("10.1038/s41586-021-03819-2"), { type: "doi", value: "10.1038/s41586-021-03819-2" });
  assert.equal(detectIdentifier("https://doi.org/10.1101/2020.01.01.892927").type, "doi");
  assert.equal(detectIdentifier("arXiv:1706.03762").value, "1706.03762");
  assert.equal(detectIdentifier("https://arxiv.org/abs/1706.03762v5").value, "1706.03762v5");
  assert.equal(detectIdentifier("cs/0701001").value, "cs/0701001");
  assert.equal(detectIdentifier("PMID: 37796413").value, "37796413");
  assert.equal(detectIdentifier("37796413").type, "pmid");
  assert.equal(detectIdentifier("PMC13227603").value, "PMC13227603");
  assert.equal(detectIdentifier("https://pubmed.ncbi.nlm.nih.gov/37796413/").type, "pmid");
  assert.equal(detectIdentifier("https://openalex.org/W4387966251").value, "W4387966251");
  assert.equal(detectIdentifier("attention is all you need").type, "query");
});

test("identifier normalisation strips URLs and trailing punctuation", () => {
  assert.equal(normalizeDoi("https://doi.org/10.1038/ABC.123."), "10.1038/abc.123");
  assert.equal(normalizeDoi("doi:10.1000/xyz"), "10.1000/xyz");
  assert.equal(normalizeArxivId("https://arxiv.org/pdf/2401.12345.pdf"), "2401.12345");
  assert.equal(normalizeArxivId("arXiv:2401.12345v2"), "2401.12345v2");
  assert.equal(normalizePmid("PMID: 12345678"), "12345678");
  assert.equal(normalizePmid("nonsense"), "");
  assert.equal(normalizePmcid("pmc1234567"), "PMC1234567");
});

test("title similarity separates the same paper from a different one", () => {
  const a = "Attention Is All You Need";
  const b = "Attention is all you need!";
  const c = "Attention Is Not All You Need: Pure Attention Loses Rank Doubly Exponentially";
  assert.ok(titleSimilarity(a, b) > 0.9);
  assert.ok(titleSimilarity(a, c) < 0.6);
  assert.equal(normalizeTitle("A <b>Study</b> of Things!"), "a study of things");
});

// ---------------------------------------------------------------------------
// Records: merge, dedupe, rank
// ---------------------------------------------------------------------------

const paper = (over = {}) => newRecord({
  title: "Attention Is All You Need",
  doi: "10.5555/3295222.3295349",
  year: 2017,
  authors: [{ name: "Ashish Vaswani" }],
  venue: "NeurIPS",
  abstract: "short",
  sources: ["crossref"],
  ...over,
});

test("mergeRecords keeps the richer value from each side", () => {
  const merged = mergeRecords(paper(), paper({ abstract: "a much longer abstract with detail", citations: 90000, pdf_url: "https://x/y.pdf", sources: ["openalex"] }));
  assert.equal(merged.abstract, "a much longer abstract with detail");
  assert.equal(merged.citations, 90000);
  assert.equal(merged.pdf_url, "https://x/y.pdf");
  assert.deepEqual(merged.sources, ["crossref", "openalex"]);
});

test("dedupe collapses the same paper from several sources", () => {
  const records = [
    paper(),
    paper({ abstract: "longer abstract text here", citations: 100, sources: ["openalex"] }),
    paper({ title: "Attention is all you need", doi: "", sources: ["arxiv"], ids: { arxiv: "1706.03762" } }),
    newRecord({ title: "A completely different paper about bees", year: 2020, sources: ["doaj"] }),
  ];
  const out = dedupe(records);
  assert.equal(out.length, 2);
  assert.equal(out[0].citations, 100);
  assert.ok(out[0].sources.includes("arxiv"));
  assert.ok(out[0].sources.includes("openalex"));
});

test("dedupe does not merge different papers that share a year", () => {
  const out = dedupe([
    newRecord({ title: "Deep learning for protein folding", year: 2021 }),
    newRecord({ title: "Deep learning for weather forecasting", year: 2021 }),
  ]);
  assert.equal(out.length, 2);
});

test("ranking prefers the paper that matches the query and is cited", () => {
  const query = "graph neural networks drug discovery";
  const records = [
    newRecord({ title: "A survey of gardening techniques", year: 2024, citations: 5, sources: ["crossref"] }),
    newRecord({ title: "Graph neural networks for drug discovery", year: 2021, citations: 400, sources: ["crossref"], pdf_url: "https://x.pdf" }),
    newRecord({ title: "Neural networks in chemistry", year: 2022, citations: 50, sources: ["crossref"] }),
  ];
  const ranked = rank(records, query);
  assert.match(ranked[0].title, /Graph neural networks/);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[0].why.includes("open-access PDF"));
});

test("relevance rewards title matches over abstract matches", () => {
  const terms = ["transformer", "attention"];
  const inTitle = relevance(newRecord({ title: "Transformer attention explained" }), terms);
  const inAbstract = relevance(newRecord({ title: "Something else", abstract: "we use transformer attention" }), terms);
  assert.ok(inTitle > inAbstract);
});

test("recordKey is stable and DOI-first", () => {
  assert.equal(recordKey(paper()), "doi:10.5555/3295222.3295349");
  assert.equal(recordKey(newRecord({ title: "No ids at all", ids: { arxiv: "1234.5678" } })), "arxiv:1234.5678");
});

test("compact and full projections drop empty fields", () => {
  const compact = toCompact(paper({ pdf_url: "https://x.pdf", citations: 12 }), 1);
  assert.equal(compact.n, 1);
  assert.equal(compact.open_access, "pdf");
  assert.equal(compact.abstract, undefined);
  const full = toFull(paper({ abstract: "text" }));
  assert.equal(full.abstract, "text");
  assert.equal(full.publisher, undefined);
});

test("helpers: cleanText strips markup, shortAuthors abbreviates", () => {
  assert.equal(cleanText("<jats:p>Hello &amp; welcome</jats:p>"), "Hello & welcome");
  assert.equal(shortAuthors([{ name: "Jane Smith" }, { name: "Bo Li" }]), "Smith, Li");
  assert.match(shortAuthors([{ name: "A B" }, { name: "C D" }, { name: "E F" }, { name: "G H" }, { name: "I J" }]), /et al\. \(5 authors\)/);
});

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

const vaswani = newRecord({
  title: "Attention Is All You Need",
  doi: "10.5555/3295222.3295349",
  year: 2017,
  venue: "Advances in Neural Information Processing Systems",
  authors: [{ name: "Ashish Vaswani" }, { name: "Noam Shazeer" }, { name: "Niki Parmar" }],
  type: "paper-conference",
  abstract: "The dominant sequence transduction models are based on complex recurrent networks.",
});

test("name parsing handles the usual shapes", () => {
  assert.deepEqual(parseName("Jane Q. Smith"), { family: "Smith", given: "Jane Q.", suffix: "" });
  assert.deepEqual(parseName("Smith, Jane Q."), { family: "Smith", given: "Jane Q.", suffix: "" });
  assert.equal(apaName("Jane Q Smith"), "Smith, J. Q.");
  assert.equal(vancouverName("Jane Q Smith"), "Smith JQ");
});

test("bibtex output is valid-looking and keys are unique", () => {
  const taken = new Set();
  const text = format(vaswani, "bibtex", taken);
  assert.match(text, /^@inproceedings\{vaswani2017attention,/);
  assert.match(text, /doi\s+= \{10\.5555\/3295222\.3295349\}/);
  assert.match(text, /author\s+= \{Ashish Vaswani and Noam Shazeer and Niki Parmar\}/);
  const second = format(vaswani, "bibtex", taken);
  assert.match(second, /^@inproceedings\{vaswani2017attentionb,/);
  assert.equal(bibtexKey(vaswani, new Set()), "vaswani2017attention");
});

test("every advertised style produces a non-empty entry", () => {
  for (const style of Object.keys(STYLES)) {
    const out = format(vaswani, style);
    assert.ok(out.length > 20, `${style} produced: ${out}`);
    assert.ok(!out.includes("undefined"), `${style} leaked undefined: ${out}`);
  }
});

test("apa, ris and plain render the expected parts", () => {
  assert.match(format(vaswani, "apa"), /^Vaswani, A\., Shazeer, N\., & Parmar, N\. \(2017\)\./);
  const ris = format(vaswani, "ris");
  assert.match(ris, /^TY {2}- CONF/m);
  assert.match(ris, /ER {2}- /);
  assert.match(format(vaswani, "plain"), /Attention Is All You Need/);
  const csl = JSON.parse(format(vaswani, "csl"));
  assert.equal(csl.DOI, "10.5555/3295222.3295349");
  assert.equal(csl.author[0].family, "Vaswani");
});

// ---------------------------------------------------------------------------
// PDF helpers
// ---------------------------------------------------------------------------

test("PDF detection and file naming", () => {
  assert.ok(isPdfBytes(Buffer.from("%PDF-1.7\n...")));
  assert.ok(!isPdfBytes(Buffer.from("<html><body>nope")));
  assert.equal(safeFilename('a<b>:c"d/e\\f?.pdf'), "abcdef");
  assert.equal(filenameFor(vaswani), "2017-Vaswani-attention.pdf");
});

const SAMPLE_TEXT = [
  "Abstract We propose a new architecture. ",
  "1 Introduction Recurrent models have long dominated sequence modelling and translation. ",
  "2 Related Work Many papers tried attention before this one was published. ",
  "3 Methods We describe the encoder and decoder stacks in detail with equations. ",
  "4 Results Our model reaches 28.4 BLEU on WMT 2014 English-to-German translation. ",
  "5 Discussion We analyse the attention heads and their behaviour. ",
  "6 Conclusion Attention is all you need indeed, and we show why that is the case. ",
  "References [1] Bahdanau et al. 2015. Neural machine translation. doi:10.3115/v1/D14-1179. ",
  "[2] Sutskever et al. 2014. Sequence to sequence learning. arXiv:1409.3215. ",
].join("");

test("section detection finds the standard headings in order", () => {
  const sections = extractSections(SAMPLE_TEXT);
  const names = sections.map((s) => s.name);
  for (const expected of ["Abstract", "Introduction", "Methods", "Results", "Conclusion", "References"]) {
    assert.ok(names.includes(expected), `missing ${expected} in ${names.join(", ")}`);
  }
  assert.ok(sections.find((s) => s.name === "Results").text.includes("28.4 BLEU"));
});

test("reference extraction pulls DOIs out of the bibliography", () => {
  const refs = extractReferences(SAMPLE_TEXT);
  assert.ok(refs.length >= 1);
  assert.equal(refs[0].doi, "10.3115/v1/D14-1179");
});

// ---------------------------------------------------------------------------
// Payload mappers (fixtures taken from real API responses)
// ---------------------------------------------------------------------------

test("OpenAlex abstract inverted index is rebuilt in order", () => {
  const text = fromInvertedIndex({ world: [0], hello: [1], again: [2] });
  assert.equal(text, "world hello again");
});

test("OpenAlex work maps to a canonical record", () => {
  const record = fromOpenAlex({
    id: "https://openalex.org/W4387966251",
    doi: "https://doi.org/10.1109/TVCG.2023.3327163",
    title: "AttentionViz: A Global View of Transformer Attention",
    publication_year: 2023,
    type: "article",
    authorships: [{ author: { display_name: "Catherine Yeh", orcid: "https://orcid.org/0000-0002-1234-5678" }, institutions: [{ display_name: "MIT" }] }],
    primary_location: { source: { display_name: "IEEE TVCG" }, landing_page_url: "https://doi.org/10.1109/tvcg.2023.3327163", license: "cc-by" },
    best_oa_location: { pdf_url: "https://example.org/a.pdf", license: "cc-by" },
    open_access: { is_oa: true, oa_status: "hybrid" },
    cited_by_count: 78,
    referenced_works_count: 60,
    abstract_inverted_index: { Transformers: [0], are: [1], everywhere: [2] },
    keywords: [{ display_name: "Visualization" }],
    ids: { openalex: "W4387966251", doi: "https://doi.org/10.1109/tvcg.2023.3327163", pmid: "https://pubmed.ncbi.nlm.nih.gov/37883259" },
  });
  assert.equal(record.doi, "10.1109/tvcg.2023.3327163");
  assert.equal(record.year, 2023);
  assert.equal(record.citations, 78);
  assert.equal(record.is_oa, true);
  assert.equal(record.pdf_url, "https://example.org/a.pdf");
  assert.equal(record.authors[0].orcid, "0000-0002-1234-5678");
  assert.equal(record.ids.pmid, "37883259");
  assert.equal(record.abstract, "Transformers are everywhere");
});

test("PubMed efetch XML maps to a canonical record", () => {
  const xml = `<PubmedArticle><MedlineCitation><PMID Version="1">37796413</PMID>
    <Article><Journal><Title>Pattern recognition</Title><JournalIssue><Volume>142</Volume><Issue>3</Issue>
      <PubDate><Year>2024</Year></PubDate></JournalIssue></Journal>
      <ArticleTitle>Efficient brain tumor segmentation</ArticleTitle>
      <Abstract><AbstractText Label="PURPOSE">To segment tumours.</AbstractText><AbstractText>We used a Swin transformer.</AbstractText></Abstract>
      <AuthorList><Author><LastName>Ghazouani</LastName><ForeName>Fethi</ForeName><Affiliation>Lab A</Affiliation></Author>
        <Author><CollectiveName>The Consortium</CollectiveName></Author></AuthorList>
      <PublicationTypeList><PublicationType>Journal Article</PublicationType></PublicationTypeList>
      <ELocationID EIdType="doi">10.1016/j.patcog.2021.108417</ELocationID>
    </Article>
    <MeshHeadingList><MeshHeading><DescriptorName>Brain Neoplasms</DescriptorName></MeshHeading></MeshHeadingList>
    <ArticleIdList><ArticleId IdType="pubmed">37796413</ArticleId><ArticleId IdType="pmc">PMC1234567</ArticleId></ArticleIdList>
  </MedlineCitation><PubmedData/></PubmedArticle>`;
  const record = parsePubmedArticle(xml);
  assert.equal(record.ids.pmid, "37796413");
  assert.equal(record.ids.pmcid, "PMC1234567");
  assert.equal(record.doi, "10.1016/j.patcog.2021.108417");
  assert.equal(record.year, 2024);
  assert.equal(record.authors.length, 2);
  assert.equal(record.authors[1].name, "The Consortium");
  assert.match(record.abstract, /^PURPOSE: To segment tumours\. We used a Swin transformer\./);
  assert.deepEqual(record.fields, ["Brain Neoplasms"]);
});

test("Europe PMC core result maps to a canonical record", () => {
  const record = fromEuropePmc({
    id: "42238349",
    source: "MED",
    pmid: "42238349",
    pmcid: "PMC13227603",
    doi: "10.1093/pnasnexus/pgag149",
    title: "Deficient executive control in transformer attention.",
    authorList: { author: [{ fullName: "Patel SC" }, { fullName: "Wang H" }] },
    journalInfo: { journal: { title: "PNAS nexus", volume: "5", issue: "2" }, yearOfPublication: 2026 },
    abstractText: "Although transformers work well, attention is limited.",
    isOpenAccess: "Y",
    citedByCount: 1,
    fullTextUrlList: { fullTextUrl: [{ documentStyle: "pdf", availability: "Open access", url: "https://europepmc.org/articles/PMC13227603?pdf=render" }] },
    meshHeadingList: { meshHeading: [{ descriptorName: "Attention" }] },
  });
  assert.equal(record.ids.pmid, "42238349");
  assert.equal(record.is_oa, true);
  assert.equal(record.citations, 1);
  assert.equal(record.year, 2026);
  assert.equal(record.pdf_url, "https://europepmc.org/articles/PMC13227603?pdf=render");
  assert.deepEqual(record.authors.map((a) => a.name), ["Patel SC", "Wang H"]);
});

test("Crossref mapping drops fragments and reads licences", () => {
  const item = {
    DOI: "10.1234/abc",
    title: ["A real article"],
    author: [{ given: "Jane", family: "Smith", ORCID: "https://orcid.org/0000-0001-2345-6789" }],
    issued: { "date-parts": [[2020, 5, 1]] },
    "container-title": ["Journal of Tests"],
    type: "journal-article",
    "is-referenced-by-count": 42,
    license: [{ URL: "https://creativecommons.org/licenses/by/4.0/" }],
    abstract: "<jats:p>An abstract.</jats:p>",
  };
  const record = fromCrossref(item);
  assert.equal(record.year, 2020);
  assert.equal(record.citations, 42);
  assert.equal(record.is_oa, true);
  assert.equal(record.abstract, "An abstract.");
  assert.equal(record.authors[0].orcid, "0000-0001-2345-6789");

  assert.ok(isFragment({ type: "component", title: ["Figure 10: pipeline"] }));
  assert.ok(isFragment({ type: "journal-article", title: ["Table 2: results"] }));
  assert.ok(isFragment({ type: "journal-article", title: [""], author: [] }));
  assert.ok(!isFragment(item));
});

test("IACR search page parser reads ids, titles, authors and abstracts", () => {
  const html = `<div class="mb-4"><div class="d-flex"><a title="2026/2286" class="paperlink" href="/2026/2286">2026/2286</a>
    <span class="ms-2"><a href="/2026/2286.pdf">(PDF)</a></span><small class="ms-auto">Last updated: 2026-10-04</small></div>
    <div class="ms-md-4"><div class="d-flex"><div><strong>Non-Interactive Witness-Indistinguishable Commit-and-Prove</strong>
    <div class="mt-1"><span class="fst-italic">Susumu Kiyoshima, Jane Doe</span></div></div>
    <div class="float-end"><small class="badge category category-PROTOCOLS">Cryptographic protocols</small></div></div>
    <p class="mb-0 mt-1 search-abstract">Targeted hitting-set generators are studied here.</p></div></div>`;
  const parsed = parseSearchPage(html);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "2026/2286");
  assert.equal(parsed[0].title, "Non-Interactive Witness-Indistinguishable Commit-and-Prove");
  assert.deepEqual(parsed[0].authors, ["Susumu Kiyoshima", "Jane Doe"]);
  assert.equal(parsed[0].category, "Cryptographic protocols");
  assert.match(parsed[0].abstract, /Targeted hitting-set/);
  assert.equal(parsed[0].posted, "2026-10-04");
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("every source exposes the adapter contract", () => {
  for (const [id, source] of Object.entries(SOURCES)) {
    assert.equal(source.id, id, `${id} has mismatched id`);
    assert.equal(typeof source.search, "function", `${id} cannot search`);
    assert.ok(source.label && source.coverage && source.homepage, `${id} is missing description fields`);
  }
});

test("source resolution handles aliases, 'all' and typos", () => {
  assert.deepEqual(resolveSources(["s2"]).sources.map((s) => s.id), ["semantic-scholar"]);
  assert.deepEqual(resolveSources(["arXiv", "pubmed"]).sources.map((s) => s.id), ["arxiv", "pubmed"]);
  const all = resolveSources(["all"]);
  assert.ok(all.sources.length > 10);
  assert.ok(!all.sources.some((s) => s.id === "unpaywall"), "unpaywall is a lookup, not a search source");
  const unknown = resolveSources(["nature"]);
  assert.deepEqual(unknown.unknown, ["nature"]);
  assert.match(unknown.suggestion, /Unknown source/);
  assert.deepEqual(resolveSources(undefined).sources.map((s) => s.id), DEFAULT_SOURCES);
});

test("sources that need a key are skipped rather than failing", () => {
  const { skipped } = resolveSources(["all"]);
  for (const entry of skipped) {
    assert.ok(entry.reason.includes("needs"), `${entry.source} skip reason should explain the key`);
  }
  const listing = listSources();
  assert.equal(listing.length, Object.keys(SOURCES).length);
  const core = listing.find((s) => s.id === "core");
  assert.equal(core.available, false);
  assert.match(core.unavailable_reason, /CORE_API_KEY/);
});
