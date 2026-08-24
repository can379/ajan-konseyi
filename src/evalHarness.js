import { bindTestEvidence } from "./reviewIsolation.js";
import { identityResponseMatchesProvider } from "./orchestrator.js";
import { normalizeExcludedProviders, providerAllowed } from "./providerPolicy.js";

export function runGoldenCase(item) {
  if (item.kind === "provider-policy") {
    const run = { excludedProviders: normalizeExcludedProviders(item.excluded) };
    const actual = providerAllowed(run, item.provider);
    return { pass: actual === item.expected, actual };
  }
  if (item.kind === "identity") {
    const actual = identityResponseMatchesProvider({ provider: item.provider }, item.text);
    return { pass: actual === item.expected, actual };
  }
  if (item.kind === "test-evidence") {
    const result = bindTestEvidence({ testCommands: item.required }, item.executions);
    const actual = result.map(({ command, ran, ok }) => ({ command, ran, ok }));
    return { pass: JSON.stringify(actual) === JSON.stringify(item.expected), actual };
  }
  return { pass: false, error: `Bilinmeyen eval türü: ${item.kind}` };
}

export function runGoldenSuite(cases = []) {
  const results = cases.map((item) => ({ id: item.id, kind: item.kind, ...runGoldenCase(item) }));
  return { total: results.length, passed: results.filter((item) => item.pass).length,
    failed: results.filter((item) => !item.pass).length, results };
}
