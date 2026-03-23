# GitHub Trending Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a styled image card of the top 10 fastest-growing GitHub repos to Telegram every Friday at 5pm (weekly) and the 1st of each month at 9am (monthly).

**Architecture:** A new `type: "shell"` cron job type is added to the existing cron system, which spawns arbitrary commands directly via `Bun.spawn`. Two shell cron jobs registered at companion startup each call a new `github-trending.ts` script that scrapes GitHub's trending page, renders a warm-beige image card via Puppeteer + system Chrome, and sends it to Telegram via a new `sendPhoto` method.

**Tech Stack:** Bun, TypeScript, `puppeteer-core@22`, `node-html-parser`, Telegram Bot API (`sendPhoto`), node-cron (existing)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `companion/src/cron/registry.ts` | Modify | Add `"shell"` to `JobType`, add `command?: string[]` to `CronJob` |
| `companion/src/cron/executor.ts` | Modify | Add `shell` branch: `Bun.spawn(job.command!)` with timeout/abort |
| `companion/src/cron/handler.ts` | Modify | Add validation for `shell` jobs requiring `command` |
| `companion/src/telegram.ts` | Modify | Add `sendPhoto` and `sendPhotoWithRetry` methods |
| `companion/src/jobs/trending-card.html` | Create | HTML card template (800×1100px, warm beige) |
| `companion/src/jobs/github-trending.ts` | Create | Scraper + renderer + sendDigest orchestration |
| `companion/src/jobs/register-trending-crons.ts` | Create | Idempotent registration of 2 shell cron jobs at startup |
| `companion/src/index.ts` | Modify | Call `registerTrendingCrons(registry)` after registry init |
| `companion/src/jobs/github-trending.test.ts` | Create | Unit tests for fetchTrending and registerTrendingCrons |
| `companion/package.json` | Modify | Add `puppeteer-core@22` and `node-html-parser` dependencies |

---

## Task 1: Extend CronRegistry with `shell` job type

**Files:**
- Modify: `companion/src/cron/registry.ts:4-18`
- Modify: `companion/src/cron/handler.ts:13-21`

- [ ] **Step 1: Write the failing test**

`companion/src/cron/registry.test.ts` already exists — append the following test at the end of the file (after the last existing `test(...)` block):

```typescript
test("create shell job with command array", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.create({
      id: "my-shell-job",
      schedule: "0 9 * * 1",
      type: "shell",
      command: ["/usr/bin/bun", "run", "/abs/path/script.ts"],
      delivery: "telegram",
    });
    const job = registry.get(id)!;
    expect(job.type).toBe("shell");
    expect(job.command).toEqual(["/usr/bin/bun", "run", "/abs/path/script.ts"]);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd companion && bun test src/cron/registry.test.ts
```

Expected: TypeScript error — `"shell"` is not assignable to `JobType`

- [ ] **Step 3: Add `"shell"` to `JobType` and `command` to `CronJob`**

In `companion/src/cron/registry.ts`, change:

```typescript
export type JobType = "reminder" | "agent";

export interface CronJob {
  id: string;
  schedule: string;
  type: JobType;
  message?: string;   // required for reminder
  prompt?: string;    // required for agent
  delivery: "telegram";
```

To:

```typescript
export type JobType = "reminder" | "agent" | "shell";

export interface CronJob {
  id: string;
  schedule: string;
  type: JobType;
  message?: string;   // required for reminder
  prompt?: string;    // required for agent
  command?: string[]; // required for shell
  delivery: "telegram";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd companion && bun test src/cron/registry.test.ts
```

Expected: All tests PASS

- [ ] **Step 5: Add handler validation for shell jobs**

In `companion/src/cron/handler.ts`, after line 20 (after the `agent` validation), add:

```typescript
if (body.type === "shell" && !body.command?.length) {
  return Response.json({ error: "command required for shell jobs" }, { status: 400 });
}
```

- [ ] **Step 6: Commit**

```bash
git add companion/src/cron/registry.ts companion/src/cron/handler.ts companion/src/cron/registry.test.ts
git commit -m "feat: add shell job type to cron registry and handler"
```

---

## Task 2: Add shell branch to executor

**Files:**
- Modify: `companion/src/cron/executor.ts:7-51`

- [ ] **Step 1: Read the current executor**

Read `companion/src/cron/executor.ts`. The file has this structure:
- Lines 1–6: imports and constants
- Lines 7–11: `reminder` branch — calls `telegram.sendMessageWithRetry` and returns
- Lines 12–51: `agent` branch — AbortController, `Bun.spawn(["claude", ...])`, timeout, `proc.kill()` on abort, `clearTimeout` in finally

