#!/usr/bin/env node
// Ajan Konseyi MCP sunucusu.
//
// Konseyi disariya acar: Claude Code, Codex ve diger MCP istemcileri
// konsey turlarini, uye sorgularini ve cok saglayicili incelemeyi arac
// olarak cagirabilir.
//
// Bu surec bilerek INCE bir koprüdur. Kendi Orchestrator'ini kurmaz; cunku
// oturum anahtarlari, config.json ve runs/ calisan uygulamanin icinde yasar
// ve ikinci bir orkestratör ayni dosyalar uzerinde catisirdi. Butun is
// 127.0.0.1'deki mevcut sunucuya devredilir.
//
// Tasima: stdio uzerinden JSON-RPC 2.0 (MCP stdio transport). Bagimlilik yok.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "ajan-konseyi", version: "0.3.0" };

// Konsey turlari dakikalarca surer; MCP istemcilerinin arac zaman asimi
// kisadir. Bu yuzden uzun isler runId dondurur ve `kosu_durumu` ile yoklanir.
const KISA_BEKLEME_MS = 20_000;

// ---------------------------------------------------------------- uc nokta

function dataRoot() {
  if (process.env.AJAN_KONSEYI_DATA_DIR) return path.resolve(process.env.AJAN_KONSEYI_DATA_DIR);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Ajan Konseyi");
  return path.join(os.homedir(), ".ajan-konseyi");
}

function readEndpoint() {
  const file = path.join(dataRoot(), "mcp-endpoint.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Number.isFinite(Number(raw.port))) return { port: Number(raw.port), token: raw.token || null };
  } catch { /* dosya yoksa varsayilan porta duseriz */ }
  return { port: Number(process.env.AJAN_PORT) || 4780, token: process.env.AJAN_UI_TOKEN || null };
}

async function api(method, route, body) {
  const { port, token } = readEndpoint();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["x-ajan-ui-token"] = token;
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Ajan Konseyi uygulamasina baglanilamadi. Uygulamanin acik oldugundan emin olun.");
  }
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!response.ok) throw new Error(parsed?.error || `Ajan Konseyi hatasi (${response.status})`);
  return parsed;
}

// ------------------------------------------------------------------ yardim

const truncate = (text, max) => {
  const value = String(text ?? "");
  return value.length > max ? value.slice(0, max) + `\n…(${value.length - max} karakter kisaltildi)` : value;
};

// Uye ve proje listesi icin hafif uc kullanilir; arka arkaya arac
// cagrilarinda ayrica kisa sure onbeleklenir.
let configCache = { at: 0, value: null };
async function appConfig() {
  if (configCache.value && Date.now() - configCache.at < 5_000) return configCache.value;
  const value = await api("GET", "/api/mcp/info") || {};
  configCache = { at: Date.now(), value };
  return value;
}

async function members() {
  const config = await appConfig();
  // /api/mcp/info zaten yalniz etkin uyeleri dondurur.
  return config?.members || [];
}

async function resolveMember(nameOrId) {
  const list = await members();
  if (!list.length) throw new Error("Etkin uye yok.");
  if (!nameOrId) return list[0];
  const wanted = String(nameOrId).trim().toLocaleLowerCase("tr-TR");
  const found = list.find((m) => m.id.toLocaleLowerCase("tr-TR") === wanted)
    || list.find((m) => m.name.toLocaleLowerCase("tr-TR") === wanted)
    || list.find((m) => m.provider.toLocaleLowerCase("tr-TR") === wanted)
    || list.find((m) => m.name.toLocaleLowerCase("tr-TR").includes(wanted));
  if (!found) throw new Error(`Uye bulunamadi: ${nameOrId}. Etkin uyeler: ${list.map((m) => m.name).join(", ")}`);
  return found;
}

async function resolveProject(nameOrId) {
  if (!nameOrId) return null;
  const config = await appConfig();
  const list = config?.projects || [];
  const wanted = String(nameOrId).trim().toLocaleLowerCase("tr-TR");
  const found = list.find((p) => p.id === nameOrId)
    || list.find((p) => String(p.name || "").toLocaleLowerCase("tr-TR") === wanted)
    || list.find((p) => String(p.path || "").toLocaleLowerCase("tr-TR") === wanted);
  if (!found) throw new Error(`Proje bulunamadi: ${nameOrId}. Kayitli projeler: ${list.map((p) => p.name).join(", ") || "yok"}`);
  return found;
}

// Yeni mesaj gelene kadar kisa sure bekler. Sure dolarsa runId dondurulur ve
// cagiran `kosu_durumu` ile devam eder; boylece istemci zaman asimina ugramaz.
async function waitForReply(runId, sinceCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const run = await api("GET", `/api/runs/${runId}`);
    const messages = run?.messages || [];
    const fresh = messages.slice(sinceCount).filter((m) => m.from !== "kullanici");
    const answer = fresh.filter((m) => m.kind === "message" || m.kind === "result").at(-1);
    if (answer) return { done: true, text: answer.content, from: answer.fromLabel || answer.from, run };
    const failure = fresh.find((m) => m.kind === "error");
    if (failure) return { done: true, text: failure.content, from: "sistem", failed: true, run };
    if (run && run.status !== "running" && !run.turnActive && !run.directActive && fresh.length) {
      return { done: true, text: fresh.at(-1).content, from: fresh.at(-1).fromLabel || "sistem", run };
    }
  }
  return { done: false };
}

