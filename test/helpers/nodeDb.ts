import type { Db } from '../../src/store/db';

/** 用 Node 內建的 SQLite（記憶體資料庫）模擬手機上的 expo-sqlite */
export function memoryDb(): Db {
  // jest 的模組解析不認得 node:sqlite，用 getBuiltinModule 直接拿
  const { DatabaseSync } = (process as any).getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return {
    exec: async (sql) => db.exec(sql),
    run: async (sql, params = []) => ({ changes: Number(db.prepare(sql).run(...params).changes) }),
    all: async (sql, params = []) => db.prepare(sql).all(...params),
    get: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
  };
}
