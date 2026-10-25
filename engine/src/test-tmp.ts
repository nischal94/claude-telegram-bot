import { mkdirSync, mkdtempSync } from "fs";
import { join } from "path";

// Tests create their temp folders here, inside the repo (git-ignored), not
// in the system temp folder. Sandboxed runners often block the system temp
// folder, and some give Bun no TMPDIR, so os.tmpdir() falls back to /tmp.
const ROOT = join(import.meta.dir, "..", ".test-tmp");

export function makeTestDir(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  return mkdtempSync(join(ROOT, prefix));
}
