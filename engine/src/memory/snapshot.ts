import { mkdirSync } from "fs";
import { dirname } from "path";
import type { AllMemories } from "./store";
import { writeOwnerOnly } from "../fsutil";

export function writeSnapshot(snapshotPath: string, memories: AllMemories): void {
  const lines: string[] = ["## Your Memory", ""];

  const section = (title: string, entries: { key: string; value: string }[]) => {
    lines.push(`### ${title}`);
    if (entries.length === 0) {
      lines.push("_(none yet)_");
    } else {
      for (const e of entries) lines.push(`- ${e.key}: ${e.value}`);
    }
    lines.push("");
  };

  section("Preferences", memories.preferences);
  section("Facts", memories.facts);
  section("Learned", memories.learned);

  mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
  // The snapshot holds the owner's personal memory: owner-only.
  writeOwnerOnly(snapshotPath, lines.join("\n"));
}
