/** Load packed extension AND shipped web assets through the real minimum Pi SDK. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runtimeHarness } from "../test/setup/pi-runtime.ts";

if (!process.argv[2]) throw new Error("Usage: node --import tsx scripts/qualify-package.ts <extracted-package>/src/extension.ts");
const root = await mkdtemp(join(tmpdir(), "flow-packed-qualification-"));
const previousPort = process.env.PI_PERSONA_FLOW_PORT;
process.env.PI_PERSONA_FLOW_PORT = "0";
let h: Awaited<ReturnType<typeof runtimeHarness>> | undefined;
try {
  h = await runtimeHarness(root, resolve(process.argv[2]));
  h.session.extensionRunner!.setFlagValue("flow", true);
  await h.bind();
  const url = h.widgets.find((line) => line.startsWith("flow dashboard at "))?.slice("flow dashboard at ".length);
  assert.ok(url);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  const script = /src="([^"]+\.js)"/.exec(html)?.[1];
  assert.ok(script, "the packed HTML references its actual built script");
  const asset = await fetch(new URL(script, url));
  assert.equal(asset.status, 200);
  assert.ok((await asset.text()).length > 1000);
  await h.dispose();
  await assert.rejects(fetch(url));
  console.log("PASS: extracted Flow package loaded in Pi 1.0; shipped HTML/JS served, server closed.");
} finally {
  try { await h?.dispose(); }
  finally {
    if (previousPort === undefined) delete process.env.PI_PERSONA_FLOW_PORT;
    else process.env.PI_PERSONA_FLOW_PORT = previousPort;
    await rm(root, { recursive: true, force: true });
  }
}