// ------------------------------------------------------------------ araclar

const TOOLS = [
  {
    name: "uye_sor",
    description: "Ajan Konseyi'ndeki tek bir uyeye (Claude, Codex, Antigravity, Ox Alpha) dogrudan soru sorar. Ikinci gorus almak veya belirli bir saglayicinin bakisini ogrenmek icin kullanilir.",
    inputSchema: {
      type: "object",
      properties: {
        uye: { type: "string", description: "Uye adi, kimligi veya saglayicisi. Ornek: Codex, Antigravity, Ox Alpha." },
        soru: { type: "string", description: "Uyeye sorulacak soru veya verilecek gorev." },
        proje: { type: "string", description: "Istege bagli: kayitli proje adi. Verilirse uye o projenin kod tabanini gorur." },
      },
      required: ["uye", "soru"],
    },
  },
  {
    name: "konsey_sor",
    description: "Tam konsey turu baslatir: gorev dagitimi, uyelerin paralel calismasi, puanli inceleme, celiskide tartisma ve oylama, kanit kapisi. Dakikalar surebilir; hemen runId doner, sonuc kosu_durumu ile alinir.",
    inputSchema: {
      type: "object",
      properties: {
        istek: { type: "string", description: "Konseye verilecek gorev veya soru." },
        proje: { type: "string", description: "Istege bagli: kayitli proje adi." },
        mod: { type: "string", enum: ["auto", "discussion", "split", "code"], description: "auto (varsayilan), discussion (tartisma), split (isbolumu), code (kod yazma)." },
      },
      required: ["istek"],
    },
  },
  {
    name: "konsey_incele",
    description: "Verilen kodu, diff'i veya dosya yolunu birden fazla saglayiciya bagimsiz inceletir ve celiskileri ortaya cikarir. Tek modelin kacirdigi hatalari yakalamak icin kullanilir.",
    inputSchema: {
      type: "object",
      properties: {
        icerik: { type: "string", description: "Incelenecek diff, kod parcasi veya aciklama." },
        odak: { type: "string", description: "Istege bagli: inceleme odagi. Ornek: guvenlik, performans, dogruluk." },
        proje: { type: "string", description: "Istege bagli: kayitli proje adi." },
      },
      required: ["icerik"],
    },
  },
  {
    name: "kosu_durumu",
    description: "Baslatilmis bir konsey turunun durumunu ve o ana kadarki sonuclarini dondurur. konsey_sor veya konsey_incele sonrasi yoklamak icin kullanilir.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "konsey_sor veya konsey_incele tarafindan dondurulen kosu kimligi." },
        son: { type: "number", description: "Dondurulecek son mesaj sayisi (varsayilan 6)." },
      },
      required: ["runId"],
    },
  },
  {
    name: "konsey_bilgi",
    description: "Ajan Konseyi'nin etkin uyelerini, saglayicilarini ve kayitli projelerini listeler.",
    inputSchema: { type: "object", properties: {} },
  },
];

