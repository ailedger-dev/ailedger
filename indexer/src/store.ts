// Indexer store — SQLite via node:sqlite (built-in; zero native deps, which
// is the point for "anyone can run this"). ':memory:' for tests, a file path
// for real use. Everything here is DERIVED state, rebuildable from the public
// mirror — there is deliberately no privileged key and no data that isn't
// reconstructible (the cold-rebuild test enforces this).

import { DatabaseSync } from 'node:sqlite';
import type { OperatorAnnouncement, ParsedRecord, TenantAnnouncement } from './parse.ts';

export interface RecordRow {
  topicId: string;
  seq: number;
  consensusTs: string;
  kind: string;
  recordHash: string;
  prevHash: string | null;
  linkOk: boolean | null;
  rawB64: string;
  recordJson: string;
}

export interface ChainStatus {
  topicId: string;
  lastSeq: number;
  lastRecordHash: string;
  continuous: boolean;
  firstBreakSeq: number | null;
  records: number;
}

export class IndexerStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        topic_id TEXT NOT NULL, seq INTEGER NOT NULL, consensus_ts TEXT NOT NULL,
        kind TEXT NOT NULL, record_hash TEXT NOT NULL, prev_hash TEXT,
        link_ok INTEGER, raw_b64 TEXT NOT NULL, record_json TEXT NOT NULL,
        PRIMARY KEY (topic_id, seq)
      );
      CREATE TABLE IF NOT EXISTS decisions (
        event_id TEXT PRIMARY KEY, tenant_ref TEXT NOT NULL, topic_id TEXT NOT NULL,
        seq INTEGER NOT NULL, decision_type TEXT NOT NULL, ts TEXT NOT NULL,
        human_in_loop INTEGER NOT NULL, payload_hash TEXT NOT NULL, record_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS unwarrants (
        event_id TEXT PRIMARY KEY, tenant_ref TEXT NOT NULL, topic_id TEXT NOT NULL,
        seq INTEGER NOT NULL, category TEXT NOT NULL, decision_type TEXT NOT NULL,
        ts TEXT NOT NULL, record_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS batches (
        batch_id TEXT PRIMARY KEY, tenant_ref TEXT NOT NULL, topic_id TEXT NOT NULL,
        seq INTEGER NOT NULL, merkle_root TEXT NOT NULL, leaf_count INTEGER NOT NULL,
        from_ts TEXT NOT NULL, to_ts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_ref TEXT PRIMARY KEY, topic_id TEXT NOT NULL,
        submit_pubkey TEXT NOT NULL, announced_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operators (
        operator_id TEXT PRIMARY KEY, operator_pubkey TEXT NOT NULL,
        warrant_health_topic_id TEXT NOT NULL, announced_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS warrant_health (
        operator_id TEXT NOT NULL, seq INTEGER NOT NULL, consensus_ts TEXT NOT NULL,
        total INTEGER NOT NULL, unwarranted INTEGER NOT NULL, rate REAL NOT NULL,
        threshold REAL NOT NULL, verdict TEXT NOT NULL, by_category TEXT NOT NULL,
        window_to_ts TEXT NOT NULL, record_hash TEXT NOT NULL,
        PRIMARY KEY (operator_id, seq)
      );
      CREATE TABLE IF NOT EXISTS duplicates (
        topic_id TEXT NOT NULL, seq INTEGER NOT NULL, event_or_batch_id TEXT NOT NULL,
        PRIMARY KEY (topic_id, seq)
      );
      CREATE INDEX IF NOT EXISTS decisions_tenant ON decisions (tenant_ref, seq);
      CREATE INDEX IF NOT EXISTS unwarrants_tenant ON unwarrants (tenant_ref, seq);
      CREATE INDEX IF NOT EXISTS batches_tenant ON batches (tenant_ref, seq);
    `);
  }

  close(): void {
    this.db.close();
  }

  lastSeq(topicId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS m FROM records WHERE topic_id = ?')
      .get(topicId) as { m: number | null };
    return row.m ?? 0;
  }

  insertRecord(
    topicId: string,
    rec: ParsedRecord,
    rawB64: string,
    prevHash: string | null,
    linkOk: boolean | null,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO records
         (topic_id, seq, consensus_ts, kind, record_hash, prev_hash, link_ok, raw_b64, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        topicId,
        rec.seq,
        rec.consensusTs,
        rec.body.v,
        rec.recordHash,
        prevHash,
        linkOk === null ? null : linkOk ? 1 : 0,
        rawB64,
        JSON.stringify(rec.body),
      );
  }

  /** INSERT OR IGNORE semantics: first writer wins; at-least-once duplicates land in `duplicates`. */
  insertDecision(tenantRef: string, topicId: string, rec: ParsedRecord): void {
    const b = rec.body as Record<string, unknown>;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO decisions
         (event_id, tenant_ref, topic_id, seq, decision_type, ts, human_in_loop, payload_hash, record_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(b.event_id),
        tenantRef,
        topicId,
        rec.seq,
        String(b.decision_type),
        String(b.ts),
        b.human_in_loop ? 1 : 0,
        String(b.payload_hash),
        rec.recordHash,
      );
    if (result.changes === 0) {
      this.db
        .prepare('INSERT OR IGNORE INTO duplicates (topic_id, seq, event_or_batch_id) VALUES (?, ?, ?)')
        .run(topicId, rec.seq, String(b.event_id));
    }
  }

  /** Record an ode-2u unwarranted decision (OWT). Deduped by event_id. */
  insertUnwarrant(tenantRef: string, topicId: string, rec: ParsedRecord): void {
    const b = rec.body as Record<string, unknown>;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO unwarrants
         (event_id, tenant_ref, topic_id, seq, category, decision_type, ts, record_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(b.event_id),
        tenantRef,
        topicId,
        rec.seq,
        String(b.unwarrant_category),
        String(b.decision_type),
        String(b.ts),
        rec.recordHash,
      );
    if (result.changes === 0) {
      this.db
        .prepare('INSERT OR IGNORE INTO duplicates (topic_id, seq, event_or_batch_id) VALUES (?, ?, ?)')
        .run(topicId, rec.seq, String(b.event_id));
    }
  }

  /**
   * Per-tenant warrant health: the unwarranted rate over the tenant's whole
   * Logbook. Denominator = warranted (ode-2) + unwarranted (ode-2u), both
   * counted from the same sequenced chain — gap-honest, tamper-evident.
   */
  warrantHealth(tenantRef: string): {
    total: number;
    unwarranted: number;
    warranted: number;
    rate: number;
    byCategory: Record<string, number>;
  } {
    const warranted = (
      this.db.prepare('SELECT COUNT(*) AS c FROM decisions WHERE tenant_ref = ?').get(tenantRef) as {
        c: number;
      }
    ).c;
    const unwarranted = (
      this.db.prepare('SELECT COUNT(*) AS c FROM unwarrants WHERE tenant_ref = ?').get(tenantRef) as {
        c: number;
      }
    ).c;
    const byCategory: Record<string, number> = {};
    for (const row of this.db
      .prepare('SELECT category, COUNT(*) AS c FROM unwarrants WHERE tenant_ref = ? GROUP BY category')
      .all(tenantRef) as { category: string; c: number }[]) {
      byCategory[row.category] = row.c;
    }
    const total = warranted + unwarranted;
    return { total, unwarranted, warranted, rate: total > 0 ? unwarranted / total : 0, byCategory };
  }

  insertBatch(tenantRef: string, topicId: string, rec: ParsedRecord): void {
    const b = rec.body as Record<string, unknown>;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO batches
         (batch_id, tenant_ref, topic_id, seq, merkle_root, leaf_count, from_ts, to_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(b.batch_id),
        tenantRef,
        topicId,
        rec.seq,
        String(b.merkle_root),
        Number(b.leaf_count),
        String((b.range as Record<string, unknown>)?.from_ts ?? ''),
        String((b.range as Record<string, unknown>)?.to_ts ?? ''),
      );
    if (result.changes === 0) {
      this.db
        .prepare('INSERT OR IGNORE INTO duplicates (topic_id, seq, event_or_batch_id) VALUES (?, ?, ?)')
        .run(topicId, rec.seq, String(b.batch_id));
    }
  }

  upsertOperator(a: OperatorAnnouncement): void {
    this.db
      .prepare(
        `INSERT INTO operators (operator_id, operator_pubkey, warrant_health_topic_id, announced_seq)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (operator_id) DO UPDATE SET
           operator_pubkey = excluded.operator_pubkey,
           warrant_health_topic_id = excluded.warrant_health_topic_id,
           announced_seq = excluded.announced_seq`,
      )
      .run(a.operatorId, a.operatorPubkey, a.warrantHealthTopicId, a.announcedSeq);
  }

  operators(): OperatorAnnouncement[] {
    return (
      this.db.prepare('SELECT * FROM operators ORDER BY announced_seq').all() as {
        operator_id: string;
        operator_pubkey: string;
        warrant_health_topic_id: string;
        announced_seq: number;
      }[]
    ).map((r) => ({
      operatorId: r.operator_id,
      operatorPubkey: r.operator_pubkey,
      warrantHealthTopicId: r.warrant_health_topic_id,
      announcedSeq: r.announced_seq,
    }));
  }

  /** Record an owh-1 aggregate (one per publish). Deduped by (operator, seq). */
  insertWarrantHealth(operatorId: string, rec: ParsedRecord): void {
    const b = rec.body as Record<string, unknown>;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO warrant_health
         (operator_id, seq, consensus_ts, total, unwarranted, rate, threshold, verdict, by_category, window_to_ts, record_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operatorId,
        rec.seq,
        rec.consensusTs,
        Number(b.total),
        Number(b.unwarranted),
        Number(b.rate),
        Number(b.threshold),
        String(b.verdict),
        JSON.stringify(b.by_category ?? {}),
        String((b.window as Record<string, unknown>)?.to_ts ?? ''),
        rec.recordHash,
      );
  }

  /** The public cross-operator board: each operator's latest published owh-1. */
  board(): {
    operatorId: string;
    warrantHealthTopicId: string;
    latest: {
      seq: number;
      consensusTs: string;
      total: number;
      unwarranted: number;
      rate: number;
      threshold: number;
      verdict: string;
      byCategory: Record<string, number>;
    } | null;
  }[] {
    return this.operators().map((op) => {
      const row = this.db
        .prepare(
          `SELECT seq, consensus_ts, total, unwarranted, rate, threshold, verdict, by_category
           FROM warrant_health WHERE operator_id = ? ORDER BY seq DESC LIMIT 1`,
        )
        .get(op.operatorId) as
        | {
            seq: number;
            consensus_ts: string;
            total: number;
            unwarranted: number;
            rate: number;
            threshold: number;
            verdict: string;
            by_category: string;
          }
        | undefined;
      return {
        operatorId: op.operatorId,
        warrantHealthTopicId: op.warrantHealthTopicId,
        latest: row
          ? {
              seq: row.seq,
              consensusTs: row.consensus_ts,
              total: row.total,
              unwarranted: row.unwarranted,
              rate: row.rate,
              threshold: row.threshold,
              verdict: row.verdict,
              byCategory: JSON.parse(row.by_category) as Record<string, number>,
            }
          : null,
      };
    });
  }

  upsertTenant(a: TenantAnnouncement): void {
    this.db
      .prepare(
        `INSERT INTO tenants (tenant_ref, topic_id, submit_pubkey, announced_seq)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_ref) DO UPDATE SET
           topic_id = excluded.topic_id,
           submit_pubkey = excluded.submit_pubkey,
           announced_seq = excluded.announced_seq`,
      )
      .run(a.tenantRef, a.topicId, a.submitPubkey, a.announcedSeq);
  }

  tenants(): TenantAnnouncement[] {
    return (
      this.db.prepare('SELECT * FROM tenants ORDER BY announced_seq').all() as {
        tenant_ref: string;
        topic_id: string;
        submit_pubkey: string;
        announced_seq: number;
      }[]
    ).map((r) => ({
      tenantRef: r.tenant_ref,
      topicId: r.topic_id,
      submitPubkey: r.submit_pubkey,
      announcedSeq: r.announced_seq,
    }));
  }

  tenantByRef(tenantRef: string): TenantAnnouncement | null {
    const all = this.tenants().filter((t) => t.tenantRef === tenantRef);
    return all[0] ?? null;
  }

  decisionsForTenant(tenantRef: string, limit = 100): Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT event_id, decision_type, ts, seq, human_in_loop, payload_hash, record_hash
         FROM decisions WHERE tenant_ref = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(tenantRef, limit) as Record<string, unknown>[];
  }

  decisionById(eventId: string): Record<string, unknown> | null {
    return (
      (this.db.prepare('SELECT * FROM decisions WHERE event_id = ?').get(eventId) as
        | Record<string, unknown>
        | undefined) ?? null
    );
  }

  batchesForTenant(tenantRef: string, limit = 100): Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT batch_id, merkle_root, leaf_count, from_ts, to_ts, seq
         FROM batches WHERE tenant_ref = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(tenantRef, limit) as Record<string, unknown>[];
  }

  chainStatus(topicId: string): ChainStatus | null {
    const rows = this.db
      .prepare(
        'SELECT seq, record_hash, link_ok FROM records WHERE topic_id = ? ORDER BY seq',
      )
      .all(topicId) as { seq: number; record_hash: string; link_ok: number | null }[];
    if (rows.length === 0) return null;
    const firstBreak = rows.find((r) => r.link_ok === 0);
    const last = rows[rows.length - 1];
    return {
      topicId,
      lastSeq: last.seq,
      lastRecordHash: last.record_hash,
      continuous: firstBreak === undefined,
      firstBreakSeq: firstBreak?.seq ?? null,
      records: rows.length,
    };
  }

  duplicateCount(topicId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM duplicates WHERE topic_id = ?')
      .get(topicId) as { c: number };
    return row.c;
  }
}
