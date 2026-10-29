import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert } from 'react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { bestPick, describeHardware, fitFor, suggestions } from '../src/lib/catalog';
import { friendlyModelName } from '../src/lib/modelName';
import type { Hardware, ModelInfo } from '../src/lib/ollama';
import { ChatStore, memorySecrets } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet, type FakeModel } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 從手機下載模型：依電腦配備推薦；透過小幫手時在電腦上下載（手機關掉也繼續）

jest.setTimeout(30_000);

const GB = 1e9;
const rtx5070: Hardware = { memoryBytes: 32 * GB, gpus: [{ name: 'NVIDIA GeForce RTX 5070', vramBytes: 12227 * 2 ** 20 }], unified: false };
const spark: Hardware = { memoryBytes: 128 * GB, gpus: [{ name: 'NVIDIA GB10', vramBytes: 0 }], unified: true };
const laptop: Hardware = { memoryBytes: 16 * GB, gpus: [], unified: false };

describe('推薦', () => {
  test('依配備判斷跑不跑得動', () => {
    expect(fitFor(8.0, rtx5070)).toBe('great'); // gemma4:12b 放得進 12 GB 顯示卡
    expect(fitFor(13.8, rtx5070)).toBe('slow'); // gpt-oss:20b 要分給 CPU
    expect(fitFor(60, rtx5070)).toBe('too-big');
    expect(fitFor(20.4, spark)).toBe('great'); // 共用記憶體看主記憶體
    expect(fitFor(2.5, laptop)).toBe('ok');
    expect(fitFor(6.6, laptop)).toBe('slow');
    expect(fitFor(8.0, laptop)).toBe('too-big');
    expect(fitFor(8.0, null)).toBe('unknown');
  });

  test('最推薦的是跑得順的裡面最好的；不知道配備推薦中等的', () => {
    expect(bestPick(suggestions(rtx5070, 'ollama', []))?.name).toBe('gemma4:12b');
    expect(bestPick(suggestions(spark, 'ollama', []))?.name).toBe('gemma4:31b');
    expect(bestPick(suggestions(laptop, 'ollama', []))?.name).toBe('gemma4:e2b');
    expect(bestPick(suggestions(null, 'ollama', []))?.name).toBe('gemma4:e4b');
    // LM Studio 用它目錄裡的名稱
    expect(bestPick(suggestions(rtx5070, 'lmstudio', []))?.name).toBe('google/gemma-4-12b');
  });

  test('已經有的標成已下載（包含 :latest、撞名的 @引擎）', () => {
    const have = (name: string) => ({ name }) as ModelInfo;
    const list = suggestions(null, 'lmstudio', [have('google/gemma-4-12b@lmstudio'), have('qwen/qwen3-4b-2507')]);
    expect(list.filter((s) => s.installed).map((s) => s.name)).toEqual(['google/gemma-4-12b', 'qwen/qwen3-4b-2507']);
  });

  test('配備的白話說明', () => {
    expect(describeHardware(rtx5070)).toBe('GeForce RTX 5070 12 GB · 記憶體 32 GB');
    expect(describeHardware(spark)).toBe('NVIDIA GB10 · 記憶體 128 GB（跟顯示卡共用）');
  });

  test('撞名的模型顯示時拿掉 @引擎', () => {
    expect(friendlyModelName('gemma4:12b@lmstudio')).toBe('Gemma 4 · 12B');
    expect(friendlyModelName('google/gemma-3-4b')).toBe('Gemma 3 4B');
    expect(friendlyModelName('qwen.gguf@server:a1')).toBe('Qwen.gguf');
  });
});

const H = 'http://192.168.1.30:11480';

async function pairedHelper(models: FakeModel[] = [], helper: Record<string, unknown> = {}) {
  const net = new FakeOllamaNet();
  const pc = net.addHelper(H, { id: 'h1', name: '書房電腦', code: '123456', hardware: { memory_bytes: 32 * GB, gpus: [{ name: 'NVIDIA GeForce RTX 5070', vram_bytes: 12227 * 2 ** 20 }] }, ...helper }, { models });
  const events: string[] = [];
  const store = new ChatStore({
    repo: new Repo(memoryDb()),
    client: net.client,
    secrets: memorySecrets(),
    deviceName: () => '測試 iPhone',
    wifiIp: async () => '192.168.1.5',
    throttleMs: 5,
    pollMs: 5,
    autoScan: false,
    onEvent: (e) => events.push(e),
  });
  await store.init();
  await store.pairHelper(H, '123456');
  return { net, pc, store, events };
}

