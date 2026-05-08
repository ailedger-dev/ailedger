"""Article 12 PDF report generation.

reportlab is a heavy dependency; we import lazily so ``ailedger verify``
works even if the PDF engine isn't available in the caller's venv.
"""

from __future__ import annotations

import datetime as dt
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ailedger_cli.verify import row_content_hash, verify_chain


@dataclass(frozen=True)
class ExportWindow:
    start: dt.date
    end: dt.date

    def label(self) -> str:
        return f"{self.start.isoformat()} → {self.end.isoformat()}"


def generate_report(
    rows: list[dict[str, Any]],
    window: ExportWindow,
    output_path: Path,
    *,
    chain_enabled: bool = False,
) -> Path:
    """Render ``rows`` to a tamper-evident PDF at ``output_path``.

    Each row is listed with its per-row hash; the document footer includes:
      - the number of rows,
      - the chain-head signature for the window (when the chain is enabled),
      - a SHA-256 digest of the concatenated row hashes as a secondary
        tamper-evidence marker usable even before the chain ships.
    """
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import letter
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import inch
        from reportlab.platypus import (
            Paragraph,
            SimpleDocTemplate,
            Spacer,
            Table,
            TableStyle,
        )
    except ImportError as exc:  # pragma: no cover - exercised when extra missing
        raise RuntimeError(
            "ailedger export requires reportlab. "
            "Install it with: pip install reportlab"
        ) from exc

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    row_hashes = [row_content_hash(row) for row in rows]
    signature = hashlib.sha256("".join(row_hashes).encode("utf-8")).hexdigest()
    report = verify_chain(rows) if chain_enabled else None

    styles = getSampleStyleSheet()
    mono = ParagraphStyle(
        "Mono",
        parent=styles["BodyText"],
        fontName="Courier",
        fontSize=7,
        leading=9,
    )
    title_style = styles["Title"]
    body = styles["BodyText"]

    doc = SimpleDocTemplate(
        str(output_path),
        pagesize=letter,
        title="AILedger Article 12 Report",
        author="AILedger",
        leftMargin=0.6 * inch,
        rightMargin=0.6 * inch,
        topMargin=0.6 * inch,
        bottomMargin=0.6 * inch,
    )

    flowables: list[Any] = [
        Paragraph("AILedger — Article 12 Compliance Report", title_style),
        Spacer(1, 0.15 * inch),
        Paragraph(f"<b>Window:</b> {window.label()}", body),
        Paragraph(f"<b>Rows:</b> {len(rows)}", body),
        Paragraph(
            f"<b>Generated:</b> {dt.datetime.now(dt.UTC).isoformat(timespec='seconds')}",
            body,
        ),
        Paragraph(
            "<b>Chain verification:</b> "
            + (
                _chain_status(report)
                if report is not None
                else "deferred (AILEDGER_CHAIN_ENABLED unset)"
            ),
            body,
        ),
        Spacer(1, 0.2 * inch),
    ]

    if rows:
        table_data: list[list[Any]] = [
            ["#", "created_at", "provider / model", "status", "content hash"]
        ]
        for i, (row, digest) in enumerate(zip(rows, row_hashes, strict=True), start=1):
            table_data.append(
                [
                    str(i),
                    str(row.get("created_at", "")),
                    f"{row.get('provider', '')} / {row.get('model', '')}",
                    str(row.get("status_code", "")),
                    Paragraph(digest, mono),
                ]
            )
        table = Table(
            table_data,
            colWidths=[0.3 * inch, 1.4 * inch, 1.8 * inch, 0.6 * inch, 3.2 * inch],
            repeatRows=1,
        )
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("FONTSIZE", (0, 0), (-1, 0), 8),
                    ("FONTSIZE", (0, 1), (-1, -1), 7),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#9ca3af")),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f3f4f6")]),
                ]
            )
        )
        flowables.append(table)
    else:
        flowables.append(Paragraph("<i>No rows in this window.</i>", body))

    flowables.extend(
        [
            Spacer(1, 0.25 * inch),
            Paragraph("<b>Tamper evidence</b>", styles["Heading3"]),
            Paragraph(f"Row count: {len(rows)}", body),
            Paragraph("Window signature (SHA-256 of row hashes):", body),
            Paragraph(signature, mono),
        ]
    )
    if report is not None and report.chain_head:
        flowables.append(Paragraph("Chain head:", body))
        flowables.append(Paragraph(report.chain_head, mono))

    doc.build(flowables)
    return output_path


def _chain_status(report: Any) -> str:
    if report.ok:
        return f"OK ({report.row_count} rows, head {report.chain_head[:16]}…)"
    return f"BROKEN — {len(report.breaks)} discontinuities"
