import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator.js";

const MEMBERS = [
  { id: "m-claude", name: "Claude", provider: "claude", enabled: true },
  { id: "m-codex", name: "Codex", provider: "codex", enabled: true },
  { id: "m-antigravity", name: "Antigravity", provider: "antigravity", enabled: true },
];
const ask = (text) => Orchestrator.prototype.explicitlyRequestedMember.call({}, text, MEMBERS);

test("dogrudan cagri hala tek uyeye gider", () => {
  assert.equal(ask("@Codex: sunu yap")?.id, "m-codex");
  assert.equal(ask("@Antigravity: sunu yap")?.id, "m-antigravity");
  assert.equal(ask("bunu Codex yapsın")?.id, "m-codex");
  assert.equal(ask("işi Antigravity yapsın")?.id, "m-antigravity");
});

// Is bolumu anlatan bir istekte uye adlari sayilir. Eskiden ciplak
// "Antigravity" sozcugu butun turu tek uyeye indiriyordu.
test("is bolumu anlatan metinde ciplak ad turu tek uyeye indirmez", () => {
  const text = "Isi bol: Antigravity dosyalari okusun diye degil, once Codex ve Claude arasinda paylastiralim.";
  assert.equal(ask("Antigravity, Codex ve Claude arasinda isi bol ve raporla"), null);
  assert.equal(ask("- Antigravity: dosyalari oku ve raporla"), null);
  assert.ok(ask(text) === null || ask(text).id === "m-codex");
});

test("reddetme ifadesi uyeyi secmez", () => {
  assert.equal(ask("bunu Codex değil başkası yapsın"), null);
  assert.equal(ask("Antigravity olmasın"), null);
});
