import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Cleanup = () => void | Promise<void>;

/** Owns only the temporary roots and handles explicitly created by one test file. */
export function createFixtureScope() {
  const roots = new Set<string>();
  const handles = new Set<Cleanup>();

  return {
    tempDirectory(prefix: string): string {
      if (!prefix || /[\\/]/.test(prefix)) throw new TypeError("temporary directory prefix must be a non-empty name");
      const directory = mkdtempSync(join(tmpdir(), prefix));
      roots.add(directory);
      return directory;
    },

    trackHandle(cleanup: Cleanup): void {
      handles.add(cleanup);
    },

    async cleanup(): Promise<void> {
      const errors: unknown[] = [];
      // Close every server/tailer before removing any fixture data, even if one close fails.
      for (const close of [...handles].reverse()) {
        try { await close(); }
        catch (error) { errors.push(error); }
      }
      for (const directory of [...roots].reverse()) {
        try {
          await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch (error) {
          errors.push(error);
        }
      }
      handles.clear();
      roots.clear();
      if (errors.length > 0) throw new AggregateError(errors, "failed to close test handles or remove owned temporary fixtures");
    },
  };
}
