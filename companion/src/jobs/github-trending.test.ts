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
