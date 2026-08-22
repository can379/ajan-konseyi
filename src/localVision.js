import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

export function resolveVisionScript() {
  const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourcePath = path.join(codeRoot, "scripts", "vision-analyze.swift");
  const candidates = [
    sourcePath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`),
    process.resourcesPath && path.join(process.resourcesPath, "app.asar.unpacked", "scripts", "vision-analyze.swift"),
    process.resourcesPath && path.join(process.resourcesPath, "scripts", "vision-analyze.swift"),
    // app.asar içindeki sanal dosya fs.existsSync açısından mevcut görünür ama
    // xcrun tarafından açılamaz; bu nedenle kaynak yol her zaman en son denenir.
    sourcePath,
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || sourcePath;
}

export async function analyzeImagesLocally(files, rootDir) {
  const paths = (files || []).filter(Boolean);
  if (!paths.length) return "";
  const script = resolveVisionScript();
  if (!fs.existsSync(script)) throw new Error(`Görsel analiz betiği bulunamadı: ${script}`);
  const { stdout } = await exec("xcrun", ["swift", "-module-cache-path", "/tmp/ajan-swift-module-cache", script, ...paths], { maxBuffer: 12 * 1024 * 1024, timeout: 120_000 });
  const results = JSON.parse(stdout || "[]");
  return results.map((item, index) => {
    const text = item.text?.length ? item.text.join("\n") : "(okunabilir metin bulunamadı)";
    const labels = item.labels?.length ? item.labels.join(", ") : "(nesne sınıfı bulunamadı)";
    return `Görsel ${index + 1} (${item.file})\nOCR metni:\n${text}\nYerel sınıflandırma: ${labels}\nOrtalama renk: ${item.averageColor || "bilinmiyor"}${item.error ? `\nTanılama: ${item.error}` : ""}`;
  }).join("\n\n");
}
