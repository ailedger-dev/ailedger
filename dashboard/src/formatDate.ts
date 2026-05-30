// UTC, 24-hour, no milliseconds — the canonical audit timestamp format used
// everywhere a server-recorded `*_at` is rendered in the dashboard. Source of
// truth in the cell text; pair with formatLocalTooltip for hover.
export function formatDate(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

// Mirrors the canonical UTC format (YYYY-MM-DD HH:MM:SS) in the viewer's
// timezone for the hover tooltip. en-CA + h23 keeps it symmetric so operators
// can compare directly.
export function formatLocalTooltip(iso: string): string {
  const formatted = new Date(iso).toLocaleString('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  })
  return 'Local: ' + formatted.replace(',', '')
}
