import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { AllMemories } from "./store";

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

  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, lines.join("\n"), "utf-8");
}
