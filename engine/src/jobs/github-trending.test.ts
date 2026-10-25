import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { buildTextDigest, cardLaunchOptions, deliverTextDigest, fetchTrending } from "./github-trending";

test("the card browser talks over a pipe and opens no TCP debugging port", () => {
  const opts = cardLaunchOptions("/path/to/chrome-headless-shell");
  expect(opts.pipe).toBe(true);
  expect(opts.executablePath).toBe("/path/to/chrome-headless-shell");
  expect(opts.args.some((a) => a.startsWith("--remote-debugging-port"))).toBe(false);
});

test("the card browser keeps Chromium's own sandbox", () => {
  expect(cardLaunchOptions("/x").args).not.toContain("--no-sandbox");
});

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

const NOW = new Date(2026, 9, 25);

test("the text digest escapes scraped fields as HTML", () => {
  const text = buildTextDigest([{
    rank: 1, owner: "some_org", name: "a<b>&c", description: "<script>alert(1)</script> & *stars*", starsGained: "1,234",
  }], "weekly", null, NOW);
  expect(text).toContain("some_org/a&lt;b&gt;&amp;c");
  expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; *stars*");
  expect(text).not.toContain("<script>");
});

test("the text digest keeps its own formatting as HTML tags", () => {
  const text = buildTextDigest([{ rank: 2, owner: "o", name: "n", description: "", starsGained: "?" }], "monthly", null, NOW);
  expect(text).toContain("<b>Fastest Growing GitHub Repos Last Month</b>");
  expect(text).toContain("<b>02. o/n</b> — ⭐");
  expect(text).toContain("<i>No description</i>");
});

test("the text digest is sent in HTML mode", async () => {
  const calls: [string, unknown][] = [];
  const telegram = { sendMessageWithRetry: async (text: string, options?: unknown) => { calls.push([text, options]); } };
  await deliverTextDigest(telegram as any, [], "weekly", null, NOW);
  expect(calls).toHaveLength(1);
  expect(calls[0][1]).toEqual({ parseMode: "HTML" });
});

test("the text digest cuts long descriptions so the HTML stays under Telegram's limit", () => {
  // GitHub's limits: owner names up to 39 characters, repo names up to 100.
  const repos = Array.from({ length: 10 }, (_, i) => ({
    rank: i + 1, owner: "o".repeat(39), name: "n".repeat(100), description: "<".repeat(400), starsGained: "99,999",
  }));
  const text = buildTextDigest(repos, "weekly", "e".repeat(1000), NOW);
  // Telegram counts the limit after parsing: tags vanish, entities count once.
  // The digest uses only these four tags, so remove them exactly.
  const rendered = ["<b>", "</b>", "<i>", "</i>"]
    .reduce((t, tag) => t.split(tag).join(""), text)
    .replace(/&(lt|gt|amp|quot);/g, "x");
  expect(rendered.length).toBeLessThanOrEqual(4096);
  expect(text).toContain("…</i>");
  // Escaping happens after the cut, so no entity is split.
  expect(text).not.toMatch(/&[a-z]*…/);
});

test("cutting a description or the error never leaves half a character", () => {
  const loneHighSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
  // 101 emoji are 202 code units: the description cut falls mid-emoji.
  const text = buildTextDigest(
    [{ rank: 1, owner: "o", name: "n", description: "😀".repeat(101), starsGained: "1" }],
    "weekly", "😀".repeat(151), NOW,
  );
  expect(text).toContain("…</i>");
  expect(loneHighSurrogate.test(text)).toBe(false);
});

test("the text digest escapes the render error it reports", () => {
  const text = buildTextDigest([], "weekly", "no <shell> found & failed", NOW);
  expect(text).toContain("Reason: no &lt;shell&gt; found &amp; failed");
});
