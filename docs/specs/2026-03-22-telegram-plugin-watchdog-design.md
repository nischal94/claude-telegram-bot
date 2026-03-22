# Telegram Plugin Watchdog — Design Spec

**Date:** 2026-03-22
**Status:** Approved

---

## Problem

The Claude Telegram bot (`claude --channels plugin:telegram@claude-plugins-official`) runs inside a tmux session managed by launchd. When the Telegram plugin (a `bun` subprocess) dies silently, `claude` stays alive at an idle prompt — deaf to new messages. Since launchd only restarts when `claude` itself exits, the bot can be broken indefinitely with no recovery and no notification.

**Root cause:** launchd watches process exit. The failure is a dead child process inside a still-running parent.

---

## Solution: Child Process Watchdog

A separate launchd service runs a watchdog script approximately every 30 seconds. It detects the dead plugin by checking whether the `claude` process has a `bun` child. If not, it waits 5s and re-checks (grace period) before acting. If still no `bun` child, it kills the tmux session (triggering launchd to restart the bot), then sends a Telegram notification once the bot recovers.

---

## Components

### 1. `~/bin/claude-bot-notify.sh`
Shared helper. Sends a Telegram message via direct `curl` to `api.telegram.org`. Takes a single message argument. Sources `~/.claude/.env` with `set -a; source ~/.claude/.env; set +a` to load `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Exits 0 regardless of curl result (best-effort notification — never block the watchdog). No dependency on the claude process.

### 2. `~/bin/claude-bot-watchdog.sh`
Core watchdog logic:

1. Find PID of the `claude` process running `--channels plugin:telegram` using:
   ```bash
   pgrep -f "claude.*--channels plugin:telegram"
   ```
2. If zero matches → bot isn't running, exit 0 (launchd handles the bot separately)
3. If multiple matches → log warning and exit 0 (ambiguous state, don't act)
4. Check if that single PID has a `bun` child:
   ```bash
   pgrep -P "$claude_pid" bun
   ```
   **Assumption:** there is at most one `claude --channels plugin:telegram` process, and any `bun` child of it is the Telegram plugin. The plugin never self-restarts — a missing `bun` child always means failure.
5. If `bun` child found → healthy, exit 0
6. If no `bun` child → wait 5s and re-check (grace period to avoid acting on transient state)
7. If still no `bun` child after grace period → plugin confirmed dead:
   - Log event with timestamp to `~/.claude/logs/claudebot-watchdog.log`
   - Kill the tmux `claude-bot` session (wrapper exits → launchd restarts bot)
   - Poll every 5s for up to 60s for recovery, defined as: a new `claude --channels plugin:telegram` process exists AND it has a `bun` child
   - If recovered: send Telegram notification: `"⚠️ Bot restarted — Telegram plugin had died"`; exit 0
   - If not recovered within 60s: log failure; send Telegram notification: `"❌ Bot failed to recover after plugin death — manual intervention needed"`; exit 1

**Note on launchd overlap:** launchd's `StartInterval` waits for the job to exit before starting the next interval. So two watchdog instances cannot run simultaneously. However, in the failure path the watchdog blocks for up to 60s during recovery polling, making the effective check interval ~90s (30s interval + up to 60s poll). This is acceptable.

### 3. `~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist`
Runs `claude-bot-watchdog.sh` on a `StartInterval` of 30 seconds. `EnvironmentVariables` must include:
```
PATH = /Users/nischal/bin:/Users/nischal/.local/bin:/Users/nischal/.npm-global/bin:/Users/nischal/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
HOME = /Users/nischal
```
(`~/bin` must be first so `claude-bot-notify.sh` is found.) Logs stdout+stderr to `~/.claude/logs/claudebot-watchdog-launchd.log`.

### 4. `~/bin/claude-bot-start.sh` (modified)
After the tmux session and `pipe-pane` are set up, call:
```bash
"$HOME/bin/claude-bot-notify.sh" "✅ Bot started" || true
```
The `|| true` ensures a notification failure never aborts the wrapper. The notification is sent immediately after tmux session creation — it signals "bot process launched", not "bot is fully ready". This is intentional and acceptable.

### 5. `~/.claude/.env` (modified)
Add two new variables (unquoted, no spaces around `=`):
```
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<your_numeric_chat_id>
```
The `set -a; source; set +a` pattern in `claude-bot-notify.sh` handles this format correctly.

---

## Detection Logic

```
pgrep -f "claude.*--channels plugin:telegram"
  → 0 matches: exit 0 (bot not running)
  → 2+ matches: log warning, exit 0 (ambiguous)
  → 1 match: check pgrep -P $pid bun
      → found: healthy, exit 0
      → not found: wait 5s, re-check
          → found: healthy (transient), exit 0
          → still not found: DEAD
              → kill tmux claude-bot
              → poll for recovery (claude process + bun child both present)
              → notify result
```

---

## Notification Design

Only the watchdog sends notifications — `claude-bot-start.sh` also sends "✅ Bot started" independently. Notification ordering is not guaranteed between the two. In practice:
- `claude-bot-start.sh` fires as soon as the tmux session is created (~15s after plugin death detected)
- Watchdog fires after recovery is confirmed (~15–75s after kill)

Users will typically see "✅ Bot started" first, then "⚠️ Bot restarted". Both are sent via `claude-bot-notify.sh` which uses:
```bash
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d chat_id="${TELEGRAM_CHAT_ID}" \
  -d text="$1"
```

---

## Files Changed

| File | Action |
|------|--------|
| `~/bin/claude-bot-notify.sh` | Create |
| `~/bin/claude-bot-watchdog.sh` | Create |
| `~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist` | Create |
| `~/bin/claude-bot-start.sh` | Modify — add startup notification |
| `~/.claude/.env` | Modify — add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` |

---

## Recovery Time Budget

| Event | Time |
|-------|------|
| Plugin dies | t=0 |
| Watchdog detects (next interval) | ≤30s |
| Grace period re-check | +5s |
| launchd throttle | +10s |
| Bot startup | +5s |
| Recovery confirmed (first poll) | +5s |
| **Typical total** | **~55s** |
| **Worst case** (recovery poll runs full 60s) | **~110s** |

---

## Log Files

| File | Written by |
|------|-----------|
| `~/.claude/logs/claudebot-watchdog.log` | watchdog script (detection events, recovery results) |
| `~/.claude/logs/claudebot-watchdog-launchd.log` | launchd (script stdout/stderr) |

No log rotation is implemented — these logs are low-volume (one line per 30s interval at most) and are acceptable to manage manually.

---

## Out of Scope

- Alerting on other MCP server failures (context7, github) — those don't affect message delivery
- Retry logic if Telegram API is down during notification
- Persistent message queue (messages sent while bot is down are lost)
- Log rotation
