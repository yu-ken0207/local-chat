import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { UsageSheet } from '../src/components/UsageSheet';
import { COMPACT_PROMPTS, ChatStore, SUMMARY_LEADS, compactCut } from '../src/state/chatStore';
import { Repo, type Message } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 一般聊天快滿了：不提示、不叫人開新對話，回答完在背景把前面整理成前情摘要；手機上的訊息都還在

const A = 'http://192.168.1.20:11434';
jest.setTimeout(20_000);

/** 每次回答都回報用了 120 tokens：上限 140 是 86%（會自動整理），300 是 40%（不會） */
async function setup(runtimeCtx = 140) {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: [{ name: 'gemma4:31b' }], runtimeCtx });
  const repo = new Repo(memoryDb());
  const store = new ChatStore({ repo, client: net.client, wifiIp: async () => null, throttleMs: 5, autoScan: false });
  await store.init();
  await store.addHost('192.168.1.20');
  await store.loadModels(A);
  await store.selectModel(A, 'gemma4:31b');
  return { net, repo, store };
}

const isCompact = (body: any) => body.messages[0]?.content === COMPACT_PROMPTS['zh-Hant'];
const settle = (store: ChatStore) => Promise.all([...store.compactTasks.values()]);
const LONG1 = '第一個問題：' + '請幫我規劃旅行'.repeat(6);
const LONG2 = '第二個問題：' + '預算大概三萬元'.repeat(6);

test('從哪裡切：從最後往前留到預算為止，切在使用者說的話；至少留最後一次發問；前面沒東西回 null', () => {
  const msg = (seq: number, role: string, content: string) => ({ id: String(seq), seq, role, content, attachments: [] }) as unknown as Message;
  const list = [msg(1, 'user', '一'.repeat(40)), msg(2, 'assistant', '二'.repeat(40)), msg(3, 'user', '三'.repeat(40)), msg(4, 'assistant', '四'.repeat(40))];
  expect(compactCut(list, 100)).toBe(2);
  expect(compactCut(list, 10)).toBe(2);
  expect(compactCut(list, 1000)).toBeNull();
  expect(compactCut(list.slice(0, 2), 10)).toBeNull();
});

test('回答完到 80% 就在背景整理；之後送給 AI 的是摘要加上最近的對話，手機上的訊息都還在', async () => {
  const { net, store } = await setup();
  await store.send(LONG1);
  await settle(store);
  // 只有一問一答：沒有東西可以整理
  expect(store.getState().session!.summarySeq).toBe(0);
  await store.send(LONG2);
  await waitFor(() => expect(store.getState().session!.summarySeq).toBeGreaterThan(0));
  const s = store.getState().session!;
  expect(s.summary).toContain('第一個問題');
  // 上限很小：一次只塞得下一則，分兩次併進摘要（第二次帶著前一次的摘要）
  const calls = net.chatBodies().filter(isCompact);
  expect(calls).toHaveLength(2);
  expect(calls[1].messages[1].content).toMatch(/^之前的摘要：\n/);
  expect(store.getState().messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([LONG1, LONG2]);
  // 下一次：系統說明後面接摘要，前面的原文不送
  await store.send('第三個問題');
  const body = net.chatBodies().filter((b) => !isCompact(b)).at(-1)!;
  expect(body.messages[1]).toEqual({ role: 'system', content: `${SUMMARY_LEADS['zh-Hant']}\n${s.summary}` });
  expect(body.messages.some((m: any) => m.content === LONG1)).toBe(false);
  expect(body.messages.some((m: any) => m.content === LONG2)).toBe(true);
  await settle(store);
});

test('改了已經整理過的訊息：摘要作廢，畫面上那條線也不見；按復原就回來', async () => {
  const { store } = await setup();
  await store.send(LONG1);
  await store.send(LONG2);
  await waitFor(() => expect(store.getState().session!.summarySeq).toBeGreaterThan(0));
  await settle(store);
  const before = store.getState().session!;
  const first = store.getState().messages.find((m) => m.content === LONG1)!;
  await store.editAndResend(first.id, '改過的問題', []);
  expect(store.getState().session).toMatchObject({ summary: '', summarySeq: 0 });
  await settle(store);
  await store.undoLast();
  await waitFor(() => expect(store.getState().session).toMatchObject({ summary: before.summary, summarySeq: before.summarySeq }));
});

test('沒到 80% 不整理；多 AI 討論不用這個（有自己的前情摘要）', async () => {
  const { net, repo, store } = await setup(300);
  await store.send(LONG1);
  await store.send(LONG2);
  await settle(store);
  expect(net.chatBodies().filter(isCompact)).toHaveLength(0);
  const a = await repo.createAgent({ name: '財務長', intro: '', card: { expertise: '預算', stance: '', style: '', blindSpot: '' }, mine: true });
  await store.addMember(a.id);
  expect(await store.compact(store.getState().session!.id)).toBe(false);
  expect(net.chatBodies().filter(isCompact)).toHaveLength(0);
});

test('對話裡出現「前面的內容已整理成摘要」，點了看摘要；快滿了不跳提示', async () => {
  const { store } = await setup();
  await render(<ChatScreen store={store} pickPhotos={jest.fn()} copyText={jest.fn()} />);
  await act(async () => {
    await store.send(LONG1);
    await store.send(LONG2);
    await settle(store);
  });
  await fireEvent.press(await screen.findByTestId('summary-divider'));
  expect(await screen.findByText(store.getState().session!.summary)).toBeTruthy();
  expect(screen.queryByText(/太長了|開新對話/)).toBeNull();
  await fireEvent.press(screen.getByText('完成'));
});

test('用量面板「現在整理」：前面有東西才出現，按了就整理；之後用量照內容估，多了「前情摘要」', async () => {
  const { net, store } = await setup(300);
  await store.send(LONG1);
  await store.send(LONG2);
  await render(<UsageSheet store={store} version={0} reduceMotion compacting={false} onClose={jest.fn()} />);
  await fireEvent.press(await screen.findByText('現在整理'));
  await waitFor(() => expect(store.getState().session!.summarySeq).toBeGreaterThan(0));
  await settle(store);
  expect(net.chatBodies().filter(isCompact)).toHaveLength(1);
  const r = await store.usageReport();
  expect(r.context!.estimated).toBe(true);
  expect(r.context!.parts.map((p) => p.key)).toContain('summary');
  expect(r.canCompact).toBe(false);
});
