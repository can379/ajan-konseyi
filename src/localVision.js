import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

export async function analyzeImagesLocally(files, rootDir) {
  const paths = (files || []).filter(Boolean);
  if (!paths.length) return "";
  const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const script = path.join(codeRoot, "scripts", "vision-analyze.swift");
  const sdk = "/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk";
  const { stdout } = await exec("xcrun", ["swift", "-sdk", sdk, "-module-cache-path", "/tmp/ajan-swift-module-cache", script, ...paths], { maxBuffer: 12 * 1024 * 1024, timeout: 120_000 });
  const results = JSON.parse(stdout || "[]");
  return results.map((item, index) => {
    const text = item.text?.length ? item.text.join("\n") : "(okunabilir metin bulunamadı)";
    const labels = item.labels?.length ? item.labels.join(", ") : "(nesne sınıfı bulunamadı)";
    return `Görsel ${index + 1} (${item.file})\nOCR metni:\n${text}\nYerel sınıflandırma: ${labels}\nOrtalama renk: ${item.averageColor || "bilinmiyor"}${item.error ? `\nTanılama: ${item.error}` : ""}`;
  }).join("\n\n");
}
