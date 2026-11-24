import type { RunSummaryRecord } from "@elenchi/shared";

export interface StoredRunRow {
  summary: RunSummaryRecord;
  ownerSessionId: string;
  encryptedPrompt: string | null;
  promptExpiresAtMs: number | null;
}

export type AgentRoomStatus = "WAITING_FOR_AGENT" | "ACTIVE" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface StoredAgentRoomRow {
  roomCode: string;
  runId: string;
  ownerSessionId: string;
  agentTokenHash: string | null;
  status: AgentRoomStatus;
  stateJson: string;
  expiresAtMs: number;
  createdAtMs: number;
}

export interface ArenaStore {
  saveRun(row: StoredRunRow, idempotencyKey?: string | null): Promise<void>;
  getRun(runId: string): Promise<StoredRunRow | null>;
  getRunByIdempotencyKey(sessionId: string, idempotencyKey: string): Promise<StoredRunRow | null>;
  deleteRun(runId: string): Promise<boolean>;
  listPublicRecentRuns(limit: number): Promise<RunSummaryRecord[]>;
  saveAgentRoom(row: StoredAgentRoomRow): Promise<void>;
  getAgentRoom(roomCode: string): Promise<StoredAgentRoomRow | null>;
  deleteAgentRoom(roomCode: string): Promise<boolean>;
  checkAndRecordQuota(params: {
    sessionId: string;
    ipHash: string;
    maxSessionPerHour: number;
    maxIpPerHour: number;
    nowMs?: number;
  }): Promise<{ allowed: boolean; reason?: string; remainingSessionRuns: number }>;
  getDailySpendUsd(dayKey: string): Promise<number>;
  addDailySpendUsd(dayKey: string, deltaUsd: number): Promise<number>;
}

/**
 * Minimal synchronous SQL backend contract compatible with BOTH:
 * - Node v26 built-in `DatabaseSync` (`node:sqlite`)
 * - Cloudflare Durable Objects SQLite (`ctx.storage.sql`)
 */
export interface SyncSqlDriver {
  exec(sql: string): void;
  query(sql: string, params?: unknown[]): Array<Record<string, unknown>>;
}

