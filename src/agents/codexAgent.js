import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BaseAgent } from "./base.js";
import { cleanEnv, uid } from "../util.js";
import { promisify } from "node:util";
import { CODEX_EFFORT } from "../models.js";
import { kindForTool, stepFromCommand } from "../steps.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
// Cagri CALISIYORSA surekli JSON olayi akar; 4 dakika hic satir gelmiyorsa
// takilmistir. Toplam siniri beklemek bos gecen dakikalar demek (olculdu).
const SESSIZLIK_MS = 4 * 60 * 1000;
const run = promisify(execFile);

// Codex'in workspace-write kum havuzu ".git" altina yazmayi varsayilan olarak
// reddeder; bu, "git apply", "git commit", "git checkout" gibi her islemi
// "Operation not permitted" ile dusurur. Ilgili dizinler writable_roots'a
// acikca eklendiginde izin verilir.
//
// Ayri calisma kopyalarinda (worktree) ".git" bir DOSYADIR ve ana deponun
// ".git/worktrees/<ad>" dizinini gosterir; bu yuzden hem git dizini hem de
// ortak git dizini eklenir.
const gitRootCache = new Map();
async function gitWritableRoots(cwd) {
  if (!cwd) return [];
  if (gitRootCache.has(cwd)) return gitRootCache.get(cwd);
  let roots = [];
  try {
    const { stdout } = await run("git", ["-C", cwd, "rev-parse", "--git-dir", "--git-common-dir"]);
    roots = stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean)
      .map((dir) => path.resolve(cwd, dir))
      .filter((dir) => fs.existsSync(dir));
    roots = [...new Set(roots)];
  } catch {
    // Git deposu degilse yazilabilir kok eklenmez; dosya yazimi zaten calisir.
    roots = [];
  }
  gitRootCache.set(cwd, roots);
  return roots;
}

// OpenAI Codex CLI adaptörü.
// ChatGPT abonelik girişi ile "codex exec --json" çağırır;
// ana oturum sürekliliği "codex exec resume <thread_id>" ile sağlanır.
// opts.fresh doğruysa taze oturum açar (paralel işçi kopyalar için).
export class CodexAgent extends BaseAgent {
  constructor(store, rootDir, opts = {}) {
    super("codex", store, rootDir);
    this.bin = opts.bin || "codex";
  }

  async invoke(prompt, opts = {}) {
    try {
      return await this._invoke(prompt, opts);
    } catch (err) {
      const message = String(err?.message || err);
      // Kullanıcı durdurduysa ASLA yeniden deneme
      if (opts.shouldStop?.()) throw err;
      // Süre sınırına ulaşan işi farklı model ayarlarıyla baştan çalıştırmak
      // gerçek sınırı katlayıp arayüzü takılmış gibi bırakır.
      if (/zaman aşım/i.test(message)) throw err;
      // Seçili model/çaba tanınmıyorsa varsayılan ayarlarla bir kez dene
      const model = opts.model ?? this.getModel?.();
      const effort = opts.effort ?? this.getEffort?.();
      if ((model || effort) && !opts._noModelRetry) {
        this.log(`model/çaba (${model}/${effort}) ile hata: ${err.message}; varsayılanlarla yeniden deneniyor`);
        return this._invoke(prompt, { ...opts, model: "", effort: "", _noModelRetry: true });
      }
      throw err;
    }
  }

