import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { claimSwipe, drawerWidth, project, rubberband, shouldOpen } from '../src/components/SideDrawer';
import { ChatStore } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 對話清單是從左邊滑出的側邊欄：手指往右滑打開、往左滑或點旁邊關上

const A = 'http://192.168.1.20:11434';

jest.setTimeout(20_000);

describe('手勢判斷', () => {
  test('側邊欄寬度：螢幕的 84%，最寬 360', () => {
    expect(drawerWidth(390)).toBe(328);
    expect(drawerWidth(1024)).toBe(360);
  });

  test('關著時只認明確往右的水平滑動；上下捲動不算', () => {
    expect(claimSwipe(false, 20, 3, 10)).toBe(true);
    expect(claimSwipe(false, -20, 3, 10)).toBe(false);
    expect(claimSwipe(false, 8, 0, 10)).toBe(false); // 還沒超過 10 點，可能只是點一下
    expect(claimSwipe(false, 20, 18, 10)).toBe(false); // 斜的，比較像在捲動
    expect(claimSwipe(false, 20, 3, 120)).toBe(false); // 從畫面中間往右滑：留給程式碼、表格往回捲
    expect(claimSwipe(true, -20, 3, 300)).toBe(true);
    expect(claimSwipe(true, 20, 3, 300)).toBe(true); // 開著時往右拉也接住（有阻力）
  });

  test('放開時用速度推算落點：輕輕一撥也會打開，慢慢拉不到一半會彈回去', () => {
    expect(project(1000)).toBeCloseTo(499, 0);
    expect(shouldOpen(60, 0.6, 328)).toBe(true); // 才拉 60 點但手指很快
    expect(shouldOpen(120, 0, 328)).toBe(false); // 慢慢拉不到一半
    expect(shouldOpen(200, 0, 328)).toBe(true); // 慢慢拉過一半
    expect(shouldOpen(300, -0.5, 328)).toBe(false); // 往回撥就關上
  });

  test('拉過頭越拉越緊，不會超過上限', () => {
    expect(rubberband(0, 328)).toBe(0);
    expect(rubberband(100, 328)).toBeLessThan(100);
    expect(rubberband(10_000, 328)).toBeLessThan(328);
  });
});

/** 模擬一根手指水平滑動：每 16ms 移動一次 */
async function swipe(dx: number, { steps = 8, startX = 10, expectGranted = true } = {}) {
  const el = screen.getByTestId('side-drawer');
  const y = 400;
  let prevX = startX;
  let prevTs = 1000;
  const ev = (x: number, ts: number) => ({
    nativeEvent: { pageX: x, pageY: y, timestamp: ts },
    touchHistory: {
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: ts,
      touchBank: [
        { touchActive: true, startPageX: startX, startPageY: y, startTimeStamp: 1000, currentPageX: x, currentPageY: y, currentTimeStamp: ts, previousPageX: prevX, previousPageY: y, previousTimeStamp: prevTs },
      ],
    },
  });
  const moves = Array.from({ length: steps }, (_, i) => ({ x: startX + (dx * (i + 1)) / steps, ts: 1000 + 16 * (i + 1) }));
  await act(async () => {
    // 跟真的觸控一樣的順序：按下時先走 capture；每次移動 capture 先更新手勢，再問要不要接手，接手後才收到移動
    el.props.onStartShouldSetResponderCapture({ ...ev(startX, 1000), nativeEvent: { touches: [{}] } });
    let granted = false;
    for (const m of moves) {
      const e = ev(m.x, m.ts);
      if (granted) el.props.onResponderMove(e);
      else {
        el.props.onMoveShouldSetResponderCapture(e);
        if (el.props.onMoveShouldSetResponder(e)) {
          el.props.onResponderGrant(e);
          granted = true;
        }
      }
      prevX = m.x;
      prevTs = m.ts;
    }
    expect(granted).toBe(expectGranted);
    if (granted) el.props.onResponderRelease(ev(moves.at(-1)!.x, moves.at(-1)!.ts + 1));
  });
}

async function setup() {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: [{ name: 'gemma4:31b', vision: true }] });
  const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => null, throttleMs: 5, autoScan: false });
  await store.init();
  await store.addHost('192.168.1.20');
  await store.send('第一段');
  await store.titleTask;
  await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
  return { store };
}

test('往右滑打開對話清單，往左滑關上', async () => {
  await setup();
  expect(screen.queryByLabelText('搜尋對話')).toBeNull();
  await swipe(220);
  expect(await screen.findByLabelText('搜尋對話')).toBeTruthy();
  await swipe(-220, { startX: 300 });
  await waitFor(() => expect(screen.queryByLabelText('搜尋對話')).toBeNull());
});

test('從畫面中間往右滑不會拉出側邊欄（留給程式碼、表格往回捲）', async () => {
  await setup();
  await swipe(220, { startX: 150, expectGranted: false });
  expect(screen.queryByLabelText('搜尋對話')).toBeNull();
});

test('往右滑一點點就放開，會彈回去不打開', async () => {
  await setup();
  await swipe(30, { steps: 30 }); // 慢慢拉 30 點
  await waitFor(() => expect(screen.queryByLabelText('搜尋對話')).toBeNull());
});

test('側邊欄最下面的「設定」不放「›」（它是從下面升起的面板，不是新的一頁）', async () => {
  await setup();
  await fireEvent.press(screen.getByLabelText('對話清單'));
  expect(await screen.findByText('設定')).toBeTruthy();
  expect(screen.queryByTestId('symbol-chevron.right', { includeHiddenElements: true })).toBeNull();
});

test('點右邊變暗的地方關上；按「對話」也能打開', async () => {
  await setup();
  await fireEvent.press(screen.getByLabelText('對話清單'));
  expect(await screen.findByLabelText('搜尋對話')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('關閉對話清單'));
  await waitFor(() => expect(screen.queryByLabelText('搜尋對話')).toBeNull());
});

test('在清單裡開新對話或選一段對話後，清單自動關上', async () => {
  const { store } = await setup();
  await swipe(220);
  await fireEvent.press(await screen.findByLabelText('開始新對話'));
  await waitFor(() => expect(store.getState().messages).toEqual([]));
  await waitFor(() => expect(screen.queryByLabelText('搜尋對話')).toBeNull());
  await swipe(220);
  const rows = await screen.findAllByLabelText(/^對話 /);
  await fireEvent.press(rows.at(-1)!);
  await waitFor(() => expect(store.getState().messages).toHaveLength(2));
  await waitFor(() => expect(screen.queryByLabelText('搜尋對話')).toBeNull());
});

test('設定固定在清單最下面，打開是一個獨立面板，按「完成」回到清單', async () => {
  await setup();
  await swipe(220);
  await fireEvent.press(await screen.findByText('設定'));
  expect(await screen.findByLabelText('語言，跟著系統')).toBeTruthy();
  await fireEvent.press(screen.getByText('完成'));
  await waitFor(() => expect(screen.queryByLabelText('語言，跟著系統')).toBeNull());
  expect(screen.getByLabelText('搜尋對話')).toBeTruthy();
});
