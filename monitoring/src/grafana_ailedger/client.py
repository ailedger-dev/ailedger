"""Live clients for Supabase Management API + Grafana HTTP API.

Both clients are dependency-free (stdlib urllib + json). Tests import these
to run live SQL and post dashboard JSON.
"""
from __future__ import annotations
import base64
import json
import os
import urllib.error
import urllib.request
from typing import Any


SUPABASE_PROJECT_REF = "gjmzhlmklgoxkqsdfsjw"
SUPABASE_API = f"https://api.supabase.com/v1/projects/{SUPABASE_PROJECT_REF}/database/query"

# api.supabase.com is fronted by Cloudflare. A missing or default
# "Python-urllib/X.Y" User-Agent gets blocked with `error code: 1010` (bot
# challenge). Any non-default UA passes — we use a descriptive one so the
# server logs identify this client clearly.
USER_AGENT = "grafana-ailedger/0.1.0 (+https://github.com/jakejjoyner/ailedger)"


class SupabaseClient:
    """Posts raw SQL to the Supabase Management API. Auth via PAT (env or file)."""

    def __init__(self, pat: str | None = None, timeout: float = 30.0):
        if pat is None:
            pat = os.environ.get("SUPABASE_PAT")
            if not pat:
                pat_file = os.environ.get("SUPABASE_PAT_FILE", os.path.expanduser("~/.secrets/supabase-pat"))
                if os.path.isfile(pat_file):
                    with open(pat_file) as f:
                        pat = f.read().strip()
        if not pat:
            raise RuntimeError("SUPABASE_PAT not set and no PAT file readable")
        self._pat = pat
        self._timeout = timeout

    def sql(self, query: str) -> list[dict[str, Any]]:
        req = urllib.request.Request(
            SUPABASE_API,
            data=json.dumps({"query": query}).encode(),
            headers={
                "Authorization": f"Bearer {self._pat}",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as r:
                body = r.read().decode()
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            raise RuntimeError(f"Supabase API HTTP {e.code}: {body}") from None
        data = json.loads(body)
        if isinstance(data, dict) and "message" in data:
            raise RuntimeError(f"Supabase SQL error: {data['message']}")
        return data


class GrafanaClient:
    """Talks to Grafana HTTP API. Auth via basic admin/password."""

    def __init__(self, url: str | None = None, user: str | None = None, password: str | None = None, timeout: float = 30.0):
        url = url or os.environ.get("GRAFANA_URL", "http://100.113.167.50:3001")
        user = user or os.environ.get("GRAFANA_USER", "admin")
        if password is None:
            password = os.environ.get("GRAFANA_PASSWORD")
            if not password:
                pw_file = os.environ.get("GRAFANA_PASSWORD_FILE", os.path.expanduser("~/.secrets/grafana-admin"))
                if os.path.isfile(pw_file):
                    with open(pw_file) as f:
                        password = f.read().strip()
        if not password:
            raise RuntimeError("GRAFANA_PASSWORD not set and no password file readable")
        self._url = url.rstrip("/")
        self._auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
        self._timeout = timeout

    def _request(self, method: str, path: str, body: dict | None = None) -> dict[str, Any]:
        req = urllib.request.Request(
            self._url + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json", "Authorization": self._auth},
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            payload = e.read().decode()
            raise RuntimeError(f"Grafana API HTTP {e.code} {method} {path}: {payload}") from None

    def post_dashboard(self, dashboard_body: dict) -> dict[str, Any]:
        return self._request("POST", "/api/dashboards/db", dashboard_body)

    def datasource_query(self, ds_uid: str, raw_sql: str, fmt: str = "table") -> dict[str, Any]:
        body = {"queries": [{
            "refId": "A",
            "datasource": {"type": "grafana-postgresql-datasource", "uid": ds_uid},
            "rawSql": raw_sql,
            "format": fmt,
        }]}
        return self._request("POST", "/api/ds/query", body)

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/api/health")

    def datasource_health(self, ds_uid: str) -> dict[str, Any]:
        return self._request("GET", f"/api/datasources/uid/{ds_uid}/health")
