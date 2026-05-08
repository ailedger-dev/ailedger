import { useEffect, useState } from 'react'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { supabase } from '../supabase'
import UpgradeModal from './UpgradeModal'

// Supabase PostgREST enforces a default max-rows of 1000 per response. A plain
// .select('*') silently truncates — catastrophic for a compliance report that
// must contain EVERY inference. Fetch in 1000-row chunks via .range() until the
// backend returns a short page.
interface LogRow {
  id: number
  logged_at: string
  started_at: string | null
  completed_at: string | null
  provider: string
  model_name: string | null
  path: string
  input_hash: string | null
  output_hash: string | null
  status_code: number
  latency_ms: number
  system_id: string | null
}

const PAGE_SIZE = 1000
async function fetchAllLogs(customerId: string): Promise<LogRow[]> {
  const all: LogRow[] = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('inference_logs')
      .select('*')
      .eq('customer_id', customerId)
      .order('logged_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
      .returns<LogRow[]>()
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

interface Props {
  customerId: string
  customerEmail: string
  onUpgrade?: () => void
}

export default function ReportGenerator({ customerId, customerEmail, onUpgrade }: Props) {
  const [generating, setGenerating] = useState(false)
  const [isPro, setIsPro] = useState<boolean | null>(null)
  const [showUpgradeModal, setShowUpgradeModal] = useState(false)

  useEffect(() => {
    supabase
      .from('subscriptions')
      .select('status, plan')
      .maybeSingle()
      .then(({ data }) => {
        const active = data?.status === 'active'
        setIsPro(active)
      })
  }, [customerId])

  if (isPro === null) return null

  if (!isPro) {
    return (
      <>
        {showUpgradeModal && (
          <UpgradeModal
            feature="report"
            onClose={() => setShowUpgradeModal(false)}
            onUpgrade={() => { setShowUpgradeModal(false); onUpgrade?.() }}
          />
        )}
        <button
          onClick={() => setShowUpgradeModal(true)}
          style={{ cursor: 'default' }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-white text-xs font-medium rounded-lg transition-colors"
        >
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
          </svg>
          Export Compliance Report
          <span className="text-[10px] pl-1.5 pr-1.5 pt-0.5 pb-0 bg-indigo-600 text-white rounded-full">Pro</span>
        </button>
      </>
    )
  }

  async function generateReport() {
    setGenerating(true)

    const formatDate = (d: Date) =>
      d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'

    // Fetch logs (paginated — ALL rows, not the PostgREST-default 1000),
    // systems, profile, subscription, and chain head in parallel.
    const [
      rawLogs,
      { data: allSystems },
      { data: subData },
      { data: profileData },
      { data: chainHeadData },
    ] = await Promise.all([
      fetchAllLogs(customerId).catch(() => null),
      supabase
        .from('account_settings')
        .select('id, system_name, system_purpose, annex_iii_category')
        .eq('customer_id', customerId)
        .order('system_name'),
      supabase
        .from('subscriptions')
        .select('status, plan')
        .maybeSingle(),
      supabase
        .from('profiles')
        .select('org_name')
        .eq('customer_id', customerId)
        .maybeSingle(),
      supabase.schema('ledger').rpc('chain_head', { p_customer_id: customerId }),
    ])

    const chainHead = (chainHeadData as { chain_head_hash: string | null; last_id: number | null; row_count: number } | null) ?? {
      chain_head_hash: null,
      last_id: null,
      row_count: 0,
    }

    // Determine plan limit
    const activePlan = subData?.status === 'active' ? subData.plan : null
    const isScale = activePlan?.startsWith('scale') ?? false
    const monthlyLimit = isScale ? null : activePlan?.startsWith('pro') ? 500_000 : 10_000

    // Cap logs to monthly limit within the current month
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    const logsThisMonth = (rawLogs ?? []).filter((l) => new Date(l.logged_at) >= monthStart)
    const limitReached = monthlyLimit !== null && logsThisMonth.length >= monthlyLimit
    const logs = monthlyLimit !== null
      ? [
          ...(rawLogs ?? []).filter((l) => new Date(l.logged_at) < monthStart),
          ...logsThisMonth.slice(0, monthlyLimit),
        ]
      : (rawLogs ?? [])

    if (!rawLogs) {
      setGenerating(false)
      return
    }

    const systems = (allSystems ?? []) as { id: string; system_name: string; system_purpose: string; annex_iii_category: string }[]
    const orgName = (profileData as { org_name: string } | null)?.org_name || ''
    const dataResidency = 'AWS eu-central-1 (Frankfurt, Germany) via Supabase. Inference data is processed at Cloudflare\'s global edge network prior to storage.'
    const retentionPolicy = 'Indefinite - records are append-only and cannot be deleted. Immutability is enforced at the database level per EU AI Act Article 12.'

    const now = new Date()
    const periodStart = logs.length > 0 ? new Date(logs[0].logged_at) : now
    const periodEnd = logs.length > 0 ? new Date(logs[logs.length - 1].logged_at) : now

    // Aggregate stats
    const totalRequests = logs.length
    const successLogs = logs.filter((l) => l.status_code >= 200 && l.status_code < 300)
    const failureLogs = logs.filter((l) => l.status_code < 200 || l.status_code >= 300)
    const successCount = successLogs.length
    const failureCount = failureLogs.length
    const successRate = totalRequests > 0 ? ((successCount / totalRequests) * 100).toFixed(1) : '0'
    const avgLatency =
      totalRequests > 0
        ? Math.round(logs.reduce((sum, l) => sum + l.latency_ms, 0) / totalRequests)
        : 0

    const providers = [...new Set(logs.map((l) => l.provider))].join(', ')
    const models = [...new Set(logs.map((l) => l.model_name).filter(Boolean))].join(', ')

    // Build PDF
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const pageWidth = doc.internal.pageSize.getWidth()
    const margin = 20

    // ─── Header ─────────────────────────────────────────────────────────────
    doc.setFillColor(15, 17, 23)
    doc.rect(0, 0, pageWidth, 40, 'F')

    doc.setTextColor(255, 255, 255)
    doc.setFontSize(20)
    doc.setFont('helvetica', 'bold')
    doc.text(orgName || 'AILedger', margin, 18)

    doc.setFontSize(10)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(150, 150, 170)
    doc.text('AI Inference Audit Report', margin, 27)
    doc.text(`Generated: ${now.toISOString().replace('T', ' ').slice(0, 19)} UTC`, margin, 34)

    // ─── EU AI Act notice ────────────────────────────────────────────────────
    doc.setFillColor(239, 246, 255)
    doc.setDrawColor(147, 197, 253)
    doc.roundedRect(margin, 48, pageWidth - margin * 2, 18, 2, 2, 'FD')
    doc.setTextColor(30, 64, 175)
    doc.setFontSize(8.5)
    doc.setFont('helvetica', 'bold')
    doc.text('EU AI Act - Article 12 Compliance Record', margin + 4, 55)
    doc.setFont('helvetica', 'normal')
    doc.text(
      'This report constitutes an automated log record as required under Article 12 of Regulation (EU) 2024/1689 (EU AI Act).',
      margin + 4,
      61
    )

    // ─── Usage limit note (if applicable) ────────────────────────────────────
    let y = 76
    if (limitReached) {
      doc.setFillColor(255, 251, 235)
      doc.setDrawColor(253, 186, 116)
      doc.roundedRect(margin, y, pageWidth - margin * 2, 14, 2, 2, 'FD')
      doc.setTextColor(146, 64, 14)
      doc.setFontSize(7.5)
      doc.setFont('helvetica', 'bold')
      doc.text(`Monthly inference limit reached (${monthlyLimit?.toLocaleString()}).`, margin + 4, y + 6)
      doc.setFont('helvetica', 'normal')
      doc.text('Logs beyond the limit are excluded. Upgrade your plan to capture all inferences.', margin + 4, y + 11)
      y += 20
    }
    doc.setTextColor(30, 30, 40)
    doc.setFontSize(13)
    doc.setFont('helvetica', 'bold')
    doc.text('AI Systems Description', margin, y)
    doc.setDrawColor(220, 220, 230)
    doc.line(margin, y + 2, pageWidth - margin, y + 2)
    y += 8

    if (systems.length === 0) {
      doc.setFontSize(9)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(120, 120, 140)
      doc.text('No AI systems configured. Add systems in Settings to include them in reports.', margin, y)
      y += 6
    } else {
      for (let si = 0; si < systems.length; si++) {
        const sys = systems[si]
        if (si > 0) y += 4

        doc.setFontSize(9)
        const sysRows: [string, string][] = [
          ['System Name', sys.system_name || 'Not specified'],
          ['Annex III Category', sys.annex_iii_category || 'Not specified'],
        ]

        for (const [label, value] of sysRows) {
          doc.setFont('helvetica', 'bold')
          doc.setTextColor(80, 80, 100)
          doc.text(label, margin, y)
          doc.setFont('helvetica', 'normal')
          doc.setTextColor(30, 30, 40)
          doc.text(String(value), margin + 42, y)
          y += 6
        }

        doc.setFont('helvetica', 'bold')
        doc.setTextColor(80, 80, 100)
        doc.text('System Purpose', margin, y)
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(30, 30, 40)
        const purposeLines = doc.splitTextToSize(sys.system_purpose || 'Not specified', pageWidth - margin * 2 - 42)
        doc.text(purposeLines, margin + 42, y)
        y += purposeLines.length * 5 + 2

        if (si < systems.length - 1) {
          doc.setDrawColor(230, 230, 240)
          doc.line(margin, y, pageWidth - margin, y)
          y += 2
        }
      }
    }

    // ─── Audit Subject ────────────────────────────────────────────────────────
    y += 4
    doc.setFontSize(13)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(30, 30, 40)
    doc.text('Audit Subject', margin, y)
    doc.setDrawColor(220, 220, 230)
    doc.line(margin, y + 2, pageWidth - margin, y + 2)
    y += 8

    const subjectRows: [string, string][] = [
      ['Customer ID', customerId],
      ['Email', customerEmail],
      ['Audit Period', `${formatDate(periodStart)}  to  ${formatDate(periodEnd)}`],
      ['AI Providers', providers || '-'],
      ['Models', models || '-'],
    ]

    doc.setFontSize(9)
    for (const [label, value] of subjectRows) {
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(80, 80, 100)
      doc.text(label, margin, y)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(30, 30, 40)
      doc.text(String(value), margin + 42, y)
      y += 6
    }

    // ─── Summary Statistics ───────────────────────────────────────────────────
    y += 4
    doc.setFontSize(13)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(30, 30, 40)
    doc.text('Summary Statistics', margin, y)
    doc.setDrawColor(220, 220, 230)
    doc.line(margin, y + 2, pageWidth - margin, y + 2)
    y += 6

    const statsRows: [string, string][] = [
      ['Total Inference Requests', String(totalRequests)],
      ['Successful Requests (2xx)', `${successCount} (${successRate}%)`],
      ['Failed Requests (non-2xx)', String(failureCount)],
      ['Average Latency', `${avgLatency}ms`],
    ]

    doc.setFontSize(9)
    for (const [label, value] of statsRows) {
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(80, 80, 100)
      doc.text(label, margin, y)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(30, 30, 40)
      doc.text(value, margin + 70, y)
      y += 6
    }

    // ─── Inference Log ────────────────────────────────────────────────────────
    y += 6
    doc.setFontSize(13)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(30, 30, 40)
    doc.text(`Inference Log (${logs.length.toLocaleString()} records)`, margin, y)
    doc.setDrawColor(220, 220, 230)
    doc.line(margin, y + 2, pageWidth - margin, y + 2)
    y += 6

    const recentLogs = [...logs].reverse()

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      headStyles: { fillColor: [15, 17, 23], textColor: 255, fontSize: 7.5 },
      bodyStyles: { fontSize: 7, textColor: [30, 30, 40] },
      alternateRowStyles: { fillColor: [248, 248, 252] },
      head: [['Started (UTC)', 'Completed (UTC)', 'Provider', 'Model', 'Status', 'Latency', 'Input Hash', 'Output Hash']],
      body: recentLogs.map((l) => [
        l.started_at ? new Date(l.started_at).toISOString().replace('T', ' ').slice(0, 19) : '-',
        l.completed_at ? new Date(l.completed_at).toISOString().replace('T', ' ').slice(0, 19) : '-',
        l.provider,
        l.model_name ?? '-',
        String(l.status_code),
        `${l.latency_ms}ms`,
        l.input_hash || '-',
        l.output_hash || '-',
      ]),
      columnStyles: {
        0: { cellWidth: 28 },
        1: { cellWidth: 28 },
        2: { cellWidth: 14 },
        3: { cellWidth: 18 },
        4: { cellWidth: 10 },
        5: { cellWidth: 12 },
        6: { cellWidth: 30, fontSize: 5 },
        7: { cellWidth: 30, fontSize: 5 },
      },
    })

    // ─── Anomalies & Failures ─────────────────────────────────────────────────
    if (failureLogs.length > 0) {
      // @ts-ignore - autoTable sets this
      const afterLogsY = (doc as any).lastAutoTable.finalY + 12
      doc.setPage(doc.getNumberOfPages())

      doc.setFontSize(13)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(30, 30, 40)
      doc.text('Anomalies & Failures', margin, afterLogsY)
      doc.setDrawColor(220, 220, 230)
      doc.line(margin, afterLogsY + 2, pageWidth - margin, afterLogsY + 2)

      autoTable(doc, {
        startY: afterLogsY + 6,
        margin: { left: margin, right: margin },
        headStyles: { fillColor: [127, 29, 29], textColor: 255, fontSize: 7.5 },
        bodyStyles: { fontSize: 7, textColor: [30, 30, 40] },
        alternateRowStyles: { fillColor: [255, 248, 248] },
        head: [['Timestamp (UTC)', 'Provider', 'Model', 'Status Code', 'Latency']],
        body: failureLogs.map((l) => [
          new Date(l.logged_at).toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
          l.provider,
          l.model_name ?? '-',
          String(l.status_code),
          `${l.latency_ms}ms`,
        ]),
        columnStyles: {
          0: { cellWidth: 50 },
          1: { cellWidth: 25 },
          2: { cellWidth: 40 },
          3: { cellWidth: 25 },
          4: { cellWidth: 25 },
        },
      })
    }

    // ─── Data Governance ─────────────────────────────────────────────────────
    // @ts-ignore
    const afterAnomaliesY = (doc as any).lastAutoTable.finalY + 12
    doc.setPage(doc.getNumberOfPages())

    doc.setFontSize(13)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(30, 30, 40)
    doc.text('Data Governance', margin, afterAnomaliesY)
    doc.setDrawColor(220, 220, 230)
    doc.line(margin, afterAnomaliesY + 2, pageWidth - margin, afterAnomaliesY + 2)

    const govRows: [string, string][] = [
      ['Data Residency', dataResidency],
      ['Retention Policy', retentionPolicy],
      ['Hash Algorithm', 'SHA-256 (inputs and outputs - raw data is never stored)'],
      ['Immutability', 'Append-only - records cannot be modified or deleted'],
      ['Chain Integrity', 'Every row\'s chain_prev_hash is the SHA-256 of the prior row\'s canonical serialization (tamper-evident hash chain)'],
    ]

    let gy = afterAnomaliesY + 8
    doc.setFontSize(9)
    for (const [label, value] of govRows) {
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(80, 80, 100)
      doc.text(label, margin, gy)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(30, 30, 40)
      const lines = doc.splitTextToSize(value, pageWidth - margin * 2 - 52)
      doc.text(lines, margin + 52, gy)
      gy += lines.length * 5 + 2
    }

    // ─── Chain-Head Signature ──────────────────────────────────────────────────
    // Regulators re-verify by calling ledger.verify_chain(customer_id); the
    // returned chain_head_hash MUST equal the value printed here. Any row
    // tampered with after export invalidates the chain and produces a
    // different head hash.
    gy += 8
    if (gy > doc.internal.pageSize.getHeight() - 60) {
      doc.addPage()
      gy = 20
    }

    doc.setFontSize(13)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(30, 30, 40)
    doc.text('Chain-Head Signature', margin, gy)
    doc.setDrawColor(220, 220, 230)
    doc.line(margin, gy + 2, pageWidth - margin, gy + 2)
    gy += 8

    const chainRows: [string, string][] = [
      ['Algorithm', 'SHA-256 over pipe-delimited canonical serialization'],
      ['Row Count', String(chainHead.row_count)],
      ['Last Row ID', chainHead.last_id != null ? String(chainHead.last_id) : '-'],
      ['Chain Head Hash', chainHead.chain_head_hash ?? '(no rows)'],
      ['Re-verify Command', 'select ledger.verify_chain(\'' + customerId + '\'::uuid);'],
    ]

    doc.setFontSize(9)
    for (const [label, value] of chainRows) {
      if (gy > doc.internal.pageSize.getHeight() - 20) {
        doc.addPage()
        gy = 20
      }
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(80, 80, 100)
      doc.text(label, margin, gy)
      doc.setFont(label === 'Chain Head Hash' || label === 'Re-verify Command' ? 'courier' : 'helvetica', 'normal')
      doc.setTextColor(30, 30, 40)
      const vLines = doc.splitTextToSize(value, pageWidth - margin * 2 - 52)
      doc.text(vLines, margin + 52, gy)
      gy += vLines.length * 5 + 2
    }

    // ─── Article 12 Compliance Matrix ───────────────────────────────────────────
    gy += 8
    if (gy > doc.internal.pageSize.getHeight() - 60) {
      doc.addPage()
      gy = 20
    }

    doc.setFontSize(13)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(30, 30, 40)
    doc.text('Article 12 Compliance - Regulation (EU) 2024/1689', margin, gy)
    doc.setDrawColor(220, 220, 230)
    doc.line(margin, gy + 2, pageWidth - margin, gy + 2)
    gy += 8

    const art12Rows: [string, string, string][] = [
      ['12(1)', 'Automatic recording of events over lifetime', 'Compliant - all AI inferences are automatically logged via proxy'],
      ['12(2)(a)', 'Identify risk situations or substantial modifications', 'Compliant - anomaly detection flags non-200 status codes and latency outliers'],
      ['12(2)(b)', 'Facilitate post-market monitoring (Art. 72)', 'Compliant - real-time dashboard with filtering, export, and alerting'],
      ['12(2)(c)', 'Monitor operation of high-risk AI systems (Art. 26(5))', 'Compliant - per-system inference logs with provider, model, and status tracking'],
      ['12(3)(a)', 'Record period of each use (start and end time)', 'Compliant - started_at and completed_at timestamps on every inference'],
      ['12(3)(d)', 'Identification of persons involved in verification', 'Available - human review tracking via inference review records'],
    ]

    doc.setFontSize(8)
    for (const [ref, requirement, status] of art12Rows) {
      if (gy > doc.internal.pageSize.getHeight() - 20) {
        doc.addPage()
        gy = 20
      }
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(30, 64, 175)
      doc.text(ref, margin, gy)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(60, 60, 80)
      const reqLines = doc.splitTextToSize(requirement, 60)
      doc.text(reqLines, margin + 18, gy)
      doc.setTextColor(21, 128, 61)
      const statusLines = doc.splitTextToSize(status, 75)
      doc.text(statusLines, margin + 80, gy)
      gy += Math.max(reqLines.length, statusLines.length) * 4 + 3
    }

    // ─── Footer on every page ─────────────────────────────────────────────────
    const pageCount = doc.getNumberOfPages()
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i)
      const pageHeight = doc.internal.pageSize.getHeight()
      doc.setFontSize(7.5)
      doc.setTextColor(150, 150, 170)
      doc.text(
        'This report was generated by AILedger (ailedger.dev). Records are cryptographically hashed and append-only.',
        margin,
        pageHeight - 10
      )
      doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin, pageHeight - 10, { align: 'right' })
    }

    doc.save(`ailedger-audit-${now.toISOString().slice(0, 10)}.pdf`)
    setGenerating(false)
  }

  return (
    <button
      onClick={generateReport}
      disabled={generating}
      style={{ cursor: 'pointer' }}
      className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
    >
      {generating ? (
        <>
          <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          Generating...
        </>
      ) : (
        <>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          </svg>
          Export Compliance Report
        </>
      )}
    </button>
  )
}
