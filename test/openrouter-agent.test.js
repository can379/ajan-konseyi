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
  assert.equal(body.max_tokens, 32_000);
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

test("Ox Alpha bütün bütçeyi akıl yürütmeye harcarsa bütçeyi büyütüp yanıtı alır", async () => {
  const encoder = new TextEncoder();
  const budgets = [];
  let calls = 0;
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider:async () => "sk-test",
    fetchImpl:async (_url, options) => {
      calls++;
      budgets.push(JSON.parse(options.body).max_tokens);
      // İlk denemede model yalnız akıl yürütür ve bütçe dolduğu için kesilir.
      const events = calls === 1
        ? [`data: ${JSON.stringify({ choices:[{ delta:{ content:"", reasoning:"düşünüyorum" } }] })}\n\n`,
           `data: ${JSON.stringify({ choices:[{ delta:{}, finish_reason:"length" }] })}\n\n`, "data: [DONE]\n\n"]
        : [`data: ${JSON.stringify({ choices:[{ delta:{ content:"Geniş bütçeyle yanıt" } }] })}\n\n`,
           `data: ${JSON.stringify({ choices:[{ delta:{}, finish_reason:"stop" }] })}\n\n`, "data: [DONE]\n\n"];
      let index = 0;
      return {
        ok:true,
        body:{ getReader:() => ({ read:async () => index < events.length ? { done:false, value:encoder.encode(events[index++]) } : { done:true } }) },
      };
    },
  });
  agent.progress = () => {};

  const result = await agent.invoke("Uzun analiz yaz", { sessionKey:"reasoning-budget", retryDelaysMs:[0, 0] });
  assert.equal(calls, 2);
  assert.equal(budgets[0], 32_000);
  assert.equal(budgets[1], 64_000);
  assert.equal(result.text, "Geniş bütçeyle yanıt");
});

test("Ox Alpha bütçe büyütmesine rağmen yanıt üretemezse akıl yürütme hatasını bildirir", async () => {
  const encoder = new TextEncoder();
  let calls = 0;
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider:async () => "sk-test",
    fetchImpl:async () => {
      calls++;
      const events = [`data: ${JSON.stringify({ choices:[{ delta:{ content:"", reasoning:"hâlâ düşünüyorum" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices:[{ delta:{}, finish_reason:"length" }] })}\n\n`, "data: [DONE]\n\n"];
      let index = 0;
      return {
        ok:true,
        body:{ getReader:() => ({ read:async () => index < events.length ? { done:false, value:encoder.encode(events[index++]) } : { done:true } }) },
      };
    },
  });
  agent.progress = () => {};

  await assert.rejects(
    () => agent.invoke("Uzun analiz yaz", { sessionKey:"reasoning-stuck", retryDelaysMs:[0, 0] }),
    /akıl yürütmeye harcadı/,
  );
  assert.ok(calls >= 2);
});

