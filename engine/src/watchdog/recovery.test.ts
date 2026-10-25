import { test, expect } from "bun:test";
import { botPgrepArgs, killSessionArgs } from "./recovery";

test("looks for the bot only among the owner's own processes", () => {
  const args = botPgrepArgs(501);
  expect(args.slice(0, 2)).toEqual(["-u", "501"]);
  expect(args).toContain("-f");
});

test("kills only the session named exactly claude-bot", () => {
  expect(killSessionArgs()).toEqual(["kill-session", "-t", "=claude-bot"]);
});
