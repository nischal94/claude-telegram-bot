import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { makeTestDir } from "./test-tmp";
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
  dir = makeTestDir("notify-test-");
  stubs = join(dir, "stubs");
  mkdirSync(stubs);
  stub("security", `case "$*" in *telegram-bot-token*) echo "${TOKEN}" ;; *telegram-chat-id*) echo 42 ;; esac`);
  // Returns at once, so retry delays cost no test time.
  stub("sleep", "exit 0");
  // Counts its calls, records its arguments, stdin and environment, and
  // prints the HTTP status in CURL_CODE (default 200), as -w '%{http_code}' does.
  stub("curl", `echo x >> "${dir}/curl-calls"
printf '%s' "\${TELEGRAM_BOT_TOKEN:-}" > "${dir}/curl-env-token"
printf '%s\\n' "$@" > "${dir}/curl-args"; cat > "${dir}/curl-stdin"
printf '%s' "\${CURL_CODE:-200}"`);
});

function calls(): number {
  return readFileSync(join(dir, "curl-calls"), "utf-8").trim().split("\n").length;
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runNotify(message: string, extraEnv: Record<string, string> = {}) {
  rmSync(join(dir, "curl-calls"), { force: true });
  return Bun.spawnSync(["/bin/bash", NOTIFY, message], {
    env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: dir, CLAUDE_BOT_NOTIFY_DELAY: "0", ...extraEnv },
  });
}

test("notify.sh sends once when Telegram accepts the message", () => {
  const result = runNotify("hello");
  expect(result.exitCode).toBe(0);
  expect(calls()).toBe(1);
  expect(result.stderr.toString()).toBe("");
});

for (const code of ["000", "429", "503"]) {
  test(`notify.sh retries HTTP ${code}, reports the failure, and still exits 0`, () => {
    const result = runNotify("hello", { CURL_CODE: code });
    expect(result.exitCode).toBe(0);
    expect(calls()).toBe(3);
    expect(result.stderr.toString()).toContain("message not sent after 3 attempts");
    expect(result.stderr.toString()).not.toContain(TOKEN);
  });
}

test("notify.sh does not retry a permanent rejection such as HTTP 401", () => {
  const result = runNotify("hello", { CURL_CODE: "401" });
  expect(result.exitCode).toBe(0);
  expect(calls()).toBe(1);
  expect(result.stderr.toString()).toContain("Telegram rejected the message: HTTP 401");
});

test("notify.sh accepts a delay override with a leading zero", () => {
  const result = runNotify("hello", { CURL_CODE: "503", CLAUDE_BOT_NOTIFY_DELAY: "08" });
  expect(result.exitCode).toBe(0);
  expect(calls()).toBe(3);
  expect(result.stderr.toString()).not.toContain("value too great for base");
  expect(result.stderr.toString()).toContain("message not sent after 3 attempts");
});

// Uses 503 so the script reaches the delay arithmetic.
test("notify.sh falls back to the default delay when the override is not a whole number", () => {
  const result = runNotify("hello", { CURL_CODE: "503", CLAUDE_BOT_NOTIFY_DELAY: "1.5" });
  expect(result.exitCode).toBe(0);
  expect(calls()).toBe(3);
  expect(result.stderr.toString()).not.toContain("syntax error");
  expect(result.stderr.toString()).toContain("message not sent after 3 attempts");
}, 15_000);

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