describe('透過小幫手下載', () => {
  test('在電腦上下載、問到完成；這段對話還沒有模型就直接用它', async () => {
    const { pc, store, events } = await pairedHelper();
    await waitFor(() => expect(store.getState().helperInfo[H]?.hardware?.gpus[0].name).toBe('NVIDIA GeForce RTX 5070'));
    expect(store.getState().session?.model).toBeNull();
    await store.startDownload(H, 'gemma4:12b');
    await waitFor(() => expect(store.getState().downloads[H]?.[0].status).toBe('done'));
    expect(pc.helper!.jobs![0]).toMatchObject({ model: 'gemma4:12b', engine: 'ollama' });
    await waitFor(() => expect(store.getState().session?.model).toBe('gemma4:12b'));
    expect(events).toContain('downloaded');
  });

  test('只有 LM Studio：下載到 LM Studio；名稱打錯說找不到', async () => {
    const { pc, store } = await pairedHelper([], { downloadEngines: ['lmstudio'] });
    await waitFor(() => expect(store.getState().helperInfo[H]?.downloadEngines).toEqual(['lmstudio']));
    await store.startDownload(H, 'nope');
    await waitFor(() => expect(store.getState().downloads[H]?.[0]).toMatchObject({ status: 'failed', code: 'not_found' }));
    expect(pc.helper!.jobs![0].engine).toBe('lmstudio');
    await store.dismissDownload(H, 'j1');
    expect(store.getState().downloads[H]).toEqual([]);
    expect(pc.helper!.jobs).toEqual([]);
  });

  test('App 重開時還在下載：接著顯示進度', async () => {
    const { pc, store } = await pairedHelper([{ name: 'gemma4:e4b' }]);
    pc.helper!.jobs = [{ id: 'j9', model: 'gemma4:31b', engine: 'ollama', status: 'downloading', completed: 0, total: 1000, cancellable: true }];
    await store.loadModels(H);
    await waitFor(() => expect(store.getState().downloads[H]?.[0]).toMatchObject({ id: 'j9', status: 'done' }));
    expect(store.getState().models[H].list.map((m) => m.name)).toContain('gemma4:31b');
  });
});

describe('直接連 Ollama 下載', () => {
  async function plain() {
    const net = new FakeOllamaNet();
    net.addHost('http://192.168.1.20:11434', { models: [] });
    const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => null, autoScan: false, throttleMs: 5 });
    await store.init();
    await store.addHost('192.168.1.20');
    return { net, store, url: 'http://192.168.1.20:11434' };
  }

  test('手機自己叫 Ollama 下載：各層加起來算進度，完成就用它', async () => {
    const { store, url } = await plain();
    expect(store.getState().helperInfo[url]).toEqual({ downloadEngines: ['ollama'], hardware: null });
    await store.startDownload(url, 'qwen3:4b');
    await store.downloadTask;
    expect(store.getState().downloads[url][0]).toMatchObject({ status: 'done', completed: 1000, total: 1000 });
    expect(store.getState().session?.model).toBe('qwen3:4b');
  });

  test('名稱打錯：說找不到', async () => {
    const { store, url } = await plain();
    await store.startDownload(url, 'nope');
    await store.downloadTask;
    expect(store.getState().downloads[url][0]).toMatchObject({ status: 'failed', code: 'not_found' });
  });
});

