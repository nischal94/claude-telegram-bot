import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface Config {
  telegramBotToken: string;
  telegramChatId: string;
  anthropicApiKey: string;
  companionDir: string;
  logsDir: string;
  projectDir: string;
  httpPort: number;
}

function parseEnvFile(path: string): Record<string, string> {
  try {
    const content = readFileSync(path, "utf-8");
    const result: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      result[key] = value;
    }
    return result;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`[config] Failed to read env file at ${path}: ${(err as Error).message}`);
    }
    return {};
  }
}

export function loadConfig(): Config {
  const home = homedir();
  const envPath = join(home, ".claude", ".env");
  const env = { ...parseEnvFile(envPath), ...process.env };

  const required = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "ANTHROPIC_API_KEY"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`[engine] Missing required credentials: ${missing.join(", ")}`);
    console.error(`[engine] Expected in ${envPath} or environment`);
    process.exit(1);
  }

  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN!,
    telegramChatId: env.TELEGRAM_CHAT_ID!,
    anthropicApiKey: env.ANTHROPIC_API_KEY!,
    companionDir: join(home, ".claude", "engine"),
    logsDir: join(home, ".claude", "logs"),
    projectDir: join(home, "projects", "claude-telegram-bot"),
    httpPort: parseInt(process.env.COMPANION_TEST_PORT ?? "7823", 10),
  };
}
