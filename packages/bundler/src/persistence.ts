import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { UserOperation } from "./index.js";

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
        received_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sender_reputations (
        sender TEXT PRIMARY KEY,
        failures INTEGER NOT NULL,
        banned_until INTEGER
      );
    `);

    this.deleteExpiredSenderReputations();
  }

  savePendingOperation(
    hash: string,
    entryPoint: string,
    userOperation: UserOperation,
    receivedAt: number,
  ): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO pending_user_operations (hash, entry_point, user_operation, received_at) VALUES (?, ?, ?, ?)",
      )
      .run(hash, entryPoint, JSON.stringify(userOperation), receivedAt);
  }

  removePendingOperation(hash: string): void {
    this.db.prepare("DELETE FROM pending_user_operations WHERE hash = ?").run(hash);
  }

  loadPendingOperations(): Array<{
    hash: string;
    entryPoint: string;
    userOperation: UserOperation;
    receivedAt: number;
  }> {
    const rows = this.db
      .prepare("SELECT hash, entry_point, user_operation, received_at FROM pending_user_operations")
      .all() as Array<{
      hash: string;
      entry_point: string;
      user_operation: string;
      received_at: number;
    }>;

    return rows.map((row) => ({
      hash: row.hash,
      entryPoint: row.entry_point,
      userOperation: JSON.parse(row.user_operation) as UserOperation,
      receivedAt: row.received_at,
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
