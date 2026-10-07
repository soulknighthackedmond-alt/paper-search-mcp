// Builds the .mcpb bundle with the official MCPB CLI (it validates the
// manifest against the published schema and honours .mcpbignore).
//
//   npm run pack        ->  paper-search-plus-<version>.mcpb
//
// The two commands below run through a shell because npx is a .cmd shim on
// Windows, which Node refuses to spawn directly. Nothing user-supplied reaches
// the command line: the package spec is a literal and both values taken from
// manifest.json are checked against a strict pattern first.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.name) || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error(`Refusing to pack: unexpected name/version in manifest.json (${manifest.name}@${manifest.version})`);
}
const output = `${manifest.name}-${manifest.version}.mcpb`;

const run = (command) => execSync(command, { cwd: root, stdio: "inherit", shell: true });
const cli = "npx --yes @anthropic-ai/mcpb@latest";

console.log(`Validating manifest.json (v${manifest.manifest_version})…`);
run(`${cli} validate manifest.json`);

console.log(`Packing ${output}…`);
run(`${cli} pack . ${output}`);

const { size } = fs.statSync(path.join(root, output));
console.log(`\n${output} — ${(size / 1_048_576).toFixed(2)} MB`);
