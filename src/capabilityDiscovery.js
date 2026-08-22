import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROVIDER_CAPABILITIES } from "./media.js";
import { connectorCatalog } from "./connectorBridge.js";

const exec = promisify(execFile);
let cache = null, cacheAt = 0;

// Güvenli canlı testlerle doğrulanan durumlar. `shared`, sağlayıcının bunu
// Ajan Konseyi ortak motoru üzerinden kullanabildiği fakat native aracının
// bulunmadığı anlamına gelir. Böylece dosyayı kabul etmek ile gerçekten
// işleyebilmek/üretebilmek aynı yeşil rozet altında gizlenmez.
const AUDITED = {
  claude:{text:"working",context:"working",files:"working",terminal:"working",web:"working",browser:"missing",imageRead:"working",imageGenerate:"shared",imageEdit:"shared",pdf:"working",document:"working",spreadsheet:"partial",presentation:"missing",audioTranscription:"missing",videoAnalysis:"missing",videoGenerate:"missing",mcp:"configured-none",skills:"working",plugins:"configured-none",subagents:"working",automation:"working",git:"working",github:"account-required",computerControl:"partial",resume:"working"},
  codex:{text:"working",context:"working",files:"working",terminal:"working",web:"working",browser:"needs-session",imageRead:"working",imageGenerate:"working",imageEdit:"working",pdf:"working",document:"working",spreadsheet:"working",presentation:"working",audioTranscription:"missing",videoAnalysis:"partial",videoGenerate:"missing",mcp:"working",skills:"working",plugins:"partial",subagents:"working",automation:"missing",git:"working",github:"account-required",computerControl:"disabled",resume:"working"},
  antigravity:{text:"working",context:"working",files:"working",terminal:"working",web:"working",browser:"needs-session",imageRead:"working",imageGenerate:"working",imageEdit:"working",pdf:"working",document:"partial",spreadsheet:"partial",presentation:"partial",audioTranscription:"partial",videoAnalysis:"partial",videoGenerate:"missing",mcp:"configured-none",skills:"working",plugins:"configured-none",subagents:"working",automation:"working",git:"working",github:"account-required",computerControl:"missing",resume:"working"},
};

async function run(bin, args) {
  try {
    const r=await exec(bin,args,{timeout:15000,maxBuffer:2*1024*1024});
    return ((r.stdout||"")+(r.stderr||"")).trim();
  } catch(e) { return ((e.stdout||"")+(e.stderr||e.message||"")).trim(); }
}
function lines(text) { return String(text).split("\n").map((x)=>x.trim()).filter(Boolean); }
function pluginLines(text) { return lines(text).filter((x)=>/installed,\s*enabled|enabled/i.test(x)&&!/^marketplace/i.test(x)); }
function mcpLines(text) { return lines(text).filter((x)=>!/(no mcp|none configured|checking mcp)/i.test(x)); }

export async function discoverCapabilities(force=false) {
  if(!force&&cache&&Date.now()-cacheAt<60_000) return cache;
  const [claudeVersion,codexVersion,agyVersion,claudeMcp,codexMcp,agyMcp,claudePlugins,codexPlugins,agyPlugins,agyAgents] = await Promise.all([
    run("claude",["--version"]),run("codex",["--version"]),run("agy",["--version"]),
    run("claude",["mcp","list"]),run("codex",["mcp","list"]),run("agy",["mcp","list"]),
    run("claude",["plugins","list"]),run("codex",["plugin","list"]),run("agy",["plugin","list"]),run("agy",["agent"]),
  ]);
  cache={
    generatedAt:new Date().toISOString(),
    connectors:connectorCatalog(),
    providers:{
      claude:{version:lines(claudeVersion)[0]||"bilinmiyor",native:AUDITED.claude,input:PROVIDER_CAPABILITIES.claude,mcp:mcpLines(claudeMcp),plugins:pluginLines(claudePlugins)},
      codex:{version:lines(codexVersion)[0]||"bilinmiyor",native:AUDITED.codex,input:PROVIDER_CAPABILITIES.codex,mcp:mcpLines(codexMcp),plugins:pluginLines(codexPlugins)},
      antigravity:{version:lines(agyVersion)[0]||"bilinmiyor",native:AUDITED.antigravity,input:PROVIDER_CAPABILITIES.antigravity,mcp:mcpLines(agyMcp),plugins:pluginLines(agyPlugins),agents:lines(agyAgents)},
    },
    shared:[
      "Kalıcı sohbet bağlamı ve sağlayıcı değiştirme","Kalıcı proje terminali","Dosya/görsel/PDF/belge/tablo/arşiv aktarımı",
      "Ses ve video dosyası aktarımı","Yerel görsel OCR","Web araştırması ve kaynak bağlantıları","Gömülü tarayıcı",
      "Görsel ve dosya üretim çıktılarının önizlenmesi","Git worktree, diff, inceleme ve bütünleştirme",
      "MCP, eklenti, skill ve alt ajan motorları","Arka planda otomatik izin değerlendirmesi"
    ],
  }; cacheAt=Date.now(); return cache;
}
