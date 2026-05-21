"""Pure-structure tests: dashboard JSON validity, panel uniqueness, grid layout.

No network. Always runs in CI.
"""
from __future__ import annotations
import json

import pytest

from grafana_ailedger.panels import PANELS, DATASOURCE_UID
from grafana_ailedger.dashboard import build_dashboard, DASHBOARD_UID, render


@pytest.fixture(scope="module")
def dashboard() -> dict:
    return build_dashboard()


def test_dashboard_renders_to_valid_json():
    s = render()
    parsed = json.loads(s)
    assert parsed["dashboard"]["uid"] == DASHBOARD_UID


def test_dashboard_has_expected_top_level_shape(dashboard):
    assert dashboard["overwrite"] is True
    d = dashboard["dashboard"]
    assert d["uid"] == DASHBOARD_UID
    assert d["title"]
    assert d["schemaVersion"] >= 39
    assert d["refresh"] == "30s"
    assert isinstance(d["panels"], list) and len(d["panels"]) > 0


def test_all_panels_serialized(dashboard):
    assert len(dashboard["dashboard"]["panels"]) == len(PANELS)


def test_panel_ids_unique():
    ids = [p.id for p in PANELS]
    assert len(ids) == len(set(ids)), f"duplicate panel ids: {ids}"


def test_panel_slugs_unique():
    slugs = [p.slug for p in PANELS]
    assert len(slugs) == len(set(slugs)), f"duplicate panel slugs: {slugs}"


def test_panel_slugs_are_snake_case():
    import re
    pat = re.compile(r"^[a-z][a-z0-9_]*$")
    for p in PANELS:
        assert pat.match(p.slug), f"slug not snake_case: {p.slug}"


@pytest.mark.parametrize("panel", PANELS, ids=lambda p: p.slug)
def test_panel_has_required_fields(panel):
    assert panel.title
    assert panel.sql.strip()
    assert panel.expects_columns, f"{panel.slug}: must declare expects_columns"
    assert panel.panel_type in {"stat", "timeseries", "barchart", "table", "piechart"}


@pytest.mark.parametrize("panel", PANELS, ids=lambda p: p.slug)
def test_panel_grid_within_24_cols(panel):
    x, y, w, h = panel.grid
    assert 0 <= x < 24, f"{panel.slug}: x={x} out of range"
    assert x + w <= 24, f"{panel.slug}: x+w={x + w} overflows 24-col grid"
    assert w > 0 and h > 0


def test_no_grid_overlaps():
    """Pairwise overlap check across all panels."""
    rects = [(p.slug, *p.grid) for p in PANELS]
    for i in range(len(rects)):
        slug_a, ax, ay, aw, ah = rects[i]
        for j in range(i + 1, len(rects)):
            slug_b, bx, by, bw, bh = rects[j]
            overlap_x = ax < bx + bw and bx < ax + aw
            overlap_y = ay < by + bh and by < ay + ah
            assert not (overlap_x and overlap_y), (
                f"panels {slug_a} ({ax},{ay},{aw}x{ah}) and "
                f"{slug_b} ({bx},{by},{bw}x{bh}) overlap"
            )


@pytest.mark.parametrize("panel", PANELS, ids=lambda p: p.slug)
def test_panel_targets_use_correct_datasource(panel):
    d = build_dashboard()
    p_json = next(p for p in d["dashboard"]["panels"] if p["id"] == panel.id)
    for target in p_json["targets"]:
        assert target["datasource"]["uid"] == DATASOURCE_UID
        assert target["datasource"]["type"] == "grafana-postgresql-datasource"


@pytest.mark.parametrize("panel", PANELS, ids=lambda p: p.slug)
def test_timeseries_panels_use_time_series_format(panel):
    if panel.panel_type == "timeseries":
        assert panel.format == "time_series", (
            f"{panel.slug}: timeseries panels must use format='time_series', "
            f"got {panel.format!r}"
        )


@pytest.mark.parametrize("panel", PANELS, ids=lambda p: p.slug)
def test_stat_panels_have_thresholds_or_description(panel):
    """Stats without thresholds should at least carry a description so the
    operator knows what they're looking at."""
    if panel.panel_type == "stat":
        assert panel.thresholds or panel.description, (
            f"{panel.slug}: stat panels need thresholds or a description"
        )
