import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { ActionSheetIOS, Alert } from 'react-native';

import { PromptStore, getEntry } from '../src/agents/catalog';
import { AgentsView } from '../src/components/AgentsSheet';
import { ChatScreen } from '../src/components/ChatScreen';
import { ChatStore } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 設定裡的「Agent」：我的 Agent、圖鑑、一句話建立、編輯、筆記、第三方授權

const A = 'http://192.168.1.20:11434';
jest.setTimeout(20_000);

const DRAFT = { name: '挑剔財務長', intro: '每筆錢都要問清楚', expertise: '預算', stance: '保守', style: '直接', blindSpot: '忽略長期價值', emoji: '💼', talk: 0.7 };

async function setup() {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: [{ name: 'gemma4:31b' }] });
  net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: JSON.stringify(DRAFT) }, done: false }, { message: { content: '' }, done: true }] });
  const repo = new Repo(memoryDb());
  const prompts = new PromptStore(async () => ({ 'agency:academic/academic-historian': { en: 'You are **Historian**.' } }));
  const store = new ChatStore({ repo, client: net.client, wifiIp: async () => null, throttleMs: 5, autoScan: false, prompts });
  await store.init();
  await store.addHost('192.168.1.20');
  await store.loadModels(A);
  await store.selectModel(A, 'gemma4:31b');
  return { net, repo, store };
}

afterEach(() => jest.restoreAllMocks());

test('設定裡有「Agent」，寫著有幾個；點了打開「我的 Agent」', async () => {
  const { store } = await setup();
  await store.send('嗨');
  await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
  await fireEvent.press(screen.getByLabelText('對話清單'));
  await fireEvent.press(await screen.findByText('設定'));
  await fireEvent.press(await screen.findByLabelText('Agent，0 個'));
  expect(await screen.findByText('建立新的 Agent')).toBeTruthy();
  expect(screen.getByText('還沒有 Agent。寫一句話讓 AI 幫你建一個，或到「圖鑑」挑現成的。')).toBeTruthy();
});