export function createSqlArenaStore(sql: SyncSqlDriver): ArenaStore {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      owner_session_id TEXT NOT NULL,
      public_opt_in INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT NOT NULL,
      encrypted_prompt TEXT,
      prompt_expires_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      scope_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rate_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bucket_key TEXT NOT NULL,
      ts_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_budget (
      day_key TEXT PRIMARY KEY,
      spent_usd REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS agent_rooms (
      room_code TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      owner_session_id TEXT NOT NULL,
      agent_token_hash TEXT,
      status TEXT NOT NULL,
      state_json TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
  `);

  function purgeExpiredPrompts(nowMs: number) {
    sql.query(
      `UPDATE runs SET encrypted_prompt = NULL, prompt_expires_at_ms = NULL WHERE prompt_expires_at_ms IS NOT NULL AND prompt_expires_at_ms <= ?`,
      [nowMs]
    );
    sql.query(`DELETE FROM agent_rooms WHERE expires_at_ms <= ? AND status IN ('WAITING_FOR_AGENT', 'CANCELLED')`, [
      nowMs,
    ]);
  }

  return {
    async saveRun(row, idempotencyKey) {
      const nowMs = Date.now();
      purgeExpiredPrompts(nowMs);
      sql.query(
        `INSERT INTO runs (id, owner_session_id, public_opt_in, summary_json, encrypted_prompt, prompt_expires_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           public_opt_in = excluded.public_opt_in,
           summary_json = excluded.summary_json,
           encrypted_prompt = excluded.encrypted_prompt,
           prompt_expires_at_ms = excluded.prompt_expires_at_ms`,
        [
          row.summary.id,
          row.ownerSessionId,
          row.summary.publicOptIn ? 1 : 0,
          JSON.stringify(row.summary),
          row.encryptedPrompt,
          row.promptExpiresAtMs,
          Date.parse(row.summary.createdAtIso) || nowMs,
        ]
      );
      if (idempotencyKey) {
        sql.query(
          `INSERT OR IGNORE INTO idempotency_keys (scope_key, run_id, created_at_ms) VALUES (?, ?, ?)`,
          [`${row.ownerSessionId}:${idempotencyKey}`, row.summary.id, nowMs]
        );
      }
    },

    async getRun(runId) {
      purgeExpiredPrompts(Date.now());
      const rows = sql.query(
        `SELECT owner_session_id, summary_json, encrypted_prompt, prompt_expires_at_ms FROM runs WHERE id = ? LIMIT 1`,
        [runId]
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        ownerSessionId: String(r.owner_session_id),
        summary: JSON.parse(String(r.summary_json)) as RunSummaryRecord,
        encryptedPrompt: r.encrypted_prompt ? String(r.encrypted_prompt) : null,
        promptExpiresAtMs:
          typeof r.prompt_expires_at_ms === "number" ? r.prompt_expires_at_ms : null,
      };
    },

    async getRunByIdempotencyKey(sessionId, idempotencyKey) {
      const rows = sql.query(
        `SELECT run_id FROM idempotency_keys WHERE scope_key = ? LIMIT 1`,
        [`${sessionId}:${idempotencyKey}`]
      );
      if (rows.length === 0) return null;
      return this.getRun(String(rows[0].run_id));
    },

    async deleteRun(runId) {
      const existing = sql.query(`SELECT id FROM runs WHERE id = ? LIMIT 1`, [runId]);
      if (existing.length === 0) return false;
      sql.query(`DELETE FROM runs WHERE id = ?`, [runId]);
      return true;
    },

    async listPublicRecentRuns(limit) {
      const safeLimit = Math.max(1, Math.min(25, limit));
      const rows = sql.query(
        `SELECT summary_json FROM runs WHERE public_opt_in = 1 ORDER BY created_at_ms DESC LIMIT ?`,
        [safeLimit]
      );
      return rows.map((r) => JSON.parse(String(r.summary_json)) as RunSummaryRecord);
    },

    async saveAgentRoom(row) {
      purgeExpiredPrompts(Date.now());
      sql.query(
        `INSERT INTO agent_rooms (room_code, run_id, owner_session_id, agent_token_hash, status, state_json, expires_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_code) DO UPDATE SET
           agent_token_hash = excluded.agent_token_hash,
           status = excluded.status,
           state_json = excluded.state_json,
           expires_at_ms = excluded.expires_at_ms`,
        [
          row.roomCode,
          row.runId,
          row.ownerSessionId,
          row.agentTokenHash,
          row.status,
          row.stateJson,
          row.expiresAtMs,
          row.createdAtMs,
        ]
      );
    },

    async getAgentRoom(roomCode) {
      const nowMs = Date.now();
      purgeExpiredPrompts(nowMs);
      const rows = sql.query(
        `SELECT room_code, run_id, owner_session_id, agent_token_hash, status, state_json, expires_at_ms, created_at_ms
         FROM agent_rooms WHERE room_code = ? LIMIT 1`,
        [roomCode]
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      const expiresAtMs = Number(r.expires_at_ms);
      const status = String(r.status) as AgentRoomStatus;
      if (expiresAtMs <= nowMs && status !== "COMPLETED") {
        return null;
      }
      return {
        roomCode: String(r.room_code),
        runId: String(r.run_id),
        ownerSessionId: String(r.owner_session_id),
        agentTokenHash: r.agent_token_hash ? String(r.agent_token_hash) : null,
        status,
        stateJson: String(r.state_json),
        expiresAtMs,
        createdAtMs: Number(r.created_at_ms),
      };
    },

    async deleteAgentRoom(roomCode) {
      const existing = sql.query(`SELECT room_code FROM agent_rooms WHERE room_code = ? LIMIT 1`, [roomCode]);
      if (existing.length === 0) return false;
      sql.query(`DELETE FROM agent_rooms WHERE room_code = ?`, [roomCode]);
      return true;
    },

    async checkAndRecordQuota({ sessionId, ipHash, maxSessionPerHour, maxIpPerHour, nowMs = Date.now() }) {
      const cutoff = nowMs - 3_600_000;
      sql.query(`DELETE FROM rate_events WHERE ts_ms < ?`, [cutoff]);

      const sessBucket = `sess:${sessionId}`;
      const ipBucket = `ip:${ipHash}`;

      const sessRows = sql.query(
        `SELECT COUNT(*) AS cnt FROM rate_events WHERE bucket_key = ? AND ts_ms >= ?`,
        [sessBucket, cutoff]
      );
      const sessCount = Number(sessRows[0]?.cnt ?? 0);
      if (sessCount >= maxSessionPerHour) {
        return {
          allowed: false,
          reason: `Free sandbox session quota reached (${maxSessionPerHour} runs/hour).`,
          remainingSessionRuns: 0,
        };
      }

      const ipRows = sql.query(
        `SELECT COUNT(*) AS cnt FROM rate_events WHERE bucket_key = ? AND ts_ms >= ?`,
        [ipBucket, cutoff]
      );
      const ipCount = Number(ipRows[0]?.cnt ?? 0);
      if (ipCount >= maxIpPerHour) {
        return {
          allowed: false,
          reason: `Secondary network rate limit reached (${maxIpPerHour} runs/hour).`,
          remainingSessionRuns: Math.max(0, maxSessionPerHour - sessCount),
        };
      }

      sql.query(`INSERT INTO rate_events (bucket_key, ts_ms) VALUES (?, ?)`, [sessBucket, nowMs]);
      sql.query(`INSERT INTO rate_events (bucket_key, ts_ms) VALUES (?, ?)`, [ipBucket, nowMs]);

      return {
        allowed: true,
        remainingSessionRuns: Math.max(0, maxSessionPerHour - sessCount - 1),
      };
    },

    async getDailySpendUsd(dayKey) {
      const rows = sql.query(`SELECT spent_usd FROM daily_budget WHERE day_key = ? LIMIT 1`, [dayKey]);
      return Number(rows[0]?.spent_usd ?? 0);
    },

    async addDailySpendUsd(dayKey, deltaUsd) {
      sql.query(
        `INSERT INTO daily_budget (day_key, spent_usd) VALUES (?, ?)
         ON CONFLICT(day_key) DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd`,
        [dayKey, Math.max(0, deltaUsd)]
      );
      return this.getDailySpendUsd(dayKey);
    },
  };
}
