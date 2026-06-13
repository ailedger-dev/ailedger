"""Click-based entry point for the ``ailedger`` CLI."""

from __future__ import annotations

import datetime as dt
import os
import sys
from pathlib import Path

import click

from ailedger_cli import __version__
from ailedger_cli.api import FetchOptions, LedgerClient
from ailedger_cli.attest import (
    SERVICE_ROLE_ENV_VAR,
    AttestClient,
    AttestError,
    compute,
    get_backend,
    publish,
    resolve_backend_name,
    verify,
)
from ailedger_cli.config import (
    API_KEY_ENV_VAR,
    ConfigError,
    default_config_path,
    get_api_key,
    load_config,
    parse_set_assignment,
    save_config,
    set_api_key,
)
from ailedger_cli.export import ExportWindow, generate_report
from ailedger_cli.verify import (
    CHAIN_STUB_MESSAGE,
    chain_enabled,
    verify_chain,
)


@click.group(help="AILedger command-line companion.")
@click.version_option(__version__, package_name="ailedger-cli")
def cli() -> None:
    """Root command group."""


# -- config --------------------------------------------------------------------


@cli.command("config", help="Read/write CLI configuration.")
@click.option("--set", "set_", metavar="KEY=VALUE", help="Set a config value.")
@click.option("--get", "get", metavar="KEY", help="Print a config value.")
@click.option("--list", "list_", is_flag=True, help="List all config values.")
@click.option(
    "--set-secret",
    metavar="KEY",
    help="Store a secret (prompted) in the OS keyring. Only 'api-key' is allowed.",
)
@click.option("--path", "show_path", is_flag=True, help="Print the config file path.")
def config_cmd(
    set_: str | None,
    get: str | None,
    list_: bool,
    set_secret: str | None,
    show_path: bool,
) -> None:
    path = default_config_path()

    if show_path:
        click.echo(str(path))
        return

    if set_secret is not None:
        if set_secret.lower() not in {"api-key", "api_key"}:
            raise click.UsageError("only 'api-key' can be stored as a secret")
        secret = click.prompt("api-key", hide_input=True, confirmation_prompt=True)
        try:
            backend = set_api_key(secret)
        except ConfigError as exc:
            raise click.ClickException(str(exc)) from exc
        click.echo(f"api-key stored in keyring backend: {backend}")
        return

    if set_ is not None:
        try:
            key, value = parse_set_assignment(set_)
        except ConfigError as exc:
            raise click.UsageError(str(exc)) from exc
        values = load_config(path)
        values[key] = value
        save_config(values, path)
        click.echo(f"{key} = {value}  (wrote {path})")
        return

    if get is not None:
        values = load_config(path)
        key = get.strip().lower()
        if key in {"api-key", "api_key"}:
            key_value = get_api_key()
            if key_value is None:
                raise click.ClickException(
                    f"api-key not set. Export {API_KEY_ENV_VAR}=… or use --set-secret api-key."
                )
            click.echo(key_value)
            return
        if key not in values:
            raise click.ClickException(f"{key!r} not set")
        click.echo(values[key])
        return

    if list_ or (set_ is None and get is None and set_secret is None):
        values = load_config(path)
        if not values:
            click.echo(f"# empty config ({path})")
        else:
            click.echo(f"# {path}")
            for key in sorted(values):
                click.echo(f"{key} = {values[key]}")
        has_key = get_api_key() is not None
        click.echo(f"# api-key: {'set (hidden)' if has_key else 'not set'}")


# -- verify --------------------------------------------------------------------


@cli.command("verify", help="Recompute the hash-chain and report integrity.")
@click.option("--customer", metavar="UUID", help="Filter to a single customer_id.")
@click.option("--since", metavar="ISO-DATE", help="Only rows on/after this date.")
@click.option("--until", metavar="ISO-DATE", help="Only rows on/before this date.")
def verify_cmd(customer: str | None, since: str | None, until: str | None) -> None:
    if not chain_enabled():
        click.echo(CHAIN_STUB_MESSAGE)
        return
    client = _build_client()
    with client:
        rows = client.fetch_rows(
            FetchOptions(
                customer_id=customer,
                since=_parse_date(since) if since else None,
                until=_parse_date(until) if until else None,
            )
        )
    report = verify_chain(rows)
    click.echo(report.summary())
    if not report.ok:
        for brk in report.breaks:
            click.echo(
                f"  break at row #{brk.index} (id={brk.row_id}): "
                f"expected prev={brk.expected_prev[:16]}… got={brk.actual_prev[:16]}…"
            )
        sys.exit(2)


