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
  // Records its arguments and whatever arrives on stdin. With CURL_FAIL set,
  // counts the call and fails the way `curl --fail` does on an HTTP error.
  stub("curl", `if [ -n "\${CURL_FAIL:-}" ]; then echo x >> "${dir}/curl-calls"; cat > /dev/null; exit 22; fi
printf '%s' "\${TELEGRAM_BOT_TOKEN:-}" > "${dir}/curl-env-token"
printf '%s\\n' "$@" > "${dir}/curl-args"; cat > "${dir}/curl-stdin"; exit 0`);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runNotify(message: string, extraEnv: Record<string, string> = {}) {
  return Bun.spawnSync(["/bin/bash", NOTIFY, message], {
    env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: dir, ...extraEnv },
  });
}

test("notify.sh retries a failed send, reports it, and still exits 0", () => {
  rmSync(join(dir, "curl-calls"), { force: true });
  const result = runNotify("hello", { CURL_FAIL: "1", CLAUDE_BOT_NOTIFY_DELAY: "0" });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(dir, "curl-calls"), "utf-8").trim().split("\n")).toHaveLength(3);
  expect(result.stderr.toString()).toContain("message not sent after 3 attempts");
  expect(result.stderr.toString()).not.toContain(TOKEN);
});

test("notify.sh keeps the token out of curl's environment even if the caller exported the name", () => {
  runNotify("hello", { TELEGRAM_BOT_TOKEN: "exported-by-caller" });
  expect(readFileSync(join(dir, "curl-env-token"), "utf-8")).toBe("");
});

test("notify.sh does not print the token when run with bash -x", () => {
  const result = Bun.spawnSync(["/bin/bash", "-x", NOTIFY, "hello"], {
    env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: dir },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).not.toContain(TOKEN);
});

test("notify.sh passes --fail, so an HTTP error counts as a failed attempt", () => {
  runNotify("hello");
  expect(readFileSync(join(dir, "curl-args"), "utf-8").split("\n")).toContain("--fail");
});

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
  expect(args).toContain('link_preview_options={"is_disabled":true}');
});
