// Open the URL printed by test-results/serve-fixture.mts, then run with playwright-cli run-code.
async (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__flowRAF = 0;
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      window.__flowRAF += 1;
      return request(callback);
    };
  });
  await page.reload();
  const worker = page.getByRole("button", { name: /^agent Dewglass, waiting/ });
  await worker.waitFor();
  await worker.click();
  const inspector = page.getByRole("complementary", { name: "Selected node inspector" });
  if (!(await inspector.getByRole("heading", { name: "Dewglass", exact: true }).isVisible())) throw new Error("worker alias not shown");
  const route = inspector.locator('[title="scout → supervisor"]');
  if ((await route.innerText()) !== "OUT → Alpha") throw new Error("route aliases or direction incorrect");
  await page.getByRole("button", { name: /^instance Alpha,/ }).click();
  if (!(await inspector.getByText("OUT → Remote", { exact: true }).isVisible())) throw new Error("exocom alias not shown");
  const text = await page.locator("body").innerText();
  if (/CANARY|cat \/etc\/shadow/.test(text)) throw new Error("unsafe payload reached DOM");
  await page.getByRole("button", { name: "REVIEW", exact: true }).click();
  await page.getByRole("slider", { name: "Replay event position" }).press("Home");
  await page.getByRole("button", { name: "Play replay", exact: true }).click();
  await page.getByRole("button", { name: "Pause replay", exact: true }).click();
  await page.getByRole("button", { name: "Return to live", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await worker.waitFor();
  // A keep-alive SSE comment does not warrant animation; allow isolated redraws, not a RAF loop.
  const before = await page.evaluate(() => window.__flowRAF);
  await page.waitForTimeout(1500);
  const idleRAF = await page.evaluate((previous) => window.__flowRAF - previous, before);
  if (idleRAF > 10) throw new Error(`idle RAF loop: ${idleRAF} callbacks in 1.5s`);
  const api = page.url().replace("/?", "/api/snapshot?");
  const response = await page.request.get(api);
  if (response.status() !== 200 || /CANARY|cat \/etc\/shadow/.test(await response.text())) throw new Error("API projection failed");
  if (errors.length) throw new Error(errors.join("\n"));
  return { waitingAlias: "Dewglass", intercomRoute: "OUT → Alpha", exocomRoute: "OUT → Remote", replay: "passed", idleRAF, pageErrors: errors.length };
}
