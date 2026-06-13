// Archiver — the answer to "public mirrors have no retention SLA."
//
// Continuously exports every known topic's FULL raw mirror rows (the exact
// REST shape, base64 message + running_hash + payer + consensus timestamp)
// as court-bundle JSON files — the same format `ailedger verify-evidence
// --archive` consumes offline — plus a bundle manifest with a SHA-256 per
// file so the bundle itself is tamper-evident.
//
// Record-file + node-signature-file archival (the council-signature-rooted
// proof layer) is the planned extension behind this same interface; it needs
// requester-pays bucket access (operator billing decision, tracked in
// ADR-016 follow-ups).

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IndexerStore } from './store.ts';

export interface ArchiveResult {
  topicId: string;
  file: string;
  messages: number;
  sha256: string;
}

export interface RawRowFetcher {
  /** ALL raw REST rows for a topic, ascending, full fields. */
  fetchAll(topicId: string): Promise<Record<string, unknown>[]>;
}

export function restRawRowFetcher(baseUrl: string): RawRowFetcher {
  return {
    async fetchAll(topicId: string): Promise<Record<string, unknown>[]> {
      const rows: Record<string, unknown>[] = [];
      let url = `${baseUrl}/api/v1/topics/${topicId}/messages?limit=100&order=asc`;
      for (;;) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`mirror ${res.status} for ${topicId}`);
        const body = (await res.json()) as {
          messages: Record<string, unknown>[];
          links?: { next?: string | null };
        };
        rows.push(...body.messages);
        const next = body.links?.next;
        if (!next) return rows;
        url = `${baseUrl}${next}`;
      }
    },
  };
}

function sha256hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function archiveTopic(
  fetcher: RawRowFetcher,
  topicId: string,
  outDir: string,
): Promise<ArchiveResult> {
  mkdirSync(outDir, { recursive: true });
  const rows = await fetcher.fetchAll(topicId);
  const file = join(outDir, `topic-${topicId.replaceAll('.', '_')}.json`);
  const content = JSON.stringify({ topic_id: topicId, messages: rows }, null, 1) + '\n';
  await writeFile(file, content, 'utf-8');
  return { topicId, file, messages: rows.length, sha256: sha256hex(content) };
}

/**
 * Archive the registry topic + every known tenant topic; write/refresh the
 * bundle manifest. Idempotent: re-running refreshes files in place (mirror
 * data for a topic is append-only, so a refresh only ever grows a file).
 */
export async function archiveAll(
  store: IndexerStore,
  fetcher: RawRowFetcher,
  registryTopicId: string,
  outDir: string,
): Promise<ArchiveResult[]> {
  const topics = [registryTopicId, ...store.tenants().map((t) => t.topicId)];
  const results: ArchiveResult[] = [];
  for (const topicId of topics) {
    results.push(await archiveTopic(fetcher, topicId, outDir));
  }
  const manifest = {
    format: 'ailedger-court-bundle/1',
    created_at: new Date().toISOString(),
    note: 'Verify any topic offline: ailedger verify-evidence --topic <id> --archive <file>. Record-file/node-signature blocks: planned (requester-pays bucket access).',
    files: results.map((r) => ({
      topic_id: r.topicId,
      file: r.file.split('/').pop(),
      messages: r.messages,
      sha256: r.sha256,
    })),
  };
  await writeFile(join(outDir, 'bundle-manifest.json'), JSON.stringify(manifest, null, 1) + '\n', 'utf-8');
  return results;
}

/** Validate an existing bundle directory against its manifest. */
export async function validateBundle(outDir: string): Promise<{ ok: boolean; detail: string }> {
  const manifest = JSON.parse(await readFile(join(outDir, 'bundle-manifest.json'), 'utf-8')) as {
    files: { file: string; sha256: string }[];
  };
  for (const entry of manifest.files) {
    const content = await readFile(join(outDir, entry.file), 'utf-8');
    if (sha256hex(content) !== entry.sha256) {
      return { ok: false, detail: `${entry.file} does not match its manifest sha256` };
    }
  }
  return { ok: true, detail: `${manifest.files.length} file(s) match the manifest` };
}
