import { parse } from "node-html-parser";
import { join } from "path";
import { homedir } from "os";
import { readFileSync, unlinkSync, readdirSync } from "fs";
import puppeteer from "puppeteer-core";
import { TelegramClient } from "../telegram";
import { loadConfig } from "../config";

const TEMPLATE_PATH = join(import.meta.dir, "trending-card.html");

// Resolve the newest Playwright-managed chrome-headless-shell binary. This is a
// headless-only Chromium built for automation, which — unlike the full Google
// Chrome.app — launches reliably under launchd. Picking the highest cached
// version keeps this working when Playwright updates its browsers.
function resolveHeadlessShell(): string {
  const cacheRoot = join(homedir(), "Library", "Caches", "ms-playwright");
  let entries: string[];
  try {
    entries = readdirSync(cacheRoot);
  } catch (e) {
    // Cache dir absent (Playwright never installed) → treat as empty so the
    // actionable error below fires. Any other fs error is a real problem.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    entries = [];
  }
  const dirs = entries
    .filter(d => d.startsWith("chromium_headless_shell-"))
    .sort((a, b) => {
      const v = (s: string) => parseInt(s.split("-").pop() ?? "0", 10) || 0;
      return v(b) - v(a);
    });
  if (dirs.length === 0) {
    throw new Error(`[github-trending] no chrome-headless-shell found under ${cacheRoot}. Run: npx playwright install chromium`);
  }
  return join(cacheRoot, dirs[0], "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
}

export interface TrendingRepo {
  rank: number;
  owner: string;
  name: string;
  description: string;
  starsGained: string;
}

// The monthly digest fires on the 1st of each month and reports GitHub's
// trailing-month trending — which on the 1st is the previous calendar month.
// Describe that month in full (e.g. "Jul 1 – Jul 31, 2026"), not the single
// day the job happens to run. `day 0` of the current month rolls back to the
// last day of the previous month, which also handles year rollover and
// variable month lengths correctly.
function previousMonthLabels(now: Date): { monthYear: string; dateRange: string } {
  const lastDayPrev = new Date(now.getFullYear(), now.getMonth(), 0);
  const firstDayPrev = new Date(lastDayPrev.getFullYear(), lastDayPrev.getMonth(), 1);
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return {
    monthYear: lastDayPrev.toLocaleString("en-US", { month: "long", year: "numeric" }).toUpperCase(),
    dateRange: `${fmt(firstDayPrev)} – ${fmt(lastDayPrev)}, ${lastDayPrev.getFullYear()}`,
  };
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
    const spans = article.querySelectorAll("span");
    const starsSpan = spans.find(s => s.text.includes("stars this week") || s.text.includes("stars this month"));
    const starsText = starsSpan?.text.trim() ?? "";
    // Extract numeric part: "12,345 stars this week" → "12,345"
    const starsGained = starsText.replace(/\s*stars?\s*(this week|this month)?/i, "").trim();

    if (!owner || !name) continue; // skip malformed entries
    repos.push({ rank: i + 1, owner, name, description, starsGained: starsGained || "?" });
  }

  // Sort descending by stars gained, then re-assign ranks
  repos.sort((a, b) => {
    const parse = (s: string) => parseInt(s.replace(/,/g, ""), 10) || 0;
    return parse(b.starsGained) - parse(a.starsGained);
  });
  repos.forEach((r, i) => { r.rank = i + 1; });

  return repos;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function renderCard(
  repos: TrendingRepo[],
  period: "weekly" | "monthly",
  outputPath: string
): Promise<void> {
  const periodLabel = period === "weekly" ? "this week" : "last month";
  const now = new Date();
  let monthYear: string;
  let dateRange: string;
  if (period === "weekly") {
    monthYear = now.toLocaleString("en-US", { month: "long", year: "numeric" }).toUpperCase();
    const weekAgo = new Date(now);
    weekAgo.setDate(now.getDate() - 7);
    const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    dateRange = `${fmt(weekAgo)} – ${fmt(now)}, ${now.getFullYear()}`;
  } else {
    ({ monthYear, dateRange } = previousMonthLabels(now));
  }

  const rows = repos.map(r => `
    <div class="row">
      <span class="rank">${String(r.rank).padStart(2, "0")}</span>
      <div class="repo">
        <div class="repo-name">${esc(r.owner)}/${esc(r.name)}</div>
        <div class="repo-desc">${esc(r.description) || "No description"}</div>
      </div>
      <span class="stars">+${esc(r.starsGained)} ★</span>
    </div>
  `).join("\n");

  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  const html = template
    .replace("{{PERIOD_LABEL}}", periodLabel)
    .replace("{{MONTH_YEAR}}", monthYear)
    .replace("{{DATE_RANGE}}", dateRange)
    .replace("{{ROWS}}", rows);

  const tmpHtml = outputPath.replace(/\.png$/, ".html");
  await Bun.write(tmpHtml, html);

  const browser = await puppeteer.launch({
    executablePath: resolveHeadlessShell(),
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 1100 });
    await page.goto(`file://${tmpHtml}`, { waitUntil: "networkidle0" });
    await page.screenshot({ path: outputPath as `${string}.png`, fullPage: false });
  } finally {
    await browser.close();
    try { unlinkSync(tmpHtml); } catch (e) { console.warn("[github-trending] failed to clean up temp HTML:", e); }
  }
}

