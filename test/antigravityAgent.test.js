import test from "node:test";
import assert from "node:assert/strict";
import { AntigravityAgent } from "../src/agents/antigravityAgent.js";

test("exit 0 ve kullanılabilir yanıt varsa araç uyarısı yanıtı kaybettirmez", async () => {
  const agent = Object.create(AntigravityAgent.prototype);
  agent.rootDir = process.cwd();
  agent.bin = "agy";
  agent._cliReady = false;
  agent.getSession = () => null;
  agent.setSession = () => {};
  agent.getModel = () => "";
  agent.getEffort = () => "";
  agent.progress = () => {};
  agent.updateBridgeStatus = () => {};
  agent.spawnCollect = async (_bin, _args, _cwd, _timeout, onLine) => {
    onLine(JSON.stringify({ event: "step_update", step_update: { text_delta: "Görsel hazır." } }));
    onLine(JSON.stringify({ event: "result", result: { status: "ERROR", response: "Görsel hazır.", usage: {} } }));
    return { code: 0, timedOut: false, stdout: "", stderr: "" };
  };
  const result = await agent._invoke("görsel üret", {});
  assert.equal(result.ok, true);
  assert.equal(result.text, "Görsel hazır.");
  assert.equal(result.raw.warning, "Araç turu uyarıyla tamamlandı");
});

test("yanıtsız ERROR sonucu başarısız kalır", async () => {
  const agent = Object.create(AntigravityAgent.prototype);
  agent.rootDir = process.cwd();
  agent.bin = "agy";
  agent._cliReady = false;
  agent.getSession = () => null;
  agent.setSession = () => {};
  agent.getModel = () => "";
  agent.getEffort = () => "";
  agent.progress = () => {};
  agent.updateBridgeStatus = () => {};
  agent.spawnCollect = async (_bin, _args, _cwd, _timeout, onLine) => {
    onLine(JSON.stringify({ event: "result", result: { status: "ERROR", message: "araç başarısız" } }));
    return { code: 0, timedOut: false, stdout: "", stderr: "" };
  };
  await assert.rejects(() => agent._invoke("görsel üret", {}), /araç başarısız/);
});

test("seçilen gerçek Gemini model kimliği CLI'ya aktarılır", async () => {
  const agent = Object.create(AntigravityAgent.prototype);
  agent.rootDir = process.cwd();
  agent.bin = "agy";
  agent._cliReady = false;
  agent.getSession = () => null;
  agent.setSession = () => {};
  agent.getModel = () => "gemini-3.7-flash-medium";
  agent.getEffort = () => "";
  agent.progress = () => {};
  agent.updateBridgeStatus = () => {};
  agent.spawnCollect = async (_bin, args, _cwd, _timeout, onLine) => {
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2),
      ["--model", "gemini-3.7-flash-medium"]);
    onLine(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "hazır" } }));
    return { code: 0, timedOut: false, stdout: "", stderr: "" };
  };
  assert.equal((await agent._invoke("görsel üret", {})).text, "hazır");
});

test("kota hatası kullanılabilir metin olsa bile başarı sayılmaz", async () => {
  const agent = Object.create(AntigravityAgent.prototype);
  agent.rootDir = process.cwd();
  agent.bin = "agy";
  agent._cliReady = false;
  agent.getSession = () => null;
  agent.setSession = () => {};
  agent.getModel = () => "gemini-3.7-flash-medium";
  agent.getEffort = () => "";
  agent.progress = () => {};
  agent.updateBridgeStatus = () => {};
  agent.spawnCollect = async (_bin, _args, _cwd, _timeout, onLine) => {
    onLine(JSON.stringify({ event: "result", result: {
      status: "ERROR",
      response: "Kota sıfırlanma süresi ~2 saat 13 dakika",
      error: "429 RESOURCE_EXHAUSTED quota will reset after 2h13m",
    } }));
    return { code: 0, timedOut: false, stdout: "", stderr: "" };
  };
  await assert.rejects(() => agent._invoke("görsel üret", {}), /kotası doldu.*2h13m/i);
});
