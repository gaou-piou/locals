import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readLibraries, root } from "./manifest-io.ts";
import { generateRules, generateWar } from "./rules.ts";

const entries = readLibraries();
const exact = generateRules(entries, "exact");
const substitute = generateRules(entries, "substitute");

mkdirSync(`${root}dist/rules`, { recursive: true });
const write = (name: string, data: unknown) => writeFileSync(`${root}dist/rules/${name}.json`, JSON.stringify(data));
write("exact", exact.rules);
write("substitute", substitute.rules);
write("index", { ...exact.index, ...substitute.index });

const manifestPath = `${root}dist/manifest.json`;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.declarative_net_request = {
  rule_resources: [
    { id: "exact", enabled: true, path: "rules/exact.json" },
    { id: "substitute", enabled: false, path: "rules/substitute.json" },
  ],
};
manifest.web_accessible_resources = generateWar(entries).map((w) => ({ ...w, use_dynamic_url: false }));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`rules: ${exact.rules.length} exact, ${substitute.rules.length} substitute; ${manifest.web_accessible_resources[0].resources.length} web-accessible files`);
