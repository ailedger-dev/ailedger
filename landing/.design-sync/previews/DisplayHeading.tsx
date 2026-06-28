import { DisplayHeading } from 'landing'

// Visual scale is decoupled from semantic level (h1/h2/h3 share the display-md
// metrics), so `muted` is the axis that actually changes appearance: it swaps
// the color to --ds-text-2 for de-emphasized CTA body copy.
function Surface({ children }: { children: React.ReactNode }) {
  return (
    <div className="ds-root" style={{ minHeight: 'auto', padding: 32 }}>
      {children}
    </div>
  )
}

export function Default() {
  return (
    <Surface>
      <DisplayHeading as="h2">Evidence you can take to court.</DisplayHeading>
    </Surface>
  )
}

export function Muted() {
  return (
    <Surface>
      <DisplayHeading as="h2" muted>
        Built for the moment a regulator asks you to prove it.
      </DisplayHeading>
    </Surface>
  )
}
