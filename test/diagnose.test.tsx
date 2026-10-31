import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { ChatStore, diagnosisText, memorySecrets } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 連不到電腦時說出原因；送出後很快就知道連不到（不用等到聊天逾時）；電腦換了位址自動改好再問一次

jest.setTimeout(30_000);

const A = 'http://192.168.1.20:11434';
const H = 'http://192.168.1.30:11480';

async function plain(wifi: string | null = '192.168.1.10') {
  const net = new FakeOllamaNet();
  const pc = net.addHost(A, { models: [{ name: 'gemma4:12b' }] });
  const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => wifi, throttleMs: 5, autoScan: false, probeTimeoutMs: 150 });
  await store.init();
  await store.addHost('192.168.1.20');
  return { net, pc, store };
}

async function helper() {
  const net = new FakeOllamaNet();
  const pc = net.addHelper(H, { id: 'h1', name: '書房電腦', code: '123456' }, { models: [{ name: 'gemma4:12b' }] });
  const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, secrets: memorySecrets(), wifiIp: async () => '192.168.1.5', throttleMs: 5, autoScan: false, probeTimeoutMs: 150 });
  await store.init();
  await store.pairHelper(H, '123456');
  return { net, pc, store };
}

describe('找原因', () => {
  test('手機沒連 Wi-Fi', async () => {
    const { pc, store } = await plain(null);
    pc.online = false;
    expect(await store.diagnose(A)).toEqual({ kind: 'no-wifi' });
  });

  test('手機和電腦不在同一個網路（例如訪客網路）', async () => {
    const { pc, store } = await plain('192.168.5.10');
    pc.online = false;
    expect(await store.diagnose(A)).toEqual({ kind: 'other-network', phoneIp: '192.168.5.10', hostIp: '192.168.1.20' });
  });

  test('馬上被拒絕：電腦開著，只是 Ollama／小幫手沒開', async () => {
    const { pc, store } = await plain();
    pc.online = false;
    const d = await store.diagnose(A);
    expect(d).toEqual({ kind: 'refused', helper: false });
    expect(diagnosisText(d)).toMatch(/電腦開著，但 Ollama 沒有開/);
  });

  test('沒有回應：睡著、關機或防火牆', async () => {
    const { pc, store } = await plain();
    Object.assign(pc, { online: false, silent: true });
    expect(await store.diagnose(A)).toEqual({ kind: 'no-response', helper: false });
  });

  test('Tailscale 的位址：手機的 Tailscale 沒開、被拒絕（小幫手沒開）、沒回應', async () => {
    const T = 'http://100.100.1.17:11434';
    const net = new FakeOllamaNet();
    const pc = net.addHost(T, { models: [{ name: 'm' }] });
    let vpn: boolean | null = false;
    const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => null, vpnOn: async () => vpn, autoScan: false, probeTimeoutMs: 150 });
    await store.init();
    await store.addHost('100.100.1.17');
    pc.online = false;
    expect(await store.diagnose(T)).toEqual({ kind: 'vpn-off' });
    vpn = true;
    expect(await store.diagnose(T)).toEqual({ kind: 'refused', helper: false });
    pc.silent = true;
    expect(await store.diagnose(T)).toEqual({ kind: 'vpn-no-response' });
  });

  test('連得到：沒事', async () => {
    const { store } = await plain();
    expect(await store.diagnose(A)).toEqual({ kind: 'ok' });
  });
});

describe('送出時', () => {
  test('電腦沒回應：幾秒內就說原因，不用等到聊天逾時', async () => {
    const { pc, store } = await plain();
    Object.assign(pc, { online: false, silent: true });
    const started = Date.now();
    await store.send('hi');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(store.getState().messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['error', '沒有得到回答：電腦沒有回應：可能睡著或關機了，或是防火牆擋住手機。'],
    ]);
  });

  test('小幫手沒開：說電腦開著但小幫手沒開', async () => {
    const { pc, store } = await helper();
    pc.online = false;
    await store.send('hi');
    expect(store.getState().messages.at(-1)?.content).toBe('沒有得到回答：電腦開著，但 Local AI 小幫手沒有開。請在電腦的應用程式選單（Windows 是「開始」功能表）打開「Local AI 小幫手」。');
  });

  test('電腦換了位址：自己找到、改好，再問一次', async () => {
    const { net, pc, store } = await helper();
    // 路由器把電腦換到 .31
    net.hosts.delete(H);
    net.hosts.set('http://192.168.1.31:11480', pc);
    await store.send('hi');
    expect(store.getState().session?.hostUrl).toBe('http://192.168.1.31:11480');
    expect(store.getState().messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', '回答：hi'],
    ]);
    expect(store.getState().notice).toMatch(/換了網路位址/);
  });

  test('模型還沒載入：標成「正在載入模型」', async () => {
    const { pc, store } = await plain();
    pc.reply = () => ({ lines: [], hang: true });
    await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    void store.send('hi');
    await waitFor(() => expect(store.getState().streaming?.loading).toBe(true));
    expect(await screen.findByText('正在載入模型')).toBeTruthy();
    store.stop();
    await waitFor(() => expect(store.getState().streaming).toBeNull());
  });

  test('模型已經載入：還是「等待模型」', async () => {
    const { pc, store } = await plain();
    pc.loaded = ['gemma4:12b'];
    pc.reply = () => ({ lines: [], hang: true });
    void store.send('hi');
    await waitFor(() => expect(store.getState().streaming?.loading).toBe(false));
    store.stop();
    await waitFor(() => expect(store.getState().streaming).toBeNull());
  });
});

describe('選模型面板', () => {
  test('連不到時先找原因再說明；重試成功就列出模型', async () => {
    const { pc, store } = await plain();
    await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    pc.online = false;
    await store.loadModels(A);
    await fireEvent.press(screen.getAllByRole('button', { name: /^選擇模型$|^模型：/ })[0]);
    expect(await screen.findByText('電腦開著，但 Ollama 沒有開，或沒有開放讓區網連線。')).toBeTruthy();
    pc.online = true;
    await fireEvent.press(screen.getByText('重試'));
    expect(await screen.findByLabelText(/模型 Gemma 4 12B/)).toBeTruthy();
  });
});
