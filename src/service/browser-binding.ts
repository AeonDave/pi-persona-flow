import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const BINDING_FILE = "browser.json";
interface BrowserBinding { version: 1; desiredPort: number; url: string }

/** Only the read-only browser capability survives a daemon; private control credentials never do. */
export async function readBrowserBinding(directory: string, desiredPort: number): Promise<{ port: number; token: string } | undefined> {
  let handle: fs.FileHandle;
  try { handle = await fs.open(path.join(directory, BINDING_FILE), "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  let value: unknown;
  try {
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024) throw new Error("Flow browser binding exceeds its bounded size");
    try { value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
    catch { throw new Error("Flow browser binding is malformed"); }
  } finally { await handle.close(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Flow browser binding is invalid");
  const binding = value as Record<string, unknown>;
  if (binding.version !== 1 || !Number.isSafeInteger(binding.desiredPort) || (binding.desiredPort as number) < 0 || (binding.desiredPort as number) > 65_535) {
    throw new Error("Flow browser binding has an invalid version or desired port");
  }
  if (typeof binding.url !== "string") throw new Error("Flow browser binding URL is invalid");
  let url: URL;
  try { url = new URL(binding.url); }
  catch { throw new Error("Flow browser binding URL is invalid"); }
  const token = url.searchParams.get("token") ?? "";
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || Number(url.port) < 1 || url.username || url.password || url.pathname !== "/" || url.hash ||
      !/^[0-9A-Za-z]{4}$/.test(token) || url.searchParams.size !== 1) {
    throw new Error("Flow browser binding is not an authenticated loopback dashboard URL");
  }
  return binding.desiredPort === desiredPort ? { port: Number(url.port), token } : undefined;
}

/** Startup election serializes writers; atomic replacement preserves the last complete binding. */
export async function writeBrowserBinding(directory: string, desiredPort: number, url: string): Promise<void> {
  const file = path.join(directory, BINDING_FILE);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify({ version: 1, desiredPort, url } satisfies BrowserBinding), "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temporary, file);
  }
  finally { await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
}
