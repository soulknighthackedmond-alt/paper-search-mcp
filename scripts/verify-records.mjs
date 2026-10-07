// Temporary mapping check: prints the first record from each source so the
// field mapping can be eyeballed against the real payloads.
const ids = process.argv.slice(2);
const { SOURCES } = await import("../server/sources/index.js");

const list = ids.length ? ids : Object.keys(SOURCES);

for (const id of list) {
  const source = SOURCES[id];
  try {
    const records = await source.search({ query: id === "chemrxiv" ? "catalysis" : "transformer attention", limit: 2 });
    const r = records[0];
    if (!r) {
      console.log(`\n### ${id}: 0 records`);
      continue;
    }
    console.log(`\n### ${id}: ${records.length} records`);
    console.log(JSON.stringify({
      title: r.title?.slice(0, 90),
      authors: r.authors?.slice(0, 2).map((a) => a.name),
      year: r.year,
      venue: r.venue?.slice(0, 60),
      doi: r.doi,
      ids: r.ids,
      citations: r.citations,
      is_oa: r.is_oa,
      pdf: r.pdf_url?.slice(0, 80),
      abstract: r.abstract ? `${r.abstract.slice(0, 90)}…` : "(none)",
      url: r.url?.slice(0, 80),
    }, null, 1));
  } catch (error) {
    console.log(`\n### ${id}: ERROR ${error.message}`);
  }
}
