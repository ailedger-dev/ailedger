import { LogDetailDrawer } from 'dashboard'

// The drawer renders nothing when `log` is null; give it a realistic inference
// log so the detail panel composes.
const log = {
  id: 84213,
  logged_at: '2024-05-15T11:58:02Z',
  started_at: '2024-05-15T11:58:01Z',
  completed_at: '2024-05-15T11:58:02Z',
  provider: 'anthropic',
  model_name: 'claude-opus-4-8',
  method: 'POST',
  path: '/v1/messages',
  input_hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9001122334455667788990aabbccddeeff',
  output_hash: 'ff00112233445566778899aabbccddee0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  chain_prev_hash: '00ffeeddccbbaa99887766554433221100ffeeddccbbaa998877665544332211',
  status_code: 200,
  latency_ms: 642,
  system_id: 'hiring-screener-v3',
} as any

// The drawer roots at `fixed inset-0`, which would escape to the page viewport.
// A `transform` on the wrapper makes it the containing block for fixed-position
// descendants, so the overlay (backdrop + right panel) renders inside the card.
export function Default() {
  return (
    <div style={{ transform: 'translateZ(0)', position: 'relative', width: 760, height: 560, overflow: 'hidden' }}>
      <LogDetailDrawer
        log={log}
        systemName="Hiring Screener v3"
        chainPosition={84213}
        onClose={() => {}}
      />
    </div>
  )
}
