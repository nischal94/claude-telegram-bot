import { test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { makeTestDir } from "./test-tmp";

// deploy/launch_bot.sh, run from a copy of the repo layout with a stand-in
// `claude` that records its arguments and umask instead of starting the bot.
const LAUNCH_BOT = join(import.meta.dir, "..", "..", "deploy", "launch_bot.sh");

const MAIN_PROMPT = "MAIN-PROMPT: you are a Telegram assistant.";
const SNAPSHOT = "SNAPSHOT: <saved-memory>\n{\"type\":\"fact\"}\n</saved-memory>";
const INSTRUCTIONS = "INSTRUCTIONS: memory API usage.";

let root: string;
let home: string;
let record: string;

beforeEach(() => {
  root = makeTestDir("launch-bot-test-");
  home = join(root, "home");
  record = join(root, "record");
  mkdirSync(join(root, "deploy"));
  mkdirSync(join(root, "prompts"));
  mkdirSync(join(root, "stubs"));
  mkdirSync(join(home, ".claude", "engine"), { recursive: true });
  copyFileSync(LAUNCH_BOT, join(root, "deploy", "launch_bot.sh"));
  writeFileSync(join(root, "prompts", "current.txt"), MAIN_PROMPT);
  writeFileSync(join(root, "prompts", "memory-tool-instructions.txt"), INSTRUCTIONS);
  writeFileSync(join(root, "stubs", "claude"), `#!/bin/bash\numask > "${record}.umask"\nprintf '%s\\n' "$@" > "${record}.args"\n`);
  chmodSync(join(root, "stubs", "claude"), 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function launch(): { args: string[]; promptFile: string; prompt: string } {
  const proc = Bun.spawnSync(["/bin/bash", join(root, "deploy", "launch_bot.sh")], {
    env: { PATH: `${join(root, "stubs")}:/usr/bin:/bin`, HOME: home },
  });
  expect(proc.exitCode).toBe(0);
  const args = readFileSync(`${record}.args`, "utf-8").trimEnd().split("\n");
  const promptFile = args[args.indexOf("--append-system-prompt-file") + 1];
  return { args, promptFile, prompt: readFileSync(promptFile, "utf-8") };
}

test("passes the prompt as one file, never as argument text", () => {
  writeFileSync(join(home, ".claude", "engine", "memory-snapshot.md"), SNAPSHOT);
  const { args } = launch();
  expect(args.filter((a) => a === "--append-system-prompt-file")).toHaveLength(1);
  expect(args).not.toContain("--append-system-prompt");
  for (const text of ["MAIN-PROMPT", "SNAPSHOT", "INSTRUCTIONS"]) {
    expect(args.some((a) => a.includes(text))).toBe(false);
  }
});

test("the prompt file holds the main prompt, then memory, then the instructions", () => {
  writeFileSync(join(home, ".claude", "engine", "memory-snapshot.md"), SNAPSHOT);
  const { prompt } = launch();
  const at = (s: string) => prompt.indexOf(s);
  expect(at(MAIN_PROMPT)).toBe(0);
  expect(at(SNAPSHOT)).toBeGreaterThan(at(MAIN_PROMPT));
  expect(at(INSTRUCTIONS)).toBeGreaterThan(at(SNAPSHOT));
});

test("without a memory snapshot the prompt file holds the main prompt and the instructions", () => {
  const { prompt } = launch();
  expect(prompt).toContain(MAIN_PROMPT);
  expect(prompt).toContain(INSTRUCTIONS);
  expect(prompt).not.toContain("SNAPSHOT");
});

test("the prompt file is owner-only, in an owner-only folder", () => {
  const { promptFile } = launch();
  expect(statSync(promptFile).mode & 0o777).toBe(0o600);
  expect(statSync(join(promptFile, "..")).mode & 0o777).toBe(0o700);
});

test("leaves no temp prompt files behind", () => {
  const { promptFile } = launch();
  const dir = join(promptFile, "..");
  const leftovers = Bun.spawnSync(["/bin/ls", "-A", dir]).stdout.toString().trim().split("\n")
    .filter((f) => f.includes(".tmp"));
  expect(leftovers).toEqual([]);
  expect(existsSync(promptFile)).toBe(true);
});

test("the bot runs with umask 077", () => {
  launch();
  expect(readFileSync(`${record}.umask`, "utf-8").trim()).toBe("0077");
});
