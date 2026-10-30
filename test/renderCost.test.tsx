import { render, waitFor } from '@testing-library/react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { ChatStore } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// AI 串流時每一格都會重畫 ChatScreen：舊回答的 Markdown 有 memo，傳進去的東西都不變就不用重畫
// （對話長、表格程式碼多時，每一格重畫全部舊回答會拖慢串流）

const mockRenders: string[] = [];
jest.mock('../src/components/Markdown', () => {
  const actual = jest.requireActual('../src/components/Markdown');
  const React = require('react');
  // 包一層一樣用 memo 的替身：只有 props 變了才會進來，記下是哪一段
  const Counted = React.memo((p: { text: string }) => {
    mockRenders.push(p.text);
    return React.createElement(actual.Markdown, p);
  });
  return { ...actual, Markdown: Counted };
});

const A = 'http://192.168.1.20:11434';

jest.setTimeout(20_000);

test('AI 串流時，舊回答的 Markdown 不會跟著重畫', async () => {
  const net = new FakeOllamaNet();
  const host = net.addHost(A, { models: [{ name: 'gemma4:31b' }] });
  const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => null, throttleMs: 5, autoScan: false });
  await store.init();
  await store.addHost('192.168.1.20');
  await store.loadModels(A);
  await store.selectModel(A, 'gemma4:31b');
  await store.send('第一題');
  await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
  const old = '回答：第一題';
  expect(mockRenders).toContain(old);
  mockRenders.length = 0;
  // 新的回答分好幾段慢慢來
  let release!: () => void;
  const holdLast = new Promise<void>((r) => (release = r));
  host.reply = () => ({
    lines: [...Array.from({ length: 6 }, (_, i) => ({ message: { content: `第${i}段` }, done: false })), { message: { content: '' }, done: true }],
    holdLast,
  });
  const p = store.send('第二題');
  await waitFor(() => expect(store.getState().streaming?.content).toContain('第5段'));
  release();
  await p;
  await waitFor(() => expect(store.getState().streaming).toBeNull());
  expect(mockRenders.filter((t) => t === old)).toEqual([]);
});
