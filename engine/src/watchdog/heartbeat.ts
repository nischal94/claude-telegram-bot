import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { TelegramClient } from "../telegram";

export function generateNonce(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

export function buildPingMessage(nonce: string): string {
  return `[HEARTBEAT_PING_${nonce}]`;
}

export function isPongMessage(text: string, nonce: string): boolean {
  return text.includes(`[HEARTBEAT_PONG_${nonce}]`);
}

function logHealth(logPath: string, message: string): void {
  const ts = new Date().toISOString().slice(0, 19);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${ts} ${message}\n`, "utf-8");
}

export class HeartbeatWatchdog {
  private telegram: TelegramClient;
  private healthLogPath: string;
  private intervalMs: number;
  private pongTimeoutMs: number;
  private onHung: () => Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private missedPings = 0;

  constructor(opts: {
    telegram: TelegramClient;
    healthLogPath: string;
    intervalMs?: number;
    pongTimeoutMs?: number;
    onHung: () => Promise<void>;
  }) {
    this.telegram = opts.telegram;
    this.healthLogPath = opts.healthLogPath;
    this.intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? 90 * 1000;
    this.onHung = opts.onHung;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    console.log("[heartbeat] watchdog started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const nonce = generateNonce();
    try {
      await this.telegram.sendMessage(buildPingMessage(nonce));
      const pongReceived = await this.telegram.waitForPong(nonce, this.pongTimeoutMs);
      if (pongReceived) {
        this.missedPings = 0;
        logHealth(this.healthLogPath, "HEALTHY");
      } else {
        this.missedPings++;
        logHealth(this.healthLogPath, `MISSED PONG (${this.missedPings})`);
        if (this.missedPings >= 2) {
          logHealth(this.healthLogPath, "HUNG — triggering recovery");
          this.missedPings = 0;
          await this.onHung();
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logHealth(this.healthLogPath, `PING ERROR: ${msg}`);
    }
  }
}
