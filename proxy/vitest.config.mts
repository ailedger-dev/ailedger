import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		// SQL tests live under test/sql/ and need a real Postgres + the `pg`
		// driver — they run via `npm test` inside test/sql/ on nightly CI.
		// Excluding them here keeps the workers test loop fast and avoids
		// loading node-only modules into the workers pool.
		exclude: ['**/node_modules/**', '**/dist/**', 'test/sql/**'],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
	},
});
