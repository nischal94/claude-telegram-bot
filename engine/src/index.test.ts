import { describe, test, expect, afterAll, spyOn } from "bun:test";

// Must be set before index.ts module loads and calls loadConfig()
process.env.COMPANION_TEST_PORT = "7824";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "123456";
process.env.ANTHROPIC_API_KEY = "test-key";

import { buildFetchHandler, generateApiToken, publishApiToken, serveOptions } from "./index";
import { MemoryStore } from "./memory/store";
import { CronRegistry } from "./cron/registry";
import { CronScheduler } from "./cron/scheduler";
import { createMemoryRouter } from "./memory/handler";
import { createCronRouter } from "./cron/handler";
import { TelegramClient } from "./telegram";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Set up isolated test fixtures in a fresh directory, so runs never share state
const testDir = mkdtempSync(join(tmpdir(), "engine-test-"));

const store = new MemoryStore(join(testDir, "test-memory.db"));
const registry = new CronRegistry(join(testDir, "test-cron-jobs.json"));
const telegram = new TelegramClient("test-token", "123456");
const scheduler = new CronScheduler(registry, telegram, "test-key");
const snapshotPath = join(testDir, "test-snapshot.md");

const API_TOKEN = "a".repeat(64);
const PORT = 7824;

const memoryRouter = createMemoryRouter(store, snapshotPath);
const cronRouter = createCronRouter(registry, scheduler);
const handler = buildFetchHandler(memoryRouter, cronRouter, { token: API_TOKEN, port: PORT });

interface RequestOptions {
  body?: string;
  headers?: Record<string, string>;
  host?: string;
  token?: string | null;
}

// Helper to make mock requests; sends the API token unless token is null
function makeRequest(method: string, path: string, opts: RequestOptions = {}): Request {
  const headers: Record<string, string> = { ...opts.headers };
  const token = opts.token === undefined ? API_TOKEN : opts.token;
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  return new Request(`http://${opts.host ?? `127.0.0.1:${PORT}`}${path}`, {
    method,
    headers,
    body: opts.body,
  });
}

function jsonRequest(method: string, path: string, body: unknown, opts: RequestOptions = {}): Request {
  return makeRequest(method, path, {
    ...opts,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...opts.headers },
  });
}

function cronJob(id: string): Record<string, string> {
  return { id, schedule: "0 0 1 1 *", type: "reminder", message: "x" };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "engine-token-"));
  try {
    fn(dir);
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
}

