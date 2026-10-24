const BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const MAX_RETRY_AFTER_MS = 60_000;

// Telegram rejects messages longer than this many characters.
export const MAX_MESSAGE_CHARS = 4096;
const TRUNCATION_MARK = "\n…(truncated)";

export interface TelegramClientOptions {
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SendOptions {
  // Plain text unless the caller asks for HTML. Model and job output is
  // always sent plain, so link text cannot hide a different URL.
  parseMode?: "HTML";
  attempts?: number;
}

// An HTTP error answer from the Bot API.
export class TelegramApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

// Network errors, timeouts, rate limits and server errors may succeed on a
// later try; any other API error will fail the same way again.
function isRetryable(e: unknown): boolean {
  if (e instanceof TelegramApiError) return e.status === 429 || e.status >= 500;
  return true;
}

// Cuts text over Telegram's limit and marks the cut, without splitting a
// character that takes two UTF-16 code units.
export function fitMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  let end = MAX_MESSAGE_CHARS - TRUNCATION_MARK.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end) + TRUNCATION_MARK;
}

export class TelegramClient {
  private token: string;
  private chatId: string;
  private offset = 0;
  private timeoutMs: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(token: string, chatId: string, options: TelegramClientOptions = {}) {
    this.token = token;
    this.chatId = chatId;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  }

  private redact(text: string): string {
    return text
      .replaceAll(this.token, "<redacted>")
      .replaceAll(encodeURIComponent(this.token), "<redacted>");
  }

  // Every request URL contains the token. When fetch itself fails, Bun's error
  // carries that URL in its message and `path`, and callers log errors whole,
  // so rethrow a plain error with the token masked. No `cause`: loggers print it.
  // Every request has a timeout, so a stalled connection cannot block the
  // cron queue that waits for it.
  private async request(method: string, init?: RequestInit, query = "", timeoutMs = this.timeoutMs): Promise<Response> {
    try {
      return await fetch(`${BASE}/bot${this.token}/${method}${query}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const reason = this.redact(e instanceof Error ? e.message : String(e));
      throw new Error(`[telegram] ${method} request failed: ${reason}`);
    }
  }

  private async check(method: string, res: Response): Promise<void> {
    if (res.ok) return;
    const body = await res.text();
    let retryAfterMs: number | undefined;
    try {
      const seconds = (JSON.parse(body) as { parameters?: { retry_after?: unknown } }).parameters?.retry_after;
      if (typeof seconds === "number" && seconds > 0) retryAfterMs = Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    } catch {
      // Not JSON; no retry_after.
    }
    throw new TelegramApiError(`[telegram] ${method} failed: ${res.status} ${this.redact(body)}`, res.status, retryAfterMs);
  }

  // Retries only errors that may succeed later, waiting retry_after on a 429
  // and backing off 1 s, 2 s, ... otherwise.
  private async withRetry(attempts: number, send: () => Promise<void>): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await send();
        return;
      } catch (e) {
        if (i === attempts - 1 || !isRetryable(e)) throw e;
        const wait = e instanceof TelegramApiError && e.retryAfterMs !== undefined ? e.retryAfterMs : (2 ** i) * 1000;
        await this.sleep(wait);
      }
    }
  }

  // Plain text is cut to Telegram's limit with a marker. HTML is sent as
  // given: cutting it could break a tag, so HTML callers keep it short.
  async sendMessage(text: string, options: SendOptions = {}): Promise<void> {
    const body = options.parseMode
      ? { chat_id: this.chatId, text, parse_mode: options.parseMode }
      : { chat_id: this.chatId, text: fitMessage(text) };
    const res = await this.request("sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await this.check("sendMessage", res);
  }

  async sendMessageWithRetry(text: string, options: SendOptions = {}): Promise<void> {
    await this.withRetry(options.attempts ?? 3, () => this.sendMessage(text, options));
  }

  async sendPhoto(imagePath: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", this.chatId);
    form.append("photo", Bun.file(imagePath));
    if (caption) form.append("caption", caption);

    const res = await this.request("sendPhoto", { method: "POST", body: form }, "", UPLOAD_TIMEOUT_MS);
    await this.check("sendPhoto", res);
  }

  async sendPhotoWithRetry(imagePath: string, caption?: string, attempts = 3): Promise<void> {
    await this.withRetry(attempts, () => this.sendPhoto(imagePath, caption));
  }

  // Poll for updates containing a specific pong nonce.
  // Returns true if pong received within timeoutMs.
  //
  // NOTE: This polls getUpdates independently of the Telegram plugin's poller.
  // Two consumers on the same bot token race for updates — whichever advances
  // offset first causes the other to miss those updates. In practice, the
  // engine only polls for 90s every 5 minutes and only looks for its own
  // nonce-tagged pong message. The bot plugin processes all other messages.
  // This is an acceptable tradeoff for a personal single-user bot.
  async waitForPong(nonce: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const pattern = `[HEARTBEAT_PONG_${nonce}]`;
    while (Date.now() < deadline) {
      const res = await this.request(
        "getUpdates",
        undefined,
        `?offset=${this.offset}&timeout=5&allowed_updates=["message"]`
      );
      if (!res.ok) {
        await Bun.sleep(2000);
        continue;
      }
      const data = await res.json() as { result: { update_id: number; message?: { text?: string } }[] };
      for (const update of data.result) {
        this.offset = update.update_id + 1;
        if (update.message?.text?.includes(pattern)) return true;
      }
    }
    return false;
  }
}
