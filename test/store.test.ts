/**
 * @jest-environment node
 */
import { BASE_SCHEMA, NotBackupError, Repo, defaultTemplates, likePattern } from '../src/store/repo';
import { memoryDb } from './helpers/nodeDb';

/** 每次呼叫時間加 1，方便檢查排序 */
function clock(start = 1000) {
  let t = start;
  return () => t++;
}

async function freshRepo() {
  const db = memoryDb();
  const repo = new Repo(db, clock());
  await repo.migrate();
  return { db, repo };
}

describe('migrate', () => {
  test('建表、放入預設範本；重跑不會重複', async () => {
    const { db, repo } = await freshRepo();
    await repo.migrate();
    expect((await repo.listTemplates()).map((t) => t.title)).toEqual(defaultTemplates().map((t) => t.title));
    expect(await db.get('PRAGMA user_version')).toEqual({ user_version: 3 });
  });
});

describe('主機', () => {
  test('掃到的主機存起來，之後再掃到只更新版本與時間', async () => {
    const { repo } = await freshRepo();
    await repo.saveHost({ url: 'http://192.168.1.5:11434', label: '192.168.1.5', source: 'scan', version: '0.31.1' });
    await repo.saveHost({ url: 'http://192.168.1.5:11434', label: '192.168.1.5', source: 'scan', version: '0.40.0' });
    const hosts = await repo.listHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ source: 'scan', version: '0.40.0' });
    expect(hosts[0].lastSeenAt).toBeGreaterThan(hosts[0].createdAt);
  });

  test('手動加的主機不會被掃描結果改掉名稱與來源；沒驗證過的不會清掉上次在線時間', async () => {
    const { repo } = await freshRepo();
    await repo.saveHost({ url: 'http://pc:11434', label: '我的電腦', source: 'manual', version: '0.40.0' });
    const seen = (await repo.listHosts())[0].lastSeenAt;
    await repo.saveHost({ url: 'http://pc:11434', label: 'pc', source: 'scan' });
    expect((await repo.listHosts())[0]).toMatchObject({ label: '我的電腦', source: 'manual', version: '0.40.0', lastSeenAt: seen });
  });

  test('掃到的主機改成手動加，就變成手動', async () => {
    const { repo } = await freshRepo();
    await repo.saveHost({ url: 'http://a:11434', label: 'a', source: 'scan', version: '1' });
    await repo.saveHost({ url: 'http://a:11434', label: 'A 機', source: 'manual' });
    expect((await repo.listHosts())[0]).toMatchObject({ label: 'A 機', source: 'manual', version: '1' });
  });

  test('標記在線、刪除', async () => {
    const { repo } = await freshRepo();
    await repo.saveHost({ url: 'http://a:11434', label: 'a', source: 'manual' });
    await repo.saveHost({ url: 'http://b:11434', label: 'b', source: 'scan', version: '1' });
    await repo.markHostSeen('http://a:11434', '0.40.0');
    await repo.removeHost('http://b:11434');
    const hosts = await repo.listHosts();
    expect(hosts.map((h) => [h.label, h.version])).toEqual([['a', '0.40.0']]);
    expect(hosts[0].lastSeenAt).not.toBeNull();
  });
});

