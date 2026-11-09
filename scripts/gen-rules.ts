import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readLibraries, root } from "./manifest-io.ts";
import { generateRules, generateWar } from "./rules.ts";

const entries = readLibraries();
const exact = generateRules(entries, "exact");
const substitute = generateRules(entries, "substitute");
const byname = generateRules(entries, "byname");

mkdirSync(`${root}dist/rules`, { recursive: true });
const write = (name: string, data: unknown) => writeFileSync(`${root}dist/rules/${name}.json`, JSON.stringify(data));
write("exact", exact.rules);
write("substitute", substitute.rules);
write("byname", byname.rules);
write("index", { ...exact.index, ...substitute.index, ...byname.index });

const manifestPath = `${root}dist/manifest.json`;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.declarative_net_request = {
  rule_resources: [
    { id: "exact", enabled: true, path: "rules/exact.json" },
    { id: "substitute", enabled: false, path: "rules/substitute.json" },
    { id: "byname", enabled: true, path: "rules/byname.json" },
  ],
};
// libs/learned/ is filled at runtime by locals-learn; the glob also covers files added after load
const war = generateWar(entries).map((w) => ({ ...w, resources: [...w.resources, "libs/learned/*"], use_dynamic_url: false }));
manifest.web_accessible_resources = war;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`rules: ${exact.rules.length} exact, ${substitute.rules.length} substitute, ${byname.rules.length} byname; ${manifest.web_accessible_resources[0].resources.length} web-accessible files`);
