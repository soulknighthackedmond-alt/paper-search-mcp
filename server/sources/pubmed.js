// PubMed — the NLM index of biomedical literature. E-utilities, no key needed
// (an NCBI key raises the rate limit from 3 to 10 requests/second).

import { cached } from "../lib/cache.js";
import { getJson, getText, qs } from "../lib/http.js";
import { normalizeDoi, normalizePmid, normalizePmcid } from "../lib/ids.js";
import { config } from "../config.js";
import { make, clampLimit, yearFilter } from "./util.js";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

function common() {
  return {
    tool: "paper-search-plus",
    email: config.email || "",
    api_key: config.keys.ncbi || "",
  };
}

function textOf(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
}

/** Parse one <PubmedArticle> block from efetch XML. */
export function parsePubmedArticle(xml) {
  const pmid = textOf(xml, "PMID");
  const title = textOf(xml, "ArticleTitle");
  const journal = textOf(xml, "Title") || textOf(xml, "ISOAbbreviation");

  const abstractParts = [...String(xml).matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/gi)].map((m) => {
    const label = m[1].match(/Label="([^"]+)"/)?.[1];
    const body = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return label ? `${label}: ${body}` : body;
  });

  const authors = [...String(xml).matchAll(/<Author\b[\s\S]*?<\/Author>/gi)].map((block) => {
    const chunk = block[0];
    const collective = textOf(chunk, "CollectiveName");
    if (collective) return { name: collective };
    const last = textOf(chunk, "LastName");
    const fore = textOf(chunk, "ForeName") || textOf(chunk, "Initials");
    if (!last) return null;
    const author = { name: [fore, last].filter(Boolean).join(" ").replace(/\s+/g, " ") };
    const aff = textOf(chunk, "Affiliation");
    if (aff) author.affiliation = aff;
    return author;
  }).filter(Boolean);

  const year =
    Number(textOf(xml, "Year")) ||
    Number((textOf(xml, "MedlineDate").match(/\b(1[89]\d{2}|20\d{2})\b/) ?? [])[1]) ||
    null;

  const articleIds = [...String(xml).matchAll(/<ArticleId IdType="([^"]+)"[^>]*>([^<]*)<\/ArticleId>/gi)];
  const ids = Object.fromEntries(articleIds.map((m) => [m[1].toLowerCase(), m[2].trim()]));
  const elocation = String(xml).match(/<ELocationID EIdType="doi"[^>]*>([^<]*)<\/ELocationID>/i);
  const doi = normalizeDoi(ids.doi ?? elocation?.[1] ?? "");

  const pubTypes = [...String(xml).matchAll(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/gi)].map((m) => m[1]);
  const mesh = [...String(xml).matchAll(/<DescriptorName[^>]*>([^<]+)<\/DescriptorName>/gi)].map((m) => m[1]);
  const keywords = [...String(xml).matchAll(/<Keyword[^>]*>([^<]+)<\/Keyword>/gi)].map((m) => m[1]);

  return make("pubmed", {
    id: `pmid:${pmid}`,
    doi,
    title,
    authors,
    year,
    venue: journal,
    type: pubTypes.find((t) => /journal article|review|clinical trial|preprint/i.test(t)) ?? pubTypes[0] ?? "journal-article",
    publisher: "",
    abstract: abstractParts.join(" "),
    url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "",
    pdf_url: "",
    is_oa: null,
    license: "",
    citations: null,
    fields: mesh.slice(0, 10),
    keywords: keywords.slice(0, 12),
    language: textOf(xml, "Language"),
    ids: {
      pmid: normalizePmid(pmid),
      pmcid: normalizePmcid(ids.pmc ?? "") || undefined,
      doi: doi || undefined,
    },
    extra: {
      volume: textOf(xml, "Volume"),
      issue: textOf(xml, "Issue"),
      pages: textOf(xml, "MedlinePgn"),
      publication_types: pubTypes,
    },
  });
}

async function efetch(pmids) {
  const url = `${EUTILS}/efetch.fcgi?${qs({ db: "pubmed", id: pmids.join(","), retmode: "xml", ...common() })}`;
  const xml = await getText(url);
  const blocks = [...String(xml).matchAll(/<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g)].map((m) => m[0]);
  return blocks.map(parsePubmedArticle);
}

export default {
  id: "pubmed",
  label: "PubMed",
  homepage: "https://pubmed.ncbi.nlm.nih.gov",
  coverage: "37M+ biomedical and life-science citations (MEDLINE/PMC).",
  auth: [],
  filters: ["query", "limit", "year_from", "year_to", "sort"],
  notes: "Supports the full PubMed query syntax (e.g. 'crispr[ti] AND 2020:2024[dp]'). An optional NCBI key speeds it up.",

  async search({ query, limit = 10, yearFrom, yearTo, sort = "relevance", signal }) {
    const max = clampLimit(limit, 50);
    const searchUrl = `${EUTILS}/esearch.fcgi?${qs({
      db: "pubmed",
      term: query,
      retmax: max,
      retmode: "json",
      sort: sort === "date" ? "pub_date" : "relevance",
      datetype: yearFrom || yearTo ? "pdat" : "",
      mindate: yearFrom || "",
      maxdate: yearTo || "",
      ...common(),
    })}`;
    const found = await cached("pubmed-search", [searchUrl], () => getJson(searchUrl, { signal }));
    const ids = found?.esearchresult?.idlist ?? [];
    if (!ids.length) return [];
    const records = await cached("pubmed-fetch", [ids.join(",")], () => efetch(ids));
    return yearFilter(records, yearFrom, yearTo);
  },

  async getById(identifier) {
    const { type, value } = identifier;
    if (type !== "pmid") return null;
    const records = await cached("pubmed-fetch", [value], () => efetch([value]));
    return records[0] ?? null;
  },
};
