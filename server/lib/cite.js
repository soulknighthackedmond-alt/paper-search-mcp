// Citation formatting: BibTeX, RIS, APA 7, MLA 9, Chicago (author-date),
// Harvard, Vancouver, GB/T 7714-2015, CSL-JSON and plain text.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Split "Jane Q. Smith", "Smith, Jane Q." or "J. Q. Smith" into parts. */
export function parseName(raw) {
  let name = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) return { family: "", given: "", suffix: "" };

  let suffix = "";
  const suffixMatch = name.match(/,\s*(Jr\.?|Sr\.?|III|II|IV|Ph\.?D\.?)$/i);
  if (suffixMatch) {
    suffix = suffixMatch[1];
    name = name.slice(0, suffixMatch.index).trim();
  }

  if (name.includes(",")) {
    const [family, ...rest] = name.split(",");
    return { family: family.trim(), given: rest.join(" ").trim(), suffix };
  }
  const parts = name.split(" ");
  if (parts.length === 1) return { family: parts[0], given: "", suffix };
  return { family: parts.at(-1), given: parts.slice(0, -1).join(" "), suffix };
}

/** "Jane Q Smith" -> "Smith, J. Q." (APA style) */
export function apaName(raw) {
  const { family, given } = parseName(raw);
  if (!given) return family;
  const initials = given
    .split(/[\s.-]+/)
    .filter(Boolean)
    .map((p) => `${p[0].toUpperCase()}.`)
    .join(" ");
  return `${family}, ${initials}`;
}

/** "Jane Q Smith" -> "Smith, Jane Q." */
export function invertedName(raw) {
  const { family, given } = parseName(raw);
  return given ? `${family}, ${given}` : family;
}

/** "Jane Q Smith" -> "Smith JQ" (Vancouver) */
export function vancouverName(raw) {
  const { family, given } = parseName(raw);
  const initials = given
    .split(/[\s.-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase())
    .join("");
  return initials ? `${family} ${initials}` : family;
}

function authorNames(record) {
  return (record.authors ?? []).map((a) => (typeof a === "string" ? a : a.name)).filter(Boolean);
}

function joinList(items, { and = "&", oxford = true } = {}) {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ${and} ${items[1]}`;
  const head = items.slice(0, -1).join(", ");
  return oxford ? `${head}, ${and} ${items.at(-1)}` : `${head} ${and} ${items.at(-1)}`;
}

/** Sortable, mostly-unique BibTeX key: smith2024attention */
export function bibtexKey(record, taken = new Set()) {
  const authors = authorNames(record);
  const { family } = parseName(authors[0] ?? "anon");
  const surname = (family || "anon").toLowerCase().replace(/[^a-z]/g, "") || "anon";
  const year = record.year ?? "n.d.";
  const word = (String(record.title ?? "").toLowerCase().match(/[a-z]{4,}/) ?? ["paper"])[0];
  let key = `${surname}${year}${word}`;
  let n = 1;
  while (taken.has(key)) {
    n += 1;
    key = `${surname}${year}${word}${String.fromCharCode(96 + n)}`;
  }
  taken.add(key);
  return key;
}

function escapeBib(value) {
  return String(value ?? "")
    .replace(/[{}]/g, "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/\$/g, "\\$")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_")
    .replace(/\s+/g, " ")
    .trim();
}

function bibType(record) {
  const type = String(record.type ?? "").toLowerCase();
  if (type.includes("book")) return "book";
  if (type.includes("chapter")) return "incollection";
  if (type.includes("thesis") || type.includes("dissertation")) return "phdthesis";
  if (type.includes("report")) return "techreport";
  if (type.includes("conference") || type.includes("proceedings") || type.includes("posted-content") === false && type.includes("paper-conference")) {
    return "inproceedings";
  }
  if (type.includes("preprint") || type.includes("posted-content")) return "misc";
  if (type.includes("dataset")) return "misc";
  return "article";
}

export function toBibtex(records, taken = new Set()) {
  const list = Array.isArray(records) ? records : [records];
  return list
    .map((record) => {
      const type = bibType(record);
      const key = bibtexKey(record, taken);
      const authors = authorNames(record).map((n) => escapeBib(n));
      const fields = [];
      if (record.title) fields.push(["title", `{${escapeBib(record.title)}}`]);
      if (authors.length) fields.push(["author", authors.join(" and ")]);
      if (record.year) fields.push(["year", record.year]);
      if (record.venue) {
        fields.push([type === "inproceedings" ? "booktitle" : "journal", escapeBib(record.venue)]);
      }
      if (record.publisher) fields.push(["publisher", escapeBib(record.publisher)]);
      if (record.volume) fields.push(["volume", escapeBib(record.volume)]);
      if (record.issue) fields.push(["number", escapeBib(record.issue)]);
      if (record.pages) fields.push(["pages", escapeBib(record.pages)]);
      if (record.doi) fields.push(["doi", escapeBib(record.doi)]);
      if (record.url) fields.push(["url", escapeBib(record.url)]);
      if (record.abstract) fields.push(["abstract", escapeBib(record.abstract.slice(0, 1200))]);
      if (record.keywords?.length) fields.push(["keywords", escapeBib(record.keywords.join(", "))]);
      if (record.license) fields.push(["license", escapeBib(record.license)]);
      const body = fields.map(([k, v]) => `  ${k.padEnd(10)} = {${v}},`).join("\n");
      return `@${type}{${key},\n${body}\n}`;
    })
    .join("\n\n");
}

const RIS_TYPE = {
  article: "JOUR",
  "journal-article": "JOUR",
  proceedings: "CONF",
  "paper-conference": "CONF",
  book: "BOOK",
  "book-chapter": "CHAP",
  preprint: "UNPB",
  "posted-content": "UNPB",
  dataset: "DATA",
  thesis: "THES",
  report: "RPRT",
};

export function toRis(records) {
  const list = Array.isArray(records) ? records : [records];
  return list
    .map((record) => {
      const lines = [`TY  - ${RIS_TYPE[String(record.type ?? "").toLowerCase()] ?? "JOUR"}`];
      for (const name of authorNames(record)) lines.push(`AU  - ${name}`);
      if (record.title) lines.push(`TI  - ${record.title}`);
      if (record.venue) lines.push(`JO  - ${record.venue}`, `T2  - ${record.venue}`);
      if (record.abstract) lines.push(`AB  - ${record.abstract.slice(0, 1500)}`);
      if (record.year) lines.push(`PY  - ${record.year}`);
      if (record.volume) lines.push(`VL  - ${record.volume}`);
      if (record.issue) lines.push(`IS  - ${record.issue}`);
      if (record.pages) {
        const [sp, ep] = String(record.pages).split(/[-–]/);
        lines.push(`SP  - ${sp.trim()}`);
        if (ep) lines.push(`EP  - ${ep.trim()}`);
      }
      if (record.publisher) lines.push(`PB  - ${record.publisher}`);
      if (record.doi) lines.push(`DO  - ${record.doi}`);
      if (record.url) lines.push(`UR  - ${record.url}`);
      else if (record.doi) lines.push(`UR  - https://doi.org/${record.doi}`);
      if (record.keywords?.length) for (const k of record.keywords) lines.push(`KW  - ${k}`);
      lines.push("ER  - ", "");
      return lines.join("\n");
    })
    .join("\n");
}

