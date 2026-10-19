import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isVoiceSupported,
  listen,
  speak,
  stopVoice,
} from "./voice.ts";

/**
 * These run on the server, where there is no window — which is exactly the
 * case the module promises to survive. The browser half of voice mode is
 * exercised in the running app, because a fake DOM here would only prove that
 * the fake works.
 */

describe("voice on the server", () => {
  it("reports no support rather than throwing", () => {
    assert.equal(typeof window, "undefined");
    assert.equal(isVoiceSupported(), false);
  });

  it("refuses to listen instead of pretending to hear something", async () => {
    await assert.rejects(() => listen(), /not supported|Speech recognition/i);
  });

  it("resolves speech it cannot perform, so a voice loop cannot hang", async () => {
    await speak("Invoice Rahul for USD 500.00.");
  });

  it("tolerates being stopped when nothing was started", () => {
    assert.doesNotThrow(() => stopVoice());
  });
});
