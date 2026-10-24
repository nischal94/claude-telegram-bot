import { describe, test, expect, mock, afterEach } from "bun:test";
import { fitMessage, TelegramClient } from "./telegram";

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

// Records each sendMessage body and answers with the next queued response.
function recordingFetch(responses: (() => Promise<Response>)[]) {
  const bodies: Record<string, unknown>[] = [];
  const inits: RequestInit[] = [];
  const fn = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    inits.push(init ?? {});
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    const next = responses.shift() ?? (async () => new Response('{"ok":true}'));
    return next();
  });
  globalThis.fetch = fn as any;
  return { fn, bodies, inits };
}

const ok = async () => new Response('{"ok":true}');
const status = (code: number, body = '{"ok":false}') => async () => new Response(body, { status: code });
const networkError = async (): Promise<Response> => {
  throw new Error("Unable to connect");
};

function client(sleeps: number[] = []): TelegramClient {
  return new TelegramClient(TOKEN, "42", { sleep: async (ms) => { sleeps.push(ms); } });
}

describe("message format", () => {
  test("sends plain text by default, with no parse_mode", async () => {
    const { bodies } = recordingFetch([ok]);
    await client().sendMessage("*not bold* _not italic_ [x](http://evil.test)");
    expect(bodies[0]).toEqual({ chat_id: "42", text: "*not bold* _not italic_ [x](http://evil.test)" });
  });

  test("sends HTML only when the caller asks for it", async () => {
    const { bodies } = recordingFetch([ok]);
    await client().sendMessage("<b>bold</b>", { parseMode: "HTML" });
    expect(bodies[0]).toMatchObject({ text: "<b>bold</b>", parse_mode: "HTML" });
  });

  test("cuts plain text over Telegram's limit and says so", async () => {
    const { bodies } = recordingFetch([ok]);
    await client().sendMessage("x".repeat(10_000));
    const text = bodies[0].text as string;
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.endsWith("…(truncated)")).toBe(true);
  });

  test("never cuts a character in half", () => {
    const text = fitMessage("a" + "😀".repeat(3000));
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false);
  });

  test("leaves text within the limit unchanged", () => {
    expect(fitMessage("hello")).toBe("hello");
  });
});

describe("timeouts", () => {
  test("every request carries an abort signal", async () => {
    const { inits } = recordingFetch([ok]);
    await client().sendMessage("hi");
    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
  });

  test("a request that never answers fails after the timeout", async () => {
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("The operation timed out.")));
    })) as any;
    const started = Date.now();
    const err = await caught(() => new TelegramClient(TOKEN, "42", { timeoutMs: 50 }).sendMessage("hi"));
    expect(Date.now() - started).toBeLessThan(2000);
    expect((err as Error).message).toContain("sendMessage request failed");
    expect(Bun.inspect(err)).not.toContain(TOKEN);
  });
});

describe("retries", () => {
  test("a 4xx other than 429 is not retried", async () => {
    const { fn } = recordingFetch([status(400), ok]);
    await caught(() => client().sendMessageWithRetry("hi"));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("a 5xx is retried", async () => {
    const { fn } = recordingFetch([status(502), status(503), ok]);
    await client().sendMessageWithRetry("hi");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("a network error is retried", async () => {
    const { fn } = recordingFetch([networkError, ok]);
    await client().sendMessageWithRetry("hi");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("a 429 waits for retry_after before retrying", async () => {
    const sleeps: number[] = [];
    recordingFetch([status(429, '{"ok":false,"parameters":{"retry_after":7}}'), ok]);
    await client(sleeps).sendMessageWithRetry("hi");
    expect(sleeps).toEqual([7000]);
  });

  test("gives up after the last attempt and throws the last error", async () => {
    const { fn } = recordingFetch([status(500), status(500), status(500), ok]);
    const err = await caught(() => client().sendMessageWithRetry("hi"));
    expect(fn).toHaveBeenCalledTimes(3);
    expect((err as Error).message).toContain("500");
  });

  test("photo uploads follow the same retry rules", async () => {
    const { fn } = recordingFetch([status(400)]);
    await caught(() => client().sendPhotoWithRetry("/nonexistent.png", "cap"));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
