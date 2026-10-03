export const MIN_PI_VERSION = "1.0.0";

/** Compare the host release against 1.0.0 without importing or invoking Pi. */
export function isSupportedPiVersion(version: string): boolean {
  const parsed = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!parsed) return false;
  const parts = parsed.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return false;
  const [major, minor, patch] = parts as [number, number, number];
  if (major !== 1) return major > 1;
  if (minor !== 0 || patch !== 0) return true;
  return parsed[4] === undefined;
}
