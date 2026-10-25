#!/usr/bin/env bash
# Regression tests for bin/watchdog.sh.
# Stubs tmux, pgrep, and sleep on PATH and runs the watchdog against a fake
# HOME, so no real bot, tmux session, or Telegram message is involved.
#
# Usage: bash tests/watchdog.test.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WATCHDOG="$REPO/bin/watchdog.sh"
FAILURES=0

setup() {
    T="$(mktemp -d "${TMPDIR:-/tmp}/watchdog-test.XXXXXX")" || { echo "[watchdog.test] setup failed: mktemp -d" >&2; exit 2; }
    mkdir -p "$T/home/bin" "$T/stubs" "$T/home/.claude/logs" \
        || { echo "[watchdog.test] setup failed: mkdir in $T" >&2; exit 2; }
    : > "$T/notify.log"
    : > "$T/kills.log"
    : > "$T/pane"

    cat > "$T/home/bin/claude-bot-notify.sh" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$T/notify.log"
EOF

    # Records every call in \$T/pgrep.log.
    # pgrep ... -f: the claude --channels process exists while \$T/claude_alive exists.
    # pgrep -P: the bun child exists while \$T/bun_alive exists, or from the
    # Nth -P call onward when \$T/bun_on_call holds N.
    cat > "$T/stubs/pgrep" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$T/pgrep.log"
case " \$* " in
    *" -f "*) [[ -f "$T/claude_alive" ]] && echo 4242 && exit 0; exit 1 ;;
    *" -P "*)
        [[ -f "$T/bun_alive" ]] && echo 4343 && exit 0
        if [[ -f "$T/bun_on_call" ]]; then
            echo x >> "$T/p_calls"
            [[ \$(wc -l < "$T/p_calls") -ge \$(cat "$T/bun_on_call") ]] && echo 4343 && exit 0
        fi
        exit 1 ;;
esac
exit 1
EOF

    # Records every call in \$T/tmux.log; has-session succeeds unless
    # \$T/no_session exists; send-keys calls also go to \$T/sendkeys.log.
    cat > "$T/stubs/tmux" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$T/tmux.log"
case "\$1" in
    has-session) [[ -f "$T/no_session" ]] && exit 1; exit 0 ;;
    capture-pane) cat "$T/pane" ;;
    kill-session) echo kill >> "$T/kills.log" ;;
    send-keys) echo "\$*" >> "$T/sendkeys.log" ;;
esac
exit 0
EOF

    printf '#!/usr/bin/env bash\nexit 0\n' > "$T/stubs/sleep"
    chmod +x "$T/home/bin/claude-bot-notify.sh" "$T/stubs/"*
    touch "$T/claude_alive"
}

run_watchdog() {
    HOME="$T/home" PATH="$T/stubs:/usr/bin:/bin" bash "$WATCHDOG" >/dev/null 2>>"$T/stderr.log"
}

count() { grep -c "$1" "$2" 2>/dev/null || true; }
kills() { wc -l < "$T/kills.log" | tr -d ' '; }

TRUST_PANE=' Accessing workspace:
 Quick safety check: Is this a project you created or one you trust?
 ❯ No, exit
   Yes, I trust this folder'

assert_eq() {
    local name="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        echo "ok   - $name"
    else
        echo "FAIL - $name (expected: $expected, actual: $actual)"
        FAILURES=$((FAILURES + 1))
    fi
}

# ── Trust prompt: alert once, never restart ──────────────────────────────────
setup
cat > "$T/pane" <<'EOF'
 Accessing workspace:
 Quick safety check: Is this a project you created or one you trust?
 ❯ No, exit
   Yes, I trust this folder
EOF
run_watchdog
run_watchdog
run_watchdog
assert_eq "trust prompt: no restarts" 0 "$(wc -l < "$T/kills.log" | tr -d ' ')"
assert_eq "trust prompt: exactly one alert" 1 "$(count trust "$T/notify.log")"
rm -rf "$T"

# ── Plugin dead with no known cause: stop after 5 restarts ───────────────────
setup
echo "some unrelated pane output" > "$T/pane"
for _i in 1 2 3 4 5 6 7 8; do run_watchdog; done
assert_eq "dead plugin: restarts capped at 5" 5 "$(wc -l < "$T/kills.log" | tr -d ' ')"
assert_eq "dead plugin: one give-up alert" 1 "$(count "stopped restarting" "$T/notify.log")"
assert_eq "dead plugin: no unbound variable errors" 0 "$(count "unbound variable" "$T/stderr.log")"
rm -rf "$T"