describe('畫面', () => {
  afterEach(() => jest.restoreAllMocks());

  async function openModels(models: FakeModel[], helper: Record<string, unknown> = {}) {
    const ctx = await pairedHelper(models, helper);
    await render(<ChatScreen store={ctx.store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    await fireEvent.press(screen.getAllByRole('button', { name: /^選擇模型$|^模型：/ })[0]);
    return ctx;
  }

  test('依配備推薦、標出跑不跑得動；下載中顯示進度，好了可以直接開始用', async () => {
    const { store } = await openModels([]);
    await fireEvent.press(await screen.findByText('選一個模型下載'));
    expect(await screen.findByText('這台電腦：GeForce RTX 5070 12 GB · 記憶體 32 GB')).toBeTruthy();
    expect(screen.getAllByText('這台電腦跑得很順').length).toBeGreaterThan(0);
    expect(screen.getAllByText('跑得動，但回答比較慢').length).toBeGreaterThan(0);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => buttons?.[1]?.onPress?.());
    await fireEvent.press(screen.getByLabelText('下載 Gemma 4 · 12B'));
    expect(alert.mock.calls[0][0]).toBe('下載 Gemma 4 · 12B？');
    expect(alert.mock.calls[0][1]).toMatch(/關掉 App 也會繼續/);
    await fireEvent.press(await screen.findByLabelText('使用 Gemma 4 · 12B'));
    await waitFor(() => expect(store.getState().session?.model).toBe('gemma4:12b'));
  });

  test('太大的模型下載前先提醒', async () => {
    await openModels([]);
    await fireEvent.press(await screen.findByText('選一個模型下載'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await fireEvent.press(await screen.findByLabelText('下載 GPT-OSS · 20B'));
    expect(alert.mock.calls[0][1]).toMatch(/回答會比較慢/);
  });

  test('OpenAI 格式伺服器的模型：選項裡沒有預先載入；有好幾個引擎時標出是哪個', async () => {
    await openModels([
      { name: 'gemma4:12b', engine: 'ollama', engineName: 'Ollama' },
      { name: 'qwen.gguf', engine: 'detected:8080', engineName: 'llama.cpp', canLoad: false },
    ]);
    expect(await screen.findByText('llama.cpp')).toBeTruthy();
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    await fireEvent.press(screen.getByLabelText('Qwen.gguf 的選項'));
    expect(sheet.mock.calls[0][0].options).toEqual(['詳細資訊', '取消']);
    await fireEvent.press(screen.getByLabelText('Gemma 4 · 12B 的選項'));
    expect(sheet.mock.calls[1][0].options).toEqual(['詳細資訊', '預先載入（之後第一次回答比較快）', '取消']);
  });

  test('電腦上沒有能下載的引擎：說明要在電腦上下載', async () => {
    await openModels([], { downloadEngines: [] });
    expect(await screen.findByText(/請在電腦上的 AI 程式裡下載模型/)).toBeTruthy();
    expect(screen.queryByText('下載更多模型')).toBeNull();
  });

  test('電腦上沒有開著的 AI 引擎：說要去小幫手裝或打開 Ollama，不是說連不到', async () => {
    const { pc, store } = await pairedHelper([{ name: 'gemma4:12b' }]);
    pc.noEngine = true;
    await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    await fireEvent.press(screen.getAllByRole('button', { name: /^選擇模型$|^模型：/ })[0]);
    await store.loadModels(H);
    expect(await screen.findByText(/AI 引擎沒有開著.*安裝 Ollama/)).toBeTruthy();
    expect(screen.queryByText('連不到這台電腦。')).toBeNull();
    pc.noEngine = false;
    await fireEvent.press(screen.getByText('重試'));
    expect(await screen.findByLabelText(/模型 Gemma 4 · 12B/)).toBeTruthy();
  });

  test('用名稱下載打錯：馬上跳出說明，不會留在清單裡', async () => {
    const { store } = await openModels([]);
    await fireEvent.press(await screen.findByText('選一個模型下載'));
    jest.spyOn(Alert, 'prompt').mockImplementation((_t, _m, buttons: any) => buttons[1].onPress('nope'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await fireEvent.press(await screen.findByText('用名稱下載其他模型'));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][0]).toBe('沒辦法下載「nope」');
    expect(alert.mock.calls[0][1]).toBe('找不到這個模型，請確認名稱。');
    await waitFor(() => expect(store.getState().downloads[H]).toEqual([]));
  });
});

test('同一個模型失敗後重試：舊的失敗紀錄拿掉，不會一直疊上去', async () => {
  const { store } = await pairedHelper();
  await store.startDownload(H, 'nope');
  await waitFor(() => expect(store.getState().downloads[H]?.[0]?.status).toBe('failed'));
  await store.startDownload(H, 'nope');
  await waitFor(() => expect(store.getState().downloads[H]?.[0]?.status).toBe('failed'));
  expect(store.getState().downloads[H]).toHaveLength(1);
});
