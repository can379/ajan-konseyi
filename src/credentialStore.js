import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SERVICE = "com.selim.ajankonseyi.openrouter";
const ACCOUNT = "openrouter-api-key";
const LEGACY_SERVICES = ["Ajan Konseyi OpenRouter", "ajan-konseyi-openrouter", "com.ajankonseyi.openrouter"];

async function keychainRead(service) {
  try {
    const { stdout } = await exec("security", ["find-generic-password", "-s", service, "-a", ACCOUNT, "-w"], { timeout: 5000 });
    return stdout.trim();
  } catch { return ""; }
}

export async function readOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  if (process.platform !== "darwin") return "";
  const current = await keychainRead(SERVICE);
  if (current) return current;
  for (const legacy of LEGACY_SERVICES) {
    const key = await keychainRead(legacy);
    if (!key) continue;
    await saveOpenRouterKey(key).catch(() => {});
    return key;
  }
  return "";
}

export async function saveOpenRouterKey(value) {
  const key = String(value || "").trim();
  if (!key) throw new Error("OpenRouter API anahtarı boş olamaz");
  if (process.platform !== "darwin") throw new Error("Güvenli anahtar saklama şu anda macOS gerektiriyor");
  await exec("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", key], { timeout: 5000 });
  const stored = await keychainRead(SERVICE);
  if (stored !== key) throw new Error("API anahtarı macOS Anahtar Zinciri'ne kalıcı olarak yazılamadı");
}

export async function deleteOpenRouterKey() {
  if (process.platform !== "darwin") return;
  try { await exec("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT], { timeout: 5000 }); } catch {}
}

export async function openRouterStatus() {
  const key = await readOpenRouterKey();
  return { configured: !!key, provider: "openrouter", model: "stealth/ox-alpha", storage: "macOS Keychain", reason:key?null:"keychain-item-missing" };
}
