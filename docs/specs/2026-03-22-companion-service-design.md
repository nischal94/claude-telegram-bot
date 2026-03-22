# Companion Service Design

**Date:** 2026-03-22
**Status:** Approved
**Inspired by:** [hermes-agent](https://github.com/NousResearch/hermes-agent) (NousResearch) — borrowed ideas: persistent memory model, skill injection pattern, cron scheduler design

---

## Problem

The existing claude-telegram-bot is stateless, has no cross-session memory, cannot schedule autonomous tasks, and can only detect plugin process death — not bot hangs. This design adds three capabilities without modifying the existing architecture.

---

## Goals

1. **Persistent memory** — bot remembers preferences, facts, and learned patterns across sessions
2. **Scheduled tasks** — reminders and agentic jobs (e.g. morning briefing) delivered to Telegram
3. **Hang detection** — detect and recover from a frozen bot (process alive but not responding), complementing the existing plugin-death watchdog

---

## Non-Goals

- Replacing the existing bot, watchdog, or launch infrastructure
- Real-time IPC between companion and Claude during a session
- Multi-user support
- Migrating away from Claude Code CLI as the agent engine
- Context compression (deferred — lower ROI given Claude Code's existing context handling)
- Portable launchd plists (user-specific paths stay hardcoded; acceptable for personal bot)

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    macOS (launchd)                      │
│                                                         │
│  ┌─────────────────────┐   ┌────────────────────────┐  │
│  │   claude-bot         │   │  claude-bot-companion  │  │
│  │   (existing)         │   │  (new, Bun/TS)         │  │
│  │                      │   │                        │  │
│  │  tmux session        │   │  ┌──────────────────┐  │  │
│  │  └─ claude CLI       │   │  │ Memory Service   │  │  │
│  │     └─ Telegram      │   │  │ (SQLite)         │  │  │
│  │        plugin (bun)  │   │  ├──────────────────┤  │  │
│  │                      │   │  │ Cron Scheduler   │  │  │
│  └──────────┬───────────┘   │  │ (node-cron)      │  │  │
│             │               │  ├──────────────────┤  │  │
│  reads at   │               │  │ Heartbeat        │  │  │
│  startup    │               │  │ Watchdog         │  │  │
│             ▼               │  └──────────────────┘  │  │
│  ~/.claude/companion/        └───────────┬────────────┘  │
│  ├── memory-snapshot.md   ◄──────────────┘ writes        │
│  ├── memory.db            (SQLite)                       │
│  └── cron-jobs.json                                      │
└──────────────────────────────────────────────────────────┘
                             │
                             │ Telegram Bot API
                             ▼
                        Your Telegram
```

**Key principle:** The companion is purely additive. If it is down, the bot starts normally with no memory injection and zero degradation. The companion never sits in the critical path of the bot's message handling.

---

## Component 1: Memory Service

### Storage

SQLite database at `~/.claude/companion/memory.db` using Bun's built-in `bun:sqlite`.

```sql
CREATE TABLE IF NOT EXISTS memories (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  type    TEXT NOT NULL CHECK(type IN ('preference', 'fact', 'learned')),
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  source  TEXT NOT NULL CHECK(source IN ('explicit', 'inferred')),
  created DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE IF NOT EXISTS transcript USING fts5(
  session_id, role, content, timestamp
);
```

### Memory Types

| Type | Description | Example |
|------|-------------|---------|
| `preference` | How you like things done | "show calendar in 12hr format" |
| `fact` | Things you've told it | "gym is 6am on Tuesdays" |
| `learned` | Patterns inferred from use | "usually active on Telegram 8-10am" |

### Character Limits

- Preferences: 2,200 chars total
- Facts: 1,375 chars total
- Learned: 1,000 chars total

Prevents system prompt bloat. On overflow: for `learned` and `fact`, oldest entries are dropped first. For `preference`, entries are dropped in reverse insertion order (most recently added first) since earlier preferences are more likely to be long-standing.

### Write Paths

1. **Explicit from Telegram:** You say "remember: my gym is 6am Tuesdays" → Claude calls `POST localhost:7823/memory` → companion writes to SQLite → re-generates snapshot
2. **Seed file:** `~/.claude/companion/memories-seed.json` (see schema below) — imported once on first companion startup, then ignored
3. **Inferred:** Claude detects a pattern and writes to memory automatically at end of session via the same `POST /memory` endpoint, with `source: "inferred"`

**Seed file schema** (`~/.claude/companion/memories-seed.json`):
```json
[
  { "type": "preference", "key": "calendar format", "value": "always show in 12hr format" },
  { "type": "fact",       "key": "gym schedule",     "value": "6am on Tuesdays" }
]
```
The `source` field is omitted from the seed schema — companion defaults it to `"explicit"` for all seed entries.

### Memory Tool (HTTP API)

Companion exposes a local HTTP server on `localhost:7823`:

```
POST /memory
Body: {
  "op":     "add" | "replace" | "remove",
  "type":   "preference" | "fact" | "learned",          (required for add)
  "key":    string,
  "value":  string,                                      (required for add/replace)
  "source": "explicit" | "inferred"                      (optional, defaults to "explicit")
}
Response: { "ok": true } | { "error": string }

GET /memory
Response: { "preferences": [...], "facts": [...], "learned": [...] }

POST /memory/snapshot
Triggers immediate re-write of memory-snapshot.md
Response: { "ok": true }
```

Claude is instructed via `memory-tool-instructions.txt` (injected into system prompt) to call this endpoint when it detects memory-related intent.

### Memory Snapshot

The companion writes `~/.claude/companion/memory-snapshot.md` on startup and after every write:

```markdown
## Your Memory

### Preferences
- Calendar: always show in 12hr format
- Responses: prefer bullet points over prose

### Facts
- Gym: 6am on Tuesdays
- Project deadline: April 5

### Learned
- Usually active on Telegram between 8-10am
```

### Integration with launch_bot.sh

`deploy/launch_bot.sh` is updated to inject the memory snapshot using `--append-system-prompt-file` (the file-based variant of the flag, confirmed available via `claude --help`):

```bash
# Before (existing final block):
exec claude \
    --dangerously-skip-permissions \
    --append-system-prompt "$SYSTEM_PROMPT" \
    --channels plugin:telegram@claude-plugins-official

# After:
MEMORY_SNAPSHOT="$HOME/.claude/companion/memory-snapshot.md"
MEMORY_INSTRUCTIONS="$EXPERIMENT_DIR/prompts/memory-tool-instructions.txt"

EXTRA_FLAGS=()
if [ -f "$MEMORY_SNAPSHOT" ]; then
    EXTRA_FLAGS+=(--append-system-prompt-file "$MEMORY_SNAPSHOT")
fi
if [ -f "$MEMORY_INSTRUCTIONS" ]; then
    EXTRA_FLAGS+=(--append-system-prompt-file "$MEMORY_INSTRUCTIONS")
fi

exec claude \
    --dangerously-skip-permissions \
    --append-system-prompt "$SYSTEM_PROMPT" \
    "${EXTRA_FLAGS[@]}" \
    --channels plugin:telegram@claude-plugins-official
```

Using `--append-system-prompt-file` (file path) avoids all multiline string quoting and argument-length issues. If neither file exists, `EXTRA_FLAGS` is empty and the bot launches exactly as before. **This is the only change to existing files.**

### Security Scanning

Before writing any memory entry, companion checks for injection patterns:
- "ignore previous instructions" / "you are now"
- Hidden Unicode (zero-width spaces, directional markers — detected via regex `/[\u200b-\u200f\u202a-\u202e]/`)
- Exfiltration patterns (`curl`/`wget` with `$`, `.env` references)

Blocked entries are rejected with `{ "error": "blocked: injection pattern detected" }`.

### system-prompt.example.txt update

The existing rule "Memory honesty — You have no cross-session memory" is updated to:

> **Memory** — You have persistent memory via a memory tool. When the user says "remember X" or you notice a preference worth saving, call POST localhost:7823/memory. Be transparent: tell the user when you've saved something. If the companion is unavailable (tool call fails), say so honestly rather than claiming you saved it.

---

## Component 2: Cron Scheduler

### Job Registry

`~/.claude/companion/cron-jobs.json` — watched via `fs.watch` on macOS. Changes are picked up within ~1 second. Note: `fs.watch` on macOS has occasional missed events on high-frequency edits; for a personal bot with infrequent manual edits this is acceptable. The companion also re-reads the file on each tick as a fallback.

```json
[
  {
    "id": "morning-briefing",
    "schedule": "0 8 * * 1-5",
    "type": "agent",
    "prompt": "Fetch my calendar for today and summarize it. Check for conflicts or tight gaps.",
    "delivery": "telegram",
    "enabled": true,
    "created": "2026-03-22T10:00:00Z",
    "lastRun": null,
    "runCount": 0
  },
  {
    "id": "gym-reminder",
    "schedule": "0 5 * * 2",
    "type": "reminder",
    "message": "Gym in 1 hour 💪",
    "delivery": "telegram",
    "enabled": true,
    "created": "2026-03-22T10:00:00Z",
    "lastRun": null,
    "runCount": 0
  }
]
```

### Job Types

**`reminder`** — companion sends a static `message` directly via Telegram Bot API. No Claude invoked. Fast, cheap.

**`agent`** — companion spawns `claude --print` with the job's `prompt`. Full tool access (calendar, web search, etc.). Result delivered to Telegram.

### Creating Jobs

**From Telegram (natural language):**
> "Remind me every Monday at 9am to check my goals"

Claude parses the intent, calls `POST localhost:7823/cron`. Companion writes to `cron-jobs.json` and confirms via Telegram.

**Manual config:**
Edit `cron-jobs.json` directly. The `created` field is an ISO 8601 timestamp; companion sets it automatically when creating via API. For manual edits, it is optional — companion defaults to the current time if absent or malformed.

### Managing Jobs from Telegram

```
"what reminders do I have?"   → lists all enabled jobs with human-readable schedules
"pause the morning briefing"  → sets enabled: false, confirms
"resume morning briefing"     → sets enabled: true, confirms
"delete gym reminder"         → removes from registry, confirms
"run morning briefing now"    → triggers immediate one-off execution
```

### Execution Safety

- **Serial execution:** Jobs queue, not run in parallel. Avoids hammering Claude API.
- **5-minute timeout:** Hung agent tasks are killed. Error message sent to Telegram.
- **Retry:** Failed jobs retry once after 60 seconds. Second failure sends error to Telegram and marks job as `lastError`.
- **Output size limit:** Agent job output truncated at 3,800 chars before Telegram delivery (stays under 4,096 char limit).

### Cron HTTP API

```
POST /cron
Body: {
  "id":       string,              (caller-suggested, companion dedupes)
  "schedule": string,              (cron expression, e.g. "0 9 * * 1")
  "type":     "reminder" | "agent",
  "message":  string,              (required if type=reminder)
  "prompt":   string,              (required if type=agent)
  "delivery": "telegram"           (only supported value for now)
}
Response: { "ok": true, "id": string } | { "error": string }

GET  /cron               — list all jobs
PATCH /cron/:id          — update fields (enabled, schedule, message, prompt)
DELETE /cron/:id         — remove job
POST /cron/:id/run       — trigger immediate one-off execution
```

### Credentials

The companion reads `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `ANTHROPIC_API_KEY` from `~/.claude/.env` at startup (same file used by `bin/start.sh` and `bin/notify.sh`), sourced via `dotenv` or manual line parsing. All three are validated on startup — companion logs an error and exits if any are missing or empty. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are required for cron delivery, heartbeat ping/pong, and notifications. `ANTHROPIC_API_KEY` is required for `agent` type cron jobs (passed to `claude --print` subprocess); if absent, agent jobs fail immediately with a clear error delivered to Telegram.

---

## Component 3: Heartbeat Watchdog

Complements the existing `watchdog.sh` (plugin process death detection). This handles the orthogonal failure: bot process alive but frozen.

### Detection: Heartbeat Ping (primary)

Every 5 minutes, companion sends a silent ping to the bot via Telegram Bot API:

```
[HEARTBEAT_PING_<nonce>]
```

`memory-tool-instructions.txt` (injected into system prompt) instructs Claude to immediately reply `[HEARTBEAT_PONG_<nonce>]` when it sees this pattern, before doing anything else.

- **Pong received within 90s** → healthy, log to `companion-health.log`
- **No pong within 90s** → bot is hung, trigger recovery

The nonce (random 8-char hex, generated per ping) prevents stale pongs from a previous session counting as a valid response.

**UX note:** The heartbeat ping appears in your Telegram chat history every 5 minutes as a message from the bot to itself. This is intentional and acceptable for a personal bot. The pong reply also appears. Both are visually distinct (`[HEARTBEAT_PING_...]` / `[HEARTBEAT_PONG_...]`) so they don't interfere with normal conversation flow. If this becomes noisy, the interval can be increased to 10–15 minutes without meaningfully impacting hang detection.

### Detection: Activity Timeout (fallback)

Companion tracks two timestamps:
1. `lastPingSentAt` — when it sent the most recent heartbeat
2. `lastSentMessageAt` — when the companion itself last sent a Telegram message (cron delivery, notification, heartbeat)

It does **not** run a second `getUpdates` poll (which would conflict with the Telegram plugin's offset-based polling). Instead, it uses its own outbound activity as a proxy for bot health combined with the ping/pong result.

If all three conditions are true simultaneously:
1. No pong received in the last two heartbeat cycles (10 minutes)
2. Bot process is running (`pgrep -f "claude.*--channels plugin:telegram"` returns a PID)
3. No recovery already in progress

→ Assume hung, trigger recovery.

### Recovery Flow

```
1. Kill tmux claude-bot session
   └─ launchd detects exit, restarts bot (10s throttle — same as today)
2. Poll every 5s for up to 90s:
   └─ Recovery confirmed: new Claude PID present + bun child present
3. Send one heartbeat ping, wait up to 90s for pong
   └─ Pong received → send "⚠️ Bot was hung and has been restarted"
   └─ No pong → count as failed attempt, retry recovery up to 3 times
```

### Escalation

If recovery fails **3 times within 1 hour**:
```
"❌ Bot has failed to recover 3 times in the last hour. Manual intervention needed."
```
Companion stops attempting recovery for 1 hour. Prevents crash loops.

### Health Log

Companion appends to `~/.claude/logs/companion-health.log` every 5 minutes:

```
2026-03-22T09:15:00 HEALTHY (pong 1.2s)
2026-03-22T09:20:00 HEALTHY (pong 0.8s)
2026-03-22T09:25:00 HUNG — triggering recovery (attempt 1/3)
2026-03-22T09:26:30 RECOVERED (pong confirmed in 28s)
```

This solves the audit gap of "can't tell if watchdog is alive between events."

---

## File Structure

### Repository

```
claude-telegram-bot/
├── companion/
│   ├── src/
│   │   ├── index.ts              # Entry point — wires all services, reads .env
│   │   ├── memory/
│   │   │   ├── store.ts          # SQLite read/write (bun:sqlite)
│   │   │   ├── snapshot.ts       # Writes memory-snapshot.md
│   │   │   └── tool-handler.ts   # HTTP handlers for /memory endpoints
│   │   ├── cron/
│   │   │   ├── scheduler.ts      # node-cron job runner
│   │   │   ├── registry.ts       # cron-jobs.json read/write/watch
│   │   │   └── executor.ts       # reminder vs agent job execution
│   │   ├── watchdog/
│   │   │   ├── heartbeat.ts      # Ping/pong + activity timeout logic
│   │   │   └── recovery.ts       # Kill tmux, wait, verify, notify
│   │   └── telegram.ts           # Thin Telegram Bot API client (fetch-based)
│   ├── package.json
│   ├── tsconfig.json
│   └── bun.lock
│
├── launchd/
│   ├── com.nischal.claudebot.plist              # unchanged
│   ├── com.nischal.claudebot-watchdog.plist     # unchanged
│   └── com.nischal.claudebot-companion.plist    # NEW (see spec below)
│
├── deploy/
│   └── launch_bot.sh     # +10 lines: memory snapshot + instructions injection
│
└── prompts/
    ├── current.txt                    # unchanged (user edits manually)
    ├── system-prompt.example.txt      # updated: memory rule reworded
    └── memory-tool-instructions.txt   # NEW — injected at launch
```

### Companion launchd Plist

`launchd/com.nischal.claudebot-companion.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nischal.claudebot-companion</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/nischal/.bun/bin/bun</string>
    <string>run</string>
    <string>/Users/nischal/projects/claude-telegram-bot/companion/src/index.ts</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/nischal</string>
    <key>PATH</key>
    <string>/Users/nischal/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>/Users/nischal/projects/claude-telegram-bot/companion</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>/Users/nischal/.claude/logs/companion.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/nischal/.claude/logs/companion.log</string>
</dict>
</plist>
```

Credentials (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY`) are **not** in the plist. Companion reads them from `~/.claude/.env` at startup, consistent with how `bin/start.sh` handles them.

### Runtime Data (outside repo, gitignored)

```
~/.claude/companion/
├── memory.db              # SQLite database (created on first run)
├── memory-snapshot.md     # Written by companion, read by bot at startup
├── cron-jobs.json         # Job registry (created as [] on first run if absent)
└── memories-seed.json     # Optional one-time import (user-created)

~/.claude/logs/
├── claudebot.log                  # existing
├── claudebot-watchdog.log         # existing
├── companion.log                  # NEW (companion stdout/stderr via launchd)
└── companion-health.log           # NEW (heartbeat status every 5min)
```

---

## Tech Stack

| Concern | Solution | Rationale |
|---------|----------|-----------|
| Runtime | Bun | Already in environment (Telegram plugin uses it) |
| Language | TypeScript | Type safety, consistent with plugin |
| SQLite | `bun:sqlite` | Built into Bun — zero extra deps |
| Cron | `node-cron` | Tiny, well-maintained, standard cron syntax |
| HTTP server | `Bun.serve()` | Built into Bun — no Express needed |
| Telegram API | `fetch()` | Direct Bot API calls — no SDK needed |

**Total new npm dependencies: 1** (`node-cron`)

---

## Reliability & Failure Modes

| Scenario | Behavior |
|----------|----------|
| Companion is down | Bot starts normally. No memory injection, no cron, no hang detection. Zero degradation to existing functionality. |
| `memory-snapshot.md` missing | `EXTRA_FLAGS` array is empty; `--append-system-prompt-file` not passed. Bot launches as before. |
| SQLite write fails | Log error, skip write. Memory from last snapshot still injected next startup. |
| Cron job agent task hangs | Killed after 5min timeout. Error message sent to Telegram. |
| Telegram API down during heartbeat ping | Ping send fails. Companion waits for next 5-minute cycle. No false recovery trigger (pong timeout only triggers after a successful ping). |
| Companion crashes | launchd restarts it (10s throttle). `cron-jobs.json` and `memory.db` persist on disk. Jobs resume on restart. |
| Bot hang + Telegram API down simultaneously | Companion detects hang via activity timeout fallback. Still kills tmux. Bot recovers. Cannot send notification until API is back. |
| `.env` missing or malformed on companion startup | Companion logs error and exits. launchd restarts; retries indefinitely. Bot unaffected. |
| `--append-system-prompt-file` flag not available in installed Claude version | `launch_bot.sh` will fail at the `exec claude` line with an unknown flag error. Fallback: the script can be updated to use `--append-system-prompt "$(cat file)"` instead. Detected immediately on first restart. |

---

## Existing Reliability Fixes (from audit)

Addressed alongside companion implementation in the same PR:

| Fix | Location |
|-----|----------|
| Log rotation: cap `claudebot.log` via launchd `SizeLimit` key | `com.nischal.claudebot.plist` |
| Validate `prompts/current.txt` exists before launching | `deploy/launch_bot.sh` (already done — confirmed in audit) |
| Validate `.env` has required keys | `bin/start.sh` (already done — confirmed in audit) |
| Retry (3×, exponential backoff) in `notify.sh` | `bin/notify.sh` |
| Watchdog health heartbeat: log "HEALTHY" every interval even without events | `bin/watchdog.sh` |