# -- verify-evidence (Hedera rails) ---------------------------------------------


@cli.command(
    "verify-evidence",
    help="Offline, keyless verification of a Hedera evidence topic: network "
    "running hash, app prev_hash chain, batch inclusion proofs, payload "
    "commitments, multi-mirror cross-check.",
)
@click.option("--topic", "topic_id", required=True, metavar="0.0.X", help="Tenant topic id.")
@click.option("--archive", "archive_path", type=click.Path(path_type=Path), help="Verify from an archive/mirror-dump JSON file (fully offline).")
@click.option("--mirror", "mirror_base", metavar="URL", help="Mirror REST base (default by --network).")
@click.option("--network", default="testnet", show_default=True, help="testnet | mainnet (selects default mirror).")
@click.option("--cross-mirror", "cross_mirror_base", metavar="URL", help="Second, independent mirror to cross-check against.")
@click.option("--manifests", "manifests_path", type=click.Path(path_type=Path), help="Drainer manifests.jsonl — verifies every batch root + all inclusion proofs.")
@click.option("--payload", "payload_specs", multiple=True, metavar="EVENT_ID=FILE", help="Decrypted payload JSON for commitment verification (repeatable).")
def verify_evidence_cmd(
    topic_id: str,
    archive_path: Path | None,
    mirror_base: str | None,
    network: str,
    cross_mirror_base: str | None,
    manifests_path: Path | None,
    payload_specs: tuple[str, ...],
) -> None:
    import json as _json

    from ailedger_cli.evidence import verify_batch_manifest, verify_commitments, verify_topic
    from ailedger_cli.mirror import (
        DEFAULT_MIRRORS,
        cross_check,
        fetch_topic_messages,
        load_archive,
    )

    if archive_path is not None:
        messages = load_archive(archive_path)
        source = f"archive {archive_path}"
    else:
        base = mirror_base or DEFAULT_MIRRORS.get(network)
        if base is None:
            raise click.UsageError(f"unknown network {network!r} — pass --mirror explicitly")
        messages = fetch_topic_messages(base, topic_id)
        source = f"mirror {base}"

    report = verify_topic(topic_id, messages)

    if cross_mirror_base is not None:
        second = fetch_topic_messages(cross_mirror_base, topic_id)
        result = cross_check(messages, second)
        report.add(
            "PASS" if result.agree else "FAIL",
            "cross-mirror",
            f"{result.detail} (vs {cross_mirror_base})",
        )

    if manifests_path is not None:
        for line in manifests_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            entry = _json.loads(line)
            if entry.get("kind") == "batch":
                verify_batch_manifest(report, entry)

    for spec in payload_specs:
        event_id, _, file_part = spec.partition("=")
        if not file_part:
            raise click.UsageError("--payload expects EVENT_ID=FILE")
        payload = _json.loads(Path(file_part).read_text(encoding="utf-8"))
        verify_commitments(report, event_id.strip(), payload)

    click.echo(f"topic {topic_id} — {len(report.records)} records from {source}")
    for finding in report.findings:
        click.echo(f"  [{finding.level}] {finding.check}: {finding.detail}")
    click.echo(
        f"VERDICT: {'OK' if report.ok else 'FAIL'}"
        + (f" ({report.warnings} warning(s))" if report.warnings else "")
    )
    if not report.ok:
        sys.exit(2)


# -- export --------------------------------------------------------------------


@cli.command("export", help="Render a tamper-evident PDF compliance report.")
@click.option(
    "--from",
    "from_",
    required=True,
    metavar="ISO-DATE",
    help="Start of export window (inclusive).",
)
@click.option(
    "--to",
    "to",
    required=True,
    metavar="ISO-DATE",
    help="End of export window (inclusive).",
)
@click.option(
    "--out",
    "out",
    required=True,
    type=click.Path(dir_okay=False, path_type=Path),
    help="PDF output path.",
)
@click.option("--customer", metavar="UUID", help="Filter to a single customer_id.")
def export_cmd(from_: str, to: str, out: Path, customer: str | None) -> None:
    start = _parse_date(from_)
    end = _parse_date(to)
    if end < start:
        raise click.UsageError("--to must be on/after --from")
    client = _build_client()
    with client:
        rows = client.fetch_rows(
            FetchOptions(
                customer_id=customer,
                since=start,
                until=_end_of_day(end),
            )
        )
    path = generate_report(
        rows,
        ExportWindow(start=start, end=end),
        out,
        chain_enabled=chain_enabled(),
    )
    click.echo(f"wrote {len(rows)} rows → {path}")


