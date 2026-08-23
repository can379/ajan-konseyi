import test from "node:test";
import assert from "node:assert/strict";
import { parseBrowserAction, parseHostAction } from "../src/orchestrator.js";

test("all providers use the same structured browser action protocol",()=>{
  assert.deepEqual(parseBrowserAction('<<<AJAN_BROWSER_ACTION>>>{"action":"open","payload":{"url":"https://example.com"}}<<<END>>>'),{action:"open",payload:{url:"https://example.com"}});
  assert.deepEqual(parseBrowserAction('<<<AJAN_BROWSER_ACTION>>>{"action":"snapshot","payload":{}}<<<END>>>'),{action:"snapshot",payload:{}});
  assert.equal(parseBrowserAction("curl http://127.0.0.1:4780"),null);
});

test("explicit publish requests use the host action protocol",()=>{
  assert.deepEqual(parseHostAction('<<<AJAN_HOST_ACTION>>>{"action":"publish","payload":{}}<<<END>>>'),{action:"publish",payload:{}});
  assert.equal(parseHostAction('<<<AJAN_HOST_ACTION>>>{"action":"force-push","payload":{}}<<<END>>>'),null);
});
