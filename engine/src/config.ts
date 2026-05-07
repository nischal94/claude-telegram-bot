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

const KEYCHAIN_SERVICES = {
  TELEGRAM_BOT_TOKEN: "telegram-bot-token-claudebot",
  TELEGRAM_CHAT_ID: "telegram-chat-id-claudebot",
  ANTHROPIC_API_KEY: "anthropic-api-claudebot",
} as const;

function readKeychain(service: string): string | undefined {
  const proc = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-w"]);
  if (proc.exitCode !== 0) return undefined;
  const value = proc.stdout.toString().trim();
  return value || undefined;
}

export function loadConfig(): Config {
  const home = homedir();

  const resolve = (key: keyof typeof KEYCHAIN_SERVICES): string | undefined =>
    process.env[key] ?? readKeychain(KEYCHAIN_SERVICES[key]);

  const telegramBotToken = resolve("TELEGRAM_BOT_TOKEN");
  const telegramChatId = resolve("TELEGRAM_CHAT_ID");
  const anthropicApiKey = resolve("ANTHROPIC_API_KEY");

  const missing = [
    !telegramBotToken && "TELEGRAM_BOT_TOKEN",
    !telegramChatId && "TELEGRAM_CHAT_ID",
    !anthropicApiKey && "ANTHROPIC_API_KEY",
  ].filter((x): x is string => Boolean(x));

  if (missing.length > 0) {
    console.error(`[engine] Missing required credentials: ${missing.join(", ")}`);
    console.error(`[engine] Expected in macOS Keychain (services: ${missing.map((k) => KEYCHAIN_SERVICES[k as keyof typeof KEYCHAIN_SERVICES]).join(", ")}) or environment`);
    process.exit(1);
  }

  return {
    telegramBotToken: telegramBotToken!,
    telegramChatId: telegramChatId!,
    anthropicApiKey: anthropicApiKey!,
    companionDir: join(home, ".claude", "engine"),
    logsDir: join(home, ".claude", "logs"),
    projectDir: join(home, "projects", "claude-telegram-bot"),
    httpPort: parseInt(process.env.COMPANION_TEST_PORT ?? "7823", 10),
  };
}
