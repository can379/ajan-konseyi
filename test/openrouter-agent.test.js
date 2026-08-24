import test from "node:test";
import assert from "node:assert/strict";
import { OpenRouterAgent } from "../src/agents/openRouterAgent.js";

function fakeStore() {
  return { setAgentStatus() {}, streamProgress() {} };
}

test("Ox Alpha çağrısı doğru OpenRouter modeli ve Bearer anahtarıyla gider", async () => {
  let request;
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider: async () => "sk-or-test-secret",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return { id:"gen-1", choices:[{ message:{ content:"Ox Alpha yanıtı" } }], usage:{ prompt_tokens:12, completion_tokens:7 } };
        },
      };
    },
  });
  agent.progress = () => {};

  const result = await agent.invoke("Görevi incele", { sessionKey:"run-1#m-ox-alpha" });
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer sk-or-test-secret");
  assert.equal(body.model, "stealth/ox-alpha");
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /must never claim that you are Codex/);
  assert.equal(body.messages[1].content, "Görevi incele");
  assert.equal(result.text, "Ox Alpha yanıtı");
  assert.deepEqual(result.raw, { id:"gen-1", usage:{ input:12, cachedInput:0, output:7, costUsd:0 } });
});

test("Ox Alpha yanıtı SSE akışıyla geldikçe kullanıcıya iletilir", async () => {
  const events = [
    `data: ${JSON.stringify({ id:"gen-stream", choices:[{ delta:{ content:"Merhaba" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices:[{ delta:{ content:" dünya" } }], usage:{ prompt_tokens:9, completion_tokens:2 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const encoder = new TextEncoder();
  let index = 0;
  const partials = [];
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider:async () => "sk-or-test-secret",
    fetchImpl:async () => ({
      ok:true,
      body:{ getReader:() => ({ read:async () => index < events.length ? { done:false, value:encoder.encode(events[index++]) } : { done:true } }) },
    }),
  });
  agent.progress = (_label, text) => partials.push(text);

  const result = await agent.invoke("Selam", { sessionKey:"stream" });
  assert.equal(result.text, "Merhaba dünya");
  assert.deepEqual(partials, ["Merhaba", "Merhaba dünya", "Merhaba dünya"]);
  assert.equal(result.raw.usage.output, 2);
});

test("Ox Alpha kimlik sorusunda kendisini Codex diye tanıtamaz", async () => {
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider: async () => "sk-or-test-secret",
    fetchImpl: async () => ({
      ok: true,
      async json() { return { id:"gen-wrong", choices:[{ message:{ content:"Evet, ben Codex'im." } }] }; },
    }),
  });
  agent.progress = () => {};

  const result = await agent.invoke("Sen Codex misin, kimsin?", { sessionKey:"identity" });
  assert.match(result.text, /Ox Alpha/);
  assert.match(result.text, /Codex değilim/);
  assert.doesNotMatch(result.text, /ben Codex'im/i);
});

test("Ox Alpha anahtar olmadan çağrı yapmaz", async () => {
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), { keyProvider:async () => "" });
  await assert.rejects(() => agent.invoke("iş"), /API anahtarı ayarlanmamış/);
});

test("Ox Alpha devam eden HTTP isteği durdurulunca anında iptal edilir", async () => {
  let aborted = false;
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider:async () => "sk-or-test-secret",
    fetchImpl:async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => { aborted = true; reject(options.signal.reason); }, { once:true });
    }),
  });
  const pending = agent.send("uzun üretim", { sessionKey:"run-stop#m-ox-alpha", shouldStop:() => true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  agent.stop("run-stop");
  const result = await pending;
  assert.equal(aborted, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /Durduruldu/);
});

test("Ox Alpha geçici 429 hatasında birkaç kez yeniden deneyip yanıtı alır", async () => {
  let calls = 0;
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider:async () => "sk-test",
    fetchImpl:async () => {
      calls++;
      if (calls < 3) return {
        ok:false,
        status:429,
        statusText:"Too Many Requests",
        headers:{ get:() => null },
        json:async () => ({ error:{ message:"Provider returned error" } }),
      };
      return {
        ok:true,
        body:null,
        json:async () => ({ choices:[{ message:{ content:"Üçüncü denemede yanıt" } }], usage:{} }),
      };
    },
  });
  const result = await agent.invoke("Yanıtla", { sessionKey:"retry", retryDelaysMs:[0, 0, 0] });
  assert.equal(calls, 3);
  assert.equal(result.text, "Üçüncü denemede yanıt");
});

test("Ox Alpha kalıcı istemci hatalarını yeniden denemez", async () => {
  let calls = 0;
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider:async () => "sk-test",
    fetchImpl:async () => {
      calls++;
      return { ok:false, status:400, statusText:"Bad Request", headers:{ get:() => null }, json:async () => ({}) };
    },
  });
  await assert.rejects(() => agent.invoke("Yanıtla", { retryDelaysMs:[0, 0] }), /OpenRouter 400/);
  assert.equal(calls, 1);
});

test("Ox Alpha boş başarılı yanıtı tamamlanmış saymayıp yeniden dener", async () => {
  let calls = 0;
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider:async () => "sk-test",
    fetchImpl:async () => {
      calls++;
      return {
        ok:true,
        body:null,
        json:async () => calls === 1
          ? { choices:[{ message:{ content:"" } }], usage:{} }
          : { choices:[{ message:{ content:"Gerçek yanıt" } }], usage:{} },
      };
    },
  });
  const result = await agent.invoke("Yanıtla", { sessionKey:"empty-retry", retryDelaysMs:[0] });
  assert.equal(calls, 2);
  assert.equal(result.text, "Gerçek yanıt");
});

test("Ox Alpha art arda boş yanıt verirse açık hata üretir", async () => {
  let calls = 0;
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider:async () => "sk-test",
    fetchImpl:async () => {
      calls++;
      return { ok:true, body:null, json:async () => ({ choices:[{ message:{ content:[] } }], usage:{} }) };
    },
  });
  await assert.rejects(
    () => agent.invoke("Yanıtla", { sessionKey:"always-empty", retryDelaysMs:[0, 0] }),
    /boş yanıt döndürdü/,
  );
  assert.equal(calls, 3);
});

test("Ox Alpha SSE içinde 200 ile gelen sağlayıcı hatasını yeniden dener", async () => {
  const encoder = new TextEncoder();
  let calls = 0;
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider:async () => "sk-test",
    fetchImpl:async () => {
      calls++;
      const events = calls === 1
        ? [`data: ${JSON.stringify({ error:{ code:429, message:"Provider returned error" } })}\n\n`, "data: [DONE]\n\n"]
        : [`data: ${JSON.stringify({ choices:[{ delta:{ content:[{ type:"text", text:"Akış yanıtı" }] } }] })}\n\n`, "data: [DONE]\n\n"];
      let index = 0;
      return {
        ok:true,
        body:{ getReader:() => ({ read:async () => index < events.length ? { done:false, value:encoder.encode(events[index++]) } : { done:true } }) },
      };
    },
  });
  const result = await agent.invoke("Yanıtla", { sessionKey:"stream-error", retryDelaysMs:[0] });
  assert.equal(calls, 2);
  assert.equal(result.text, "Akış yanıtı");
});