export async function sendDigest(period: "weekly" | "monthly"): Promise<void> {
  const config = loadConfig();
  const telegram = new TelegramClient(config.telegramBotToken, config.telegramChatId);

  const repos = await fetchTrending(period);
  const tmpDir = process.env.TMPDIR ?? "/tmp";
  const tmpPath = `${tmpDir}/trending-${period}-${new Date().toISOString().slice(0, 10)}.png`;
  const periodLabel = period === "weekly" ? "this week" : "last month";

  let renderError: string | null = null;
  try {
    await renderCard(repos, period, tmpPath);
    await telegram.sendPhotoWithRetry(tmpPath, `Fastest growing GitHub repos ${periodLabel}`);
    console.log(`[github-trending] delivered ${period} digest (image) with ${repos.length} repos`);
    return;
  } catch (e) {
    console.error(`[github-trending] image send failed, falling back to text:`, e);
    // Surface the failure in the message so a silent image→text regression
    // (e.g. the Playwright browser cache was cleared) is visible, not silent.
    renderError = (e instanceof Error ? e.message : String(e)).split("\n")[0];
  } finally {
    try { unlinkSync(tmpPath); } catch (e) { console.warn("[github-trending] failed to clean up temp PNG:", e); }
  }

  // Text fallback
  const now = new Date();
  let dateRange: string;
  if (period === "weekly") {
    const weekAgo = new Date(now);
    weekAgo.setDate(now.getDate() - 7);
    const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    dateRange = `${fmt(weekAgo)} – ${fmt(now)}, ${now.getFullYear()}`;
  } else {
    dateRange = previousMonthLabels(now).dateRange;
  }

  const header = period === "weekly"
    ? `📈 *Fastest Growing GitHub Repos This Week*`
    : `📈 *Fastest Growing GitHub Repos Last Month*`;

  const repoLines = repos.map(r => {
    const stars = r.starsGained !== "?" ? `+${r.starsGained} ⭐` : "⭐";
    const desc = r.description || "No description";
    return `*${String(r.rank).padStart(2, "0")}. ${r.owner}/${r.name}* — ${stars}\n_${desc}_`;
  });

  const alert = renderError
    ? [`⚠️ _Image render failed, sent as text. Reason: ${renderError}_`]
    : [];
  const message = [header, `_${dateRange}_`, "", ...repoLines, ...alert].join("\n\n");
  await telegram.sendMessageWithRetry(message);
  console.log(`[github-trending] delivered ${period} digest (text fallback) with ${repos.length} repos`);
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
