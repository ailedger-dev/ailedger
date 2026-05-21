#!/usr/bin/env python3
"""POST the AILedger Business Pulse dashboard to live Grafana.

Reads:
  GRAFANA_URL       (default http://100.113.167.50:3001)
  GRAFANA_USER      (default admin)
  GRAFANA_PASSWORD  (or file at GRAFANA_PASSWORD_FILE / ~/.secrets/grafana-admin)
"""
from __future__ import annotations
import sys

from grafana_ailedger.client import GrafanaClient
from grafana_ailedger.dashboard import build_dashboard, DASHBOARD_UID


def main() -> int:
    g = GrafanaClient()
    msg = sys.argv[1] if len(sys.argv) > 1 else "Tier 1 panels — POST via build-dashboard.py"
    body = build_dashboard(message=msg)
    result = g.post_dashboard(body)
    if result.get("status") == "success":
        print(f"OK: version={result.get('version')} url={result.get('url')}")
        print(f"Live: {g._url}/d/{DASHBOARD_UID}")
        return 0
    print(f"FAIL: {result}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
