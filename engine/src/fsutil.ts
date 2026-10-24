import { randomBytes } from "crypto";
import { renameSync, rmSync, writeFileSync } from "fs";

// Writes through a uniquely named temp file created exclusively with mode
// 0600, then renames it into place, so readers never see a partial file or
// a wider mode and concurrent writers never share a temp file. A failed
// write or rename removes the temp file before rethrowing.
export function writeOwnerOnly(path: string, contents: string): void {
  const tmpPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmpPath, contents, { mode: 0o600, flag: "wx" });
    renameSync(tmpPath, path);
  } catch (e) {
    rmSync(tmpPath, { force: true });
    throw e;
  }
}
