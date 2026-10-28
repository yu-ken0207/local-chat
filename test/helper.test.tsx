import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { parsePairingPayload } from '../src/lib/helper';
import { ChatStore, NeedsPairingError, PairError, memorySecrets } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// Local AI 小幫手：掃 QR code 或輸入配對碼配對，權杖放安全儲存區，之後都透過小幫手

const H = 'http://192.168.1.30:11480';
const payload = (code: string, ips = ['10.0.0.99', '192.168.1.30'], id = 'h1') =>
  `localai://pair?v=1&id=${id}&name=${encodeURIComponent('書房電腦')}&port=11480&code=${code}&${ips.map((ip) => `ip=${ip}`).join('&')}`;

jest.setTimeout(30_000);

async function setup(options: { db?: ReturnType<typeof memoryDb>; secrets?: ReturnType<typeof memorySecrets>; net?: FakeOllamaNet } = {}) {
  const net = options.net ?? new FakeOllamaNet();
  const pc = net.hosts.get(H) ?? net.addHelper(H, { id: 'h1', name: '書房電腦', code: '123456' }, { models: [{ name: 'gemma4:12b', vision: true }] });
  const db = options.db ?? memoryDb();
  const secrets = options.secrets ?? memorySecrets();
  const store = new ChatStore({
    repo: new Repo(db),
    client: net.client,
    secrets,
    deviceName: () => '測試 iPhone',
    wifiIp: async () => '192.168.1.5',
    throttleMs: 5,
    autoScan: false,
  });
  await store.init();
  return { net, pc, db, secrets, store };
}

describe('QR code 內容', () => {
  test('解析小幫手的 QR code', () => {
    expect(parsePairingPayload(payload('012345'))).toEqual({ id: 'h1', name: '書房電腦', port: 11480, code: '012345', ips: ['10.0.0.99', '192.168.1.30'] });
  });

  test('不是小幫手的、少東西的都不接受', () => {
    for (const bad of ['https://example.com', 'localai://pair?id=h1&code=123456', payload('12345'), payload('123456', []), 'localai://pair?id=h1&code=123456&ip=1.2.3.4&port=99999']) {
      expect(parsePairingPayload(bad)).toBeNull();
    }
  });
});

describe('配對', () => {
  test('掃 QR code：試到連得到的位址就配對；權杖只放安全儲存區；自動選模型，聊天透過小幫手', async () => {
    const { pc, db, secrets, store } = await setup();
    expect(await store.pairFromQr(payload('123456'))).toBe(H);
    expect(store.getState().hosts).toMatchObject([{ url: H, label: '書房電腦', source: 'helper', helperId: 'h1' }]);
    expect(await secrets.get('helper-token.h1')).toBe('token-1');
    expect(JSON.stringify(await db.all('SELECT * FROM hosts'))).not.toContain('token-1');
    expect(pc.helper!.devices).toEqual(['測試 iPhone']);
    expect(store.getState().session).toMatchObject({ hostUrl: H, model: 'gemma4:12b' });

    await store.send('你好');
    expect(store.getState().messages.map((m) => m.content)).toEqual(['你好', '回答：你好']);
  });

  test('失敗時的白話說明：配對碼錯、電腦沒在配對、連不到、不是小幫手的 QR code', async () => {
    const { pc, store } = await setup();
    await expect(store.pairFromQr(payload('999999'))).rejects.toThrow(/配對碼不對/);
    pc.helper!.code = null;
    await expect(store.pairFromQr(payload('123456'))).rejects.toThrow(/配對已經結束/);
    await expect(store.pairFromQr(payload('123456', ['10.0.0.99']))).rejects.toThrow(/手機連不到「書房電腦」/);
    await expect(store.pairFromQr(payload('123456', ['192.168.1.30'], 'other'))).rejects.toThrow(/手機連不到/);
    await expect(store.pairFromQr('https://example.com')).rejects.toBeInstanceOf(PairError);
    expect(store.getState().hosts).toEqual([]);
  });

  test('自動尋找：沒配對過的小幫手列出來；輸入配對碼後連上', async () => {
    const { store } = await setup();
    await store.scanLan({ userInitiated: true });
    expect(store.getState().scan?.helpers).toEqual([{ url: H, id: 'h1', name: '書房電腦', pairing: true }]);
    expect(store.getState().hosts).toEqual([]);
    await store.pairHelper(H, '123 456');
    expect(store.getState().scan?.helpers).toEqual([]);
    expect(store.getState().session).toMatchObject({ hostUrl: H, model: 'gemma4:12b' });
  });

  test('小幫手換了位址：自動尋找認得是同一台，電腦和對話都改成新位址', async () => {
    const { net, pc, store } = await setup();
    await store.pairFromQr(payload('123456'));
    await store.send('記得我');
    const H2 = 'http://192.168.1.31:11480';
    net.hosts.delete(H);
    net.hosts.set(H2, pc);
    await store.scanLan({ userInitiated: true });
    expect(store.getState().hosts.map((h) => h.url)).toEqual([H2]);
    expect(store.getState().session?.hostUrl).toBe(H2);
    await store.send('還在嗎');
    expect(store.getState().messages.at(-1)?.content).toBe('回答：還在嗎');
  });

  test('手動輸入小幫手的位址：要輸入配對碼', async () => {
    const { store } = await setup();
    const err = await store.addHost('192.168.1.30').catch((e) => e);
    expect(err).toBeInstanceOf(NeedsPairingError);
    expect(err).toMatchObject({ url: H, name: '書房電腦' });
  });

  test('電腦上移除了這支手機：聊天時說要重新配對，並標成要重新配對', async () => {
    const { pc, store } = await setup();
    await store.pairFromQr(payload('123456'));
    pc.helper!.tokens = [];
    await store.send('hi');
    expect(store.getState().messages.at(-1)?.content).toMatch(/配對已經被移除/);
    expect(store.needsPairing(H)).toBe(true);
  });

  test('重開 App：權杖從安全儲存區讀回來，照樣能用', async () => {
    const first = await setup();
    await first.store.pairFromQr(payload('123456'));
    const again = await setup({ db: first.db, secrets: first.secrets, net: first.net });
    expect(again.store.needsPairing(H)).toBe(false);
    await again.store.send('又見面了');
    expect(again.store.getState().messages.at(-1)?.content).toBe('回答：又見面了');
  });

  test('移除電腦：確定後忘掉權杖；還能復原時權杖還在', async () => {
    const { secrets, store } = await setup();
    await store.pairFromQr(payload('123456'));
    await store.removeHost(H);
    expect(await secrets.get('helper-token.h1')).toBe('token-1');
    await store.dismissUndo();
    expect(await secrets.get('helper-token.h1')).toBeNull();
  });
});