# ── Healthy run resets the failure counter ───────────────────────────────────
setup
echo "some unrelated pane output" > "$T/pane"
for _i in 1 2 3; do run_watchdog; done
touch "$T/bun_alive"
run_watchdog
rm -f "$T/bun_alive"
for _i in 1 2 3; do run_watchdog; done
assert_eq "healthy run resets counter: 6 restarts, no give-up" 6 "$(wc -l < "$T/kills.log" | tr -d ' ')"
assert_eq "healthy run resets counter: no give-up alert" 0 "$(count "stopped restarting" "$T/notify.log")"
rm -rf "$T"

# ── Chat text quoting the prompt must not mask a healthy or dead plugin ──────
setup
echo "user: the watchdog said \"choose 'Yes, I trust this folder'\" — what does that mean?" > "$T/pane"
touch "$T/bun_alive"
run_watchdog
assert_eq "chat quote, bun alive: no trust alert" 0 "$(count trust "$T/notify.log")"
assert_eq "chat quote, bun alive: logged HEALTHY" 1 "$(count HEALTHY "$T/home/.claude/logs/claudebot-watchdog.log")"
rm -rf "$T"

# ── A second trust prompt after recovery alerts again ────────────────────────
setup
echo "$TRUST_PANE" > "$T/pane"
run_watchdog
echo "normal output" > "$T/pane"
touch "$T/bun_alive"
run_watchdog
rm -f "$T/bun_alive"
echo "$TRUST_PANE" > "$T/pane"
run_watchdog
assert_eq "trust prompt returns after recovery: two alerts" 2 "$(count trust "$T/notify.log")"
rm -rf "$T"

# ── A second give-up after recovery alerts again ─────────────────────────────
setup
echo "normal output" > "$T/pane"
for _i in 1 2 3 4 5 6; do run_watchdog; done
touch "$T/bun_alive"
run_watchdog
rm -f "$T/bun_alive"
for _i in 1 2 3 4 5 6; do run_watchdog; done
assert_eq "give-up returns after recovery: two give-up alerts" 2 "$(count "stopped restarting" "$T/notify.log")"
rm -rf "$T"

# ── A transient blip (healthy on the grace re-check) resets the counter ──────
setup
echo "normal output" > "$T/pane"
for _i in 1 2 3; do run_watchdog; done
echo 2 > "$T/bun_on_call"
run_watchdog
rm -f "$T/bun_on_call"
for _i in 1 2 3; do run_watchdog; done
assert_eq "transient blip resets counter: 6 restarts" 6 "$(kills)"
assert_eq "transient blip resets counter: no give-up alert" 0 "$(count "stopped restarting" "$T/notify.log")"
rm -rf "$T"

# ── Stale tmux session with no claude process is capped too ──────────────────
setup
rm -f "$T/claude_alive"
for _i in 1 2 3 4 5 6 7 8; do run_watchdog; done
assert_eq "stale session: restarts capped at 5" 5 "$(kills)"
assert_eq "stale session: one give-up alert" 1 "$(count "stopped restarting" "$T/notify.log")"
rm -rf "$T"

# ── No tmux session and no claude process: leave it to launchd ───────────────
setup
rm -f "$T/claude_alive"
touch "$T/no_session"
for _i in 1 2 3; do run_watchdog; done
assert_eq "no session: no restarts, no alerts" "0 0" "$(kills) $(wc -l < "$T/notify.log" | tr -d ' ')"
rm -rf "$T"

# ── Process and session lookups are exact and owner-only ─────────────────────
setup
echo "normal output" > "$T/pane"
touch "$T/bun_alive"
run_watchdog
assert_eq "pgrep for the bot is limited to the owner's uid" 1 "$(grep -c -- "-u $(id -u) -f" "$T/pgrep.log")"
assert_eq "every tmux target is the exact session name" 0 "$(grep -- "-t" "$T/tmux.log" | grep -vc -- "-t =claude-bot")"
assert_eq "pane commands use the exact pane target =claude-bot:" 0 "$(grep -E '^(capture-pane|send-keys|pipe-pane)' "$T/tmux.log" | grep -vc -- "-t =claude-bot:")"
rm -rf "$T"

# The real status line block: the context bar line, usage lines, and Claude
# Code's footer. $1 is the context %, $2 the context size.
status_block() {
    printf '  Opus 5.5 │ [█████████░ %s%% / %s] │ claude-telegram-bot\n' "$1" "$2"
    printf 'current ████░░░░░░ 40%% ⟳ 2h10m\n'
    printf 'weekly  ██░░░░░░░░ 20%% ⟳ 3d4h\n'
    printf '  ⏵⏵ bypass permissions on (shift+tab to cycle)\n'
}

# ── The context % is read from the real multi-line status block ──────────────
setup
{ echo "assistant: here is your answer"; status_block 92 200k; } > "$T/pane"
touch "$T/bun_alive"
run_watchdog
assert_eq "92% in the status block: /compact sent" 1 "$(count "/compact" "$T/sendkeys.log")"
rm -rf "$T"

