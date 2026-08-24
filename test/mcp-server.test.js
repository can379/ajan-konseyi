import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS, handle, setOutput } from "../mcp-server.js";

// handle() yanitlari cikti kancasindan toplanir.
function capture() {
  const collected = [];
  setOutput((message) => collected.push(message));
  return {
    restore: () => setOutput((message) => process.stdout.write(JSON.stringify(message) + "\n")),
    messages: () => collected,
  };
}

async function rpc(request, routes = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const route = new URL(url).pathname;
    calls.push({ route, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    const handler = routes[route];
    if (!handler) return { ok: false, status: 404, text: async () => JSON.stringify({ error: "Bulunamadı" }) };
    const value = typeof handler === "function" ? handler(calls.at(-1)) : handler;
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  };
  const out = capture();
  try { await handle(request); }
  finally { out.restore(); globalThis.fetch = originalFetch; }
  return { messages: out.messages(), calls };
}

const INFO = {
  members: [
    { id: "m-claude", name: "Claude", provider: "claude", role: "auto", model: "opus" },
    { id: "m-ox-alpha", name: "Ox Alpha", provider: "openrouter", role: "arastirmaci", model: "stealth/ox-alpha" },
  ],
  projects: [{ id: "p-1", name: "ajan", path: "/Users/x/ajan" }],
};

test("initialize protokol surumu ve sunucu kimligi doner", async () => {
  const { messages } = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].result.serverInfo.name, "ajan-konseyi");
  assert.equal(messages[0].result.protocolVersion, "2024-11-05");
  assert.ok(messages[0].result.capabilities.tools, "tools yetenegi bildirilmeli");
});

test("bildirimlere (id yok) yanit yazilmaz", async () => {
  const { messages } = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(messages.length, 0);
});

test("tools/list gecerli sema ile tum araclari doner", async () => {
  const { messages } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = messages[0].result.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ["konsey_bilgi", "konsey_incele", "konsey_sor", "kosu_durumu", "uye_sor"]);
  for (const tool of TOOLS) {
    assert.ok(tool.description?.length > 20, `${tool.name} aciklamasi yetersiz`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} semasi nesne olmali`);
    for (const required of tool.inputSchema.required || []) {
      assert.ok(tool.inputSchema.properties[required], `${tool.name}: zorunlu alan ${required} tanimsiz`);
    }
  }
});

test("bilinmeyen arac protokol hatasi doner", async () => {
  const { messages } = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "yok" } });
  assert.equal(messages[0].error.code, -32602);
});

test("arac hatasi protokol hatasi degil isError olarak doner", async () => {
  const { messages } = await rpc(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "uye_sor", arguments: { uye: "Yok", soru: "x" } } },
    { "/api/mcp/info": INFO },
  );
  assert.equal(messages[0].error, undefined, "protokol hatasi olmamali");
  assert.equal(messages[0].result.isError, true);
  assert.match(messages[0].result.content[0].text, /Uye bulunamadi/);
});

test("konsey_bilgi uye ve projeleri listeler", async () => {
  const { messages } = await rpc(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "konsey_bilgi", arguments: {} } },
    { "/api/mcp/info": INFO },
  );
  const text = messages[0].result.content[0].text;
  assert.match(text, /Ox Alpha \(openrouter/);
  assert.match(text, /ajan → \/Users\/x\/ajan/);
});

test("uye_sor uyeyi saglayici adiyla da bulur ve dogru uca gonderir", async () => {
  const { messages, calls } = await rpc(
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "uye_sor", arguments: { uye: "openrouter", soru: "selam" } } },
    {
      "/api/mcp/info": INFO,
      "/api/direct-chat": { runId: "run-1" },
      "/api/runs/run-1": { messages: [
        { from: "kullanici", kind: "message", content: "@Ox Alpha: selam" },
        { from: "m-ox-alpha", fromLabel: "Ox Alpha", kind: "message", content: "merhaba" },
      ] },
    },
  );
  const dm = calls.find((c) => c.route === "/api/direct-chat");
  assert.equal(dm.body.to, "m-ox-alpha", "saglayici adiyla dogru uye secilmeli");
  assert.equal(dm.body.text, "selam");
  assert.match(messages[0].result.content[0].text, /Ox Alpha[\s\S]*merhaba/);
});

test("konsey_sor uzun is icin hemen runId doner", async () => {
  const { messages, calls } = await rpc(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "konsey_sor", arguments: { istek: "analiz", mod: "discussion" } } },
    { "/api/mcp/info": INFO, "/api/chat": { runId: "run-2" } },
  );
  assert.equal(calls.find((c) => c.route === "/api/chat").body.mode, "discussion");
  assert.match(messages[0].result.content[0].text, /run-2/);
  assert.match(messages[0].result.content[0].text, /kosu_durumu/, "yoklama yolu anlatilmali");
});

test("gecersiz mod varsayilana duser", async () => {
  const { calls } = await rpc(
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "konsey_sor", arguments: { istek: "x", mod: "sacma" } } },
    { "/api/mcp/info": INFO, "/api/chat": { runId: "run-3" } },
  );
  assert.equal(calls.find((c) => c.route === "/api/chat").body.mode, "auto");
});

test("bilinmeyen proje adi acik hata verir", async () => {
  const { messages } = await rpc(
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "konsey_sor", arguments: { istek: "x", proje: "olmayan" } } },
    { "/api/mcp/info": INFO, "/api/chat": { runId: "run-4" } },
  );
  assert.equal(messages[0].result.isError, true);
  assert.match(messages[0].result.content[0].text, /Proje bulunamadi/);
});

// kosu_durumu bilerek secildi: uye/proje onbellegine ugramaz, bu yuzden
// baglanti hatasi gercekten ag katmanindan gelir.
test("uygulama kapaliyken anlasilir hata doner", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  const out = capture();
  try { await handle({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "kosu_durumu", arguments: { runId: "run-9" } } }); }
  finally { out.restore(); globalThis.fetch = originalFetch; }
  const message = out.messages()[0];
  assert.equal(message.result.isError, true);
  assert.match(message.result.content[0].text, /uygulamanin acik oldugundan|baglanilamadi/i);
});

test("desteklenmeyen metot -32601 doner", async () => {
  const { messages } = await rpc({ jsonrpc: "2.0", id: 11, method: "sacma/metot" });
  assert.equal(messages[0].error.code, -32601);
});
