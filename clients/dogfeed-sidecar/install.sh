#!/usr/bin/env bash
# install.sh — wire dogfeed-sidecar into the user's gt-lab.
#
# Idempotent: safe to re-run. Installs scripts to ~/gt-lab/bin/, links
# systemd units to ~/.config/systemd/user/, prints the exact Claude Code
# hook config snippet for mayor/.claude/settings.json. Does NOT modify
# Bob's settings (per ai-4vp off-limits policy — Jake/Bob installs).
#
# Override the install root with $GT_LAB_ROOT (used by the install test
# in tmp dir). Default: ~/gt-lab.
set -euo pipefail

GT_LAB_ROOT="${GT_LAB_ROOT:-$HOME/gt-lab}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BIN_SRC="$SCRIPT_DIR/bin"
SYSTEMD_SRC="$SCRIPT_DIR/systemd"

BIN_DST="$GT_LAB_ROOT/bin"
QUEUE_DIR="$GT_LAB_ROOT/.dogfeed"
SECRETS_DIR="$GT_LAB_ROOT/.secrets"
SECRETS_FILE="$SECRETS_DIR/dogfeed.env"
SYSTEMD_DST="$HOME/.config/systemd/user"

# When invoked with a non-default GT_LAB_ROOT (e.g. install tests against
# mktemp -d), don't write into the real user's ~/.config/systemd/user —
# write systemd units inside the alt root so cleanup is just `rm -rf`.
if [[ "$GT_LAB_ROOT" != "$HOME/gt-lab" ]]; then
  SYSTEMD_DST="$GT_LAB_ROOT/.config/systemd/user"
  SKIP_SYSTEMCTL=1
fi

echo "[dogfeed-sidecar] installing to $GT_LAB_ROOT"

mkdir -p "$BIN_DST" "$QUEUE_DIR" "$SECRETS_DIR" "$SYSTEMD_DST"
chmod 700 "$SECRETS_DIR"

install -m 0755 "$BIN_SRC/dogfeed-capture" "$BIN_DST/dogfeed-capture"
install -m 0755 "$BIN_SRC/dogfeed-drain"   "$BIN_DST/dogfeed-drain"

# Drop a stub secrets file the first time so the user knows what to fill in.
if [[ ! -f "$SECRETS_FILE" ]]; then
  cat > "$SECRETS_FILE" <<'EOF'
# AILedger dogfeed sidecar secrets. Source of truth for dogfeed-drain.
# chmod 600 enforced below.
AILEDGER_PROXY_URL=https://proxy.ailedger.dev
AILEDGER_KEY=REPLACE_WITH_alg_sk_KEY
EOF
fi
chmod 600 "$SECRETS_FILE"

# systemd units only when systemd-as-user is available. Skip silently in
# environments without it (CI, ephemeral test dirs).
if command -v systemctl >/dev/null 2>&1 && [[ -d /run/user/$(id -u) ]]; then
  install -m 0644 "$SYSTEMD_SRC/dogfeed-drain.service" "$SYSTEMD_DST/dogfeed-drain.service"
  install -m 0644 "$SYSTEMD_SRC/dogfeed-drain.timer"   "$SYSTEMD_DST/dogfeed-drain.timer"
  if [[ -z "${SKIP_SYSTEMCTL:-}" ]]; then
    systemctl --user daemon-reload
    systemctl --user enable --now dogfeed-drain.timer >/dev/null
    echo "[dogfeed-sidecar] timer enabled — runs every 5 minutes"
  else
    echo "[dogfeed-sidecar] alt root detected; units staged at $SYSTEMD_DST (no systemctl)"
  fi
else
  echo "[dogfeed-sidecar] systemd-user unavailable; skipped timer install"
  echo "                   (run \`crontab -e\` and add: */5 * * * * $BIN_DST/dogfeed-drain)"
fi

echo
echo "[dogfeed-sidecar] install complete."
echo
echo "Next step: edit $SECRETS_FILE and fill in AILEDGER_KEY."
echo
echo "Then ADD this hook entry to ~/.claude/settings.json (or"
echo "mayor/.claude/settings.json for Bob — Jake installs that side):"
echo
cat <<EOF
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "$BIN_DST/dogfeed-capture" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "$BIN_DST/dogfeed-capture" }
        ]
      }
    ]
  }
}
EOF
echo
echo "Verify the queue is draining: ls -lh $QUEUE_DIR"
