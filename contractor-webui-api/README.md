# contractor-webui-api

FastAPI service backing the contractor web UI. Runs on the desktop under the
contractor's Linux user (e.g., `sales-agent` for Pasha), bound to localhost;
Cloudflare Tunnel is the public surface at `api.<slug>.<domain>`.

One binary, many contractors. A single instance serves one contractor (per
`CONTRACTOR_SLUG`); for multiple contractors, run multiple instances on
different ports (typical deployment) under each contractor's Linux user.

## Endpoints

All endpoints require the `session` cookie (issued by `contractor-auth`) to be
valid HS256, audience = this contractor's slug, issuer = `contractor-auth`.

```
GET  /health              200 always
GET  /me                  current user (for debugging)
GET  /inbox               addressable hails (6-gate filter, unread + read)
GET  /message/{id}        rendered markdown → html
POST /read/{id}           mark-read sentinel
GET  /docs                reading-room doc list
GET  /doc/{id}            rendered markdown → html
```

## Install on desktop (Pasha)

Run as the contractor's Linux user (`sales-agent` for Pasha). These commands
are paste-ready for `ssh jjoyner@100.113.167.50`. **Do NOT run under `jjoyner`
on the desktop** — the process must run in the contractor's silo so its
process tree, cache dir, and open file handles respect the per-silo boundary.

```sh
# 1. Clone or rsync the service to the contractor's home.
# Choose ONE: rsync from lemur OR direct git clone/checkout on desktop.

# From lemur (in the polecat worktree):
rsync -av --exclude __pycache__ --exclude .venv \
  ~/gt-lab/ailedger/polecats/dust/ailedger/contractor-webui-api/ \
  sales-agent@100.113.167.50:/home/sales-agent/contractor-webui-api/

# On desktop, as sales-agent:
cd ~/contractor-webui-api
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt

# 2. Stash the JWT secret (same bytes as the auth worker's SESSION_JWT_SECRET).
mkdir -p ~/.secrets
chmod 700 ~/.secrets
# Copy the value from ~jjoyner/gt-lab/.secrets/contractor-auth-pasha-session.key
# on lemur. Must be EXACTLY the contents (no trailing newline wrangles).
install -m 600 <(cat /path/to/source) ~/.secrets/contractor-auth-pasha-session.key

# 3. Create the systemd env file.
mkdir -p ~/.config/contractor-webui-api ~/.config/systemd/user
cp ~/contractor-webui-api/contractors/pasha.env.example \
   ~/.config/contractor-webui-api/pasha.env
chmod 600 ~/.config/contractor-webui-api/pasha.env
# Edit to confirm paths. CONTRACTOR_JWT_SECRET_FILE must point at the secret
# you just installed.

# 4. Install the systemd user unit (templated).
cp ~/contractor-webui-api/systemd/contractor-webui-api@.service \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now contractor-webui-api@pasha.service
systemctl --user status contractor-webui-api@pasha.service --no-pager

# 5. Smoke test from desktop:
curl -sS http://127.0.0.1:7777/health   # {"ok":true}
```

## Cloudflare Tunnel (desktop, one-time)

The service binds localhost only. Public reachability is via `cloudflared`.

```sh
# Install cloudflared per-user (no sudo).
mkdir -p ~/bin ~/.cloudflared
curl -fsSL -o ~/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x ~/bin/cloudflared
export PATH=$HOME/bin:$PATH

# Auth and create a tunnel (first contractor only; subsequent contractors
# reuse the same tunnel with additional hostname entries).
~/bin/cloudflared tunnel login                              # browser OAuth
~/bin/cloudflared tunnel create contractor-webui-api        # prints tunnel UUID

# Configure ~/.cloudflared/config.yml:
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: <paste-UUID>
credentials-file: /home/<user>/.cloudflared/<paste-UUID>.json

ingress:
  - hostname: api.pasha.jvholdings.co
    service: http://127.0.0.1:7777
  # (add more per-contractor hostnames here when onboarding future contractors)
  - service: http_status:404
EOF

# Route the hostname to the tunnel (creates CNAME on Cloudflare for zones we
# own; for zones NOT on Cloudflare like jvholdings.co, Jake must add the
# CNAME at NameCheap — see paste-ready).
~/bin/cloudflared tunnel route dns contractor-webui-api api.pasha.jvholdings.co

# Run as a systemd user unit for auto-restart + linger:
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/cloudflared.service <<'EOF'
[Unit]
Description=cloudflared tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/bin/cloudflared tunnel --config %h/.cloudflared/config.yml run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now cloudflared.service
```

## Security posture

- Process bound to localhost. No direct public listener.
- JWT verified strictly with `audience=<slug>`, `issuer=contractor-auth`, and
  `contractor` claim — a Pasha token cannot access future-contractor-N's API.
- Path-traversal defenses in both inbox and docs handlers: filenames must match
  the addressable-hail pattern (inbox) or stay resolvably inside `docs_dir`.
- Strict-confidence logs: `main.py` middleware ensures transcript content never
  reaches the log stream; only metadata (request path, method) is logged.

## Tests

```sh
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m pytest tests/
```
