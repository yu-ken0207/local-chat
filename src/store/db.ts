import * as SQLite from 'expo-sqlite';

// 資料庫的最小介面：手機上用 expo-sqlite，測試時用 Node 內建的 SQLite，兩邊都照這個介面。

export type SqlValue = string | number | null;

export interface Db {
  /** 資料庫檔案在手機上的實際路徑（記憶體資料庫沒有） */
  path?: string;
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
}

function wrap(db: SQLite.SQLiteDatabase, path?: string): Db {
  return {
    path,
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params = []) => ({ changes: (await db.runAsync(sql, params)).changes }),
    all: (sql, params = []) => db.getAllAsync(sql, params),
    get: (sql, params = []) => db.getFirstAsync(sql, params),
  };
}

/** 手機上的資料庫（expo-sqlite） */
export async function openPhoneDb(name = 'local-chat.db'): Promise<Db> {
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return wrap(db, db.databasePath);
}

/** 暫時的記憶體資料庫（還原前先把目前的資料存一份，給「復原」用） */
export async function openMemoryDb(): Promise<Db> {
  const db = await SQLite.openDatabaseAsync(':memory:');
  await db.execAsync('PRAGMA foreign_keys = ON;');
  return wrap(db);
}

/** 把備份檔的內容載入成記憶體資料庫（不會動到手機上的資料） */
export async function openBackupBytes(bytes: Uint8Array): Promise<Db> {
  const db = await SQLite.deserializeDatabaseAsync(bytes);
  return wrap(db);
}