- [ ] **Step 2: Add the shell branch**

In `companion/src/cron/executor.ts`, after the `reminder` branch (after line 11, before the `// agent job:` comment), add a `shell` branch:

```typescript
if (job.type === "shell") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const proc = Bun.spawn(job.command!, {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
    signal: controller.signal,
  });

  try {
    const [, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(`[executor] shell job exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }
    // Shell jobs send their own Telegram messages — don't forward stdout
  } catch (e: unknown) {
    if (controller.signal.aborted) {
      proc.kill();
      throw new Error(`[executor] shell job timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  return;
}
```

- [ ] **Step 3: Verify existing tests still pass**

```bash
cd companion && bun test src/cron/
```

Expected: All cron tests PASS (no regressions)

- [ ] **Step 4: Commit**

```bash
git add companion/src/cron/executor.ts
git commit -m "feat: add shell branch to cron executor"
```

---

## Task 3: Add `sendPhoto` to TelegramClient

**Files:**
- Modify: `companion/src/telegram.ts:25-35` (add after `sendMessageWithRetry`)

- [ ] **Step 1: Add `sendPhoto` and `sendPhotoWithRetry` methods**

In `companion/src/telegram.ts`, add after the `sendMessageWithRetry` method (after line 35, before `waitForPong`):

```typescript
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
```

- [ ] **Step 2: Verify existing tests pass**

```bash
cd companion && bun test
```

Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add companion/src/telegram.ts
git commit -m "feat: add sendPhoto and sendPhotoWithRetry to TelegramClient"
```

---

## Task 4: Create the HTML card template

**Files:**
- Create: `companion/src/jobs/trending-card.html`

- [ ] **Step 1: Create the template file**

Create `companion/src/jobs/trending-card.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=800">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: #f5f0e8;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    width: 800px;
    min-height: 1100px;
    padding: 60px 56px 56px;
  }

  .header {
    margin-bottom: 40px;
  }

  .title-line1 {
    font-size: 42px;
    font-weight: 400;
    color: #1a1a1a;
    line-height: 1.1;
  }

  .title-line2 {
    font-size: 42px;
    font-weight: 700;
    color: #1a1a1a;
    line-height: 1.1;
  }

  .title-period {
    color: #4caf50;
  }

  .meta {
    position: absolute;
    top: 60px;
    right: 56px;
    text-align: right;
  }

  .meta-month {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: #888;
    text-transform: uppercase;
  }

  .meta-ranked {
    font-size: 12px;
    color: #aaa;
    margin-top: 2px;
  }

  .divider {
    height: 1px;
    background: #ddd8ce;
    margin-bottom: 8px;
  }

  .row {
    display: flex;
    align-items: flex-start;
    padding: 16px 0;
    border-bottom: 1px solid #e8e3d8;
    gap: 20px;
  }

  .row:last-child {
    border-bottom: none;
  }

  .rank {
    font-size: 15px;
    font-weight: 400;
    color: #bbb;
    min-width: 28px;
    padding-top: 2px;
    flex-shrink: 0;
  }

  .repo {
    flex: 1;
    min-width: 0;
  }

  .repo-name {
    font-size: 17px;
    font-weight: 700;
    color: #1a1a1a;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .repo-desc {
    font-size: 13px;
    color: #666;
    margin-top: 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .stars {
    font-size: 14px;
    font-weight: 600;
    color: #1a1a1a;
    white-space: nowrap;
    flex-shrink: 0;
    padding-top: 3px;
  }
</style>
</head>
<body style="position:relative;">

<div class="meta">
  <div class="meta-month">{{MONTH_YEAR}}</div>
  <div class="meta-ranked">ranked by stars gained</div>
</div>

<div class="header">
  <div class="title-line1">fastest growing</div>
  <div class="title-line2">GitHub repos <span class="title-period">{{PERIOD_LABEL}}</span></div>
</div>

<div class="divider"></div>

{{ROWS}}

</body>
</html>
```

- [ ] **Step 2: Visually verify the template looks right**

Open the file in a browser to spot-check layout. Replace the `{{ROWS}}` placeholder manually with a sample row to check styling:

```html
<div class="row">
  <span class="rank">01</span>
  <div class="repo">
    <div class="repo-name">owner/sample-repo</div>
    <div class="repo-desc">A sample description for visual checking</div>
  </div>
  <span class="stars">+22.4K ★</span>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add companion/src/jobs/trending-card.html
git commit -m "feat: add GitHub trending card HTML template"
```

---

## Task 5: Install dependencies

**Files:**
- Modify: `companion/package.json`

- [ ] **Step 1: Install puppeteer-core and node-html-parser**

```bash
cd companion && bun add puppeteer-core@22 node-html-parser
```

- [ ] **Step 2: Verify install**

```bash
cd companion && bun run -e "import puppeteer from 'puppeteer-core'; console.log('ok')"
```

Expected: prints `ok`

- [ ] **Step 3: Commit**

```bash
git add companion/package.json companion/bun.lockb
git commit -m "chore: add puppeteer-core and node-html-parser dependencies"
```

---

## Task 6: Create `github-trending.ts`

**Files:**
- Create: `companion/src/jobs/github-trending.ts`
- Create: `companion/src/jobs/github-trending.test.ts`

- [ ] **Step 1: Write the failing test for `fetchTrending`**

Create `companion/src/jobs/github-trending.test.ts`:

```typescript
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { fetchTrending } from "./github-trending";

// Minimal fixture HTML that mirrors GitHub's trending page structure
const FIXTURE_HTML = `
<article class="Box-row">
  <h2 class="h3 lh-condensed">
    <a href="/torvalds/linux">torvalds / <strong>linux</strong></a>
  </h2>
  <p class="col-9 color-fg-muted my-1 pr-4">The Linux kernel source tree</p>
  <div class="f6 color-fg-muted mt-2">
    <span class="d-inline-block ml-0 mr-3">
      <svg></svg>
      <span data-view-component="true">12,345 stars this week</span>
    </span>
  </div>
</article>
`;

let fetchMock: ReturnType<typeof mock>;

beforeEach(() => {
  fetchMock = mock(async () => new Response(FIXTURE_HTML, { status: 200 }));
  globalThis.fetch = fetchMock as any;
});

afterEach(() => {
  fetchMock.mockRestore?.();
});

test("fetchTrending returns parsed repos", async () => {
  const repos = await fetchTrending("weekly");
  expect(repos).toHaveLength(1);
  expect(repos[0].owner).toBe("torvalds");
  expect(repos[0].name).toBe("linux");
  expect(repos[0].description).toBe("The Linux kernel source tree");
  expect(repos[0].starsGained).toContain("12,345");
  expect(repos[0].rank).toBe(1);
});

test("fetchTrending requests correct URL for monthly", async () => {
  await fetchTrending("monthly");
  expect(fetchMock).toHaveBeenCalledWith(
    "https://github.com/trending?since=monthly",
    expect.any(Object)
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd companion && bun test src/jobs/github-trending.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement `github-trending.ts`**

Create `companion/src/jobs/github-trending.ts`:

```typescript
import { parse } from "node-html-parser";
import { join } from "path";
import { readFileSync, unlinkSync } from "fs";
import puppeteer from "puppeteer-core";
import { TelegramClient } from "../telegram";
import { loadConfig } from "../config";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TEMPLATE_PATH = join(import.meta.dir, "trending-card.html");

export interface TrendingRepo {
  rank: number;
  owner: string;
  name: string;
  description: string;
  starsGained: string;
}

export async function fetchTrending(period: "weekly" | "monthly"): Promise<TrendingRepo[]> {
  if (period !== "weekly" && period !== "monthly") {
    throw new Error(`[github-trending] invalid period: ${period}`);
  }
  const url = `https://github.com/trending?since=${period}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; trending-bot/1.0)" },
  });
  if (!res.ok) throw new Error(`[github-trending] fetch failed: ${res.status}`);
  const html = await res.text();
  const root = parse(html);

  const repos: TrendingRepo[] = [];
  const articles = root.querySelectorAll("article.Box-row");

  for (let i = 0; i < Math.min(10, articles.length); i++) {
    const article = articles[i];
    const link = article.querySelector("h2 a, h1 a");
    if (!link) continue;
    const href = link.getAttribute("href") ?? "";
    const parts = href.replace(/^\//, "").split("/");
    const owner = parts[0] ?? "";
    const name = parts[1] ?? "";
    const description = article.querySelector("p")?.text.trim() ?? "";
    const starsText = article.querySelector("span[data-view-component]")?.text.trim()
      ?? article.querySelectorAll(".f6 span").find(s => s.text.includes("star"))?.text.trim()
      ?? "";
    // Extract numeric part: "12,345 stars this week" → "12,345"
    const starsGained = starsText.replace(/\s*stars?\s*(this week|this month)?/i, "").trim();

    if (!owner || !name) continue; // skip malformed entries
    repos.push({ rank: i + 1, owner, name, description, starsGained: starsGained || "?" });
  }

  return repos;
}

export async function renderCard(
  repos: TrendingRepo[],
  period: "weekly" | "monthly",
  outputPath: string
): Promise<void> {
  const periodLabel = period === "weekly" ? "this week" : "this month";
  const monthYear = new Date().toLocaleString("en-US", { month: "long", year: "numeric" }).toUpperCase();

  const rows = repos.map(r => `
    <div class="row">
      <span class="rank">${String(r.rank).padStart(2, "0")}</span>
      <div class="repo">
        <div class="repo-name">${r.owner}/${r.name}</div>
        <div class="repo-desc">${r.description || "No description"}</div>
      </div>
      <span class="stars">+${r.starsGained} ★</span>
    </div>
  `).join("\n");

  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  const html = template
    .replace("{{PERIOD_LABEL}}", periodLabel)
    .replace("{{MONTH_YEAR}}", monthYear)
    .replace("{{ROWS}}", rows);

  const tmpHtml = outputPath.replace(/\.png$/, ".html");
  await Bun.write(tmpHtml, html);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 1100 });
    await page.goto(`file://${tmpHtml}`, { waitUntil: "networkidle0" });
    await page.screenshot({ path: outputPath as `${string}.png`, fullPage: false });
  } finally {
    await browser.close();
    try { unlinkSync(tmpHtml); } catch {}
  }
}

export async function sendDigest(period: "weekly" | "monthly"): Promise<void> {
  const config = loadConfig();
  const telegram = new TelegramClient(config.telegramBotToken, config.telegramChatId);

  const repos = await fetchTrending(period);
  const tmpDir = process.env.TMPDIR ?? "/tmp";
  const tmpPath = `${tmpDir}/trending-${period}-${new Date().toISOString().slice(0, 10)}.png`;
  const periodLabel = period === "weekly" ? "this week" : "this month";
  const monthYear = new Date().toLocaleString("en-US", { month: "long", year: "numeric" }).toUpperCase();

  try {
    await renderCard(repos, period, tmpPath);
    await telegram.sendPhotoWithRetry(tmpPath, `Fastest growing GitHub repos ${periodLabel}`);
    return;
  } catch (e) {
    console.error(`[github-trending] image send failed, falling back to text:`, e);
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }

  // Text fallback
  const lines = [
    `fastest growing GitHub repos ${periodLabel} (${monthYear})`,
    "",
    ...repos.map(r => `${String(r.rank).padStart(2, "0")}. ${r.owner}/${r.name} (+${r.starsGained} ⭐) — ${r.description || "No description"}`),
  ];
  await telegram.sendMessageWithRetry(lines.join("\n"));
}

// Entry point when run as a script: bun run github-trending.ts [weekly|monthly]
if (import.meta.main) {
  const period = Bun.argv[2] as "weekly" | "monthly";
  if (period !== "weekly" && period !== "monthly") {
    console.error("[github-trending] usage: bun run github-trending.ts [weekly|monthly]");
    process.exit(1);
  }
  sendDigest(period).catch(e => {
    console.error("[github-trending] fatal:", e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd companion && bun test src/jobs/github-trending.test.ts
```

Expected: Both tests PASS

- [ ] **Step 5: Commit**

```bash
git add companion/src/jobs/github-trending.ts companion/src/jobs/github-trending.test.ts
git commit -m "feat: add github-trending scraper and card renderer"
```

---

## Task 7: Create `register-trending-crons.ts` + tests

**Files:**
- Create: `companion/src/jobs/register-trending-crons.ts`
- Modify: `companion/src/jobs/github-trending.test.ts` (add registration tests)

- [ ] **Step 1: Write the failing tests for `registerTrendingCrons`**

Add to `companion/src/jobs/github-trending.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { CronRegistry } from "../cron/registry";
import { registerTrendingCrons } from "./register-trending-crons";

function makeTestRegistry() {
  const dir = mkdtempSync("/tmp/test-registry-");
  const registry = new CronRegistry(join(dir, "cron-jobs.json"));
  const cleanup = () => {
    registry.close();
    rmSync(dir, { recursive: true });
  };
  return { registry, cleanup };
}

test("registerTrendingCrons creates both jobs", () => {
  const { registry, cleanup } = makeTestRegistry();
  try {
    registerTrendingCrons(registry);
    expect(registry.get("github-trending-weekly")).toBeDefined();
    expect(registry.get("github-trending-monthly")).toBeDefined();
  } finally {
    cleanup();
  }
});

test("registerTrendingCrons is idempotent — no duplicates on second call", () => {
  const { registry, cleanup } = makeTestRegistry();
  try {
    registerTrendingCrons(registry);
    registerTrendingCrons(registry);
    const jobs = registry.list();
    const weeklyJobs = jobs.filter(j => j.id.startsWith("github-trending-weekly"));
    const monthlyJobs = jobs.filter(j => j.id.startsWith("github-trending-monthly"));
    expect(weeklyJobs).toHaveLength(1);
    expect(monthlyJobs).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("registered jobs are shell type with command array", () => {
  const { registry, cleanup } = makeTestRegistry();
  try {
    registerTrendingCrons(registry);
    const weekly = registry.get("github-trending-weekly")!;
    expect(weekly.type).toBe("shell");
    expect(Array.isArray(weekly.command)).toBe(true);
    expect(weekly.command!.length).toBeGreaterThan(0);
    expect(weekly.schedule).toBe("0 17 * * 5");
    const monthly = registry.get("github-trending-monthly")!;
    expect(monthly.schedule).toBe("0 9 1 * *");
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd companion && bun test src/jobs/github-trending.test.ts
```

Expected: FAIL — `register-trending-crons` module not found

- [ ] **Step 3: Implement `register-trending-crons.ts`**

Create `companion/src/jobs/register-trending-crons.ts`:

```typescript
import { join } from "path";
import type { CronRegistry } from "../cron/registry";

export function registerTrendingCrons(registry: CronRegistry): void {
  const scriptPath = join(import.meta.dir, "github-trending.ts");

  const jobs = [
    {
      id: "github-trending-weekly",
      schedule: "0 17 * * 5",
      type: "shell" as const,
      command: ["bun", "run", scriptPath, "weekly"],
      delivery: "telegram" as const,
    },
    {
      id: "github-trending-monthly",
      schedule: "0 9 1 * *",
      type: "shell" as const,
      command: ["bun", "run", scriptPath, "monthly"],
      delivery: "telegram" as const,
    },
  ];

  for (const job of jobs) {
    if (!registry.get(job.id)) {
      registry.create(job);
      console.log(`[trending] registered cron: ${job.id}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd companion && bun test src/jobs/github-trending.test.ts
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add companion/src/jobs/register-trending-crons.ts companion/src/jobs/github-trending.test.ts
git commit -m "feat: add register-trending-crons with idempotency guard"
```

---

## Task 8: Wire into `startCompanion()`

**Files:**
- Modify: `companion/src/index.ts:74-77`

- [ ] **Step 1: Add import and call in index.ts**

In `companion/src/index.ts`, add the import at the top. Place it after the existing local imports (after the `import { RecoveryManager }` line) to match the file's existing import ordering:

```typescript
import { registerTrendingCrons } from "./jobs/register-trending-crons";
```

Then, after line 74 (`const registry = new CronRegistry(...)`), add:

```typescript
registerTrendingCrons(registry);
```

The relevant section should look like:

```typescript
const registry = new CronRegistry(join(config.companionDir, "cron-jobs.json"));
registerTrendingCrons(registry);  // register trending digest jobs
const telegram = new TelegramClient(config.telegramBotToken, config.telegramChatId);
const scheduler = new CronScheduler(registry, telegram, config.anthropicApiKey);
scheduler.start();
```

- [ ] **Step 2: Run all tests to verify no regressions**

```bash
cd companion && bun test
```

Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add companion/src/index.ts
git commit -m "feat: wire registerTrendingCrons into startCompanion"
```

---

## Task 9: Manual smoke test

- [ ] **Step 1: Test scraping works**

First verify your working directory is `companion/`:

```bash
pwd  # should end in /claude-telegram-bot/companion
```

If not, `cd /Users/nischal/projects/claude-telegram-bot/companion` first. Then run:

```bash
bun run src/jobs/github-trending.ts weekly 2>&1 | head -20
```

Expected: Fetches GitHub trending page, renders card, sends to Telegram. No error output.

If Chrome not found error, verify the path exists:

```bash
ls "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

- [ ] **Step 2: Test manual cron trigger via HTTP API**

With companion running, trigger the weekly job:

```bash
curl -s -X POST http://localhost:7823/cron/github-trending-weekly/run | jq
```

Expected: `{"ok": true}` — and a card arrives in Telegram within ~15 seconds.

- [ ] **Step 3: Verify both cron jobs are registered**

```bash
curl -s http://localhost:7823/cron | jq '.[] | select(.id | startswith("github-trending"))'
```

Expected: Two jobs with `type: "shell"`, both `enabled: true`, correct schedules.

- [ ] **Step 4: Push to GitHub**

```bash
git push origin main
```

---
