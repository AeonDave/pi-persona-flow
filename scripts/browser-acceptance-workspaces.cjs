// Run against test-results/serve-workspaces.mts, then send `add` on its stdin and inspect the menu.
async (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const picker = page.getByRole("combobox", { name: "Workspace", exact: true });
  await picker.waitFor();
  const choices = await picker.locator("option").evaluateAll((items) => items.map((item) => ({ id: item.value, label: item.textContent })));
  const client = choices.find((item) => item.label.startsWith("client ·"));
  const api = choices.find((item) => item.label.startsWith("api ·"));
  if (!client || !api || !choices.every((item) => /5 active sessions/.test(item.label))) throw new Error("workspace catalog/session counts are wrong");
  await picker.selectOption(client.id);
  const worker = page.getByRole("button", { name: /^agent Client worker 1, waiting/ });
  await worker.waitFor(); await worker.click();
  const inspector = page.getByRole("complementary", { name: "Selected node inspector" });
  await inspector.getByRole("heading", { name: "Client worker 1", exact: true }).waitFor();
  await page.getByRole("button", { name: "REVIEW", exact: true }).click();
  await page.getByRole("slider", { name: "Replay event position in recorded order", exact: true }).press("Home");
  await picker.selectOption(api.id);
  await page.getByRole("button", { name: /^agent API worker 1, waiting/ }).waitFor();
  if (await page.getByRole("button", { name: /^agent Client / }).count()) throw new Error("old workspace cards leaked across selection");
  await inspector.getByRole("heading", { name: "Nothing selected", exact: true }).waitFor();
  if (!(await page.getByText("NOW / FOLLOWING RECORDED ORDER", { exact: true }).isVisible())) throw new Error("replay state did not reset on workspace switch");
  if (await page.evaluate(() => new URL(location.href).searchParams.get("workspace")) !== api.id) throw new Error("selection was not retained in URL");
  await page.reload();
  await page.getByRole("button", { name: /^agent API worker 1, waiting/ }).waitFor();
  if (await picker.inputValue() !== api.id) throw new Error("reload changed workspace");
  const endpoint = await page.evaluate(() => { const url = new URL(location.href); url.pathname = "/api/snapshot"; return url.href; });
  const snapshot = await page.request.get(endpoint);
  const raw = await snapshot.text();
  if (snapshot.status() !== 200 || /Client worker|CANARY|controlToken|flow-browser-workspaces-/.test(raw)) throw new Error("snapshot leaked foreign workspace, unsafe fields or private paths");
  if ((await page.request.get(endpoint.replace(/workspace=[^&]*/, "workspace=unknown"))).status() !== 404) throw new Error("unknown workspace silently fell back");
  await page.getByRole("button", { name: /^agent API worker 5, running/ }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: /^agent API worker 5, running/ }).click();
  await inspector.getByRole("heading", { name: "API worker 5", exact: true }).waitFor();
  await page.waitForFunction(() => {
    const canvas = document.querySelector("canvas");
    return canvas && Math.abs(canvas.width / devicePixelRatio - canvas.getBoundingClientRect().width) < 2;
  });
  await page.screenshot({ path: "test-results/flow-workspaces-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await inspector.isVisible()) await inspector.getByRole("button", { name: "Close inspector", exact: true }).click();
  await picker.selectOption(client.id);
  await worker.waitFor(); await worker.scrollIntoViewIfNeeded(); await worker.click();
  await inspector.getByRole("heading", { name: "Client worker 1", exact: true }).waitFor();
  await page.waitForFunction(() => {
    const canvas = document.querySelector("canvas");
    return canvas && Math.abs(canvas.width / devicePixelRatio - canvas.getBoundingClientRect().width) < 2;
  });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (overflow > 1) throw new Error(`mobile horizontal overflow ${overflow}px`);
  await page.screenshot({ path: "test-results/flow-workspaces-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  if (errors.length) throw new Error(errors.join("\n"));
  return { workspaces: choices.length, piSessions: 10, isolation: "passed (colliding IDs)", reload: "preserves workspace", replay: "reset on switch", mobileOverflow: overflow, pageErrors: errors.length };
}
