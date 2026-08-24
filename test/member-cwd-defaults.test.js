import test from "node:test";
import assert from "node:assert/strict";
import { resolveMemberCwd } from "../src/orchestrator.js";

const RUN = (extra = {}) => ({ id: "run-1", kind: "chat", mode: "auto", projectDir: "/proje", ...extra });

test("cwd verilmeyen cagri proje dizinine baglanir", () => {
  assert.equal(resolveMemberCwd(RUN(), { label: "doğrudan mesaj" }), "/proje");
});

test("acikca verilen cwd korunur", () => {
  assert.equal(resolveMemberCwd(RUN(), { cwd: "/proje/worktree" }), "/proje/worktree");
});

// Izole inceleme yalniz kanit paketiyle calisir; proje agacini gormemelidir.
test("izole inceleme proje dizinine baglanmaz", () => {
  assert.equal(resolveMemberCwd(RUN(), { isolated: true }), undefined);
});

// Kod modunda ayri calisma kopyasi yoksa ajan ana agaca YAZMAMALIDIR.
test("kod modunda kopyasiz gorev ana agaca baglanmaz", () => {
  assert.equal(resolveMemberCwd(RUN({ mode: "code" }), { codeMode: true, noProjectCwd: true }), undefined);
});

test("projesiz sohbette cwd zorlanmaz", () => {
  assert.equal(resolveMemberCwd(RUN({ projectDir: null }), {}), undefined);
});

// Acikca undefined gecirmek "verilmedi" ile ayni anlama gelir; kasitli
// izolasyon noProjectCwd ile belirtilir.
test("acikca undefined verilmesi varsayilani engellemez", () => {
  assert.equal(resolveMemberCwd(RUN(), { cwd: undefined }), "/proje");
});

// Kod modunda calisma kopyasi dagitimi: kod yazamayan uyeler de (Antigravity)
// kopya almalidir, aksi halde calisma dizinleri bos kalir ve projeyi hic
// goremezler. Kopya, ana agaci kanit kapisi olmadan degistirmelerini de
// engeller.
test("kod modunda tum gorevli uyeler calisma kopyasi alir", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8"));
  const block = src.slice(src.indexOf("const involved = "), src.indexOf("const involved = ") + 260);
  assert.doesNotMatch(block, /provider !== "antigravity"/,
    "Antigravity çalışma kopyası dağıtımından dışlanmamalı");
  assert.match(block, /\.filter\(Boolean\)/);
});
