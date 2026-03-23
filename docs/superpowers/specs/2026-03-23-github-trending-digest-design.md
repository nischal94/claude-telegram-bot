# GitHub Trending Digest Design

## Goal

Automatically send a styled image card of the top 10 fastest-growing GitHub repositories to the user's Telegram bot every Friday at 5pm (weekly) and on the 1st of each month at 9am (monthly).

## Architecture

All logic lives in a new TypeScript module (`companion/src/jobs/github-trending.ts`) that is called directly by a new `type: "shell"` cron job type. The companion registers two cron jobs at startup. When a job fires, the executor spawns `bun run companion/src/jobs/github-trending.ts [weekly|monthly]` as a subprocess.

```
cron fires (Friday 5pm / 1st of month 9am)
    → executor.ts: Bun.spawn(["bun", "run", "github-trending.ts", period])
        → fetchTrending(period)  — fetch + parse GitHub trending HTML
        → renderCard(repos, period, tmpPath)  — HTML template → Puppeteer → PNG
        → telegram.sendPhoto(tmpPath)  — POST to Telegram sendPhoto API
        → fs.unlink(tmpPath)  — cleanup
    → on failure at any stage: telegram.sendMessage(fallback text)
```

No new services. New dependencies: `puppeteer`, `node-html-parser`.

## New Job Type: `"shell"`

The existing `JobType = "reminder" | "agent"` must be extended to `"reminder" | "agent" | "shell"`.

A `shell` job has a `command` field (string array) that `executor.ts` runs directly via `Bun.spawn`. This avoids routing a shell command through the Claude CLI.

### Changes to existing files

**`companion/src/cron/registry.ts`**
- Add `"shell"` to `JobType`
- Add `command?: string[]` to `CronJob` interface (required for shell jobs)

**`companion/src/cron/executor.ts`**
- Add branch: `if (job.type === "shell")` → `Bun.spawn(job.command!, { ... })` — no `cwd` override needed; scripts use `import.meta.dir` internally for path resolution
- Shell jobs use same timeout (5 min) and same abort/kill pattern as agent jobs (`controller.abort()` → `proc.kill()`)
- On success: do NOT send stdout to Telegram (the script sends its own Telegram messages)
- On failure (non-zero exit): throw so the scheduler logs the error and sends its standard failure message
- **The script must exit non-zero on Telegram send failure** so the scheduler's error recovery fires

**`companion/src/cron/handler.ts`**
- Add validation for `shell` jobs: if `body.type === "shell"` and `!body.command?.length`, return `400 { error: "command required for shell jobs" }`

## Components

### `companion/src/jobs/github-trending.ts`

Main entry point when run as a script (`import.meta.main` guard). Accepts `Bun.argv[2]` as `"weekly" | "monthly"`.

**Exports:**
- `fetchTrending(period: "weekly" | "monthly"): Promise<TrendingRepo[]>`
  - Fetches `https://github.com/trending?since=${period}`
  - Parses with `node-html-parser`
  - Returns top 10 `{ rank, owner, name, description, starsGained }`
- `renderCard(repos: TrendingRepo[], period, outputPath: string): Promise<void>`
  - Reads `trending-card.html` template, replaces `{{PERIOD_LABEL}}`, `{{MONTH_YEAR}}`, `{{ROWS}}`
  - Launches Puppeteer (uses system Chrome via `executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`, falls back to Puppeteer-downloaded Chromium)
  - Screenshots at 800×1100px, saves to `outputPath`
- `sendDigest(period): Promise<void>` — orchestrates fetch → render → sendPhoto → cleanup, with plain-text fallback on any error

**`TrendingRepo` interface:**
```typescript
interface TrendingRepo {
  rank: number;
  owner: string;
  name: string;
  description: string;
  starsGained: string; // e.g. "22,456"
}
```

### `companion/src/jobs/trending-card.html`

Static HTML template, self-contained (inline CSS only). Rendered at 800×1100px.

Style: warm beige (`#f5f0e8`) background, bold black/green heading, matching @sharbel aesthetic.

Template tokens:
- `{{PERIOD_LABEL}}` → `"this week"` or `"this month"`
- `{{MONTH_YEAR}}` → `"MARCH 2026"`
- `{{ROWS}}` → HTML rows generated per repo

Row format:
```html
<div class="row">
  <span class="rank">01</span>
  <div class="repo">
    <div class="name">owner/repo-name</div>
    <div class="desc">Short description text</div>
  </div>
  <span class="stars">+22K ★</span>
</div>
```

### `companion/src/jobs/register-trending-crons.ts`

Called from `startCompanion()` in `index.ts` after the registry is initialized.

Commands use **absolute paths** so `Bun.spawn` can locate the script regardless of the companion's working directory (launchd daemons have an unpredictable cwd):

```typescript
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
    if (!registry.get(job.id)) {  // idempotency guard — create() would rename duplicates
      registry.create(job);
      console.log(`[trending] registered cron: ${job.id}`);
    }
  }
}
```

### Integration point in `index.ts`

Add after registry is created, before scheduler starts:

