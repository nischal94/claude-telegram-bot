import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// bin/notify.sh, run with stand-in `security` and `curl` commands.
const NOTIFY = join(import.meta.dir, "..", "..", "bin", "notify.sh");
const TOKEN = "123456789:FAKE-notify-test-token";

let dir: string;
let stubs: string;

function stub(name: string, body: string): void {
  const path = join(stubs, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "notify-test-"));
  stubs = join(dir, "stubs");
  mkdirSync(stubs);
  stub("security", `case "$*" in *telegram-bot-token*) echo "${TOKEN}" ;; *telegram-chat-id*) echo 42 ;; esac`);
  // Records its arguments and whatever arrives on stdin.
  stub("curl", `printf '%s\\n' "$@" > "${dir}/curl-args"; cat > "${dir}/curl-stdin"; exit 0`);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runNotify(message: string) {
  return Bun.spawnSync(["/bin/bash", NOTIFY, message], {
    env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: dir },
  });
}

test("notify.sh keeps the bot token out of curl's arguments", () => {
  expect(runNotify("hello world").exitCode).toBe(0);
  const args = readFileSync(join(dir, "curl-args"), "utf-8");
  expect(args).not.toContain(TOKEN);
});

test("notify.sh passes the request URL with the token to curl on stdin", () => {
  runNotify("hello world");
  const args = readFileSync(join(dir, "curl-args"), "utf-8").split("\n");
  const stdin = readFileSync(join(dir, "curl-stdin"), "utf-8");
  expect(args).toContain("-K");
  expect(args[args.indexOf("-K") + 1]).toBe("-");
  expect(stdin).toContain(`url = "https://api.telegram.org/bot${TOKEN}/sendMessage"`);
});

test("notify.sh still sends the chat id and the message", () => {
  runNotify("hello world");
  const args = readFileSync(join(dir, "curl-args"), "utf-8").split("\n");
  expect(args).toContain("chat_id=42");
  expect(args).toContain("text=hello world");
});