describe('對話與訊息', () => {
  test('建立對話、思考設定存取（開關、等級、未設定）', async () => {
    const { repo } = await freshRepo();
    for (const think of [true, false, 'high', null] as const) {
      const s = await repo.createSession({ hostUrl: 'http://a:11434', model: 'gemma4:31b', think, systemPrompt: '你是巡檢專家' });
      expect(await repo.getSession(s.id)).toEqual(s);
    }
    expect(await repo.getSession('nope')).toBeNull();
  });

  test('改對話設定不會讓它跳到清單最上面；新訊息會', async () => {
    const { repo } = await freshRepo();
    const a = await repo.createSession();
    const b = await repo.createSession();
    expect((await repo.listSessions()).map((s) => s.id)).toEqual([b.id, a.id]);
    await repo.updateSession(a.id, { title: '午餐', model: 'gemma4:12b', think: 'low', systemPrompt: 'x' });
    expect((await repo.listSessions()).map((s) => s.id)).toEqual([b.id, a.id]);
    await repo.addMessage(a.id, { role: 'user', content: '吃什麼' });
    const list = await repo.listSessions();
    expect(list.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(list[0]).toMatchObject({ title: '午餐', model: 'gemma4:12b', think: 'low', systemPrompt: 'x', preview: '吃什麼' });
  });

  test('訊息依序編號，照片照順序存取，統計可以寫回', async () => {
    const { repo } = await freshRepo();
    const s = await repo.createSession();
    const u = await repo.addMessage(s.id, {
      role: 'user',
      content: '比較兩張',
      attachments: [
        { base64: 'AAA', width: 100, height: 50 },
        { base64: 'BBB', width: 30, height: 60 },
      ],
    });
    const a = await repo.addMessage(s.id, { role: 'assistant', content: '', model: 'gemma4:31b', hostLabel: '書房電腦' });
    await repo.updateMessage(a.id, {
      content: '第一張比較寬',
      thinking: '看尺寸',
      stats: { evalCount: 10, evalDurationNs: 1e9, promptEvalCount: 300, totalDurationNs: 2e9 },
    });
    const msgs = await repo.listMessages(s.id);
    expect(msgs.map((m) => [m.seq, m.role])).toEqual([
      [1, 'user'],
      [2, 'assistant'],
    ]);
    expect(msgs[0].attachments.map((x) => [x.base64, x.width, x.height])).toEqual([
      ['AAA', 100, 50],
      ['BBB', 30, 60],
    ]);
    expect(msgs[0].id).toBe(u.id);
    expect(msgs[1]).toMatchObject({
      content: '第一張比較寬',
      thinking: '看尺寸',
      model: 'gemma4:31b',
      hostLabel: '書房電腦',
      stats: { evalCount: 10, evalDurationNs: 1e9, promptEvalCount: 300, totalDurationNs: 2e9 },
    });
  });

  test('從某則訊息開始刪到最後（編輯重送、重新產生）', async () => {
    const { repo } = await freshRepo();
    const s = await repo.createSession();
    for (const c of ['q1', 'a1', 'q2', 'a2']) await repo.addMessage(s.id, { role: c.startsWith('q') ? 'user' : 'assistant', content: c });
    await repo.deleteMessagesFrom(s.id, 3);
    expect((await repo.listMessages(s.id)).map((m) => m.content)).toEqual(['q1', 'a1']);
    // 刪掉之後再加，編號接著最後一則
    expect((await repo.addMessage(s.id, { role: 'user', content: 'q2b' })).seq).toBe(3);
  });

  test('刪對話會連訊息和照片一起刪', async () => {
    const { db, repo } = await freshRepo();
    const s = await repo.createSession();
    const m = await repo.addMessage(s.id, { role: 'user', content: 'x', attachments: [{ base64: 'A', width: 1, height: 1 }] });
    await repo.deleteMessage(m.id);
    expect(await db.get('SELECT COUNT(*) AS n FROM attachments')).toEqual({ n: 0 });
    await repo.addMessage(s.id, { role: 'user', content: 'y', attachments: [{ base64: 'B', width: 1, height: 1 }] });
    await repo.deleteSession(s.id);
    expect(await db.get('SELECT COUNT(*) AS n FROM messages')).toEqual({ n: 0 });
    expect(await db.get('SELECT COUNT(*) AS n FROM attachments')).toEqual({ n: 0 });
  });

  test('清掉沒講話的空白對話，保留目前這段', async () => {
    const { repo } = await freshRepo();
    const empty = await repo.createSession();
    const current = await repo.createSession();
    const used = await repo.createSession();
    await repo.addMessage(used.id, { role: 'user', content: 'hi' });
    await repo.deleteEmptySessions(current.id);
    expect((await repo.listSessions()).map((s) => s.id).sort()).toEqual([current.id, used.id].sort());
    expect(await repo.getSession(empty.id)).toBeNull();
  });
});

describe('搜尋對話', () => {
  async function seeded() {
    const { repo } = await freshRepo();
    const a = await repo.createSession();
    await repo.updateSession(a.id, { title: 'Docker 設定' });
    await repo.addMessage(a.id, { role: 'user', content: '怎麼裝' });
    const b = await repo.createSession();
    await repo.addMessage(b.id, { role: 'user', content: '照片裡有沒有煙？' });
    await repo.addMessage(b.id, { role: 'assistant', content: '有，左上角 50% 的區域' });
    const c = await repo.createSession();
    await repo.addMessage(c.id, { role: 'user', content: 'snake_case 是什麼' });
    return { repo, a, b, c };
  }

  test('比對標題與訊息內容，英文不分大小寫', async () => {
    const { repo, a, b } = await seeded();
    expect((await repo.listSessions('docker')).map((s) => s.id)).toEqual([a.id]);
    expect((await repo.listSessions('煙')).map((s) => s.id)).toEqual([b.id]);
    expect((await repo.listSessions('  ')).length).toBe(3);
  });

  test('% 和 _ 當一般字元，不是萬用字元', async () => {
    const { repo, b, c } = await seeded();
    expect((await repo.listSessions('50%')).map((s) => s.id)).toEqual([b.id]);
    expect((await repo.listSessions('_')).map((s) => s.id)).toEqual([c.id]);
    expect(likePattern('a%b_c\\')).toBe('%a\\%b\\_c\\\\%');
  });

  test('預覽是最後一則對話內容', async () => {
    const { repo, b } = await seeded();
    expect((await repo.listSessions()).find((s) => s.id === b.id)?.preview).toBe('有，左上角 50% 的區域');
  });
});

describe('設定', () => {
  test('設定存取與覆寫', async () => {
    const { repo } = await freshRepo();
    expect(await repo.getSetting('lastModel')).toBeNull();
    await repo.setSetting('lastModel', 'gemma4:31b');
    await repo.setSetting('lastModel', 'gemma4:12b');
    expect(await repo.getSetting('lastModel')).toBe('gemma4:12b');
  });
});


describe('資料庫檔案', () => {
  test('大小會隨內容變大；合併暫存寫入不會出錯；記憶體資料庫沒有路徑', async () => {
    const { repo } = await freshRepo();
    const before = await repo.sizeBytes();
    const s = await repo.createSession();
    await repo.addMessage(s.id, { role: 'user', content: 'x'.repeat(20000), attachments: [{ base64: 'A'.repeat(50000), width: 1, height: 1 }] });
    expect(await repo.sizeBytes()).toBeGreaterThan(before + 60000);
    await expect(repo.checkpoint()).resolves.toBeUndefined();
    expect(repo.dbPath()).toBeNull();
  });
});

describe('使用者自己移除資料', () => {
  async function seeded() {
    const { db, repo } = await freshRepo();
    await repo.saveHost({ url: 'http://a:11434', label: 'a', source: 'manual', version: '1' });
    await repo.setSetting('lastModel', 'gemma4:31b');
    for (let i = 0; i < 3; i++) {
      const s = await repo.createSession();
      await repo.addMessage(s.id, { role: 'user', content: 'x'.repeat(30000), attachments: [{ base64: 'A'.repeat(60000), width: 1, height: 1 }] });
    }
    return { db, repo };
  }

  test('刪除所有對話：先移到最近刪除（主機、設定保留）；清空最近刪除後檔案變小', async () => {
    const { db, repo } = await seeded();
    const before = await repo.sizeBytes();
    expect(await repo.countSessions()).toBe(3);
    const ids = await repo.trashAllSessions();
    expect(ids).toHaveLength(3);
    expect(await repo.countSessions()).toBe(0);
    expect(await repo.countTrash()).toBe(3);
    expect(await repo.listHosts()).toHaveLength(1);
    expect(await repo.getSetting('lastModel')).toBe('gemma4:31b');
    await repo.emptyTrash();
    expect(await repo.countTrash()).toBe(0);
    expect(await db.get('SELECT COUNT(*) AS n FROM attachments')).toEqual({ n: 0 });
    expect(await repo.sizeBytes()).toBeLessThan(before / 2);
  });

  test('清除全部資料：什麼都不留，範本恢復成預設', async () => {
    const { repo } = await seeded();
    await repo.resetAll();
    expect(await repo.countSessions()).toBe(0);
    expect(await repo.listHosts()).toEqual([]);
    expect(await repo.getSetting('lastModel')).toBeNull();
    expect((await repo.listTemplates()).map((t) => t.title)).toEqual(defaultTemplates().map((t) => t.title));
  });
});

describe('資料庫升級', () => {
  test('第 1 版的資料庫升級後，舊訊息還在、新欄位有預設值', async () => {
    const db = memoryDb();
    const v1 = new Repo(db);
    // 模擬已經在手機上用過的第 1 版資料庫
    await db.exec(BASE_SCHEMA);
    await db.exec(`INSERT INTO sessions VALUES ('s1', '舊對話', NULL, NULL, NULL, '', 1, 1);
      INSERT INTO messages VALUES ('m1', 's1', 1, 'user', '舊訊息', '', NULL, NULL, NULL, 1);
      PRAGMA user_version = 1;`);
    await v1.migrate();
    expect(await db.get('PRAGMA user_version')).toEqual({ user_version: 3 });
    const msgs = await v1.listMessages('s1');
    expect(msgs.map((m) => [m.content, m.detail])).toEqual([['舊訊息', '']]);
    await v1.addMessage('s1', { role: 'error', content: '連不到', detail: 'Network request failed' });
    expect((await v1.listMessages('s1'))[1].detail).toBe('Network request failed');
  });
});

describe('備份與還原', () => {
  test('用備份取代目前的資料；舊版本的備份會先升級', async () => {
    const { repo } = await freshRepo();
    await repo.saveHost({ url: 'http://now:11434', label: '現在的', source: 'manual' });
    const backup = memoryDb();
    await backup.exec(BASE_SCHEMA);
    await backup.exec(`INSERT INTO hosts VALUES ('http://old:11434', '備份的電腦', 'manual', '0.40.0', NULL, 1);
      INSERT INTO sessions VALUES ('s1', '備份的對話', NULL, NULL, NULL, '', 1, 1);
      INSERT INTO messages VALUES ('m1', 's1', 1, 'user', '備份裡的話', '', NULL, NULL, NULL, 1);
      INSERT INTO templates VALUES ('t1', '備份範本', '內容', 0);
      PRAGMA user_version = 1;`);
    await repo.replaceWith(backup);
    expect((await repo.listHosts()).map((h) => h.label)).toEqual(['備份的電腦']);
    expect((await repo.listSessions()).map((s) => s.title)).toEqual(['備份的對話']);
    expect((await repo.listMessages('s1')).map((m) => [m.content, m.detail, m.versions])).toEqual([['備份裡的話', '', null]]);
    expect((await repo.listTemplates()).map((t) => t.title)).toEqual(['備份範本']);
  });

  test('不是這個 App 的檔案：丟錯，目前的資料不動', async () => {
    const { repo } = await freshRepo();
    await repo.saveHost({ url: 'http://now:11434', label: '現在的', source: 'manual' });
    const other = memoryDb();
    await other.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    await expect(repo.replaceWith(other)).rejects.toBeInstanceOf(NotBackupError);
    expect((await repo.listHosts()).map((h) => h.label)).toEqual(['現在的']);
  });

  test('複製到另一個資料庫：內容一樣（給還原前的「復原」用）', async () => {
    const { repo } = await freshRepo();
    const s = await repo.createSession();
    await repo.addMessage(s.id, { role: 'user', content: 'hi', attachments: [{ base64: 'IMG', width: 2, height: 3 }] });
    const target = memoryDb();
    await repo.copyTo(target);
    const copy = new Repo(target);
    expect((await copy.listMessages(s.id)).map((m) => [m.content, m.attachments.map((a) => a.base64)])).toEqual([['hi', ['IMG']]]);
  });
});