describe('連接面板', () => {
  async function openConnect() {
    const ctx = await setup();
    await render(<ChatScreen store={ctx.store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    await fireEvent.press(screen.getByText('連接你的電腦'));
    return ctx;
  }

  afterEach(() => jest.restoreAllMocks());

  test('最顯眼的是「掃描 QR code」；掃到小幫手就配對，面板自動關上可以直接聊天', async () => {
    const { store } = await openConnect();
    await fireEvent.press(await screen.findByText('掃描 QR code'));
    await fireEvent(await screen.findByTestId('qr-camera'), 'barcodeScanned', { data: payload('123456') });
    await waitFor(() => expect(store.getState().session?.model).toBe('gemma4:12b'));
    await waitFor(() => expect(screen.queryByTestId('qr-camera')).toBeNull());
    expect(await screen.findByText(/直接在下面輸入問題/)).toBeTruthy();
  });

  test('掃到別的 QR code：留在掃描畫面，說明要掃哪一個', async () => {
    await openConnect();
    await fireEvent.press(await screen.findByText('掃描 QR code'));
    await fireEvent(await screen.findByTestId('qr-camera'), 'barcodeScanned', { data: 'https://example.com' });
    expect(await screen.findByText(/不是 Local AI 小幫手的 QR code/)).toBeTruthy();
    expect(screen.getByTestId('qr-camera')).toBeTruthy();
  });

  test('自動尋找到的小幫手：點一下輸入配對碼', async () => {
    const { store } = await openConnect();
    await fireEvent.press(screen.getByText('自動尋找'));
    jest.spyOn(Alert, 'prompt').mockImplementation((_t, _m, cb: any) => cb('123456'));
    await fireEvent.press(await screen.findByLabelText('小幫手 書房電腦，點一下輸入配對碼'));
    await waitFor(() => expect(store.getState().hosts.map((h) => h.source)).toEqual(['helper']));
  });

  test('配對碼打錯：說明原因，可以再試', async () => {
    const { store } = await openConnect();
    await fireEvent.press(screen.getByText('自動尋找'));
    jest.spyOn(Alert, 'prompt').mockImplementation((_t, _m, cb: any) => cb('000000'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await fireEvent.press(await screen.findByLabelText('小幫手 書房電腦，點一下輸入配對碼'));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][1]).toMatch(/配對碼不對/);
    expect(store.getState().hosts).toEqual([]);
  });
});
