import { test, expect, mock, afterEach } from "bun:test";
import { TelegramClient } from "./telegram";

// Fake token: the shape of a real one, valid nowhere.
const TOKEN = "123456789:FAKE-test-token_for-redaction";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Bun's fetch rejects with an error that carries the request URL in `path`.
function failingFetch(url: string) {
  const err = Object.assign(
    new Error(`Unable to connect. Is the computer able to access the url? ${url}`),
    { code: "ConnectionRefused", path: url },
  );
  return Promise.reject(err);
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw");
}

// [client method, Telegram API method its error names, call]
const calls: [string, string, (c: TelegramClient) => Promise<unknown>][] = [
  ["sendMessage", "sendMessage", (c) => c.sendMessage("hi")],
  ["sendPhoto", "sendPhoto", (c) => c.sendPhoto("/nonexistent.png", "cap")],
  ["waitForPong", "getUpdates", (c) => c.waitForPong("n1", 5_000)],
];

for (const [label, apiMethod, call] of calls) {
  test(`${label}: a network error does not expose the bot token`, async () => {
    globalThis.fetch = mock((input: string | URL | Request) => failingFetch(String(input))) as any;
    const err = await caught(() => call(new TelegramClient(TOKEN, "42")));

    expect(err).toBeInstanceOf(Error);
    expect(Bun.inspect(err)).not.toContain(TOKEN);
    expect(String(err)).not.toContain(TOKEN);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
    expect((err as Error).message).toContain("<redacted>");
    expect((err as Error).message).toContain(apiMethod);
  });
}

test("a percent-encoded token in the error message is masked too", async () => {
  globalThis.fetch = mock(() => Promise.reject(new Error(`failed: bot${encodeURIComponent(TOKEN)}/sendMessage`))) as any;
  const err = await caught(() => new TelegramClient(TOKEN, "42").sendMessage("hi"));

  expect(Bun.inspect(err)).not.toContain(encodeURIComponent(TOKEN));
  expect((err as Error).message).toContain("<redacted>");
});

test("an error response keeps its status and body", async () => {
  globalThis.fetch = mock(async () => new Response('{"ok":false,"description":"Bad Request"}', { status: 400 })) as any;
  const err = await caught(() => new TelegramClient(TOKEN, "42").sendMessage("hi"));

  expect((err as Error).message).toContain("400");
  expect((err as Error).message).toContain("Bad Request");
  expect(Bun.inspect(err)).not.toContain(TOKEN);
});
