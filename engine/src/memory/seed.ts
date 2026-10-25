import { existsSync, readFileSync, writeFileSync } from "fs";
import { MAX_KEY_LENGTH, MAX_VALUE_LENGTH, MEMORY_TYPES, type MemoryEntry, type MemoryStore } from "./store";

function toEntry(raw: unknown): MemoryEntry {
  const e = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof e.type !== "string" || !MEMORY_TYPES.has(e.type)) throw new Error("entry type must be preference, fact or learned");
  if (typeof e.key !== "string" || e.key.length === 0 || e.key.length > MAX_KEY_LENGTH) throw new Error("entry key is missing or too long");
  if (typeof e.value !== "string" || e.value.length === 0 || e.value.length > MAX_VALUE_LENGTH) throw new Error("entry value is missing or too long");
  return { type: e.type as MemoryEntry["type"], key: e.key, value: e.value, source: "explicit" };
}

const SEED_IMPORT = "memories-seed";

// Imports memories-seed.json once. The seed is the owner's own file, so its
// entries count as explicit. The store imports all entries or none, and
// records the import in the same transaction, so a failure leaves nothing
// behind and the seed is never imported twice. The flag file is written for
// older engines, which check only the file.
export function importSeed(store: MemoryStore, seedPath: string, flagPath: string): void {
  if (!existsSync(seedPath) || existsSync(flagPath)) return;
  try {
    const parsed: unknown = JSON.parse(readFileSync(seedPath, "utf-8"));
    if (!Array.isArray(parsed)) throw new Error("expected a list of entries");
    const entries = parsed.map(toEntry);
    // false: the database already recorded this import, but the flag file
    // is missing (an earlier write failed). Write it below.
    if (store.importOnce(SEED_IMPORT, entries)) console.log(`[engine] imported ${entries.length} seed memories`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[engine] Failed to import seed: ${msg}. Context: path=${seedPath}`);
    return;
  }
  try {
    writeFileSync(flagPath, new Date().toISOString(), "utf-8");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[engine] Failed to write the seed flag: ${msg}. Context: path=${flagPath}`);
  }
}
