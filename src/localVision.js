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
  // Electron'un asar sanal dosya sistemi fs.existsSync için dosya varmış gibi
  // davranabilir. Swift derleyicisi ise arşiv içindeki yolu açamaz. Bu nedenle
  // yalnız gerçek dosya sistemindeki betikleri kabul et.
  return candidates.find((candidate) =>
    !candidate.includes(`${path.sep}app.asar${path.sep}`) &&
    fs.existsSync(candidate) && fs.statSync(candidate).isFile()
  ) || null;
}

export async function analyzeImagesLocally(files, rootDir) {
  const paths = (files || []).filter(Boolean);
  if (!paths.length) return "";
  const script = resolveVisionScript();
  if (!script) throw new Error("Görsel analiz betiği uygulama kaynaklarında bulunamadı");
  const env = { ...process.env };
  // Electron veya bir geliştirici kabuğundan kalmış SDK değişkenleri xcrun'un
  // artık mevcut olmayan sabit bir SDK sürümünü seçmesine yol açmasın.
  delete env.SDKROOT;
  delete env.DEVELOPER_DIR;
  delete env.TOOLCHAINS;
  const { stdout } = await exec("xcrun", ["swift", "-module-cache-path", "/tmp/ajan-swift-module-cache", script, ...paths], {
    env, maxBuffer: 12 * 1024 * 1024, timeout: 120_000,
  });
  const results = JSON.parse(stdout || "[]");
  return results.map((item, index) => {
    const text = item.text?.length ? item.text.join("\n") : "(okunabilir metin bulunamadı)";
    const labels = item.labels?.length ? item.labels.join(", ") : "(nesne sınıfı bulunamadı)";
    return `Görsel ${index + 1} (${item.file})\nOCR metni:\n${text}\nYerel sınıflandırma: ${labels}\nOrtalama renk: ${item.averageColor || "bilinmiyor"}${item.error ? `\nTanılama: ${item.error}` : ""}`;
  }).join("\n\n");
}