const HANDLERS = {
  async konsey_bilgi() {
    const config = await appConfig();
    const uyeler = (config?.members || [])
      .map((m) => `- ${m.name} (${m.provider}${m.model ? `, ${m.model}` : ""}${m.role ? `, ${m.role}` : ""})`);
    const projeler = (config?.projects || []).map((p) => `- ${p.name} → ${p.path}`);
    return `## Etkin uyeler\n${uyeler.join("\n") || "- yok"}\n\n## Kayitli projeler\n${projeler.join("\n") || "- yok"}`;
  },

  async uye_sor({ uye, soru, proje }) {
    if (!String(soru || "").trim()) throw new Error("soru bos olamaz");
    const member = await resolveMember(uye);
    const project = await resolveProject(proje);
    const started = await api("POST", "/api/direct-chat", {
      to: member.id, text: String(soru), projectId: project?.id || null,
    });
    const runId = started?.runId;
    if (!runId) throw new Error("Kosu baslatilamadi");
    const result = await waitForReply(runId, 1, KISA_BEKLEME_MS);
    if (!result.done) {
      return `${member.name} hala calisiyor. Sonucu almak icin kosu_durumu aracini bu kimlikle cagirin:\n\nrunId: ${runId}`;
    }
    return `**${result.from}**${result.failed ? " (hata)" : ""}:\n\n${truncate(result.text, 60_000)}\n\n_runId: ${runId}_`;
  },

  async konsey_sor({ istek, proje, mod }) {
    if (!String(istek || "").trim()) throw new Error("istek bos olamaz");
    const project = await resolveProject(proje);
    const started = await api("POST", "/api/chat", {
      text: String(istek),
      mode: ["auto", "discussion", "split", "code"].includes(mod) ? mod : "auto",
      projectId: project?.id || null,
    });
    const runId = started?.runId;
    if (!runId) throw new Error("Konsey turu baslatilamadi");
    return [
      `Konsey turu basladi.`,
      ``,
      `runId: ${runId}`,
      ``,
      `Konsey turu dakikalar surer. Sonucu almak icin kosu_durumu aracini bu runId ile cagirin.`,
    ].join("\n");
  },

  async konsey_incele({ icerik, odak, proje }) {
    if (!String(icerik || "").trim()) throw new Error("icerik bos olamaz");
    const project = await resolveProject(proje);
    const istek = [
      `Asagidaki degisikligi inceleyin. Her uye BAGIMSIZ inceleme yapsin;`,
      `bulgu yoksa "bulgu yok" deyin, uydurma bulgu uretmeyin.`,
      odak ? `Inceleme odagi: ${odak}.` : `Odak: dogruluk, guvenlik ve gozden kacan kenar durumlari.`,
      `Her bulgu icin dosya ve satir verin; iddiayi kod tabaninda dogrulayin.`,
      ``,
      `--- INCELENECEK ICERIK ---`,
      String(icerik),
      `--- ICERIK SONU ---`,
    ].join("\n");
    const started = await api("POST", "/api/chat", { text: istek, mode: "discussion", projectId: project?.id || null });
    const runId = started?.runId;
    if (!runId) throw new Error("Inceleme baslatilamadi");
    return `Cok saglayicili inceleme basladi.\n\nrunId: ${runId}\n\nSonucu almak icin kosu_durumu aracini bu runId ile cagirin.`;
  },

  async kosu_durumu({ runId, son }) {
    if (!String(runId || "").trim()) throw new Error("runId bos olamaz");
    const run = await api("GET", `/api/runs/${String(runId)}`);
    const count = Math.min(Math.max(Number(son) || 6, 1), 40);
    const messages = (run?.messages || []).slice(-count);
    const aktif = run?.turnActive || run?.directActive || run?.status === "running";
    const head = `Durum: ${aktif ? "calisiyor" : (run?.status || "bilinmiyor")} · asama: ${run?.phase || "-"} · toplam mesaj: ${(run?.messages || []).length}`;
    const body = messages.map((m) => {
      const who = m.from === "kullanici" ? "Kullanici" : (m.fromLabel || m.from || "Sistem");
      return `### ${who} (${m.kind})\n${truncate(m.content, 12_000)}`;
    }).join("\n\n");
    return `${head}\n\n${body || "_Henuz mesaj yok._"}`;
  },
};

// -------------------------------------------------------------- JSON-RPC

// Cikti kancasi: varsayilanda stdio tasimasina yazar. Testler kendi
// toplayicisini takar; process.stdout taklit edilirse test raporlayicisinin
// ciktisi da yutulur.
let output = (message) => process.stdout.write(JSON.stringify(message) + "\n");
function setOutput(fn) { output = fn; }
function send(message) { output(message); }
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(request) {
  const { id, method, params } = request;
  // Bildirimlerin (id yok) yaniti olmaz.
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: "Ajan Konseyi: Claude, Codex, Antigravity ve OpenRouter uyelerini tek konseyde calistirir. Ikinci gorus icin uye_sor, cok saglayicili inceleme icin konsey_incele, tam tur icin konsey_sor kullanin. Uzun isler runId dondurur; kosu_durumu ile yoklayin.",
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") return isNotification ? undefined : reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "resources/list") return reply(id, { resources: [] });
  if (method === "prompts/list") return reply(id, { prompts: [] });

  if (method === "tools/call") {
    const handler = HANDLERS[params?.name];
    if (!handler) return fail(id, -32602, `Bilinmeyen arac: ${params?.name}`);
    try {
      const text = await handler(params?.arguments || {});
      return reply(id, { content: [{ type: "text", text: String(text) }] });
    } catch (error) {
      // Arac hatasi protokol hatasi degildir: isError ile dondurulur ki
      // istemci modele gosterip duzeltme sansi versin.
      return reply(id, { content: [{ type: "text", text: `Hata: ${error.message}` }], isError: true });
    }
  }

  if (!isNotification) fail(id, -32601, `Desteklenmeyen metot: ${method}`);
}

// Testten import edildiginde stdin dinlenmemeli; yalnizca dogrudan
// calistirildiginda MCP tasimasi baglanir.
function serve() {
// Ucusta olan arac cagrilari stdin kapandiginda dusmemeli; aksi halde
// istemci yanit alamadan koprü olur.
const pending = new Set();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let request;
    try { request = JSON.parse(line); }
    catch { fail(null, -32700, "Gecersiz JSON"); continue; }
    const work = Promise.resolve(handle(request)).catch((error) => {
      if (request?.id !== undefined && request?.id !== null) fail(request.id, -32603, String(error?.message || error));
    });
    pending.add(work);
    work.finally(() => pending.delete(work));
  }
});
process.stdin.on("end", async () => {
  while (pending.size) await Promise.allSettled([...pending]);
  process.exit(0);
});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();

export { TOOLS, HANDLERS, handle, readEndpoint, resolveMember, serve, setOutput };
