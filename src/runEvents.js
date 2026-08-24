import crypto from "node:crypto";

function text(value, max = 12000) {
  return String(value ?? "").slice(-max);
}

export function appendRunEvent(run, type, detail = {}, at = new Date().toISOString()) {
  if (!run || !type) throw new Error("Run ve event türü gerekli");
  run.events ??= [];
  const previous = run.events.at(-1)?.hash || "root";
  const event = {
    id: crypto.randomUUID(),
    seq: run.events.length + 1,
    at,
    type: String(type),
    detail: structuredClone(detail),
    previous,
  };
  event.hash = crypto.createHash("sha256").update(JSON.stringify(event)).digest("hex");
  run.events.push(event);
  return event;
}

export function recordTestExecution(run, { command, ok, output, cwd = null, taskId = null }, at) {
  const evidence = {
    ts: at || new Date().toISOString(),
    command: String(command || "").trim(),
    ok: ok === true,
    output: text(output),
    cwd: cwd ? String(cwd) : null,
    taskId: taskId || null,
  };
  run.tests ??= [];
  run.tests.push(evidence);
  const event = appendRunEvent(run, "test.finished", evidence, evidence.ts);
  evidence.eventId = event.id;
  evidence.eventHash = event.hash;
  return evidence;
}

export function testEvidenceFromEvents(run, taskId = null) {
  return (run?.events || [])
    .filter((event) => event.type === "test.finished")
    .map((event) => ({ ...event.detail, eventId: event.id, eventHash: event.hash }))
    .filter((item) => !taskId || !item.taskId || item.taskId === taskId);
}

export function verifyRunEventChain(events = []) {
  let previous = "root";
  for (const event of events) {
    const { hash, ...unsigned } = event;
    if (unsigned.previous !== previous) return false;
    const expected = crypto.createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
    if (hash !== expected) return false;
    previous = hash;
  }
  return true;
}
