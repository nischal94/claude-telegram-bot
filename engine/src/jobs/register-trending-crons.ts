import { join } from "path";
import type { CronRegistry } from "../cron/registry";

export function registerTrendingCrons(registry: CronRegistry): void {
  const scriptPath = join(import.meta.dir, "github-trending.ts");

  const jobs = [
    {
      id: "github-trending-weekly",
      // Every Sunday at 10:00 (local time)
      schedule: "0 10 * * 0",
      type: "shell" as const,
      command: ["bun", "run", scriptPath, "weekly"],
      delivery: "telegram" as const,
    },
    {
      id: "github-trending-monthly",
      // 1st of each month at 10:00 (local time)
      schedule: "0 10 1 * *",
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
