import fs from "node:fs";
import { runGoldenSuite } from "../src/evalHarness.js";

const cases = JSON.parse(fs.readFileSync(new URL("../evals/golden.json", import.meta.url), "utf8"));
const result = runGoldenSuite(cases);
for (const item of result.results) console.log(`${item.pass ? "✓" : "✗"} ${item.id}`);
console.log(`\nGolden eval: ${result.passed}/${result.total} geçti`);
if (result.failed) process.exitCode = 1;
