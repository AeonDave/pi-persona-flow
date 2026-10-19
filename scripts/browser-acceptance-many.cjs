// Open test-results/serve-fixture.mts's URL, then execute with Playwright CLI run-code.
async (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await page.getByRole("button", { name: /^agent Worker 10, waiting/ }).waitFor({ state: "attached" });
  const options = await page.getByRole("combobox", { name: "Instance", exact: true }).locator("option").allTextContents();
  const alphaOptions = options.filter((label) => label.startsWith("Alpha"));
  if (alphaOptions.length !== 2 || new Set(alphaOptions).size !== 2) throw new Error("duplicate supervisor aliases are indistinguishable");
  const viewport = page.locator(".graph-viewport");
  if (await viewport.count() !== 1) throw new Error("ten-session graph has no user-scrollable viewport");
  const dimensions = await viewport.evaluate((element) => ({ height: element.clientHeight, scroll: element.scrollHeight }));
  if (dimensions.scroll <= dimensions.height) throw new Error("ten-session canvas was clipped to the viewport");
  const lastWorker = page.getByRole("button", { name: /^agent Worker 10, waiting/ });
  await lastWorker.scrollIntoViewIfNeeded();
  await lastWorker.click();
  const inspector = page.getByRole("complementary", { name: "Selected node inspector" });
  await inspector.getByRole("heading", { name: "Worker 10", exact: true }).waitFor();
  if (!/12 of 15/.test(await inspector.innerText()) || !/5 of 15/.test(await inspector.innerText())) throw new Error("retained tool/traffic list limits are not disclosed");
  await inspector.getByRole("button", { name: /Show \d+ more tools/ }).click();
  await inspector.getByRole("button", { name: /Show \d+ more traffic/ }).click();
  await inspector.getByRole("button", { name: /Show \d+ more traffic/ }).click();
  if (await inspector.locator(".tool-row").count() !== 15 || await inspector.locator(".traffic-row").count() !== 15) throw new Error("remaining retained telemetry cannot be inspected");
  await page.getByRole("button", { name: "REVIEW", exact: true }).click();
  await page.getByRole("slider", { name: "Replay event position" }).press("Home");
  const replayText = await inspector.innerText();
  const replaySelection = /not present at this replay position/i.test(replayText) ? "explicitly absent" : "retained node predates replay window";
  if (replaySelection === "retained node predates replay window") {
    // The fixture keeps every stream fresh. After enough heartbeats, the 120-event slider
    // window begins after this node's creation, so Home correctly still contains that node.
    if (!(await inspector.getByRole("heading", { name: "Worker 10", exact: true }).isVisible())) throw new Error("replay selection has neither an existing node nor an explicit absent state");
    if (/Nothing selected/.test(replayText)) throw new Error("replay loses a selected node without an explanation");
  }
  await page.getByRole("button", { name: "Return to live", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await inspector.isVisible()) await inspector.getByRole("button", { name: "Close inspector", exact: true }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (overflow > 1) throw new Error(`mobile page overflows horizontally by ${overflow}px`);
  await lastWorker.scrollIntoViewIfNeeded();
  await lastWorker.click();
  await inspector.getByRole("heading", { name: "Worker 10", exact: true }).waitFor();
  const screenshot = await page.screenshot({ path: "test-results/flow-many-mobile.png", fullPage: true });
  if (!screenshot.byteLength) throw new Error("mobile screenshot is empty");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector("canvas");
    return canvas && Math.abs(canvas.width / devicePixelRatio - canvas.getBoundingClientRect().width) < 2;
  });
  await page.screenshot({ path: "test-results/flow-many-desktop.png", fullPage: true });
  if (errors.length) throw new Error(errors.join("\n"));
  return { independentPiSessions: 10, thirdPartyStreams: 1, duplicateAliasChoices: alphaOptions, toolRows: 15, trafficRows: 15, replaySelection, mobileHorizontalOverflow: overflow, pageErrors: errors.length };
}
