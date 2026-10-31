import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, Alert, Animated, Image, Keyboard, Modal, PanResponder, Pressable, ScrollView, Share, StyleSheet, Text, View, findNodeHandle, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { KeyboardChatScrollView, KeyboardGestureArea, KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { captureScreen, releaseCapture } from 'react-native-view-shot';

import { fmtElapsed, fmtTokPerSec } from '../lib/format';
import { friendlyModelName } from '../lib/modelName';
import type { NewPhoto } from '../lib/photos';
import type { ChatStore } from '../state/chatStore';
import { useChatState } from '../state/useChat';
import type { Db } from '../store/db';
import { isRecordNote, isThreadRoot, type Attachment, type Message } from '../store/repo';
import { APP_NAME } from '../ui/brand';
import { C, TEXT } from '../ui/theme';
import { COMPOSER_INPUT_ID, Composer, chooseOption, type PickSource } from './Composer';
import { ConnectSheet } from './ConnectSheet';
import { ImageViewer } from './ImageViewer';
import { ActionListCard, ActionView, RevealContext, type CardField } from './ActionCard';
import { CONCLUSION, parseConclusion } from '../agents/discussion';
import { BubbleView, ConclusionCard, DiscussionStatus, MembersBar, MembersSheet, MentionPicker, PinnedConclusion, conclusionText, replyTargets } from './GroupChat';
import { MessageView, ThreadDivider, ThreadLink, metaLine } from './Messages';
import { ModelSheet } from './ModelSheet';
import { SessionList, SettingsPages, deleteSession } from './SessionSheets';
import { SideDrawer, project, rubberband } from './SideDrawer';
import { Toast, type ToastData } from './Toast';
import { UndoToast } from './UndoToast';
import { t } from '../i18n';

export type ChatScreenProps = {
  store: ChatStore;
  pickPhotos: (source: PickSource, limit: number) => Promise<NewPhoto[] | 'denied'>;
  copyText: (text: string) => void;
  /** 選一個備份檔並載入（設定 > 從備份還原） */
  pickBackup?: () => Promise<Db | null>;
};

export function ChatScreen(p: ChatScreenProps) {
  const { store } = p;
  const state = useChatState(store);
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  // 捲到上面看舊訊息時，右下角給「捲到最新」
  // 連接面板關好之後要做的事（例如接著打開選模型）；iOS 沒回報關好時 1.5 秒後也繼續
  const afterConnect = useRef<(() => void) | null>(null);
  const connectClosed = () => {
    const next = afterConnect.current;
    afterConnect.current = null;
    next?.();
  };
  const messageCount = useRef(0);
  // 「跟著最新」：在最底附近時內容變長就跟著捲。只看使用者自己捲到哪（剛送出、按了捲到最新、換對話時也算），
  // 自己捲上去看舊訊息就不跟，右下角給「捲到最新」；程式自己跟著捲時不會冒出按鈕
  const nearBottom = useRef(true);
  const [following, setFollowing] = useState(true);
  const follow = (on: boolean) => {
    nearBottom.current = on;
    setFollowing(on);
  };
  const userScrolling = useRef(false);
  // 目前捲到哪（卡片輸入框要往上捲多少時用）
  const scrollY = useRef(0);
  const updateNearBottom = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, contentInset, layoutMeasurement } = e.nativeEvent;
    scrollY.current = contentOffset.y;
    // 鍵盤開著時，鍵盤那段留白放在 contentInset.bottom（不算在 contentSize 裡），要一起算
    follow(contentSize.height + (contentInset?.bottom ?? 0) - contentOffset.y - layoutMeasurement.height < 120);
  };
  // 回答剛結束（或還沒出字就失敗）：「回答中」換成按鈕列或錯誤說明，內容變高也要跟著捲。
  // 這時訊息數沒變、也不在串流中，下面 onContentSizeChange 的判斷抓不到；只算收尾後 1 秒內，
  // 不然之後自己點開「思考過程」也會被拉走
  const answerEnded = useRef(false);
  // 多 AI 討論：最後一輪舉手時沒有串流，但還沒講完；講完時「複製」「重新產生」才冒出來，也要跟著捲
  const streamingNow = !!state.streaming || (!!state.session && state.session.id in state.running);
  useLayoutEffect(() => {
    answerEnded.current = !streamingNow;
    if (streamingNow) return;
    const timer = setTimeout(() => (answerEnded.current = false), 1000);
    return () => clearTimeout(timer);
  }, [streamingNow]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [connect, setConnect] = useState<{ help: boolean } | null>(null);
  const [editing, setEditing] = useState<{ id: string; later: number } | null>(null);
  const [injected, setInjected] = useState<{ text: string; photos?: NewPhoto[]; nonce: number } | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  // 多 AI 討論：成員面板、輸入框裡正在打的字（打 @ 時跳出名單）、每則訊息的位置（點「回覆 某某」跳過去）
  const [membersOpen, setMembersOpen] = useState(false);
  // 打的字放在 ref（每打一個字不重畫整個畫面）；只有 @ 後面的字變了才更新名單
  const draftRef = useRef('');
  const mentionRef = useRef<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const setMention = useCallback((q: string | null) => {
    // 先比對再 setState：一樣的值 React 有時還是會多跑一次這個元件
    if (q === mentionRef.current) return;
    mentionRef.current = q;
    setMentionQuery(q);
  }, []);
  const onDraftChange = useCallback(
    (text: string) => {
      draftRef.current = text;
      setMention(/(?:^|\s)@([^\s@]*)$/.exec(text)?.[1] ?? null);
    },
    [setMention]
  );
  const messageY = useRef(new Map<string, number>());
  const group = state.members.length > 0;
  // 用氣泡畫：有成員，或有 Agent 說過話、有結論卡（成員清空了、剛切過來成員還沒讀到時，不會印出結論卡原文）
  const bubbles = group || state.messages.some((m) => !!m.agentId || m.detail === CONCLUSION);
  const discussing = !!state.session && state.session.id in state.running && group;
  // 「我的 Agent」：@ 名單（一般聊天也可以 @ 拉人進來）、成員面板要用
  useEffect(() => {
    void store.loadMyAgents();
  }, [store, membersOpen, state.session?.id]);

  function showToast(text: string, action?: ToastData['action']) {
    setToast({ id: Date.now(), text, action });
  }

  /** 複製並在畫面上提示「已複製」 */
  function copy(text: string) {
    p.copyText(text);
    showToast(t('已複製'));
  }

  /** 回答的詳細資訊：原始模型名稱、電腦、速度、時間（進階資訊，平常不顯示） */
  function showDetails(m: Message) {
    const lines = [
      m.model ? t('模型：{p0}（{p1}）', { p0: friendlyModelName(m.model), p1: m.model }) : '',
      m.hostLabel ? t('電腦：{p0}', { p0: m.hostLabel }) : '',
      m.stats ? t('速度：每秒約 {p0} 個字詞（tok/s）', { p0: fmtTokPerSec(m.stats.evalCount, m.stats.evalDurationNs).replace(' tok/s', '') }) : '',
      m.stats?.totalDurationNs ? t('花費時間：{p0}', { p0: fmtElapsed(m.stats.totalDurationNs / 1e9) }) : '',
      m.stats ? t('用掉的上下文：{p0} tokens', { p0: m.stats.promptEvalCount + m.stats.evalCount }) : '',
    ].filter(Boolean);
    Alert.alert(t('詳細資訊'), lines.join('\n'));
  }

  // 換對話時結束編輯
  useEffect(() => {
    setEditing(null);
  }, [state.session?.id]);

  /** 重新產生：舊回答會留著當版本，後面的訊息可以復原，所以不用先確認 */
  function confirmLater(_m: Message, action: () => Promise<void>) {
    void action();
  }

  function startEdit(m: Message) {
    setEditing({ id: m.id, later: store.laterCount(m.id) });
    setInjected({ text: m.content, photos: m.attachments.map(({ base64, width, height }) => ({ base64, width, height })), nonce: Date.now() });
  }

  function cancelEdit() {
    setEditing(null);
    setInjected({ text: '', photos: [], nonce: Date.now() });
  }

  /** 刪除訊息：直接刪，畫面下方可以復原 */
  function confirmDeleteMessage(m: Message) {
    void store.deleteMessage(m.id);
  }

  /** 這則訊息屬於哪一題（使用者那則的 id）：討論串用它當 key */
  function threadQuestionId(m: Message): string {
    if (m.role === 'user') return m.id;
    const i = state.messages.findIndex((x) => x.id === m.id);
    return state.messages.slice(0, i).filter((x) => x.role === 'user').at(-1)?.id ?? '';
  }

  /** 長按訊息的選單：真的要開才輕震一下（跟 iPhone 長按一樣的手感）；AI 回答中先不開，說一聲 */
  function messageMenu(m: Message, pageY?: number) {
    if (state.streaming || discussing) {
      const busy = discussing ? t('大家正在討論，按「暫停」後再試一次。') : t('AI 正在回答，答完再試一次。');
      // 「復原」提示還在時一般提示排不上（會等它消失才跳，那時可能已經答完了）：改成輕震＋讀螢幕播報
      if (state.undo) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        AccessibilityInfo.announceForAccessibility(busy);
      } else showToast(busy);
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // 選單項目：[字, 要做的事]；最後一項是刪除（紅字）
    const menu = (title: string, items: [string, () => void][], destructive = true) =>
      chooseOption(title, items.map(([text]) => text), (i) => items[i][1](), destructive ? items.length - 1 : undefined);
    // 討論串帶進來的那一題：只是背景，只能複製
    if (isThreadRoot(m)) {
      menu(m.role === 'user' ? t('你的訊息') : t('AI 的回答'), [[t('複製'), () => copy(m.content)]], false);
      return;
    }
    // 討論串（只有一層：討論串裡不能再開）
    const thread: [string, () => void][] = session?.parentId ? [] : [[state.threads[threadQuestionId(m)]?.count ? t('打開討論串') : t('開討論串'), () => void openThread(m.id, pageY, true)]];
    if (m.role === 'user') {
      menu(t('你的訊息'), [[t('複製'), () => copy(m.content)], [t('編輯並重送'), () => startEdit(m)], ...thread, [t('刪除'), () => confirmDeleteMessage(m)]]);
    } else if (m.role === 'assistant' && m.agentId) {
      // 多 AI 討論裡某個 Agent 說的
      const name = state.agents[m.agentId]?.name ?? 'AI';
      menu(name, [
        [t('複製'), () => copy(m.content)],
        [t('分享'), () => void Share.share({ message: m.content })],
        [t('請他展開講'), () => void store.expandMessage(m.id)],
        [t('重新產生'), () => confirmLater(m, () => store.regenerate(m.id))],
        [t('詳細資訊'), () => showDetails(m)],
        [t('刪除'), () => confirmDeleteMessage(m)],
      ]);
    } else if (m.role === 'assistant') {
      const hostUrl = state.session?.hostUrl;
      const others = hostUrl ? (state.models[hostUrl]?.list ?? []).map((x) => x.name) : [];
      menu(t('AI 的回答'), [
        [t('複製'), () => copy(m.content)],
        [t('分享'), () => void Share.share({ message: m.content })],
        ...thread,
        [t('重新產生'), () => confirmLater(m, () => store.regenerate(m.id))],
        [
          t('換個模型重新產生'),
          () =>
            hostUrl && others.length > 0
              ? chooseOption(t('用哪個模型重新產生'), others.map(friendlyModelName), (j) => confirmLater(m, () => store.regenerate(m.id, { hostUrl, model: others[j] })))
              : Alert.alert(t('沒有其他模型'), t('這台電腦上只有一個模型。')),
        ],
        [t('詳細資訊'), () => showDetails(m)],
        [t('刪除'), () => confirmDeleteMessage(m)],
      ]);
    } else {
      chooseOption(m.role === 'error' ? t('錯誤訊息') : t('提示'), [t('複製'), t('刪除')], (i) => [() => copy(m.content), () => void store.deleteMessage(m.id)][i](), 1);
    }
  }
  const [viewer, setViewer] = useState<{ images: Attachment[]; index: number } | null>(null);
  // 輸入列底部固定留給 Home 鍵橫條的空間；鍵盤打開時（橫條被鍵盤蓋住）用 keyboardOffset 把多的扣回來，
  // 只剩 8pt。用位移不用改留白，跟著鍵盤一格一格動，收鍵盤時不會跳
  // 討論串的卡片：底邊停在 Home 鍵橫條上方，輸入列在卡片裡只留 8pt；鍵盤打開時輸入列要往上推到鍵盤上緣
  const cardBottom = Math.max(insets.bottom, 12);
  const cardMode = !!state.session?.parentId;
  const bottomInset = cardMode ? 8 : Math.max(insets.bottom, 8);
  const keyboardOffset = cardMode ? cardBottom : bottomInset - 8;
  // 輸入列（含上面的提示）在鍵盤上方露出的高度：往下拖收鍵盤時，手指一碰到輸入列上緣鍵盤就開始跟（像 iMessage），
  // 不用先越過整個輸入列
  const [stickyHeight, setStickyHeight] = useState(0);
  const gestureOffset = Math.max(0, stickyHeight - keyboardOffset);

  // 卡片裡的輸入框（修改欄位、說要改成怎樣、自己輸入答案）打字時要看得到：不在最底時鍵盤不會把對話往上推
  // （keyboardLiftBehavior whenAtEnd），欄位會被鍵盤和輸入列擋住。鍵盤出來後量一下，擋住多少就往上捲多少
  const composerAboveKeyboard = useRef(0);
  composerAboveKeyboard.current = gestureOffset;
  // 正在卡片欄位打字：「捲到最新」先不出現（捲上去露出欄位後會算成離開最底，按鈕會蓋在欄位上）
  const [cardTyping, setCardTyping] = useState(false);
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidHide', () => setCardTyping(false));
    return () => sub.remove();
  }, []);
  const revealField = useCallback((field: CardField) => {
    setCardTyping(true);
    let done = false;
    const reveal = () => {
      if (done) return;
      done = true;
      subs.forEach((s) => s.remove());
      clearTimeout(fallback);
      field.measureInWindow((_x, y, _w, h) => {
        const kb = Keyboard.metrics();
        if (!kb) return;
        const by = coveredBy(y + h, kb.screenY, composerAboveKeyboard.current);
        if (by > 0) scrollRef.current?.scrollTo({ y: scrollY.current + by, animated: true });
      });
    };
    // 等這次鍵盤的位置定了再量：剛叫出鍵盤要等它出來、套件把內容推好；從輸入列換過來時，
    // 輸入列掛在鍵盤上的那段會拿掉（鍵盤位置變了），用舊的位置量會多捲一個輸入列高
    const subs = [
      Keyboard.addListener('keyboardDidShow', () => setTimeout(reveal, 50)),
      Keyboard.addListener('keyboardDidChangeFrame', () => setTimeout(reveal, 50)),
    ];
    // 鍵盤本來就開著、位置也沒變（不會有事件）：等一下就量
    const fallback = setTimeout(reveal, Keyboard.isVisible() ? 350 : 2000);
  }, []);

  // 換對話時捲到最下面；從討論串回到原對話時回到剛才看的位置
  const savedScroll = useRef<{ sessionId: string; y: number; following: boolean } | null>(null);
  // 討論串卡片：從哪裡長出來／縮回哪裡（手指按的位置）、後面墊的原對話截圖、動畫的值
  const threadAnchor = useRef<number | null>(null);
  const [threadShot, setThreadShot] = useState<string | null>(null);
  const threadAnim = useRef(new Animated.Value(0)).current;
  const threadBlur = useRef(new Animated.Value(0)).current;
  const threadDrag = useRef(new Animated.Value(0)).current;
  const threadClosing = useRef(false);
  // 卡片還在長出來：點背景先不關（連點入口兩下時第二下會點到背景）
  const threadSettled = useRef(false);
  // 正在開討論串（拍截圖、建討論串那幾十毫秒）：再點入口不理
  const threadOpening = useRef(false);
  // 往下拉放手、卡片正在滑走：這時再抓住可以接回來
  const threadSliding = useRef(false);
  // 讀螢幕：卡片打開後焦點移到標題；關上後回到原本那個「討論串」入口
  const threadTitleRef = useRef<ComponentRef<typeof Pressable>>(null);
  const threadLinkRefs = useRef(new Map<string, ComponentRef<typeof Pressable> | null>());
  const returnFocus = useRef<string | null>(null);
  /** 換掉卡片後面墊的截圖：舊的暫存檔順便刪掉 */
  const shotRef = useRef<string | null>(null);
  const swapShot = (uri: string | null) => {
    if (shotRef.current && shotRef.current !== uri) {
      try {
        releaseCapture(shotRef.current);
      } catch {
        // 刪不掉就算了（系統之後會清）
      }
    }
    shotRef.current = uri;
    setThreadShot(uri);
  };
  const screenHRef = useRef(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [reduceTransparency, setReduceTransparency] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotion)
      .catch(() => {});
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then(setReduceTransparency)
      .catch(() => {});
    const a = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    const b = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduceTransparency);
    return () => {
      a.remove();
      b.remove();
    };
  }, []);
  // 進到討論串：卡片長出來、後面慢慢模糊；回到原對話後歸零
  useEffect(() => {
    threadClosing.current = false;
    threadSliding.current = false;
    threadSettled.current = false;
    // 輸入框換位置重建、草稿是空的：@ 名單也收起來
    draftRef.current = '';
    setMention(null);
    if (!cardMode) {
      threadAnim.setValue(0);
      threadBlur.setValue(0);
      threadDrag.setValue(0);
      swapShot(null);
      return;
    }
    const open = (v: Animated.Value) =>
      reduceMotion ? Animated.timing(v, { toValue: 1, duration: 200, useNativeDriver: true }) : Animated.spring(v, { toValue: 1, ...CARD_SPRING });
    Animated.parallel([open(threadAnim), open(threadBlur)]).start(() => {
      threadSettled.current = true;
      const node = findNodeHandle(threadTitleRef.current);
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    });
  }, [cardMode]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 回到原對話：卡片縮回那則訊息（slideDown：往下拉放手時順著手指往下滑走），模糊退掉後才真的換回去 */
  function closeThread(slideDown = false, velocity = 0) {
    if (threadClosing.current) return;
    threadClosing.current = true;
    Keyboard.dismiss();
    // 中途被接住（滑走時又抓住卡片）：不離開，等手指放開再決定
    const leave = ({ finished }: { finished: boolean }) => {
      threadSliding.current = false;
      if (finished) void store.leaveThread();
      else threadClosing.current = false;
    };
    if (reduceMotion) {
      const out = (v: Animated.Value) => Animated.timing(v, { toValue: 0, duration: 180, useNativeDriver: true });
      Animated.parallel([out(threadAnim), out(threadBlur)]).start(leave);
    } else if (slideDown) {
      threadSliding.current = true;
      Animated.parallel([
        Animated.spring(threadDrag, { toValue: screenHRef.current, velocity, ...CARD_SPRING, restDisplacementThreshold: 1, restSpeedThreshold: 1 }),
        Animated.spring(threadBlur, { toValue: 0, ...CARD_SPRING }),
      ]).start(leave);
    } else {
      Animated.parallel([Animated.spring(threadAnim, { toValue: 0, ...CARD_SPRING }), Animated.spring(threadBlur, { toValue: 0, ...CARD_SPRING })]).start(leave);
    }
  }
  const closeRef = useRef(closeThread);
  closeRef.current = closeThread;
  // 抓著卡片上方往下拉：1:1 跟手指，往上拉有阻力；放手時看推算的落點，夠遠就關掉（接著手指的速度），不然彈回去。
  // 彈回去或滑走到一半再抓住：從現在的位置接手（不會跳回去）
  const grabbedAt = useRef(0);
  const threadPan = useMemo(
    () => {
      const back = (velocity = 0) => {
        Animated.spring(threadDrag, { toValue: 0, velocity, ...CARD_SPRING }).start();
        Animated.spring(threadBlur, { toValue: 1, ...CARD_SPRING }).start();
      };
      return PanResponder.create({
        // 縮回去的關法（點 ✕、點背景）進行中不能抓
        onMoveShouldSetPanResponder: (_e, g) => (!threadClosing.current || threadSliding.current) && Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderGrant: () => threadDrag.stopAnimation((v) => (grabbedAt.current = v)),
        onPanResponderMove: (_e, g) => {
          const y = grabbedAt.current + g.dy;
          threadDrag.setValue(y > 0 ? y : rubberband(y, 200));
        },
        onPanResponderRelease: (_e, g) => {
          const y = grabbedAt.current + g.dy;
          if (y + project(g.vy * 1000) > 160) closeRef.current(true, g.vy * 1000);
          else back(g.vy * 1000);
        },
        onPanResponderTerminate: () => back(),
      });
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    const saved = savedScroll.current;
    if (saved && saved.sessionId === state.session?.id) {
      savedScroll.current = null;
      follow(saved.following);
      requestAnimationFrame(() => (saved.following ? scrollRef.current?.scrollToEnd({ animated: false }) : scrollRef.current?.scrollTo({ y: saved.y, animated: false })));
      // 讀螢幕：焦點回到剛才點的那個「討論串」入口
      const back = returnFocus.current;
      returnFocus.current = null;
      if (back) {
        setTimeout(() => {
          const node = findNodeHandle(threadLinkRefs.current.get(back) ?? null);
          if (node) AccessibilityInfo.setAccessibilityFocus(node);
        }, 300);
      }
      return;
    }
    follow(true);
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
  }, [state.session?.id]);

  /**
   * 開某一題的討論串（開過就回到那一個）：先記住現在看到哪、手指按在哪（卡片從那裡長出來），
   * 再拍下現在的原對話墊在卡片後面（蓋上模糊）。fromMenu：剛從長按選單選的，等選單收好再拍
   */
  async function openThread(messageId: string, pageY?: number, fromMenu = false) {
    if (!state.session || threadOpening.current || cardMode) return;
    threadOpening.current = true;
    try {
      const keyboardOpen = Keyboard.isVisible();
      Keyboard.dismiss();
      const m = state.messages.find((x) => x.id === messageId);
      returnFocus.current = m ? threadQuestionId(m) : messageId;
      savedScroll.current = { sessionId: state.session.id, y: scrollY.current, following: nearBottom.current };
      threadAnchor.current = pageY ?? null;
      if (fromMenu || keyboardOpen) await new Promise((r) => setTimeout(r, keyboardOpen ? 400 : 250));
      swapShot(await captureScreen({ format: 'jpg', quality: 0.9, result: 'tmpfile' }).catch(() => null));
      // 還沒開過、這段又還在回答或討論：先不開（開過的照樣打開）
      if (!(await store.openThread(messageId))) {
        savedScroll.current = null;
        returnFocus.current = null;
        swapShot(null);
        showToast(discussing ? t('大家正在討論，按「暫停」後再試一次。') : t('AI 正在回答，答完再試一次。'));
      }
    } finally {
      threadOpening.current = false;
    }
  }

  // 空白畫面要講的那台電腦：這段對話用的；還沒綁電腦時（例如剛配對、電腦上沒有模型）看最近加入的那台
  const statusHost = state.session?.hostUrl ?? state.hosts[state.hosts.length - 1]?.url;

  // 回答下方的「模型，電腦」：只在換了模型或電腦時顯示（使用者決定，10/30）
  const metaShown = new Set<string>();
  let lastMeta = '';
  for (const m of state.messages) {
    if (m.role !== 'assistant' || !m.content.trim()) continue;
    const meta = metaLine(m);
    if (meta !== lastMeta) metaShown.add(m.id);
    lastMeta = meta;
  }

  // 「你按了復原」那種紀錄行不算最後一則：上面 AI 的回答照樣有複製、重新產生
  const lastIndex = state.messages.findLastIndex((m) => !isRecordNote(m) && !isThreadRoot(m));
  // 討論串的入口：放在那一題那一輪的最後一則後面（下一則是另一題、或已經是最後）
  const threadAfter = new Map<number, { questionId: string; count: number; running: boolean; fresh: boolean }>();
  if (!state.session?.parentId) {
    let question = '';
    state.messages.forEach((m, i) => {
      if (m.role === 'user') question = m.id;
      const next = state.messages[i + 1];
      const thread = question ? state.threads[question] : undefined;
      if (thread && thread.count > 0 && (!next || next.role === 'user'))
        threadAfter.set(i, { questionId: question, count: thread.count, running: thread.id in state.running, fresh: state.fresh.includes(thread.id) });
    });
  }

  const session = state.session;
  const model = store.currentModel();
  const anySheetOpen = sheetOpen || listOpen || appSettingsOpen || !!connect || membersOpen;
  // 多 AI 討論：「回覆 某某」（回的不是上一則才顯示）、打 @ 時的名單、要不要給「繼續討論」
  const replies = bubbles ? replyTargets(state.messages, state.agents, t('你')) : null;
  // 一般聊天也有 @ 名單（只列「我的 Agent」）：選了送出就把他拉進來
  const mention = group || state.myAgents.length > 0 ? mentionQuery : null;
  // 討論串帶進來的背景不算（剛開還沒問就不顯示「繼續討論」）；最後一則是結論卡就已經收尾了
  const lastSpoken = state.messages.findLast((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim() && !isThreadRoot(m));
  // 最後一則是錯誤：下面已經有「重試」，不再多一列
  const lastShown = state.messages.findLast((m) => !isRecordNote(m));
  const concluded = lastShown?.detail === CONCLUSION || lastShown?.role === 'error';
  const canContinue = group && !discussing && state.members.length > 1 && lastSpoken?.role === 'assistant' && !concluded;
  const topic = state.messages.find((m) => m.role === 'user')?.content ?? draftRef.current;
  const pinnedMessage = session?.pinnedId ? state.messages.find((m) => m.id === session.pinnedId) : undefined;
  const pinnedCard = pinnedMessage ? parseConclusion(pinnedMessage.content) : null;
  const jumpTo = (id: string) => {
    const y = messageY.current.get(id);
    if (y === undefined) return;
    follow(false);
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 80), animated: true });
  };
  // 模型在前、電腦在後：放不下時截掉的是電腦名，不會截掉 31B／12B 這種最重要的差別
  // 只有一台電腦時不寫電腦名（不會搞混，省下空間給模型名）
  const modelLabel =
    session?.hostUrl && session.model
      ? state.hosts.length > 1
        ? t('{p0}，{p1}', { p0: friendlyModelName(session.model), p1: store.hostLabel(session.hostUrl) })
        : friendlyModelName(session.model)
      : null;
  const failed = (title: string) => (e: unknown) => Alert.alert(title, e instanceof Error ? e.message : String(e));
  /** AI 訊息下面的確認卡與做了什麼；同一則回答有兩件以上要確認時合成清單卡 */
  const actionsOf = (m: Message) => {
    const actions = m.actions ?? [];
    if (actions.length === 0) return undefined;
    // 選擇題、找 Agent 的勾選卡各自一張，不合進清單卡
    const listed = actions.filter((a) => a.status === 'pending' && !store.toolFor(a.tool)?.kind);
    const grouped = listed.length >= 2;
    return (
      <>
        {actions
          .filter((a) => !(grouped && listed.includes(a)))
          .map((a) => (
            <ActionView
              key={a.id}
              action={a}
              tool={store.toolFor(a.tool)}
              onApprove={(id, edited) => store.approveAction(id, edited).catch(failed(t('沒有做成')))}
              onDecline={(id, reason) => store.declineAction(id, reason)}
              onUndo={(id) => store.undoAction(id).catch(failed(t('沒辦法復原')))}
              agents={{
                approve: (id, keys) => store.approveAgents(id, keys).catch(failed(t('沒有加進來'))),
                more: (id) => store.moreAgents(id).catch(failed(t('沒有找到人'))),
                finding: state.findingAgents,
              }}
            />
          ))}
        {grouped ? (
          <ActionListCard
            key={listed.map((a) => a.id).join(',')}
            actions={listed}
            toolFor={(name) => store.toolFor(name)}
            progress={state.acting?.messageId === m.id ? state.acting : null}
            onApproveAll={(items, skip) => store.approveActions(items, skip).catch(failed(t('沒有做成')))}
            onDeclineAll={(ids, reason) => store.declineActions(ids, reason)}
          />
        ) : null}
      </>
    );
  };
  // 還沒取好標題：跟對話清單一樣先用第一句話（不寫「對話」，免得跟左上角的按鈕同一個字）
  const inThread = !!session?.parentId;
  const title = inThread ? t('討論串') : session?.title || state.messages.find((m) => m.role === 'user')?.content.trim() || t('新對話');
  const hasChat = !!session && state.messages.length > 0;

  /** 點標題：改名或刪除這段對話（跟對話清單的 ⋯ 一樣）；在討論串裡只能刪掉這個討論串 */
  function sessionMenu() {
    // 回答中也能改名、刪除（刪除本來就會先停掉回答）；以前回答中點標題沒反應
    if (!session) return;
    // 討論串有自己的成員（跟原對話分開）：在這裡邀請 Agent
    if (inThread) {
      chooseOption(title, [t('成員與討論設定'), t('刪除這個討論串')], (i) => (i === 0 ? setMembersOpen(true) : void store.deleteSession(session.id)), 1);
      return;
    }
    chooseOption(title, [t('重新命名'), t('成員與討論設定'), t('刪除這段對話')], (i) => {
      if (i === 0) Alert.prompt(t('重新命名'), undefined, (text) => void store.renameSession(session.id, text), 'plain-text', session.title);
      if (i === 1) setMembersOpen(true);
      if (i === 2) void deleteSession(store, session.id);
    }, 2);
  }

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
      <View style={styles.headerSide}>
        <HeaderButton
          name="list.bullet"
          text={t('對話')}
          label={t('對話清單')}
          onPress={() => {
            // 跟用手勢打開一樣先收鍵盤
            Keyboard.dismiss();
            setListOpen(true);
          }}
        />
      </View>
      <Pressable
        style={({ pressed }) => [styles.flex, styles.titleButton, pressed && styles.pressed]}
        onPress={sessionMenu}
        disabled={!hasChat}
        accessibilityRole="button"
        accessibilityLabel={hasChat ? t('{p0}，點一下可以改名或刪除', { p0: title }) : title}>
        <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header" testID="chat-title" maxFontSizeMultiplier={HEADER_MAX_SCALE}>
          {title}
        </Text>
        {hasChat ? <SymbolView name="chevron.down" size={11} tintColor={C.secondary} /> : null}
      </Pressable>
      <View style={[styles.headerSide, styles.headerRight]}>
        <HeaderButton name="square.and.pencil" text={t('新對話')} label={t('新對話')} disabled={state.messages.length === 0 || !!state.streaming} onPress={() => store.newSession()} />
      </View>
    </View>
  );

  const conversation = (
    <>
    {group ? <MembersBar members={state.members} onPress={() => setMembersOpen(true)} /> : null}
    {pinnedCard && pinnedMessage ? <PinnedConclusion card={pinnedCard} onPress={() => jumpTo(pinnedMessage.id)} onUnpin={() => void store.pinConclusion(null)} /> : null}
    <KeyboardGestureArea style={styles.flex} offset={gestureOffset} textInputNativeID={COMPOSER_INPUT_ID}>
    {/* 訊息區：鍵盤打開時只在看著最新訊息時把內容往上推（往上翻舊訊息時不動）；拖著收鍵盤時跟手 */}
    <RevealContext.Provider value={revealField}>
    <KeyboardChatScrollView
      ref={scrollRef}
      testID="transcript"
      keyboardLiftBehavior="whenAtEnd"
      offset={keyboardOffset}
      style={styles.flex}
      contentContainerStyle={styles.transcript}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={100}
      // 「跟著最新」只看使用者自己的捲動：程式捲動的動畫不算，手指在拖或放手後還在滑時也不自動捲到底
      // （不然 AI 回答中往下拖收鍵盤，內容會被拉回最底，跟手指打架）
      onScrollBeginDrag={() => (userScrolling.current = true)}
      onScroll={(e) => {
        scrollY.current = e.nativeEvent.contentOffset.y;
        if (userScrolling.current) updateNearBottom(e);
      }}
      onScrollEndDrag={(e) => {
        updateNearBottom(e);
        userScrolling.current = false;
      }}
      // 點狀態列捲到最上面也是使用者自己捲的：不再跟著最新，出現「捲到最新」
      onScrollToTop={updateNearBottom}
      onMomentumScrollBegin={() => (userScrolling.current = true)}
      onMomentumScrollEnd={(e) => {
        updateNearBottom(e);
        userScrolling.current = false;
      }}
      onContentSizeChange={() => {
        // 只在 AI 正在回答（含剛答完）、或多了新訊息時跟著捲；點開「思考過程」這類自己展開的內容不要把畫面拉走
        const grew = state.messages.length !== messageCount.current;
        messageCount.current = state.messages.length;
        if (nearBottom.current && !userScrolling.current && (grew || streamingNow || answerEnded.current)) scrollRef.current?.scrollToEnd({ animated: true });
      }}>
      {state.messages.length === 0 ? (
        <EmptyState
          phase={state.hosts.length === 0 ? 'noComputer' : !session?.model ? 'noModel' : 'ready'}
          scanning={state.scan?.running && state.scan.total > 0 ? t('正在尋找你的電腦…（{p0}/{p1}）', { p0: state.scan.done, p1: state.scan.total }) : ''}
          modelLabel={modelLabel}
          hostState={statusHost ? state.hostStatus[statusHost]?.state : undefined}
          downloading={statusHost ? state.downloads[statusHost]?.find((j) => j.status === 'downloading') : undefined}
          noModels={!!statusHost && state.models[statusHost]?.loading === false && state.models[statusHost]?.list.length === 0 && !state.models[statusHost]?.error}
          onConnect={() => setConnect({ help: false })}
          onHelp={() => setConnect({ help: true })}
          onPickModel={() => setSheetOpen(true)}
          onInvite={() => setMembersOpen(true)}
          members={state.members.length}
        />
      ) : (
        state.messages.map((m, i) => {
          const plain = (
            <MessageView
              message={m}
              streaming={state.streaming}
              isLast={i === lastIndex}
              showMeta={metaShown.has(m.id)}
              onOpenImage={(images, index) => setViewer({ images, index })}
              onCopyCode={copy}
              onLongPress={messageMenu}
              onRetry={() => void store.retry()}
              onHelp={() => setConnect({ help: true })}
              onCopy={() => copy(m.content)}
              onRegenerate={() => confirmLater(m, () => store.regenerate(m.id))}
              onSwitchVersion={(delta) => void store.switchVersion(m.id, delta)}
              extra={actionsOf(m)}
            />
          );
          return (
          <Fragment key={m.id}>
          {bubbles ? (
            <View onLayout={(e) => messageY.current.set(m.id, e.nativeEvent.layout.y)}>
              <BubbleView
                message={m}
                streaming={state.streaming}
                agent={m.agentId ? (state.agents[m.agentId] ?? null) : null}
                replyTarget={replies?.get(m.id) ?? null}
                fallback={plain}
                isLast={i === lastIndex && !discussing}
                onOpenImage={(images, index) => setViewer({ images, index })}
                onCopyCode={copy}
                onLongPress={messageMenu}
                onJump={jumpTo}
                onCopy={() => copy(m.content)}
                onRegenerate={() => confirmLater(m, () => store.regenerate(m.id))}
                onSwitchVersion={(delta) => void store.switchVersion(m.id, delta)}
                conclusion={(cm, card) => (
                  <ConclusionCard
                    card={card}
                    agents={state.agents}
                    pinned={session?.pinnedId === cm.id}
                    onVote={(index) => void store.voteConclusion(cm.id, index)}
                    onPin={(on) => void store.pinConclusion(on ? cm.id : null)}
                    onCopy={() => copy(conclusionText(card))}
                  />
                )}
              />
            </View>
          ) : (
            plain
          )}
          {threadAfter.has(i) ? (
                  <ThreadLink
                    ref={(r) => void threadLinkRefs.current.set(threadAfter.get(i)!.questionId, r)}
                    count={threadAfter.get(i)!.count}
                    running={threadAfter.get(i)!.running}
                    fresh={threadAfter.get(i)!.fresh}
                    onPress={(pageY) => void openThread(threadAfter.get(i)!.questionId, pageY)}
                  />
                ) : null}
          {isThreadRoot(m) && !(state.messages[i + 1] && isThreadRoot(state.messages[i + 1])) ? <ThreadDivider /> : null}
          </Fragment>
          );
        })
      )}
    </KeyboardChatScrollView>
    </RevealContext.Provider>

    {/* 提示、復原提示、輸入列黏在鍵盤上，跟著鍵盤一起動 */}
    <KeyboardStickyView
      testID="composer-area"
      offset={{ closed: 0, opened: keyboardOffset }}
      onLayout={(e) => {
        const height = e.nativeEvent.layout.height;
        // 輸入框長高、出現提示、附了照片：訊息區變矮，最下面幾行會被蓋住；跟著最新時補捲（不加動畫，跟輸入列同一格動）
        if (height > stickyHeight && nearBottom.current && !userScrolling.current) requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
        setStickyHeight(height);
      }}>
    {!following && !cardTyping && state.messages.length > 0 ? (
      <Pressable
        onPress={() => {
          follow(true);
          scrollRef.current?.scrollToEnd({ animated: true });
        }}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={t('捲到最新')}
        style={({ pressed }) => [styles.toLatest, pressed && styles.pressed]}>
        <SymbolView name="arrow.down" size={16} tintColor={C.label} />
      </Pressable>
    ) : null}
    {group ? (
      <DiscussionStatus
        phase={state.discussion}
        running={discussing}
        agents={state.agents}
        suggest={!!session && state.suggestConclude.includes(session.id)}
        canContinue={canContinue}
        onPause={() => store.stop()}
        onContinue={() => void store.continueDiscussion()}
        onConclude={() => void store.conclude()}
        onDismissSuggest={() => store.dismissConclude()}
      />
    ) : null}
    {state.notice ? <Banner text={state.notice} tone="warn" onClose={() => store.dismissNotice()} /> : null}
    {state.context && state.context.level !== 'ok' ? (
      <Banner
        tone={state.context.level === 'full' ? 'error' : 'warn'}
        text={
          state.context.level === 'full'
            ? t('這段對話太長了，AI 已經記不住最前面的內容。')
            : t('這段對話快要太長了，AI 可能開始忘記前面的內容。')
        }
        action={{ text: t('開新對話'), onPress: () => store.newSession() }}
      />
    ) : null}

    <View style={styles.toastAnchor} pointerEvents="box-none">
      {/* 面板開著時，復原提示由面板自己顯示 */}
      {state.undo ? anySheetOpen ? null : <UndoToast store={store} /> : <Toast toast={toast} onDone={() => setToast(null)} />}
    </View>
    <Composer
      modelLabel={modelLabel}
      canAttach={!!model?.vision}
      modelKnown={!!model}
      think={model?.think ?? null}
      thinkValue={session?.think ?? null}
      busy={group ? false : !!state.streaming}
      bottomInset={bottomInset}
      onDraftChange={onDraftChange}
      onInputFocus={() => setCardTyping(false)}
      onSend={async (text, photos) => {
        follow(true);
        // 送出後收鍵盤，整個畫面留給回答（使用者決定，10/30）
        Keyboard.dismiss();
        if (editing) {
          const saved = editing;
          setEditing(null);
          try {
            await store.editAndResend(saved.id, text, photos, true);
          } catch (e) {
            // 沒送出去：字和照片會放回輸入框，「編輯中」也要回來，不然再按送出會變成多加一則
            setEditing(saved);
            throw e;
          }
        } else {
          // 送出就好，回答、討論在背景跑：換到別段照樣可以問，大家在講的時候也能接著插話
          await store.send(text, photos, true);
        }
      }}
      onStop={() => store.stop()}
      onOpenModels={() => setSheetOpen(true)}
      onThink={(v) => store.setThink(v)}
      pickPhotos={p.pickPhotos}
      injected={injected}
      // 塞進去的字套用一次就清掉：不然輸入框換位置重建時（打開討論串）又被放回去
      onInjected={() => setInjected(null)}
      accessory={
        mention !== null && !editing ? (
          <MentionPicker
            query={mention}
            members={state.members.map((x) => x.agent)}
            mine={state.myAgents}
            onPick={(name) => setInjected({ text: draftRef.current.replace(/@[^\s@]*$/, `@${name} `), nonce: Date.now() })}
          />
        ) : editing ? (
          <Banner
            tone="info"
            text={t('編輯中：送出後會取代這則訊息{p0}', { p0: editing.later > 0 ? t('和之後的 {n} 則', { n: editing.later }) : '' })}
            action={{ text: t('取消編輯'), onPress: cancelEdit }}
          />
        ) : null
      }
      notReadyHint={state.hosts.length === 0 ? t('先連接你的電腦') : t('先在下方選一個模型')}
    />
    </KeyboardStickyView>
    </KeyboardGestureArea>
    </>
  );

  // ---- 討論串：浮在原對話上的卡片（apple-design：從來源長出來、怎麼出來就怎麼回去、可以抓住往下拉）----
  // 後面是開討論串前拍下的原對話，蓋上模糊；點模糊的地方、按 ✕ 回去時卡片縮回那則訊息，往下拉放手時順著往下滑走
  const { height: screenH } = useWindowDimensions();
  screenHRef.current = screenH;
  // 上方多留一截看得到模糊的原對話，一眼看出卡片是浮在上面、點那裡就回去
  const cardTop = insets.top + 36;
  const cardCenter = (cardTop + screenH - cardBottom) / 2;
  const from = (threadAnchor.current ?? cardCenter) - cardCenter;
  const cardMotion = reduceMotion
    ? { opacity: threadAnim, transform: [{ translateY: threadDrag }] }
    : {
        // 縮到很小才消失（使用者要「縮到更小再隱藏」）：最後一小段才變透明
        opacity: threadAnim.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 1, 1] }),
        transform: [
          { translateY: Animated.add(threadAnim.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }), threadDrag) },
          { scale: threadAnim.interpolate({ inputRange: [0, 1], outputRange: [0.08, 1] }) },
        ],
      };
  const threadLayer = (
    <>
      {threadShot ? <Image source={{ uri: threadShot }} style={StyleSheet.absoluteFill} /> : null}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: threadBlur }]} pointerEvents="none">
        {reduceTransparency ? <View style={[StyleSheet.absoluteFill, styles.threadDim]} /> : <BlurView intensity={40} tint="systemThinMaterial" style={StyleSheet.absoluteFill} />}
      </Animated.View>
      {/* 卡片還在長出來時點到背景不關（連點入口兩下的第二下） */}
      <Pressable style={StyleSheet.absoluteFill} onPress={() => threadSettled.current && closeThread()} accessibilityRole="button" accessibilityLabel={t('回到對話')} testID="thread-backdrop" />
      <Animated.View style={[styles.threadCard, { top: cardTop, bottom: cardBottom }, cardMotion]} accessibilityViewIsModal onAccessibilityEscape={() => closeThread()}>
        <View style={styles.threadCardInner}>
          <View style={styles.threadHeader} {...threadPan.panHandlers}>
            <View style={styles.grabber} />
            <View style={styles.threadHeaderRow}>
              <View style={styles.threadSide} />
              <Pressable
                ref={threadTitleRef}
                style={({ pressed }) => [styles.flex, styles.titleButton, pressed && styles.pressed]}
                onPress={sessionMenu}
                accessibilityRole="button"
                accessibilityLabel={t('討論串，點一下可以刪除')}>
                <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header" testID="chat-title" maxFontSizeMultiplier={HEADER_MAX_SCALE}>
                  {t('討論串')}
                </Text>
                <SymbolView name="chevron.down" size={11} tintColor={C.secondary} />
              </Pressable>
              <View style={[styles.threadSide, styles.headerRight]}>
                <Pressable onPress={() => closeThread()} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('關閉討論串')} style={({ pressed }) => pressed && styles.pressed}>
                  <SymbolView name="xmark.circle.fill" size={28} tintColor={C.tertiary} />
                </Pressable>
              </View>
            </View>
          </View>
          {conversation}
        </View>
      </Animated.View>
    </>
  );

  return (
    <>
      <SideDrawer
        open={listOpen}
        onOpenChange={setListOpen}
        swipeEnabled={listOpen || (!anySheetOpen && !viewer && !cardMode)}
        closeLabel={t('關閉對話清單')}
        renderDrawer={() => (
          <SessionList
            store={store}
            currentId={session?.parentId ?? session?.id ?? null}
            onClose={() => setListOpen(false)}
            onOpenSettings={() => setAppSettingsOpen(true)}
            showUndo={!appSettingsOpen}
          />
        )}>
        <View style={styles.root}>
          {cardMode ? threadLayer : (
            <>
              {header}
              {conversation}
            </>
          )}

          <Modal visible={sheetOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setSheetOpen(false)}>
            <ModelSheet store={store} state={state} copyText={p.copyText} onClose={() => setSheetOpen(false)} />
          </Modal>
          <Modal visible={!!connect} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setConnect(null)} onDismiss={connectClosed}>
            <ConnectSheet
              store={store}
              state={state}
              copyText={p.copyText}
              showHelp={connect?.help}
              onClose={() => setConnect(null)}
              onNeedModel={() => {
                // 等連接面板關好再打開選模型（兩層面板不能同時動）
                afterConnect.current = () => setSheetOpen(true);
                setConnect(null);
                setTimeout(connectClosed, 1500);
              }}
            />
          </Modal>
          <Modal visible={membersOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setMembersOpen(false)}>
            <MembersSheet store={store} state={state} topic={topic} onClose={() => setMembersOpen(false)} />
          </Modal>
          <ImageViewer images={viewer?.images ?? null} index={viewer?.index ?? 0} onClose={() => setViewer(null)} />
        </View>
      </SideDrawer>
      {/* 設定從側邊欄打開，放在主畫面外面（側邊欄開著時主畫面對輔助使用是隱藏的） */}
      <Modal visible={appSettingsOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setAppSettingsOpen(false)}>
        <SettingsPages store={store} copyText={copy} pickBackup={p.pickBackup} onClose={() => setAppSettingsOpen(false)} />
      </Modal>
    </>
  );
}