test("Ox Alpha yalnız akıl yürütürken kartı boş bırakmaz", async () => {
  const encoder = new TextEncoder();
  const labels = [];
  const events = [
    `data: ${JSON.stringify({ choices:[{ delta:{ content:"", reasoning_details:[{ type:"reasoning.text", text:"plan kuruyorum" }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices:[{ delta:{ content:"Sonuç" } }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  let index = 0;
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider:async () => "sk-test",
    fetchImpl:async () => ({
      ok:true,
      body:{ getReader:() => ({ read:async () => index < events.length ? { done:false, value:encoder.encode(events[index++]) } : { done:true } }) },
    }),
  });
  agent.progress = (label, text) => labels.push([label, text]);

  const result = await agent.invoke("Selam", { sessionKey:"thinking-label", label:"yanıtlıyor" });
  assert.equal(result.text, "Sonuç");
  assert.deepEqual(labels[0], ["yanıtlıyor · akıl yürütüyor", ""]);
  // Ham akıl yürütme metni kullanıcıya akıtılmaz.
  assert.ok(labels.every(([, text]) => !String(text).includes("plan kuruyorum")));
});

// Akış üzerinden sürekli veri gelen bir yanıtı taklit eder; abort edilince
// gerçek fetch gibi bekleyen read() reddedilir.
function streamingFetch({ events, gapMs = 0, hangAfter = false }) {
  const encoder = new TextEncoder();
  return async (_url, options) => {
    let index = 0;
    return {
      ok: true,
      body: { getReader: () => ({
        read: () => new Promise((resolve, reject) => {
          const fail = () => reject(options.signal.reason || new Error("aborted"));
          if (options.signal.aborted) return fail();
          options.signal.addEventListener("abort", fail, { once: true });
          if (index >= events.length) {
            if (hangAfter) return; // sağlayıcı susuyor: yalnız abort bitirir
            return setTimeout(() => resolve({ done: true }), gapMs);
          }
          setTimeout(() => resolve({ done: false, value: encoder.encode(events[index++]) }), gapMs);
        }),
      }) },
    };
  };
}

test("akış sürdükçe uzun yanıt duraklama sınırıyla kesilmez", async () => {
  const events = Array.from({ length: 6 }, (_, i) =>
    `data: ${JSON.stringify({ choices:[{ delta:{ content:"", reasoning:`adım ${i} ` } }] })}\n\n`);
  events.push(`data: ${JSON.stringify({ choices:[{ delta:{ content:"Uzun düşünmenin ardından yanıt" } }] })}\n\n`);
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider: async () => "sk-test",
    // Her parça 30 ms arayla gelir; toplam süre 200 ms duraklama sınırını aşar
    // ama tek bir sessizlik aralığı aşmaz.
    fetchImpl: streamingFetch({ events, gapMs: 30 }),
  });
  agent.progress = () => {};

  const result = await agent.invoke("Uzun analiz", { sessionKey:"long-stream", stallTimeoutMs:200 });
  assert.equal(result.text, "Uzun düşünmenin ardından yanıt");
});

test("sağlayıcı akışın ortasında susarsa duraklama sınırı çağrıyı bitirir", async () => {
  const events = [`data: ${JSON.stringify({ choices:[{ delta:{ content:"", reasoning:"düşünüyorum" } }] })}\n\n`];
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider: async () => "sk-test",
    fetchImpl: streamingFetch({ events, gapMs: 5, hangAfter: true }),
  });
  agent.progress = () => {};

  await assert.rejects(
    () => agent.invoke("Analiz", { sessionKey:"stalled", stallTimeoutMs:80, retryDelaysMs:[] }),
    /veri göndermiyor/,
  );
});

test("toplam süre sınırı duraklama sınırından bağımsız uygulanır", async () => {
  const events = Array.from({ length: 200 }, () =>
    `data: ${JSON.stringify({ choices:[{ delta:{ content:"", reasoning:"hâlâ düşünüyorum " } }] })}\n\n`);
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider: async () => "sk-test",
    fetchImpl: streamingFetch({ events, gapMs: 5 }),
  });
  agent.progress = () => {};

  await assert.rejects(
    () => agent.invoke("Bitmeyen üretim", { sessionKey:"total-cap", timeoutMs:120, stallTimeoutMs:10_000, retryDelaysMs:[] }),
    /zaman aşımı/,
  );
});

test("toplam süre duraklama sınırından kısaysa duraklama mesajı dönmez", async () => {
  const events = Array.from({ length: 200 }, () =>
    `data: ${JSON.stringify({ choices:[{ delta:{ content:"", reasoning:"düşünüyorum " } }] })}\n\n`);
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider: async () => "sk-test",
    fetchImpl: streamingFetch({ events, gapMs: 5 }),
  });
  agent.progress = () => {};
  for (let i = 0; i < 5; i++) {
    const err = await agent.invoke("Bitmeyen üretim",
      { sessionKey:`race-${i}`, timeoutMs:80, stallTimeoutMs:10_000, retryDelaysMs:[] }).catch((e) => e);
    assert.match(String(err), /zaman aşımı/);
    assert.doesNotMatch(String(err), /saniyedir veri göndermiyor/,
      "toplam sınır önce dolduğunda duraklama mesajı yanıltıcı olur");
  }
});

test("gecmisteki kimlik tartismasi arastirma yanitini silmez", async () => {
  const analiz = "Devin, Cursor, Codex ve Claude Code karşılaştırması: ".padEnd(3000, "detaylı analiz metni. ");
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider: async () => "sk-test",
    fetchImpl: streamingFetch({ events: [
      `data: ${JSON.stringify({ choices:[{ delta:{ content: analiz } }] })}\n\n`, "data: [DONE]\n\n",
    ] }),
  });
  agent.progress = () => {};
  const promptWithHistory = "--- ORTAK SOHBET GEÇMİŞİ ---\nKullanıcı: sen kimsin\nOx Alpha: codex değilim\n--- GEÇMİŞ SONU ---\n\nbüyük yazılımları analiz et";
  const res = await agent.invoke(promptWithHistory,
    { sessionKey:"gecmis-kirli", routeText:"büyük yazılımları analiz et", retryDelaysMs:[] });
  assert.match(res.text, /Devin, Cursor/, "analiz yanıtı korunmalı");
  assert.doesNotMatch(res.text, /kimliğiyle sunulan Ox Alpha modeliyim/);
});

test("gercek kimlik sorusunda saglayici kimligi hala zorlanir", async () => {
  const agent = new OpenRouterAgent(fakeStore(), process.cwd(), {
    keyProvider: async () => "sk-test",
    fetchImpl: streamingFetch({ events: [
      `data: ${JSON.stringify({ choices:[{ delta:{ content:"Ben Codex'im." } }] })}\n\n`, "data: [DONE]\n\n",
    ] }),
  });
  agent.progress = () => {};
  const res = await agent.invoke("Kullanıcı sordu: sen kimsin",
    { sessionKey:"kimlik", routeText:"sen kimsin", retryDelaysMs:[] });
  assert.match(res.text, /Ox Alpha modeliyim/);
  assert.doesNotMatch(res.text, /Ben Codex'im/);
});
