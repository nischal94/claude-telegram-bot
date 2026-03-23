import { test, expect, mock, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fetchTrending } from "./github-trending";
import { CronRegistry } from "../cron/registry";
import { registerTrendingCrons } from "./register-trending-crons";

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

describe("registerTrendingCrons", () => {
  let tmpDir: string;
  let registry: CronRegistry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "trending-test-"));
    registry = new CronRegistry(join(tmpDir, "cron-jobs.json"));
  });

  afterEach(() => {
    registry.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("registers both weekly and monthly jobs", () => {
    registerTrendingCrons(registry);
    const weekly = registry.get("github-trending-weekly");
    const monthly = registry.get("github-trending-monthly");
    expect(weekly).toBeDefined();
    expect(monthly).toBeDefined();
  });

  test("does not create duplicates on repeated calls", () => {
    registerTrendingCrons(registry);
    registerTrendingCrons(registry);
    const all = registry.list();
    const weeklyJobs = all.filter((j) => j.id === "github-trending-weekly");
    const monthlyJobs = all.filter((j) => j.id === "github-trending-monthly");
    expect(weeklyJobs).toHaveLength(1);
    expect(monthlyJobs).toHaveLength(1);
  });

  test("creates jobs with correct type, schedule, and command", () => {
    registerTrendingCrons(registry);
    const weekly = registry.get("github-trending-weekly")!;
    const monthly = registry.get("github-trending-monthly")!;
    expect(weekly.type).toBe("shell");
    expect(weekly.schedule).toBe("0 17 * * 5");
    expect(Array.isArray(weekly.command)).toBe(true);
    expect(weekly.command!.length).toBeGreaterThan(0);
    expect(monthly.type).toBe("shell");
    expect(monthly.schedule).toBe("0 9 1 * *");
    expect(Array.isArray(monthly.command)).toBe(true);
    expect(monthly.command!.length).toBeGreaterThan(0);
  });
});
