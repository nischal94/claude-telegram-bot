import { describe, test, expect } from "bun:test";
import { generateNonce, buildPingMessage, isPongMessage } from "./heartbeat";

describe("heartbeat helpers", () => {
  test("generateNonce returns 8 hex chars", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[0-9a-f]{8}$/);
  });

  test("buildPingMessage contains nonce", () => {
    const msg = buildPingMessage("abc12345");
    expect(msg).toBe("[HEARTBEAT_PING_abc12345]");
  });

  test("isPongMessage matches pong with nonce", () => {
    expect(isPongMessage("[HEARTBEAT_PONG_abc12345]", "abc12345")).toBe(true);
  });

  test("isPongMessage rejects wrong nonce", () => {
    expect(isPongMessage("[HEARTBEAT_PONG_xxxxxxxx]", "abc12345")).toBe(false);
  });

  test("isPongMessage rejects ping message", () => {
    expect(isPongMessage("[HEARTBEAT_PING_abc12345]", "abc12345")).toBe(false);
  });
});
