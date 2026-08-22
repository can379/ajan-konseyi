import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator.js";

const members = [
  { id: "m-claude", name: "Claude", provider: "claude", enabled: true },
  { id: "m-antigravity", name: "Antigravity", provider: "antigravity", enabled: true },
];

test("kullanıcının açık ajan tercihi diğer ajanlara devredilmez", () => {
  const orch = Object.create(Orchestrator.prototype);
  assert.equal(
    orch.explicitlyRequestedMember("dur dur bunu antigravity yapsın claude değil", members)?.id,
    "m-antigravity",
  );
  assert.equal(
    orch.explicitlyRequestedMember("bunu antigravitiy yapsın claude değil", members)?.id,
    "m-antigravity",
  );
  assert.equal(orch.explicitlyRequestedMember("@Claude bunu incele", members)?.id, "m-claude");
});

test("normal mesajda ajan tercihi uydurulmaz", () => {
  const orch = Object.create(Orchestrator.prototype);
  assert.equal(orch.explicitlyRequestedMember("bu görseli ayrıntılı incele", members), null);
});