/** 沒有對話時：直接告訴使用者下一步（連接電腦、選模型，或直接開始打字） */
function EmptyState({
  phase,
  scanning,
  modelLabel,
  hostState,
  noModels,
  downloading,
  onConnect,
  onHelp,
  onPickModel,
  onInvite,
  members,
}: {
  phase: 'noComputer' | 'noModel' | 'ready';
  scanning: string;
  modelLabel: string | null;
  /** 這段對話的電腦現在連不連得到：沒連上時不要寫「已經連上」 */
  hostState?: 'checking' | 'online' | 'offline';
  /** 電腦連上了，但上面一個模型都沒有：要說「下載一個」，不是「選一個」 */
  noModels?: boolean;
  /** 這台電腦正在下載的模型（有的話先說進度） */
  downloading?: { model: string; completed: number; total: number };
  onConnect: () => void;
  onHelp: () => void;
  onPickModel: () => void;
  /** 邀請 Agent 一起討論 */
  onInvite?: () => void;
  /** 已經有幾位成員 */
  members?: number;
}) {
  const offline = hostState === 'offline';
  const checking = hostState === 'checking';
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>
        <Text style={{ color: C.accent }}>◆ </Text>
        {APP_NAME}
      </Text>
      <Text style={styles.dim}>{t('跟你自己電腦上的 AI 模型聊天。對話只存在這支手機。')}</Text>
      {scanning ? (
        <Text style={styles.dim} accessibilityLiveRegion="polite">
          {scanning}
        </Text>
      ) : null}
      {phase === 'noComputer' ? (
        <>
          <PrimaryButton text={t('連接你的電腦')} onPress={onConnect} />
          <Text style={styles.hint}>{t('需要一台開著 Local AI 小幫手的電腦，跟手機連同一個 Wi-Fi。')}</Text>
        </>
      ) : offline ? (
        <>
          <Text style={styles.hint}>{t('現在連不到你的電腦。確認電腦開著、小幫手在執行，手機和電腦連在同一個網路。')}</Text>
          <PrimaryButton text={t('連線說明')} onPress={onHelp} />
        </>
      ) : checking ? (
        <Text style={styles.hint}>{t('正在連線到你的電腦…')}</Text>
      ) : phase === 'noModel' && downloading ? (
        <>
          <Text style={styles.hint}>
            {t('正在下載 {p0}…（{p1}%）', { p0: friendlyModelName(downloading.model), p1: downloading.total > 0 ? Math.floor((downloading.completed / downloading.total) * 100) : 0 })}
          </Text>
          <PrimaryButton text={t('查看下載')} onPress={onPickModel} />
        </>
      ) : phase === 'noModel' && noModels ? (
        <>
          <PrimaryButton text={t('下載一個模型')} onPress={onPickModel} />
          <Text style={styles.hint}>{t('已經連上電腦，但上面還沒有模型。下載一個就能開始聊天。')}</Text>
        </>
      ) : phase === 'noModel' ? (
        <>
          <PrimaryButton text={t('選擇模型')} onPress={onPickModel} />
          <Text style={styles.hint}>{t('已經連上電腦，選一個模型就能開始聊天。')}</Text>
        </>
      ) : (
        <>
          <Text style={styles.ready}>
            {members ? t('{p0} 位 Agent 已經準備好，說說要討論什麼。', { p0: members }) : (
              <>
                {t('已經連上')} <Text style={styles.readyModel}>{modelLabel}</Text>{t('，直接在下面輸入問題就可以開始。')}
              </>
            )}
          </Text>
          {onInvite ? (
            <Pressable onPress={onInvite} accessibilityRole="button" style={({ pressed }) => [styles.invite, pressed && styles.pressed]}>
              <SymbolView name="person.3" size={16} tintColor={C.accent} />
              <Text style={styles.inviteText}>{members ? t('成員與討論設定') : t('邀請幾個 Agent 一起討論')}</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}

function PrimaryButton({ text, onPress }: { text: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && styles.primaryPressed]}>
      <Text style={styles.primaryText}>{text}</Text>
    </Pressable>
  );
}

function Banner({ text, tone, onClose, action }: { text: string; tone: 'info' | 'warn' | 'error'; onClose?: () => void; action?: { text: string; onPress: () => void } }) {
  return (
    <View style={styles.banner} accessibilityLiveRegion="polite">
      <Text style={[styles.bannerText, { color: tone === 'error' ? C.errorText : tone === 'warn' ? C.warnText : C.secondary }]}>{text}</Text>
      {action ? (
        <Pressable onPress={action.onPress} hitSlop={8} accessibilityRole="button">
          <Text style={styles.bannerAction}>{action.text}</Text>
        </Pressable>
      ) : null}
      {onClose ? (
        <Pressable onPress={onClose} hitSlop={16} accessibilityRole="button" accessibilityLabel={t('關閉提示')}>
          <SymbolView name="xmark" size={12} tintColor={C.secondary} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** 標題列按鈕：圖示加文字，一看就知道是什麼 */
/** 標題列的字最多放大到 1.3 倍：大字時標題列還放得下（訊息內容照樣跟著放大） */
const HEADER_MAX_SCALE = 1.3;

export function HeaderButton({ name, text, label, onPress, disabled }: { name: SFSymbol; text?: string; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
      <SymbolView name={name} size={18} tintColor={disabled ? C.tertiary : C.accent} />
      {text ? (
        <Text style={[styles.headerButtonText, disabled && { color: C.tertiary }]} maxFontSizeMultiplier={HEADER_MAX_SCALE}>
          {text}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * 討論串卡片的彈簧：不回彈（阻尼比 1），大約 0.28 秒到位（apple-design：一般介面用臨界阻尼；使用者要再快一點）。
 * stiffness = (2π / 0.28)² ≈ 500、damping = 2√500 ≈ 45
 */
const CARD_SPRING = { stiffness: 500, damping: 45, mass: 1, useNativeDriver: true } as const;

/** 輸入框被鍵盤或輸入列擋住多少 pt（沒擋到是 0）：都是螢幕座標；輸入列上緣再留一點空 */
export function coveredBy(fieldBottom: number, keyboardTop: number, composerAboveKeyboard: number, gap = 12): number {
  return Math.max(0, fieldBottom + gap - (keyboardTop - composerAboveKeyboard));
}

const styles = StyleSheet.create({
  // 討論串卡片：外層帶陰影（不能 overflow hidden，不然陰影被切掉），裡層圓角裁切內容
  threadCard: { position: 'absolute', left: 12, right: 12, borderRadius: 22, backgroundColor: C.bg, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 24, shadowOffset: { width: 0, height: 8 } },
  threadCardInner: { flex: 1, borderRadius: 22, overflow: 'hidden' },
  threadHeader: { paddingTop: 6, paddingHorizontal: 12, paddingBottom: 2 },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: C.separator },
  threadHeaderRow: { flexDirection: 'row', alignItems: 'center', minHeight: 40 },
  threadSide: { width: 44 },
  // 「降低透明度」打開時不用模糊，改成一層夠深的遮罩
  threadDim: { backgroundColor: 'rgba(0,0,0,0.45)' },
  root: { flex: 1, backgroundColor: C.bg },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 8 },
  // 兩邊至少 92pt、內容長（英文、大字）時可以變寬，標題自己讓位截短，不會被按鈕蓋住
  headerSide: { minWidth: 92, flexShrink: 0, flexDirection: 'row' },
  headerRight: { justifyContent: 'flex-end' },
  headerTitle: { textAlign: 'center', ...TEXT.body, fontWeight: '700', color: C.label, flexShrink: 1 },
  titleButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  headerButtonText: { fontSize: 15, fontWeight: '600', color: C.accent },
  // 浮在輸入列右上方、跟著鍵盤走；圓形 40pt（可以按的範圍補到 44pt）
  toLatest: { position: 'absolute', top: -52, right: 16, width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg, borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator, zIndex: 20, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  toastAnchor: { height: 0, zIndex: 10 },
  headerButton: { height: 38, flexDirection: 'row', alignItems: 'center', gap: 4 },
  pressed: { opacity: 0.4 },
  transcript: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 16, gap: 14 },
  empty: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator, borderRadius: 10, padding: 16, gap: 10, marginTop: 8 },
  emptyTitle: { ...TEXT.body, fontSize: 17, fontWeight: '700', color: C.label },
  dim: { ...TEXT.small, color: C.secondary },
  hint: { ...TEXT.meta, color: C.secondary, textAlign: 'center' },
  ready: { ...TEXT.small, color: C.label, marginTop: 4 },
  readyModel: { color: C.accent },
  invite: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', minHeight: 40, paddingHorizontal: 14, marginTop: 8, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator },
  inviteText: { ...TEXT.small, color: C.accent, fontWeight: '600' },
  primary: { height: 52, borderRadius: 14, backgroundColor: C.accentFill, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  primaryPressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  primaryText: { ...TEXT.body, fontWeight: '700', color: '#ffffff' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginBottom: 4 },
  bannerText: { ...TEXT.meta, flex: 1 },
  bannerAction: { ...TEXT.meta, color: C.accent, fontWeight: '700' },
});
