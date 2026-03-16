import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { HexString, UserOperation } from "./index.js";

const DEFAULT_DB_PATH = "./data/servo.db";

export class BundlerPersistenceStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = process.env.DB_PATH ?? DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_user_operations (
        hash TEXT PRIMARY KEY,
        entry_point TEXT NOT NULL,
        user_operation TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        submission_tx_hash TEXT,
        submission_started_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS sender_reputations (
        sender TEXT PRIMARY KEY,
        failures INTEGER NOT NULL,
        banned_until INTEGER
      );
    `);

    this.migratePendingUserOperationsTable();
    this.deleteExpiredSenderReputations();
  }

  private migratePendingUserOperationsTable(): void {
    const columns = this.db.prepare("PRAGMA table_info(pending_user_operations)").all() as Array<{
      name: string;
    }>;
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has("state")) {
      this.db.exec(
        "ALTER TABLE pending_user_operations ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'",
      );
    }

    if (!columnNames.has("submission_tx_hash")) {
      this.db.exec("ALTER TABLE pending_user_operations ADD COLUMN submission_tx_hash TEXT");
    }

    if (!columnNames.has("submission_started_at")) {
      this.db.exec("ALTER TABLE pending_user_operations ADD COLUMN submission_started_at INTEGER");
    }
  }

  savePendingOperation(
    hash: string,
    entryPoint: HexString,
    userOperation: UserOperation,
    receivedAt: number,
  ): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO pending_user_operations (hash, entry_point, user_operation, received_at, state, submission_tx_hash, submission_started_at) VALUES (?, ?, ?, ?, 'pending', NULL, NULL)",
      )
      .run(hash, entryPoint, JSON.stringify(userOperation), receivedAt);
  }

  markPendingOperationSubmitting(hash: string, startedAt: number): void {
    this.db
      .prepare(
        "UPDATE pending_user_operations SET state = 'submitting', submission_started_at = ?, submission_tx_hash = NULL WHERE hash = ?",
      )
      .run(startedAt, hash);
  }

  recordPendingOperationsTransactionHash(hashes: string[], transactionHash: HexString): void {
    if (hashes.length === 0) {
      return;
    }

    const update = this.db.prepare(
      "UPDATE pending_user_operations SET state = 'submitting', submission_tx_hash = ? WHERE hash = ?",
    );
    const writeBatch = this.db.transaction((pendingHashes: string[], hashValue: HexString) => {
      for (const hash of pendingHashes) {
        update.run(hashValue, hash);
      }
    });

    writeBatch(hashes, transactionHash);
  }

  markPendingOperationPending(hash: string): void {
    this.db
      .prepare(
        "UPDATE pending_user_operations SET state = 'pending', submission_tx_hash = NULL, submission_started_at = NULL WHERE hash = ?",
      )
      .run(hash);
  }

  removePendingOperation(hash: string): void {
    this.db.prepare("DELETE FROM pending_user_operations WHERE hash = ?").run(hash);
  }

  loadPendingOperations(): Array<{
    hash: string;
    entryPoint: HexString;
    userOperation: UserOperation;
    receivedAt: number;
    state: "pending" | "submitting";
    submissionTxHash: HexString | null;
    submissionStartedAt: number | null;
  }> {
    const rows = this.db
      .prepare(
        "SELECT hash, entry_point, user_operation, received_at, state, submission_tx_hash, submission_started_at FROM pending_user_operations",
      )
      .all() as Array<{
      hash: string;
      entry_point: string;
      user_operation: string;
      received_at: number;
      state: string;
      submission_tx_hash: string | null;
      submission_started_at: number | null;
    }>;

    return rows.map((row) => ({
      hash: row.hash,
      entryPoint: row.entry_point as HexString,
      userOperation: JSON.parse(row.user_operation) as UserOperation,
      receivedAt: row.received_at,
      state: row.state === "submitting" ? "submitting" : "pending",
      submissionTxHash: row.submission_tx_hash as HexString | null,
      submissionStartedAt: row.submission_started_at,
    }));
  }

  saveSenderReputation(sender: string, failures: number, bannedUntil: number | null): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO sender_reputations (sender, failures, banned_until) VALUES (?, ?, ?)",
      )
      .run(sender, failures, bannedUntil);
  }

  deleteSenderReputation(sender: string): void {
    this.db.prepare("DELETE FROM sender_reputations WHERE sender = ?").run(sender);
  }

  loadSenderReputations(): Array<{ sender: string; failures: number; bannedUntil: number | null }> {
    const rows = this.db
      .prepare("SELECT sender, failures, banned_until FROM sender_reputations")
      .all() as Array<{ sender: string; failures: number; banned_until: number | null }>;

    return rows.map((row) => ({
      sender: row.sender,
      failures: row.failures,
      bannedUntil: row.banned_until,
    }));
  }

  deleteExpiredSenderReputations(nowMs: number = Date.now()): void {
    this.db
      .prepare(
        "DELETE FROM sender_reputations WHERE banned_until IS NOT NULL AND banned_until <= ?",
      )
      .run(nowMs);
  }

  close(): void {
    this.db.close();
  }
}
