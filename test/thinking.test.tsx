import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { ChatStore } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 一定會思考的模型（例如現在的 qwen3:4b = Qwen3 4B Thinking-2507）：關掉思考還是會想，Ollama 不會分開，思考混在回答前面

jest.setTimeout(30_000);

const A = 'http://192.168.1.20:11434';
const done = { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 5, eval_duration: 1e8, prompt_eval_count: 10 };

async function setup() {
  const net = new FakeOllamaNet();
  const pc = net.addHost(A, { models: [{ name: 'qwen3:4b', think: 'toggle' }] });
  // 照真的 Ollama 0.31：開思考才分開；關掉時思考混在回答裡，只看得到結尾的 </think>
  pc.reply = (body) =>
    body.think
      ? { lines: [{ message: { thinking: '想一下 1+1' } }, { message: { content: '答案是 2' } }, done] }
      : { lines: [{ message: { content: '想一下 1+1' } }, { message: { content: '</think>\n\n答案' } }, { message: { content: '是 2' } }, done] };
  const db = memoryDb();
  const store = new ChatStore({ repo: new Repo(db), client: net.client, wifiIp: async () => null, throttleMs: 5, autoScan: false });
  await store.init();
  await store.addHost('192.168.1.20');
  return { net, store, db };
}

test('思考混在回答裡：拆出來；記住這個模型一定會思考，下次直接開著思考送出', async () => {
  const { net, store, db } = await setup();
  expect(store.getState().session?.think).toBe(false);
  await store.send('1+1=?');
  expect(store.getState().messages[1]).toMatchObject({ role: 'assistant', content: '答案是 2', thinking: '想一下 1+1' });
  expect(store.currentModel()?.think).toEqual({ kind: 'always' });

  await store.send('再一次');
  expect(net.chatBodies().at(-1).think).toBe(true);
  expect(store.getState().messages[3]).toMatchObject({ content: '答案是 2', thinking: '想一下 1+1' });

  // 重開 App 也記得
  const again = new ChatStore({ repo: new Repo(db), client: net.client, wifiIp: async () => null, autoScan: false });
  await again.init();
  await again.loadModels(A);
  expect(again.currentModel()?.think).toEqual({ kind: 'always' });
});

test('輸入列：一定會思考的模型顯示「一定會先思考」，按了說明為什麼關不掉', async () => {
  const { store } = await setup();
  await store.send('1+1=?');
  await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await fireEvent.press(await screen.findByLabelText('一定會先思考'));
  expect(alert.mock.calls[0][1]).toMatch(/沒辦法關掉/);
  alert.mockRestore();
});

test('一般會思考的模型關掉思考：回答照常，不會被誤判', async () => {
  const { net, store } = await setup();
  net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '答案是 2' } }, done] });
  await store.send('1+1=?');
  expect(store.getState().messages[1]).toMatchObject({ content: '答案是 2', thinking: '' });
  expect(store.currentModel()?.think).toEqual({ kind: 'toggle' });
  await waitFor(() => expect(store.titleTask).not.toBeNull());
});
