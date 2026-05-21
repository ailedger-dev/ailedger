"""Pytest fixtures + skip-live helpers.

Live tests (those marked `@pytest.mark.live`) hit the Supabase Management API
and require SUPABASE_PAT in env or ~/.secrets/supabase-pat on disk. In CI,
they are skipped unless the secret is wired up.
"""
from __future__ import annotations
import os
import pytest

from grafana_ailedger.client import SupabaseClient


def _supabase_available() -> bool:
    if os.environ.get("SUPABASE_PAT"):
        return True
    pat_file = os.environ.get("SUPABASE_PAT_FILE", os.path.expanduser("~/.secrets/supabase-pat"))
    return os.path.isfile(pat_file)


@pytest.fixture(scope="session")
def supabase() -> SupabaseClient:
    if not _supabase_available():
        pytest.skip("SUPABASE_PAT not available; skipping live test")
    return SupabaseClient()


def pytest_collection_modifyitems(config, items):
    """Apply skip to live tests when no Supabase credential is available."""
    if _supabase_available():
        return
    skip_live = pytest.mark.skip(reason="SUPABASE_PAT not available")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip_live)