afterAll(() => {
  store.close();
  registry.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe("engine HTTP server", () => {
  test("GET /health returns ok", async () => {
    const res = await handler(makeRequest("GET", "/health"));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("GET /memory returns empty collections", async () => {
    const res = await handler(makeRequest("GET", "/memory"));
    expect(res.status).toBe(200);
    const body = await res.json() as { preferences: unknown[]; facts: unknown[]; learned: unknown[] };
    expect(Array.isArray(body.preferences)).toBe(true);
    expect(Array.isArray(body.facts)).toBe(true);
    expect(Array.isArray(body.learned)).toBe(true);
  });

  test("GET /cron returns empty array", async () => {
    const res = await handler(makeRequest("GET", "/cron"));
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  test("unknown route returns 404", async () => {
    const res = await handler(makeRequest("GET", "/unknown"));
    expect(res.status).toBe(404);
  });
});

describe("engine HTTP request checks", () => {
  test("GET /health needs no token", async () => {
    const res = await handler(makeRequest("GET", "/health", { token: null }));
    expect(res.status).toBe(200);
  });

  test("request without a token is rejected with 401", async () => {
    const res = await handler(makeRequest("GET", "/memory", { token: null }));
    expect(res.status).toBe(401);
  });

  test("request with a wrong token is rejected with 401", async () => {
    const res = await handler(makeRequest("GET", "/cron", { token: "b".repeat(64) }));
    expect(res.status).toBe(401);
  });

  test("request with a token of the wrong length is rejected with 401", async () => {
    const res = await handler(makeRequest("GET", "/cron", { token: "a" }));
    expect(res.status).toBe(401);
  });

  test("the right token under another auth scheme is rejected with 401", async () => {
    const res = await handler(makeRequest("GET", "/cron", { token: null, headers: { Authorization: `Token ${API_TOKEN}` } }));
    expect(res.status).toBe(401);
  });

  test("every state-changing route rejects a request without a token and changes nothing", async () => {
    registry.create(cronJob("keep-me"));
    const requests = [
      jsonRequest("POST", "/memory", { op: "add", type: "fact", key: "no-token", value: "x" }, { token: null }),
      makeRequest("POST", "/memory/snapshot", { token: null }),
      jsonRequest("POST", "/cron", cronJob("no-token"), { token: null }),
      jsonRequest("PATCH", "/cron/keep-me", { enabled: false }, { token: null }),
      makeRequest("DELETE", "/cron/keep-me", { token: null }),
      makeRequest("POST", "/cron/keep-me/run", { token: null }),
    ];
    for (const req of requests) {
      const res = await handler(req);
      expect(res.status).toBe(401);
    }
    expect(registry.get("no-token")).toBeUndefined();
    expect(registry.get("keep-me")?.enabled).toBe(true);
    const memory = await (await handler(makeRequest("GET", "/memory"))).json() as { facts: { key: string }[] };
    expect(memory.facts.some((f) => f.key === "no-token")).toBe(false);
    registry.remove("keep-me");
  });

  test("request for a foreign Host is rejected with 403, even with the token", async () => {
    const res = await handler(makeRequest("GET", "/memory", { host: `attacker.test:${PORT}` }));
    expect(res.status).toBe(403);
  });

  test("request for the right host on another port is rejected with 403", async () => {
    const res = await handler(makeRequest("GET", "/memory", { host: "127.0.0.1:9999" }));
    expect(res.status).toBe(403);
  });

  test("request with localhost as Host is accepted", async () => {
    const res = await handler(makeRequest("GET", "/memory", { host: `localhost:${PORT}` }));
    expect(res.status).toBe(200);
  });

  test("request with an Origin header is rejected with 403, even with the token", async () => {
    const res = await handler(makeRequest("GET", "/memory", { headers: { Origin: "https://attacker.test" } }));
    expect(res.status).toBe(403);
  });

  test("request with a cross-site Sec-Fetch-Site is rejected with 403", async () => {
    const res = await handler(makeRequest("GET", "/memory", { headers: { "Sec-Fetch-Site": "cross-site" } }));
    expect(res.status).toBe(403);
  });

  test("request with a same-site Sec-Fetch-Site is rejected with 403", async () => {
    const res = await handler(makeRequest("GET", "/memory", { headers: { "Sec-Fetch-Site": "same-site" } }));
    expect(res.status).toBe(403);
  });

  test("request with Sec-Fetch-Site none is accepted", async () => {
    const res = await handler(makeRequest("GET", "/memory", { headers: { "Sec-Fetch-Site": "none" } }));
    expect(res.status).toBe(200);
  });

  test("text/plain POST /cron is rejected with 415 and creates no job", async () => {
    const res = await handler(jsonRequest("POST", "/cron", cronJob("ct-probe"), {
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
    }));
    expect(res.status).toBe(415);
    expect(registry.get("ct-probe")).toBeUndefined();
  });

  test("text/plain POST /memory is rejected with 415", async () => {
    const res = await handler(jsonRequest("POST", "/memory", { op: "add", type: "fact", key: "ct-probe", value: "x" }, {
      headers: { "Content-Type": "text/plain" },
    }));
    expect(res.status).toBe(415);
  });

  test("PATCH /cron/:id without a JSON content type is rejected with 415", async () => {
    const res = await handler(makeRequest("PATCH", "/cron/any", { body: "{\"enabled\":false}" }));
    expect(res.status).toBe(415);
  });

  test("routes without a body need no Content-Type", async () => {
    registry.create(cronJob("no-body"));
    const run = await handler(makeRequest("POST", "/cron/missing-job/run"));
    expect(run.status).not.toBe(415);
    const del = await handler(makeRequest("DELETE", "/cron/no-body"));
    expect(del.status).toBe(200);
    expect(registry.get("no-body")).toBeUndefined();
  });

  test("POST /cron with the token and JSON content type creates the job", async () => {
    const res = await handler(jsonRequest("POST", "/cron", cronJob("auth-ok")));
    expect(res.status).toBe(200);
    expect(registry.get("auth-ok")).toBeDefined();
    registry.remove("auth-ok");
  });

  test("JSON content type with a charset parameter is accepted", async () => {
    const res = await handler(jsonRequest("POST", "/cron", cronJob("auth-charset"), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }));
    expect(res.status).toBe(200);
    expect(registry.get("auth-charset")).toBeDefined();
    registry.remove("auth-charset");
  });

  test("rejection logs never contain the submitted token", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await handler(makeRequest("GET", "/memory", { token: "c".repeat(64) }));
      await handler(makeRequest("GET", "/memory", { host: `attacker.test:${PORT}` }));
      const logged = warn.mock.calls.flat().join("\n");
      expect(logged).toContain("auth=mismatch");
      expect(logged).not.toContain("c".repeat(64));
      expect(logged).not.toContain(API_TOKEN);
    } finally {
      warn.mockRestore();
    }
  });

  test("an empty token is refused when the handler is built", () => {
    expect(() => buildFetchHandler(memoryRouter, cronRouter, { token: "", port: PORT })).toThrow();
  });
});

describe("served over a real socket", () => {
  // Sends a raw HTTP/1.1 request so the Host header is exactly what a
  // DNS-rebinding page would send, then returns the status line.
  async function rawRequest(port: number, host: string): Promise<string> {
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(socket) {
            socket.write(
              `GET /memory HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${API_TOKEN}\r\nConnection: close\r\n\r\n`
            );
          },
          data(_socket, data) {
            chunks.push(data.toString());
          },
          close() {
            resolve();
          },
          error(_socket, error) {
            reject(error);
          },
        },
      }).catch(reject);
    });
    return chunks.join("").split("\r\n")[0];
  }

  function startServer(): ReturnType<typeof Bun.serve> {
    let realHandler: ((req: Request) => Promise<Response>) | undefined;
    const server = Bun.serve({
      ...serveOptions({ httpPort: 0 }),
      fetch: (req) => realHandler!(req),
    });
    realHandler = buildFetchHandler(memoryRouter, cronRouter, { token: API_TOKEN, port: server.port });
    return server;
  }

  test("a forged Host header on the wire is rejected with 403, even with the token", async () => {
    const server = startServer();
    try {
      expect(await rawRequest(server.port, `attacker.test:${server.port}`)).toBe("HTTP/1.1 403 Forbidden");
      expect(await rawRequest(server.port, `127.0.0.1:${server.port}`)).toBe("HTTP/1.1 200 OK");
    } finally {
      server.stop(true);
    }
  });

  test("the server does not accept connections on IPv6 loopback", async () => {
    const server = startServer();
    try {
      const connected = await Bun.connect({
        hostname: "::1",
        port: server.port,
        socket: { data() {}, error() {} },
      }).then((socket) => {
        socket.end();
        return true;
      }, () => false);
      expect(connected).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

describe("serveOptions", () => {
  test("returns IPv4 loopback as the bind hostname", () => {
    expect(serveOptions({ httpPort: 7823 })).toEqual({ hostname: "127.0.0.1", port: 7823 });
  });
});

describe("generateApiToken", () => {
  test("returns a 64-character hex token", () => {
    expect(generateApiToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("returns a new token on every call", () => {
    expect(generateApiToken()).not.toBe(generateApiToken());
  });
});

describe("publishApiToken", () => {
  test("writes the curl header file readable only by the owner", () => {
    withTempDir((dir) => {
      const token = generateApiToken();
      publishApiToken(dir, token);
      const path = join(dir, "api-auth-header");
      expect(readFileSync(path, "utf-8")).toBe(`Authorization: Bearer ${token}\n`);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });

  test("the published header line is accepted by the handler", async () => {
    let line = "";
    const token = generateApiToken();
    withTempDir((dir) => {
      publishApiToken(dir, token);
      line = readFileSync(join(dir, "api-auth-header"), "utf-8").trim();
    });
    const separator = line.indexOf(": ");
    const tokenHandler = buildFetchHandler(memoryRouter, cronRouter, { token, port: PORT });
    const res = await tokenHandler(makeRequest("GET", "/memory", {
      token: null,
      headers: { [line.slice(0, separator)]: line.slice(separator + 2) },
    }));
    expect(res.status).toBe(200);
  });

  test("replaces a world-readable header file with an owner-only one", () => {
    withTempDir((dir) => {
      const path = join(dir, "api-auth-header");
      writeFileSync(path, "old");
      chmodSync(path, 0o644);
      publishApiToken(dir, generateApiToken());
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });

  test("leaves no temporary files behind", () => {
    withTempDir((dir) => {
      publishApiToken(dir, generateApiToken());
      expect(readdirSync(dir)).toEqual(["api-auth-header"]);
    });
  });

  test("throws and leaves no temporary file when the directory is not writable", () => {
    withTempDir((dir) => {
      chmodSync(dir, 0o500);
      expect(() => publishApiToken(dir, generateApiToken())).toThrow();
      expect(readdirSync(dir)).toEqual([]);
    });
  });
});