export function toApa(record) {
  const authors = authorNames(record).map(apaName);
  const year = record.year ?? "n.d.";
  const title = record.title ?? "";
  const venue = record.venue ?? "";
  const parts = [`${joinList(authors)} (${year}).`];
  parts.push(`${title}.`);
  if (venue) parts.push(`*${venue}*${record.volume ? `, *${record.volume}*` : ""}${record.issue ? `(${record.issue})` : ""}${record.pages ? `, ${record.pages}` : ""}.`);
  if (record.doi) parts.push(`https://doi.org/${record.doi}`);
  else if (record.url) parts.push(record.url);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function toMla(record) {
  const authors = authorNames(record).map(invertedName);
  let authorText = "";
  if (authors.length === 1) authorText = `${authors[0]}. `;
  else if (authors.length === 2) authorText = `${authors[0]}, and ${authorNames(record)[1]}. `;
  else if (authors.length > 2) authorText = `${authors[0]}, et al. `;
  const year = record.year ?? "n.d.";
  const bits = [
    `${authorText}"${record.title ?? ""}."`,
    record.venue ? `*${record.venue}*${record.volume ? `, vol. ${record.volume}` : ""}${record.issue ? `, no. ${record.issue}` : ""}${record.pages ? `, pp. ${record.pages}` : ""}, ${year}` : `${year}`,
  ];
  let out = bits.join(" ").trim();
  if (record.doi) out += `, https://doi.org/${record.doi}.`;
  else if (record.url) out += `, ${record.url}.`;
  else out += ".";
  return out.replace(/\s+/g, " ");
}

export function toChicago(record) {
  const authors = authorNames(record);
  const first = authors[0] ? invertedName(authors[0]) : "";
  const rest = authors.slice(1);
  let authorText = first;
  if (rest.length === 1) authorText = `${first}, and ${rest[0]}`;
  else if (rest.length > 1) authorText = `${first}, ${rest.slice(0, -1).join(", ")}, and ${rest.at(-1)}`;
  const year = record.year ?? "n.d.";
  const venue = record.venue ? ` *${record.venue}*${record.volume ? ` ${record.volume}` : ""}${record.issue ? ` (${record.issue})` : ""}${record.pages ? `: ${record.pages}` : ""}.` : "";
  const doi = record.doi ? ` https://doi.org/${record.doi}.` : record.url ? ` ${record.url}.` : "";
  return `${authorText}. ${year}. "${record.title ?? ""}."${venue}${doi}`.replace(/\s+/g, " ").trim();
}

export function toHarvard(record) {
  const authors = authorNames(record).map((n) => {
    const { family, given } = parseName(n);
    const initials = given.split(/[\s.-]+/).filter(Boolean).map((p) => `${p[0].toUpperCase()}.`).join(" ");
    return initials ? `${family}, ${initials}` : family;
  });
  const year = record.year ?? "n.d.";
  const bits = [`${joinList(authors, { and: "and" })} (${year})`];
  bits.push(`'${record.title ?? ""}'`);
  if (record.venue) bits.push(`*${record.venue}*${record.volume ? `, ${record.volume}` : ""}${record.issue ? `(${record.issue})` : ""}${record.pages ? `, pp. ${record.pages}` : ""}`);
  let out = bits.join(", ");
  if (record.doi) out += `. doi: ${record.doi}.`;
  else if (record.url) out += `. Available at: ${record.url}.`;
  else out += ".";
  return out.replace(/\s+/g, " ");
}

export function toVancouver(record) {
  const authors = authorNames(record).map(vancouverName);
  const year = record.year ?? "n.d.";
  let out = `${joinList(authors, { and: ",", oxford: false })}. ${record.title ?? ""}.`;
  if (record.venue) out += ` ${record.venue}.`;
  out += ` ${year}`;
  if (record.volume) out += `;${record.volume}`;
  if (record.issue) out += `(${record.issue})`;
  if (record.pages) out += `:${record.pages}`;
  out += ".";
  if (record.doi) out += ` doi:${record.doi}.`;
  return out.replace(/\s+/g, " ").trim();
}

export function toGbt7714(record) {
  const authors = authorNames(record).map((n) => {
    const { family, given } = parseName(n);
    const initials = given.split(/[\s.-]+/).filter(Boolean).map((p) => `${p[0].toUpperCase()}`).join("");
    return `${family} ${initials}`.trim();
  });
  const type = String(record.type ?? "").toLowerCase().includes("conference") ? "C" : "J";
  const year = record.year ?? "n.d.";
  let out = `${joinList(authors, { and: ",", oxford: false })}. ${record.title ?? ""}[${type}].`;
  if (record.venue) out += ` ${record.venue}`;
  out += `, ${year}`;
  if (record.volume) out += `, ${record.volume}`;
  if (record.issue) out += `(${record.issue})`;
  if (record.pages) out += `: ${record.pages}`;
  out += ".";
  if (record.doi) out += ` DOI: ${record.doi}.`;
  return out.replace(/\s+/g, " ").trim();
}

export function toCslJson(record) {
  const type = String(record.type ?? "").toLowerCase();
  const cslType = type.includes("conference")
    ? "paper-conference"
    : type.includes("book")
      ? "book"
      : type.includes("dataset")
        ? "dataset"
        : type.includes("preprint") || type.includes("posted-content")
          ? "article"
          : "article-journal";
  const date = record.year ? { "date-parts": [[record.year]] } : undefined;
  return {
    type: cslType,
    id: record.doi || record.ids?.arxiv || record.title,
    DOI: record.doi || undefined,
    title: record.title,
    author: (record.authors ?? []).map((a) => {
      const { family, given } = parseName(typeof a === "string" ? a : a.name);
      return { family, given };
    }),
    issued: date,
    "container-title": record.venue || undefined,
    volume: record.volume,
    issue: record.issue,
    page: record.pages,
    publisher: record.publisher,
    abstract: record.abstract || undefined,
    URL: record.url || undefined,
    keyword: record.keywords?.length ? record.keywords.join(", ") : undefined,
  };
}

export const STYLES = {
  bibtex: "BibTeX entry",
  ris: "RIS (EndNote/Zotero/Mendeley)",
  apa: "APA 7th",
  mla: "MLA 9th",
  chicago: "Chicago author-date",
  harvard: "Harvard",
  vancouver: "Vancouver (ICMJE)",
  gbt7714: "GB/T 7714-2015",
  csl: "CSL-JSON (Pandoc/Zotero)",
  plain: "Plain text",
};

export function format(record, style, taken = new Set()) {
  switch (String(style).toLowerCase()) {
    case "bibtex":
    case "bib":
      return toBibtex(record, taken);
    case "ris":
      return toRis(record);
    case "apa":
      return toApa(record);
    case "mla":
      return toMla(record);
    case "chicago":
      return toChicago(record);
    case "harvard":
      return toHarvard(record);
    case "vancouver":
      return toVancouver(record);
    case "gbt7714":
    case "gbt":
      return toGbt7714(record);
    case "csl":
    case "csl-json":
    case "json":
      return JSON.stringify(toCslJson(record), null, 2);
    case "plain":
    default: {
      const authors = authorNames(record);
      return [
        authors.length ? `${authors.slice(0, 6).join("; ")}${authors.length > 6 ? "; et al." : ""}` : "",
        record.year ? `(${record.year})` : "",
        record.title ?? "",
        record.venue ? `- ${record.venue}` : "",
        record.doi ? `doi:${record.doi}` : record.url || "",
      ]
        .filter(Boolean)
        .join(" ");
    }
  }
}
