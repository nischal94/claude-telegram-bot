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

    # pgrep -f: the claude --channels process exists while \$T/claude_alive exists.
    # pgrep -P: the bun child exists while \$T/bun_alive exists, or from the
    # Nth -P call onward when \$T/bun_on_call holds N.
    cat > "$T/stubs/pgrep" <<EOF
#!/usr/bin/env bash
case "\$1" in
    -f) [[ -f "$T/claude_alive" ]] && echo 4242 && exit 0; exit 1 ;;
    -P)
        [[ -f "$T/bun_alive" ]] && echo 4343 && exit 0
        if [[ -f "$T/bun_on_call" ]]; then
            echo x >> "$T/p_calls"
            [[ \$(wc -l < "$T/p_calls") -ge \$(cat "$T/bun_on_call") ]] && echo 4343 && exit 0
        fi
        exit 1 ;;
esac
exit 1
EOF

    # has-session succeeds unless \$T/no_session exists.
    cat > "$T/stubs/tmux" <<EOF
#!/usr/bin/env bash
case "\$1" in
    has-session) [[ -f "$T/no_session" ]] && exit 1; exit 0 ;;
    capture-pane) cat "$T/pane" ;;
    kill-session) echo kill >> "$T/kills.log" ;;
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

if [[ "$FAILURES" -gt 0 ]]; then
    echo "$FAILURES test(s) failed"
    exit 1
fi
echo "all tests passed"
