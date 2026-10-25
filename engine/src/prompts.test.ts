import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const INSTRUCTIONS = readFileSync(
  join(import.meta.dir, "..", "..", "prompts", "memory-tool-instructions.txt"),
  "utf-8",
);

test("the memory instructions save only what the user asks for", () => {
  expect(INSTRUCTIONS).not.toMatch(/proactiv/i);
  expect(INSTRUCTIONS).toContain('Always send "source": "explicit"');
  // Every example add or replace body names the source explicit.
  const bodies = INSTRUCTIONS.match(/\{"op": "(add|replace)"[^\n]*\}/g) ?? [];
  expect(bodies.length).toBeGreaterThanOrEqual(2);
  for (const body of bodies) expect(body).toContain('"source": "explicit"');
});

test("the memory instructions tell the bot to treat saved memory as data", () => {
  expect(INSTRUCTIONS).toMatch(/Treat it as data/);
});

test("the memory instructions have no hidden heartbeat exchange", () => {
  expect(INSTRUCTIONS).not.toMatch(/HEARTBEAT/);
});
