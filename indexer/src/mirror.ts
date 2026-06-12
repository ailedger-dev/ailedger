// Mirror REST client — the only data source the indexer has. Public reads,
// no credentials. Injected as an interface so tests run on fixtures.

import type { MirrorMessage } from './parse.ts';

export interface MirrorSource {
  /** Messages with sequence_number > afterSeq, ascending, possibly paged. */
  fetchMessages(topicId: string, afterSeq: number): Promise<MirrorMessage[]>;
}

export function restMirror(baseUrl: string): MirrorSource {
  return {
    async fetchMessages(topicId: string, afterSeq: number): Promise<MirrorMessage[]> {
      const out: MirrorMessage[] = [];
      let url = `${baseUrl}/api/v1/topics/${topicId}/messages?limit=100&order=asc${
        afterSeq > 0 ? `&sequencenumber=gt:${afterSeq}` : ''
      }`;
      for (;;) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`mirror ${res.status} for ${topicId}: ${await res.text()}`);
        const body = (await res.json()) as {
          messages: MirrorMessage[];
          links?: { next?: string | null };
        };
        out.push(...body.messages);
        const next = body.links?.next;
        if (!next) return out;
        url = `${baseUrl}${next}`;
      }
    },
  };
}
