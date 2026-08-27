import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const PROVIDER_CAPABILITIES = {
  // Girdi türleri ortak ön-işleme katmanından geçirilir; üretim ve araç
  // yetenekleri sağlayıcının native CLI/MCP/skill motorunda çalışır.
  codex: { image:true, pdf:true, document:true, spreadsheet:true, archive:true, text:true, file:true, audio:true, video:true, imageGenerate:true, web:true, browser:true, terminal:true, mcp:true, skills:true, subagents:true, automation:true },
  claude: { image:true, pdf:true, document:true, spreadsheet:true, archive:true, text:true, file:true, audio:true, video:true, imageGenerate:true, web:true, browser:true, terminal:true, mcp:true, skills:true, subagents:true, automation:true },
  antigravity: { image:true, pdf:true, document:true, spreadsheet:true, archive:true, text:true, file:true, audio:true, video:true, imageGenerate:true, web:true, browser:true, terminal:true, mcp:true, skills:true, subagents:true, automation:true },
  openrouter: { image:true, pdf:false, document:false, spreadsheet:false, archive:false, text:true, file:false, audio:false, video:true, imageGenerate:false, web:false, browser:false, terminal:false, mcp:false, skills:false, subagents:false, automation:false },
};
export function unsupportedAttachments(provider, list) {
  const caps = PROVIDER_CAPABILITIES[provider] || {};
  return (list || []).filter((a) => !caps[a.kind]);
}

const MIME_BY_EXT = {
  ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".gif":"image/gif", ".webp":"image/webp", ".avif":"image/avif", ".heic":"image/heic", ".svg":"image/svg+xml",
  ".pdf":"application/pdf", ".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".doc":"application/msword", ".rtf":"application/rtf", ".odt":"application/vnd.oasis.opendocument.text",
  ".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls":"application/vnd.ms-excel", ".ods":"application/vnd.oasis.opendocument.spreadsheet",
  ".pptx":"application/vnd.openxmlformats-officedocument.presentationml.presentation", ".ppt":"application/vnd.ms-powerpoint", ".odp":"application/vnd.oasis.opendocument.presentation",
  ".csv":"text/csv", ".tsv":"text/tab-separated-values", ".txt":"text/plain", ".md":"text/markdown", ".json":"application/json", ".xml":"application/xml", ".yaml":"text/yaml", ".yml":"text/yaml",
  ".js":"text/javascript", ".ts":"text/typescript", ".jsx":"text/jsx", ".tsx":"text/tsx", ".html":"text/html", ".css":"text/css", ".py":"text/x-python", ".sh":"text/x-shellscript",
  ".zip":"application/zip", ".tar":"application/x-tar", ".gz":"application/gzip", ".7z":"application/x-7z-compressed", ".rar":"application/vnd.rar", ".epub":"application/epub+zip",
  ".mp3":"audio/mpeg", ".wav":"audio/wav", ".m4a":"audio/mp4", ".aac":"audio/aac", ".ogg":"audio/ogg", ".flac":"audio/flac",
  ".mp4":"video/mp4", ".mov":"video/quicktime", ".webm":"video/webm",
};