```typescript
import { registerTrendingCrons } from "./jobs/register-trending-crons";
// ...
const registry = new CronRegistry(join(config.companionDir, "cron-jobs.json"));
registerTrendingCrons(registry);  // ← add this line
const scheduler = new CronScheduler(registry, telegram, config.anthropicApiKey);
```

### Idempotency in `register-trending-crons.ts`

`CronRegistry.create()` does NOT skip duplicates — it renames with a suffix (e.g. `-2`). The registration function must guard with `registry.get(id)` before calling `create()`:

```typescript
if (!registry.get(job.id)) {
  registry.create(job);
}
```

This prevents duplicate jobs accumulating on every companion restart.

### `sendPhoto` addition to `TelegramClient`

Add to `companion/src/telegram.ts`:

```typescript
async sendPhoto(imagePath: string, caption?: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", this.chatId);
  form.append("photo", Bun.file(imagePath));
  if (caption) form.append("caption", caption);

  const res = await fetch(
    `https://api.telegram.org/bot${this.token}/sendPhoto`,
    { method: "POST", body: form }
  );
  if (!res.ok) throw new Error(`[TelegramClient] sendPhoto failed: ${res.status}`);
}

async sendPhotoWithRetry(imagePath: string, caption?: string): Promise<void> {
  // Same 3x exponential backoff pattern as sendMessageWithRetry
}
```

`github-trending.ts` imports `TelegramClient` and calls `sendPhotoWithRetry`. Credentials come from `loadConfig()` (same env vars already used by the companion).

## Data Source

GitHub public trending page — no API key:
- Weekly: `https://github.com/trending?since=weekly`
- Monthly: `https://github.com/trending?since=monthly`

Parsed fields:
- `owner/name` — from `h2.h3 > a`
- `description` — from `p.col-9`
- `starsGained` — from `span.d-inline-block.float-sm-right` (the "X stars this week" span)

## Image Card Design

Dimensions: 800×1100px PNG
Background: `#f5f0e8` (warm beige)

```
┌──────────────────────────────────────────┐
│  fastest growing                         │
│  GitHub repos  [this week]    MARCH 2026 │
│                           ranked by stars│
├──────────────────────────────────────────┤
│  01  owner/repo-name              +22K ★ │
│      Short description text              │
├──────────────────────────────────────────┤
│  ...rows 02–10...                        │
└──────────────────────────────────────────┘
```

## Error Handling

| Failure | Response |
|---------|----------|
| GitHub fetch fails | `sendMessageWithRetry("⚠️ GitHub trending fetch failed. Will retry next cycle.")` |
| Puppeteer render fails | Fall back to `sendMessageWithRetry` with plain-text numbered list |
| Telegram send fails | Handled by `sendPhotoWithRetry` / `sendMessageWithRetry` (3x backoff) |
| Cron job itself fails | No retry — waits until next scheduled run |

## Puppeteer / Bun Compatibility

Use `puppeteer-core@22` (not `puppeteer`) to avoid auto-downloading Chromium. Point to system Chrome:

```typescript
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  args: ["--no-sandbox"],
});
```

**Fallback behavior:** If Chrome is not found (ENOENT on launch) or if Puppeteer throws for any reason, catch the error and fall back to a plain-text Telegram message containing the numbered list:
```
fastest growing GitHub repos this week (MARCH 2026)

01. owner/repo-name (+22K ⭐) — description
02. ...
```
The script still exits 0 in this case (text was delivered successfully).

If the Telegram text send also fails, exit non-zero so the scheduler's error recovery fires.

## Schedule & Timezone

Cron expressions run in the **system timezone of the companion process** (macOS local time via launchd). No explicit timezone config — this is intentional for a personal bot.

| Digest | Cron | Local Time |
|--------|------|------------|
| Weekly | `0 17 * * 5` | Every Friday 5:00pm |
| Monthly | `0 9 1 * *` | 1st of each month 9:00am |

## Dependencies

- `puppeteer-core@22` — HTML → PNG (uses system Chrome, avoids Chromium download, pinned major version)
- `node-html-parser` — lightweight HTML parsing

## Schedule

| Digest | Cron | Time |
|--------|------|------|
| Weekly | `0 17 * * 5` | Every Friday 5:00pm |
| Monthly | `0 9 1 * *` | 1st of each month 9:00am |

## Testing

- **Unit test `fetchTrending`**: mock `fetch()` with fixture HTML, assert correct `TrendingRepo[]` output
- **Unit test `renderCard`**: skip (or mark `@skip`) if system Chrome not found at expected path; when Chrome is present, assert PNG file is created at `outputPath`. Do NOT mock puppeteer — this test is an integration test for the render pipeline and only runs when Chrome is available
- **Unit test `registerTrendingCrons`**: use `mkdtempSync` + real `CronRegistry` (same pattern as `registry.test.ts`); assert both job IDs exist after one call; assert calling twice does not create duplicates (no `-2` suffix jobs)
- **Integration**: `POST /cron/github-trending-weekly/run` — mock `TelegramClient.sendPhoto` to avoid a real Telegram send; assert it was called with a PNG path
