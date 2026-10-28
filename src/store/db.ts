import * as SQLite from 'expo-sqlite';

// 資料庫的最小介面：手機上用 expo-sqlite，測試時用 Node 內建的 SQLite，兩邊都照這個介面。

export type SqlValue = string | number | null;

export interface Db {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
}

/** 手機上的資料庫（expo-sqlite） */
export async function openPhoneDb(name = 'local-chat.db'): Promise<Db> {
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params = []) => ({ changes: (await db.runAsync(sql, params)).changes }),
    all: (sql, params = []) => db.getAllAsync(sql, params),
    get: (sql, params = []) => db.getFirstAsync(sql, params),
  };
}