  async _invoke(prompt, opts = {}) {
    const lastMsgFile = path.join(this.rootDir, "runs", `codex-last-${uid()}.txt`);
    const model = opts.model ?? this.getModel?.();
    // Yerleşik web araması ve otomatik güvenlik incelemesi; kullanıcının mevcut
    // Codex MCP, eklenti ve skill yapılandırması aynen yüklenmeye devam eder.
    const common = ["--json", "--skip-git-repo-check", "-o", lastMsgFile];
    // Kum havuzunun yazilabilir kokleri: calisma dizini ve deposunun git
    // dizinleri. Boylece ajan hem dosya yazabilir hem git islemi yapabilir.
    if (opts.cwd) {
      const roots = [opts.cwd, ...(await gitWritableRoots(opts.cwd))];
      common.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`);
    }
    if (model) common.push("-m", model);
    const effort = opts.effort ?? this.getEffort?.();
    if (effort && CODEX_EFFORT[effort]) {
      common.push("-c", `model_reasoning_effort="${CODEX_EFFORT[effort]}"`);
    }
    for (const img of opts.images || []) {
      common.push("-i", img);
    }

    // TAM YETKİ (kullanıcı kararı: "hepsi tam yetki olsun"). Önceki kurulum
    // taze oturumda --approve-for-me, devam oturumunda on-request onay
    // kullanıyordu; ikisi de komutu otomatik incelemeye sokuyor ve inceleme
    // reddedince üye "komut izni verilmedi" diye takılıyordu. Üye başsız
    // çalışır — onay penceresine düşen her şey kayıptır. Claude ve
    // Antigravity ile aynı düzeye çekildi; güvenlik çizgisi izin penceresi
    // değil, kapasite sözleşmesi + operasyon kapılarıdır (faz, onay, mühür).
    // Bayrağı "exec" hem de "exec resume" kabul ediyor (yardım çıktısıyla
    // doğrulandı); -C'yi yalnız taze oturum alır, resume dizini oturumda kalır.
    const YETKI = "--dangerously-bypass-approvals-and-sandbox";
    const freshArgs = ["--search", "exec", YETKI, ...common];
    if (opts.cwd) freshArgs.push("-C", opts.cwd);

    const sess = opts.fresh ? null : this.getSession(opts);
    const useResume = !!sess;
    let args = useResume
      ? ["--search", "exec", "resume", YETKI, ...common, sess]
      : freshArgs;

    // Canlı akış: olaylar geldikçe kısmi çıktıyı yayınla
    let live = "", text = "", usage = null;
    const steps = opts.steps || null;
    const onLine = (line) => {
      if (!line.startsWith("{")) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === "thread.started" && ev.thread_id && !opts.fresh) {
        this.setSession(opts, ev.thread_id);
      } else if (ev.type === "item.started" && ev.item?.type === "reasoning") {
        steps?.open("dusunme", "dusundu", "Akıl yürütüyor");
      } else if (ev.type === "item.completed" && ev.item) {
        if (ev.item.type === "agent_message") {
          steps?.close("dusunme", { title: "Akıl yürüttü" });
          text = ev.item.text || text;
          live += (live ? "\n" : "") + (ev.item.text || "");
        } else if (ev.item.type === "command_execution") {
          {
            // Ham komut basliga cikmaz: anlamina gore insan cumlesi olur,
            // ham komut + cikti detayda saklanir (tiklayinca gorunur).
            const insan = stepFromCommand(ev.item.command || "komut");
            steps?.add(insan.kind, insan.title,
              `$ ${ev.item.command || ""}
${String(ev.item.aggregated_output || ev.item.output || "")}`,
              { status: Number(ev.item.exit_code) ? "failed" : "ok" });
          }
        } else if (ev.item.type === "file_change") {
          for (const change of ev.item.changes || [{ path: ev.item.path }]) {
            steps?.add("yazdi", change?.path || "dosya", String(change?.kind || ""));
          }
        } else if (ev.item.type === "web_search") {
          steps?.add("aradi", ev.item.query || "web araması");
        } else if (ev.item.type === "mcp_tool_call") {
          steps?.add(kindForTool(ev.item.tool || ev.item.server), ev.item.tool || "araç",
            "", { status: ev.item.status === "failed" ? "failed" : "ok" });
        } else if (ev.item.type === "reasoning" && ev.item.text) {
          // Ham akil yurutme metni ne akan metne ne adim detayina girer.
          steps?.close("dusunme", { title: "Akıl yürüttü" });
        }
        if (!opts.silent) this.progress(opts.label || "", live, opts.memberId);
      } else if (ev.type === "turn.completed" && ev.usage) {
        usage = ev.usage;
      }
    };

    let result = await this.spawnCollect(this.bin, args, prompt, opts.timeoutMs, onLine, opts.sessionKey, opts.cwd);
    if (result.timedOut) throw new Error("Codex çağrısı zaman aşımına uğradı");

    // Resume başarısız olursa (oturum bulunamadı vb.) taze oturumla tekrar dene
    if (result.code !== 0 && useResume) {
      if (opts.shouldStop?.()) throw new Error("Durduruldu");
      this.log("codex resume başarısız, yeni oturum deneniyor");
      this.clearSession(opts);
      live = ""; text = "";
      result = await this.spawnCollect(this.bin, freshArgs, prompt, opts.timeoutMs, onLine, opts.sessionKey, opts.cwd);
      if (result.timedOut) throw new Error("Codex çağrısı zaman aşımına uğradı");
    }
    if (result.code !== 0) {
      throw new Error(`Codex hata ile çıktı (exit ${result.code}): ${(result.stderr || result.stdout).slice(0, 400)}`);
    }
    // -o dosyası en güvenilir son mesaj kaynağı
    try {
      const fromFile = fs.readFileSync(lastMsgFile, "utf8").trim();
      if (fromFile) text = fromFile;
      fs.unlinkSync(lastMsgFile);
    } catch {}

    if (!text) throw new Error("Codex yanıtı boş döndü");
    const normUsage = usage ? {
      input: usage.input_tokens || 0,
      cachedInput: usage.cached_input_tokens || 0,
      output: usage.output_tokens || 0,
      costUsd: 0,
    } : null;
    if (normUsage) (opts.onUsage || this.onUsage)?.(normUsage);
    return { ok: true, text, raw: { thread_id: this.getSession(opts), usage: normUsage } };
  }

  spawnCollect(bin, args, stdinText, timeoutMs = DEFAULT_TIMEOUT_MS, onLine = null, sessionKey = null, cwd = null) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        // Calisma dizini surec seviyesinde verilir. "-C" bayragi yalniz taze
        // oturumda gecerlidir; "exec resume" onu kabul etmez. Yalniz -C'ye
        // guvenilirse resume edilen her cagri sunucunun kendi dizinine duser
        // ve workspace-write sandbox'i projeye yazmayi engeller.
        cwd: cwd || this.rootDir,
        env: cleanEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      child._sessionKey = sessionKey || null;
      this.children.add(child);
      let stdout = "", stderr = "", timedOut = false, lineBuf = "";
      let forceKillTimer = null;
      const oldur = (sebep) => {
        timedOut = true; this.log?.(`codex ${sebep}`);
        try { child.kill("SIGTERM"); } catch {}
        forceKillTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 4_000);
      };
      const timer = setTimeout(() => oldur("toplam süre aşıldı"), timeoutMs);
      const sessizlikMs = Math.min(SESSIZLIK_MS, timeoutMs);
      let sessizlikTimer = setTimeout(() => oldur("yanıt akmıyor (sessizlik)"), sessizlikMs);
      const canlilik = () => {
        clearTimeout(sessizlikTimer);
        sessizlikTimer = setTimeout(() => oldur("yanıt akmıyor (sessizlik)"), sessizlikMs);
      };
      child.stdout.on("data", (d) => {
        canlilik();
        stdout += d;
        if (onLine) {
          lineBuf += d;
          const lines = lineBuf.split("\n");
          lineBuf = lines.pop();
          for (const l of lines) if (l.trim()) onLine(l.trim());
        }
      });
      child.stderr.on("data", (d) => { canlilik(); stderr += d; });
      child.on("error", (err) => { clearTimeout(timer); clearTimeout(sessizlikTimer); clearTimeout(forceKillTimer); this.children.delete(child); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(sessizlikTimer);
        clearTimeout(forceKillTimer);
        this.children.delete(child);
        if (onLine && lineBuf.trim()) onLine(lineBuf.trim());
        this.log(`codex exit=${code} args=${args.join(" ")}\nstderr: ${stderr.slice(0, 2000)}`);
        resolve({ stdout, stderr, code, timedOut });
      });
      child.stdin.write(stdinText);
      child.stdin.end();
    });
  }
}
