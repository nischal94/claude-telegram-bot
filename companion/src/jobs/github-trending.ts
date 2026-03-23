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
  const periodLabel = period === "weekly" ? "this week" : "this month";
  const monthYear = new Date().toLocaleString("en-US", { month: "long", year: "numeric" }).toUpperCase();

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
    try { unlinkSync(tmpHtml); } catch (e) { console.warn("[github-trending] failed to clean up temp HTML:", e); }
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
    try { unlinkSync(tmpPath); } catch (e) { console.warn("[github-trending] failed to clean up temp PNG:", e); }
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