# ── A 1M context prints its size as 1.0m ─────────────────────────────────────
setup
{ echo "assistant: done"; status_block 91 1.0m; } > "$T/pane"
touch "$T/bun_alive"
run_watchdog
assert_eq "1.0m context at 91%: /compact sent" 1 "$(count "/compact" "$T/sendkeys.log")"
rm -rf "$T"

# ── A /compact that fails counts toward the restart cap ──────────────────────
setup
{ echo "chat line"; status_block 95 200k; } > "$T/pane"
touch "$T/bun_alive"
for _i in 1 2 3 4 5 6 7; do run_watchdog; done
assert_eq "failed compact: restarts capped at 5" 5 "$(kills)"
assert_eq "failed compact: one give-up alert" 1 "$(count "stopped restarting" "$T/notify.log")"
assert_eq "failed compact: no /compact once the cap is reached" 5 "$(count "/compact" "$T/sendkeys.log")"
rm -rf "$T"

# ── The context % comes from the status line, not from chat text ─────────────
setup
{ echo "user: my disk shows [██ 95% / 200k] full, help"; status_block 10 200k; } > "$T/pane"
touch "$T/bun_alive"
run_watchdog
assert_eq "chat text with a percentage: no /compact" 0 "$(cat "$T/sendkeys.log" 2>/dev/null | wc -l | tr -d ' ')"
rm -rf "$T"

# ── An expired login with a full context alerts instead of compacting ────────
setup
{ echo "Not logged in · Please run /login"; status_block 95 200k; } > "$T/pane"
touch "$T/bun_alive"
run_watchdog
assert_eq "expired login at 95% context: OAuth alert" 1 "$(count OAuth "$T/notify.log")"
assert_eq "expired login at 95% context: no /compact" 0 "$(cat "$T/sendkeys.log" 2>/dev/null | wc -l | tr -d ' ')"
assert_eq "expired login at 95% context: no restart" 0 "$(kills)"
rm -rf "$T"

# ── The logs folder is made owner-only ───────────────────────────────────────
setup
chmod 755 "$T/home/.claude/logs"
echo "normal output" > "$T/pane"
touch "$T/bun_alive"
run_watchdog
assert_eq "logs folder is owner-only after a run" "drwx------" "$(ls -ld "$T/home/.claude/logs" | cut -c1-10)"
rm -rf "$T"

# ── Login text quoted in chat above the status block is not an expiry ────────
setup
{ echo "user: what does 'Please run /login' mean?"; for _i in $(seq 1 14); do echo "assistant: line $_i"; done; status_block 20 200k; } > "$T/pane"
touch "$T/bun_alive"
run_watchdog
assert_eq "login text quoted higher up, plugin alive: no OAuth alert" 0 "$(count OAuth "$T/notify.log")"
rm -rf "$T"

# ── Login text on screen must not stop the restart of a dead plugin ──────────
setup
echo "user: what does 'Please run /login' mean?" > "$T/pane"
run_watchdog
assert_eq "dead plugin with login text on screen: restarted" 1 "$(kills)"
assert_eq "dead plugin with login text on screen: no OAuth alert" 0 "$(count OAuth "$T/notify.log")"
rm -rf "$T"

# ── The login error above the input box and a tall status block still alerts ─
setup
{
    echo "assistant: earlier reply"
    echo "  ⎿  API Error: Not logged in · Please run /login"
    echo "✻ Thinking…"
    echo "╭──────────────────────────────────────────╮"
    echo "│ >                                        │"
    echo "╰──────────────────────────────────────────╯"
    printf '  Opus 5.5 │ [█████████░ 20%% / 200k] │ claude-telegram-bot\n'
    printf 'current ████░░░░░░ 40%% ⟳ 2h10m\n'
    printf 'weekly  ██░░░░░░░░ 20%% ⟳ 3d4h\n'
    printf 'extra   █░░░░░░░░░ 10%%\n'
    printf '  ⏵⏵ bypass permissions on (shift+tab to cycle)\n'
} > "$T/pane"
touch "$T/bun_alive"
run_watchdog
assert_eq "login error 10 lines up, plugin alive: OAuth alert" 1 "$(count OAuth "$T/notify.log")"
assert_eq "login error 10 lines up, plugin alive: no restart" 0 "$(kills)"
rm -rf "$T"

# ── An expired login while the plugin runs: alert once, no restart ───────────
setup
echo "Not logged in · Please run /login" > "$T/pane"
touch "$T/bun_alive"
run_watchdog
run_watchdog
assert_eq "expired login, plugin alive: no restart" 0 "$(kills)"
assert_eq "expired login, plugin alive: one OAuth alert" 1 "$(count OAuth "$T/notify.log")"
rm -rf "$T"

if [[ "$FAILURES" -gt 0 ]]; then
    echo "$FAILURES test(s) failed"
    exit 1
fi
echo "all tests passed"
