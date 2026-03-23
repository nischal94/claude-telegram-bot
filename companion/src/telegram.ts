const BASE = "https://api.telegram.org";

export class TelegramClient {
  private token: string;
  private chatId: string;
  private offset = 0;

  constructor(token: string, chatId: string) {
    this.token = token;
    this.chatId = chatId;
  }

  async sendMessage(text: string): Promise<void> {
    const res = await fetch(`${BASE}/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: "Markdown" }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`[telegram] sendMessage failed: ${res.status} ${body}`);
    }
  }

  async sendMessageWithRetry(text: string, attempts = 3): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.sendMessage(text);
        return;
      } catch (e) {
        if (i === attempts - 1) throw e;
        await Bun.sleep((2 ** i) * 1000);
      }
    }
  }

  async sendPhoto(imagePath: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", this.chatId);
    form.append("photo", Bun.file(imagePath));
    if (caption) form.append("caption", caption);

    const res = await fetch(`${BASE}/bot${this.token}/sendPhoto`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`[telegram] sendPhoto failed: ${res.status} ${body}`);
    }
  }

  async sendPhotoWithRetry(imagePath: string, caption?: string, attempts = 3): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.sendPhoto(imagePath, caption);
        return;
      } catch (e) {
        if (i === attempts - 1) throw e;
        await Bun.sleep((2 ** i) * 1000);
      }
    }
  }

  // Poll for updates containing a specific pong nonce.
  // Returns true if pong received within timeoutMs.
  //
  // NOTE: This polls getUpdates independently of the Telegram plugin's poller.
  // Two consumers on the same bot token race for updates — whichever advances
  // offset first causes the other to miss those updates. In practice, the
  // companion only polls for 90s every 5 minutes and only looks for its own
  // nonce-tagged pong message. The bot plugin processes all other messages.
  // This is an acceptable tradeoff for a personal single-user bot.
  async waitForPong(nonce: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const pattern = `[HEARTBEAT_PONG_${nonce}]`;
    while (Date.now() < deadline) {
      const res = await fetch(
        `${BASE}/bot${this.token}/getUpdates?offset=${this.offset}&timeout=5&allowed_updates=["message"]`
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