test('一句話建立：生成角色卡、可以改、儲存後出現在清單', async () => {
  const { store } = await setup();
  await render(<AgentsView store={store} onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('建立新的 Agent'));
  expect(screen.getByRole('button', { name: '儲存' }).props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.changeText(screen.getByLabelText('描述你想要的 Agent'), '愛挑毛病的財務長');
  await fireEvent.press(screen.getByText('生成'));
  expect(await screen.findByDisplayValue('挑剔財務長')).toBeTruthy();
  expect(screen.getByDisplayValue('忽略長期價值')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('名字'), '財務長');
  await fireEvent.press(screen.getByText('愛講'));
  await fireEvent.press(screen.getByText('儲存'));
  await waitFor(() => expect(store.getState().myAgents.map((a) => [a.name, a.talk, a.card?.blindSpot])).toEqual([['財務長', 0.8, '忽略長期價值']]));
  expect(await screen.findByText('財務長')).toBeTruthy();
});

test('圖鑑：搜尋、分類、直接加；加過的打勾；切回「我的 Agent」看得到', async () => {
  const { store } = await setup();
  await render(<AgentsView store={store} onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('圖鑑'));
  await fireEvent.changeText(screen.getByLabelText('搜尋圖鑑'), 'historian');
  const name = getEntry('agency:academic/academic-historian')!.n[0];
  expect(await screen.findByText(name)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(`加到我的 Agent：${name}`));
  expect(await screen.findByLabelText('已加入')).toBeTruthy();
  await fireEvent.press(screen.getByText('學術研究'));
  expect(screen.getByText(name)).toBeTruthy();
  await fireEvent.press(screen.getByText('程式與工程'));
  expect(screen.getByText('找不到符合的角色。')).toBeTruthy();
  await fireEvent.press(screen.getByText('我的 Agent'));
  expect(screen.getByText(name)).toBeTruthy();
});

test('圖鑑的角色：看介紹、角色原文，從這裡加入', async () => {
  const { store } = await setup();
  await render(<AgentsView store={store} onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('圖鑑'));
  await fireEvent.changeText(screen.getByLabelText('搜尋圖鑑'), 'historian');
  const e = getEntry('agency:academic/academic-historian')!;
  await fireEvent.press(await screen.findByLabelText(`${e.n[0]}，${e.d[0]}`));
  expect(await screen.findByText('作者：msitarzewski/agency-agents')).toBeTruthy();
  await fireEvent.press(screen.getByText('顯示角色原文'));
  expect(await screen.findByText('You are **Historian**.')).toBeTruthy();
  await fireEvent.press(screen.getByText('加到我的 Agent'));
  expect(await screen.findByText('已在我的 Agent')).toBeTruthy();
  expect(store.getState().myAgents.map((a) => a.catalogId)).toEqual([e.id]);
});

test('編輯：改積極度、可以自己加入、指定模型；筆記可以刪；刪掉 Agent 可以復原', async () => {
  const { repo, store } = await setup();
  const a = await store.saveAgent({ name: '財務長', intro: '看預算', card: { expertise: '', stance: '', style: '', blindSpot: '' } });
  await repo.addNote(a.id, null, '上次主張先修再換');
  await render(<AgentsView store={store} onClose={jest.fn()} />);
  await fireEvent.press(await screen.findByLabelText('財務長，看預算'));
  expect(await screen.findByText('上次主張先修再換')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('刪除這則筆記'));
  expect(await screen.findByText('還沒有筆記。討論收尾後他會寫下這次的立場。')).toBeTruthy();
  await fireEvent.press(screen.getByText('安靜'));
  await fireEvent(screen.getByLabelText('可以自己加入'), 'valueChange', true);
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((o, cb) => cb(o.options.findIndex((x: string) => x.startsWith('gemma4:31b'))));
  await fireEvent.press(screen.getByLabelText('模型，跟著對話'));
  await fireEvent.press(screen.getByText('儲存'));
  await waitFor(() => expect(store.getState().myAgents[0]).toMatchObject({ talk: 0.2, autoJoin: true, hostUrl: A, model: 'gemma4:31b' }));
  await fireEvent.press(await screen.findByLabelText('財務長，看預算'));
  await fireEvent.press(await screen.findByText('刪除這個 Agent'));
  await waitFor(() => expect(store.getState().myAgents).toEqual([]));
  await fireEvent.press(await screen.findByText('復原'));
  await waitFor(() => expect(store.getState().myAgents.map((x) => x.name)).toEqual(['財務長']));
});

test('清除全部筆記要先確認', async () => {
  const { repo, store } = await setup();
  const a = await store.saveAgent({ name: '財務長' });
  await repo.addNote(a.id, null, '一');
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => buttons?.find((b) => b.style === 'destructive')?.onPress?.());
  await render(<AgentsView store={store} onClose={jest.fn()} />);
  await fireEvent.press(await screen.findByLabelText('財務長，'));
  await fireEvent.press(await screen.findByText('清除全部筆記'));
  expect(alert).toHaveBeenCalledWith('清除全部筆記？', '他會忘記之前討論的立場。', expect.any(Array));
  await waitFor(async () => expect(await store.listNotes(a.id)).toEqual([]));
});

test('第三方授權：兩份 MIT 全文', async () => {
  const { store } = await setup();
  await render(<AgentsView store={store} onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('第三方授權'));
  const sheet = await screen.findByText('lobehub/lobe-chat-agents');
  expect(sheet).toBeTruthy();
  expect(screen.getByText('msitarzewski/agency-agents')).toBeTruthy();
  expect(screen.getAllByText(/MIT License/).length).toBeGreaterThanOrEqual(2);
  expect(within(screen.getByText('圖鑑裡的角色來自下面兩個開放原始碼專案（MIT 授權）。').parent!)).toBeTruthy();
});