# -- attest --------------------------------------------------------------------
# Operator tooling for the monthly public-blockchain anchor. Cross-customer
# metadata, so every command here uses the service-role key (not the customer
# api-key). See docs/attest.md.


@cli.group("attest", help="Cross-customer chain-head anchoring (operator only).")
def attest_group() -> None:
    """Group wrapper — subcommands do the work."""


@attest_group.command("compute", help="Compute the root hash across all customers (dry run).")
def attest_compute_cmd() -> None:
    client = _build_attest_client()
    with client:
        result = compute(client)
    click.echo(f"root_hash      {result.root_hash}")
    click.echo(f"customer_count {result.customer_count}")


@attest_group.command("publish", help="Compute + publish via the configured backend.")
@click.option(
    "--backend",
    metavar="NAME",
    help=f"Override {SERVICE_ROLE_ENV_VAR[:-3]}ANCHOR_BACKEND. One of: mock, bitcoin-testnet, bitcoin.",
)
def attest_publish_cmd(backend: str | None) -> None:
    backend_name = (backend or resolve_backend_name()).lower()
    try:
        anchor = get_backend(backend_name)
    except AttestError as exc:
        raise click.ClickException(str(exc)) from exc
    client = _build_attest_client()
    with client:
        try:
            attestation = publish(client, backend=anchor)
        except AttestError as exc:
            raise click.ClickException(str(exc)) from exc
    click.echo(f"network        {attestation.anchor_network}")
    click.echo(f"tx_id          {attestation.anchor_tx_id}")
    click.echo(f"root_hash      {attestation.root_hash}")
    click.echo(f"customer_count {attestation.customer_count}")
    click.echo(f"anchored_at    {attestation.anchored_at.isoformat()}")


@attest_group.command("verify", help="Fetch an attestation by tx id and re-verify it.")
@click.argument("tx_id")
@click.option("--network", metavar="NAME", help="Restrict lookup to a specific backend.")
def attest_verify_cmd(tx_id: str, network: str | None) -> None:
    client = _build_attest_client()
    with client:
        try:
            result = verify(client, tx_id, network=network)
        except AttestError as exc:
            raise click.ClickException(str(exc)) from exc
    if not result.ok:
        click.echo(f"FAIL — {result.reason}")
        sys.exit(2)
    assert result.attestation is not None
    click.echo(
        f"OK — tx {tx_id} anchors root_hash "
        f"{result.attestation.root_hash[:16]}… "
        f"({result.attestation.customer_count} customers, "
        f"{result.attestation.anchor_network})"
    )


@attest_group.command("list", help="List recent attestations.")
@click.option("--limit", default=20, show_default=True, help="Max rows to print.")
def attest_list_cmd(limit: int) -> None:
    client = _build_attest_client()
    with client:
        rows = client.list_attestations(limit=limit)
    if not rows:
        click.echo("no attestations")
        return
    for row in rows:
        tx = row.anchor_tx_id or "-"
        click.echo(
            f"{row.anchored_at.isoformat()}  {row.anchor_network:<15}  "
            f"tx={tx[:16]}…  root={row.root_hash[:16]}…  "
            f"customers={row.customer_count}"
        )


# -- helpers -------------------------------------------------------------------


def _build_attest_client() -> AttestClient:
    config = load_config()
    base_url = config.get("base-url")
    if not base_url:
        raise click.ClickException(
            "base-url not configured. Run: ailedger config --set base-url=<your-supabase-url>"
        )
    service_role_key = os.environ.get(SERVICE_ROLE_ENV_VAR)
    if not service_role_key:
        raise click.ClickException(
            f"{SERVICE_ROLE_ENV_VAR} not set. Attest commands require the "
            "Supabase service-role key — customer api-keys cannot read "
            "cross-customer chain heads."
        )
    return AttestClient(base_url, service_role_key)


def _build_client() -> LedgerClient:
    config = load_config()
    base_url = config.get("base-url")
    if not base_url:
        raise click.ClickException(
            "base-url not configured. Run: ailedger config --set base-url=<your-supabase-url>"
        )
    api_key = get_api_key()
    if not api_key:
        raise click.ClickException(
            f"api-key not set. Export {API_KEY_ENV_VAR}=… or run: ailedger config --set-secret api-key"
        )
    return LedgerClient(base_url, api_key)


def _parse_date(value: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise click.UsageError(f"invalid date {value!r} — expected YYYY-MM-DD") from exc


def _end_of_day(value: dt.date) -> dt.datetime:
    return dt.datetime.combine(value, dt.time.max, tzinfo=dt.UTC)


if __name__ == "__main__":  # pragma: no cover
    cli()
