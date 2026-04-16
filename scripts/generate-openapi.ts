import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { buildOpenApiSpec } from "../src/openapi.js";

const spec = buildOpenApiSpec();
const outDir = path.resolve(process.cwd(), "..", "docs", "api");
const outFile = path.join(outDir, "openapi.yaml");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, yaml.dump(spec, { noRefs: true, lineWidth: 120 }), "utf8");

console.log(`OpenAPI spec written to ${outFile}`);
