// forked from design-sync lib/common.mjs — does NOT copy the module. It imports
// the bundled copy, re-exports it unchanged, and mutates ONE shared constant.
//
// WHY: dashboard/src/supabase.ts runs
//   createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY)
// at module top level. Under the IIFE bundle those keys are undefined, so
// @supabase/supabase-js throws "supabaseUrl is required." at init → the whole
// window.ProductApp IIFE never finishes → every preview blanks. Injecting a
// dummy URL lets the client construct; on-mount queries just fail async,
// leaving each screen in its loading/empty state (fine for static previews).
//
// HOW: lib/bundle.mjs imports IIFE_IMPORT_META_DEFINE from this same file path,
// so it shares this exact object. package-build calls loadLib('common') (→ this
// override) before bundleToIife runs, so the mutation is in place when esbuild
// reads the `define`. ponytail: shared-object mutation — clean upgrade path is a
// real cfg.define hook upstream; revisit if design-sync adds one.
import * as base from '../../.ds-sync/lib/common.mjs'

base.IIFE_IMPORT_META_DEFINE['import.meta.env'] =
  '{"MODE":"development","DEV":true,"PROD":false,"SSR":false,"BASE_URL":"/",' +
  '"VITE_SUPABASE_URL":"https://demo.supabase.co","VITE_SUPABASE_ANON_KEY":"demo-anon-key"}'

export * from '../../.ds-sync/lib/common.mjs'
