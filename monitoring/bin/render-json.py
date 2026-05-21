#!/usr/bin/env python3
"""Dump the dashboard JSON to stdout for diffing or manual import."""
from grafana_ailedger.dashboard import render
print(render())