export function detectMedia(buffer, name = "", declared = "") {
  const ext = path.extname(name).toLowerCase();
  let mime = MIME_BY_EXT[ext] || declared || "application/octet-stream";
  if (buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = "image/png";
  else if (buffer[0] === 0xff && buffer[1] === 0xd8) mime = "image/jpeg";
  else if (buffer.subarray(0,4).toString() === "%PDF") mime = "application/pdf";
  else if (buffer.subarray(0,4).toString("hex") === "504b0304") mime = MIME_BY_EXT[ext] || "application/zip";
  else if (buffer.subarray(0,6).toString().startsWith("GIF8")) mime = "image/gif";
  else if (buffer.subarray(0,4).toString() === "RIFF" && buffer.subarray(8,12).toString() === "WEBP") mime = "image/webp";
  const kind = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" :
    mime === "application/pdf" ? "pdf" : /wordprocessingml|msword|opendocument\.text|rtf/.test(mime) ? "document" : /spreadsheetml|ms-excel|opendocument\.spreadsheet|csv|tab-separated/.test(mime) ? "spreadsheet" :
    /presentationml|ms-powerpoint|opendocument\.presentation/.test(mime) ? "document" : /zip|x-tar|gzip|7z|rar|epub/.test(mime) ? "archive" : /^(text\/|application\/(json|xml))/.test(mime) ? "text" : "file";
  return { mime, kind, ext, size: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}

function cleanXml(s) {
  return String(s).replace(/<w:tab\/?\s*>/g, "\t").replace(/<w:br\/?\s*>/g, "\n").replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+\n/g, "\n").trim();
}

export async function extractMediaText(att) {
  const file = att.path;
  const max = 30000;
  try {
    if (att.kind === "file") {
      const sample = fs.readFileSync(file).subarray(0, max);
      const printable = [...sample].filter((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0xc2).length / Math.max(1, sample.length);
      return printable > 0.85 ? sample.toString("utf8") : `İkili dosya; içerik doğrudan dosya yolundan incelenmelidir. MIME: ${att.mime}`;
    }
    if (["text", "spreadsheet"].includes(att.kind) && !/xlsx/.test(att.mime)) return fs.readFileSync(file, "utf8").slice(0, max);
    if (att.kind === "document") {
      const { stdout } = await exec("unzip", ["-p", file, "word/document.xml"], { maxBuffer: 8e6 });
      return cleanXml(stdout).slice(0, max);
    }
    if (att.kind === "spreadsheet" && /xlsx/.test(att.mime)) {
      const { stdout } = await exec("unzip", ["-p", file, "xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"], { maxBuffer: 12e6 });
      return cleanXml(stdout).slice(0, max);
    }
    if (att.kind === "archive") {
      const { stdout:list } = await exec("unzip", ["-Z1", file], { maxBuffer: 2e6 });
      const names=list.split("\n").filter(Boolean).slice(0,200); let result="Arşiv dosyaları:\n"+names.join("\n");
      for (const name of names.filter((n)=>/\.(txt|md|json|ya?ml|csv|tsv|js|ts|jsx|tsx|py|html|css|xml|sh)$/i.test(n)).slice(0,20)) {
        try { const {stdout}=await exec("unzip",["-p",file,name],{maxBuffer:2e6}); result+=`\n\n--- ${name} ---\n${stdout.slice(0,5000)}`; } catch {}
      }
      return result.slice(0,max);
    }
    if (att.kind === "pdf") {
      const { stdout } = await exec("mdls", ["-raw", "-name", "kMDItemTextContent", file], { maxBuffer: 8e6 });
      return stdout && stdout !== "(null)" ? stdout.slice(0, max) : "PDF metni yerel indeks tarafından çıkarılamadı; görsel/PDF destekli ajana iletilmelidir.";
    }
    if (["audio", "video"].includes(att.kind)) {
      const { stdout } = await exec("mdls", ["-name", "kMDItemDurationSeconds", "-name", "kMDItemCodecs", file], { maxBuffer: 1e6 });
      return `${att.kind === "audio" ? "Ses" : "Video"} metaverisi:\n${stdout}\nYerel transkripsiyon motoru yoksa içerik medya destekli ajana iletilmelidir.`;
    }
  } catch (e) { return `İçerik çıkarımı başarısız: ${String(e.message || e).slice(0,300)}`; }
  return "";
}

export async function enrichAttachments(list) {
  return Promise.all((list || []).map(async (a) => ({ ...a, extractedText: a.extractedText || await extractMediaText(a) })));
}

// Ekler NUMARALANIR: kullanici "2. gorsel" diyerek atif yapabilmeli
// (kullanici istegi: "sistem gonderdigim gorselin kacinci gorsel oldugunu
// bilsin"). Gorseller kendi icinde ayri sayilir — "3. gorsel" derken
// aradaki PDF'i saymaz. Genel sira da ayrica verilir.
export function attachmentPrompt(list) {
  if (!list?.length) return "";
  let gorselNo = 0;
  const satirlar = (list || []).map((a, i) => {
    const gorselMi = a.kind === "image" || /^image\//.test(String(a.mime || ""));
    const etiket = gorselMi ? `${++gorselNo}. görsel` : `${i + 1}. dosya`;
    return `- [${etiket}] ${a.name} | tür=${a.kind}/${a.mime} | boyut=${a.size} | yol=${a.path}`
      + (a.extractedText ? `\n  Çıkarılan içerik:\n${a.extractedText.slice(0, 12000)}` : "");
  });
  const not = gorselNo > 1
    ? `\nKullanıcı "1. görsel", "2. görsel" diye atıf yapabilir; yukarıdaki sıra geçerlidir (toplam ${gorselNo} görsel).`
    : "";
  return "\n\n--- EK DOSYALAR ---\n" + satirlar.join("\n") + not;
}

// Uretilen dosyanin KANONIK yeri bagli projenin icidir: kullanicinin
// "YaSel guncellemesi" gibi bir ciktisi Ajan Konseyi'nin uploads deposunda
// degil, guncellenen projenin kendi klasorunde (cikti/) yasamalidir.
// uploads kopyasi yalniz arayuz onizleme/indirme SUNUMU icin tutulur.
export function collectGeneratedAssets(content, rootDir, projectDir = null) {
  const out = [], seen = new Set();
  const text = String(content || "");
  const matches = text.match(/\/?(?:Users|private|tmp)\/[\w\-./ ]+\.(?:png|jpe?g|webp|gif|avif|svg|pdf|docx?|xlsx?|csv|txt|md|html?|mp3|wav|m4a|aac|ogg|mp4|mov|webm|zip)/gi) || [];
  const uploadDir = path.join(rootDir, "uploads"); fs.mkdirSync(uploadDir, { recursive:true });
  for (const raw of matches.slice(0,8)) {
    const source = path.resolve(raw.trim()); if (seen.has(source) || !fs.existsSync(source)) continue; seen.add(source);
    try {
      const data=fs.readFileSync(source); const meta=detectMedia(data,path.basename(source));
      const name=`generated-${Date.now().toString(36)}-${path.basename(source)}`;
      const dest=path.join(uploadDir,name); fs.copyFileSync(source,dest);
      // Projesiz sohbette kanonik yer uploads kopyasidir (kaynak /tmp gibi
      // ucucu bir yerde olabilir); proje bagliysa kanonik yer projedir.
      let canonical = dest;
      if (projectDir && fs.existsSync(projectDir)) {
        const resolvedProject = path.resolve(projectDir) + path.sep;
        if (source.startsWith(resolvedProject)) {
          canonical = source; // zaten projenin icinde; kopyalama
        } else {
          const outDir = path.join(projectDir, "cikti");
          fs.mkdirSync(outDir, { recursive:true });
          canonical = path.join(outDir, path.basename(source));
          fs.copyFileSync(source, canonical);
        }
      }
      out.push({path:canonical,url:"/uploads/"+name,name:path.basename(source),...meta,generated:true});
    } catch {}
  }
  // Ajan bazen dosya yazmak yerine SVG'yi Markdown kod bloğu olarak döndürür.
  // Güvenli bir SVG dosyasına dönüştürerek gerçek çıktı/önizleme haline getir.
  const svgBlocks = [...text.matchAll(/```(?:svg|xml)\s*\n([\s\S]*?<svg\b[\s\S]*?<\/svg>)\s*```/gi)].slice(0,4);
  for (const [index, match] of svgBlocks.entries()) {
    let svg = match[1]
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "")
      .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
      .replace(/\s(?:href|xlink:href)\s*=\s*["'](?:https?:|javascript:)[^"']*["']/gi, "");
    const name = `tasarlanan-gorsel-${Date.now().toString(36)}${index ? `-${index + 1}` : ""}.svg`;
    const dest = path.join(uploadDir, name); fs.writeFileSync(dest, svg, "utf8");
    const data = fs.readFileSync(dest); out.push({ path:dest, url:"/uploads/"+name, name, ...detectMedia(data,name,"image/svg+xml"), generated:true, inlineSource:"svg" });
  }
  return out;
}
