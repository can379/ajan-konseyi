import test from "node:test";
import assert from "node:assert/strict";
import { resolveVisionScript } from "../src/localVision.js";

test("yerel görsel betiği asar arşivi dışında gerçek dosyadır", () => {
  const script = resolveVisionScript();
  assert.ok(script);
  assert.doesNotMatch(script, /[\\/]app\.asar[\\/]/);
});
