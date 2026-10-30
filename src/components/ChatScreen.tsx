import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Alert, Keyboard, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { KeyboardChatScrollView, KeyboardGestureArea, KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fmtElapsed, fmtTokPerSec } from '../lib/format';
import { friendlyModelName } from '../lib/modelName';
import type { NewPhoto } from '../lib/photos';
import type { ChatStore } from '../state/chatStore';
import { useChatState } from '../state/useChat';
import type { Db } from '../store/db';
import type { Attachment, Message } from '../store/repo';
import { APP_NAME } from '../ui/brand';
import { C, TEXT } from '../ui/theme';
import { COMPOSER_INPUT_ID, Composer, chooseOption, type PickSource } from './Composer';
import { ConnectSheet } from './ConnectSheet';
import { ImageViewer } from './ImageViewer';
import { ActionListCard, ActionView } from './ActionCard';
import { MessageView } from './Messages';
import { ModelSheet } from './ModelSheet';
import { SessionList, SettingsPages, deleteSession } from './SessionSheets';
import { SideDrawer } from './SideDrawer';
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
  const nearBottom = useRef(true);
  const userScrolling = useRef(false);
  const updateNearBottom = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 120;
  };
  const [sheetOpen, setSheetOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [connect, setConnect] = useState<{ help: boolean } | null>(null);
  const [editing, setEditing] = useState<{ id: string; later: number } | null>(null);
  const [injected, setInjected] = useState<{ text: string; photos?: NewPhoto[]; nonce: number } | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);

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

  /** 長按訊息的選單 */
  function messageMenu(m: Message) {
    if (state.streaming) return;
    if (m.role === 'user') {
      chooseOption(t('你的訊息'), [t('複製'), t('編輯並重送'), t('刪除')], (i) => [() => copy(m.content), () => startEdit(m), () => confirmDeleteMessage(m)][i](), 2);
    } else if (m.role === 'assistant') {
      const hostUrl = state.session?.hostUrl;
      const others = hostUrl ? (state.models[hostUrl]?.list ?? []).map((x) => x.name) : [];
      chooseOption(t('AI 的回答'), [t('複製'), t('分享'), t('重新產生'), t('換個模型重新產生'), t('詳細資訊'), t('刪除')], (i) =>
        [
          () => copy(m.content),
          () => void Share.share({ message: m.content }),
          () => confirmLater(m, () => store.regenerate(m.id)),
          () =>
            hostUrl && others.length > 0
              ? chooseOption(t('用哪個模型重新產生'), others.map(friendlyModelName), (j) => confirmLater(m, () => store.regenerate(m.id, { hostUrl, model: others[j] })))
              : Alert.alert(t('沒有其他模型'), t('這台電腦上只有一個模型。')),
          () => showDetails(m),
          () => confirmDeleteMessage(m),
        ][i](),
        5
      );
    } else {
      chooseOption(m.role === 'error' ? t('錯誤訊息') : t('提示'), [t('複製'), t('刪除')], (i) => [() => copy(m.content), () => void store.deleteMessage(m.id)][i](), 1);
    }
  }
  const [viewer, setViewer] = useState<{ images: Attachment[]; index: number } | null>(null);
  // 輸入列底部固定留給 Home 鍵橫條的空間；鍵盤打開時（橫條被鍵盤蓋住）用 keyboardOffset 把多的扣回來，
  // 只剩 8pt。用位移不用改留白，跟著鍵盤一格一格動，收鍵盤時不會跳
  const bottomInset = Math.max(insets.bottom, 8);
  const keyboardOffset = bottomInset - 8;
  // 輸入列（含上面的提示）在鍵盤上方露出的高度：往下拖收鍵盤時，手指一碰到輸入列上緣鍵盤就開始跟（像 iMessage），
  // 不用先越過整個輸入列
  const [stickyHeight, setStickyHeight] = useState(0);
  const gestureOffset = Math.max(0, stickyHeight - keyboardOffset);

  // 換對話時捲到最下面
  useEffect(() => {
    nearBottom.current = true;
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
  }, [state.session?.id]);

  const session = state.session;
  const model = store.currentModel();
  const anySheetOpen = sheetOpen || listOpen || appSettingsOpen || !!connect;
  // 模型在前、電腦在後：放不下時截掉的是電腦名，不會截掉 31B／12B 這種最重要的差別
  const modelLabel = session?.hostUrl && session.model ? `${friendlyModelName(session.model)} · ${store.hostLabel(session.hostUrl)}` : null;
  const failed = (title: string) => (e: unknown) => Alert.alert(title, e instanceof Error ? e.message : String(e));
  /** AI 訊息下面的確認卡與做了什麼；同一則回答有兩件以上要確認時合成清單卡 */
  const actionsOf = (m: Message) => {
    const actions = m.actions ?? [];
    if (actions.length === 0) return undefined;
    const listed = actions.filter((a) => a.status === 'pending' && store.toolFor(a.tool)?.kind !== 'question');
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
  const title = session?.title || state.messages.find((m) => m.role === 'user')?.content.trim() || t('新對話');
  const hasChat = !!session && state.messages.length > 0;

  /** 點標題：改名或刪除這段對話（跟對話清單的 ⋯ 一樣） */
  function sessionMenu() {
    if (!session || state.streaming) return;
    chooseOption(title, [t('重新命名'), t('刪除這段對話')], (i) => {
      if (i === 0) Alert.prompt(t('重新命名'), undefined, (text) => void store.renameSession(session.id, text), 'plain-text', session.title);
      if (i === 1) void deleteSession(store, session.id);
    }, 1);
  }

  return (
    <>
      <SideDrawer
        open={listOpen}
        onOpenChange={setListOpen}
        swipeEnabled={listOpen || (!anySheetOpen && !viewer)}
        closeLabel={t('關閉對話清單')}
        renderDrawer={() => (
          <SessionList
            store={store}
            currentId={session?.id ?? null}
            onClose={() => setListOpen(false)}
            onOpenSettings={() => setAppSettingsOpen(true)}
            showUndo={!appSettingsOpen}
          />
        )}>
        <View style={styles.root}>
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
              <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header" testID="chat-title">
                {title}
              </Text>
              {hasChat ? <SymbolView name="chevron.down" size={11} tintColor={C.secondary} /> : null}
            </Pressable>
            <View style={[styles.headerSide, styles.headerRight]}>
              <HeaderButton name="square.and.pencil" text={t('新對話')} label={t('新對話')} disabled={state.messages.length === 0 || !!state.streaming} onPress={() => store.newSession()} />
            </View>
          </View>

          <KeyboardGestureArea style={styles.flex} offset={gestureOffset} textInputNativeID={COMPOSER_INPUT_ID}>
          {/* 訊息區：鍵盤打開時只在看著最新訊息時把內容往上推（往上翻舊訊息時不動）；拖著收鍵盤時跟手 */}
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
            onScroll={(e) => userScrolling.current && updateNearBottom(e)}
            onScrollEndDrag={(e) => {
              updateNearBottom(e);
              userScrolling.current = false;
            }}
            onMomentumScrollBegin={() => (userScrolling.current = true)}
            onMomentumScrollEnd={(e) => {
              updateNearBottom(e);
              userScrolling.current = false;
            }}
            onContentSizeChange={() => {
              if (nearBottom.current && !userScrolling.current) scrollRef.current?.scrollToEnd({ animated: true });
            }}>
            {state.messages.length === 0 ? (
              <EmptyState
                phase={state.hosts.length === 0 ? 'noComputer' : !session?.model ? 'noModel' : 'ready'}
                scanning={state.scan?.running && state.scan.total > 0 ? t('正在尋找你的電腦…（{p0}/{p1}）', { p0: state.scan.done, p1: state.scan.total }) : ''}
                modelLabel={modelLabel}
                onConnect={() => setConnect({ help: false })}
                onPickModel={() => setSheetOpen(true)}
              />
            ) : (
              state.messages.map((m, i) => (
                <MessageView
                  key={m.id}
                  message={m}
                  streaming={state.streaming}
                  isLast={i === state.messages.length - 1}
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
              ))
            )}
          </KeyboardChatScrollView>

          {/* 提示、復原提示、輸入列黏在鍵盤上，跟著鍵盤一起動 */}
          <KeyboardStickyView offset={{ closed: 0, opened: keyboardOffset }} onLayout={(e) => setStickyHeight(e.nativeEvent.layout.height)}>
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
            think={model?.think ?? null}
            thinkValue={session?.think ?? null}
            busy={!!state.streaming}
            bottomInset={bottomInset}
            onSend={async (text, photos) => {
              nearBottom.current = true;
              if (editing) {
                const id = editing.id;
                setEditing(null);
                await store.editAndResend(id, text, photos);
              } else {
                await store.send(text, photos);
              }
            }}
            onStop={() => store.stop()}
            onOpenModels={() => setSheetOpen(true)}
            onThink={(v) => store.setThink(v)}
            pickPhotos={p.pickPhotos}
            injected={injected}
            accessory={
              editing ? (
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

          <Modal visible={sheetOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setSheetOpen(false)}>
            <ModelSheet store={store} state={state} copyText={p.copyText} onClose={() => setSheetOpen(false)} />
          </Modal>
          <Modal visible={!!connect} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setConnect(null)}>
            <ConnectSheet store={store} state={state} copyText={p.copyText} showHelp={connect?.help} onClose={() => setConnect(null)} />
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
  onConnect,
  onPickModel,
}: {
  phase: 'noComputer' | 'noModel' | 'ready';
  scanning: string;
  modelLabel: string | null;
  onConnect: () => void;
  onPickModel: () => void;
}) {
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
      ) : phase === 'noModel' ? (
        <>
          <PrimaryButton text={t('選擇模型')} onPress={onPickModel} />
          <Text style={styles.hint}>{t('已經連上電腦，選一個模型就能開始聊天。')}</Text>
        </>
      ) : (
        <Text style={styles.ready}>
          {t('已經連上')} <Text style={styles.readyModel}>{modelLabel}</Text>{t('，直接在下面輸入問題就可以開始。')}
        </Text>
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
      {text ? <Text style={[styles.headerButtonText, disabled && { color: C.tertiary }]}>{text}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 8 },
  headerSide: { width: 92, flexDirection: 'row' },
  headerRight: { justifyContent: 'flex-end' },
  headerTitle: { textAlign: 'center', ...TEXT.body, fontWeight: '700', color: C.label, flexShrink: 1 },
  titleButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  headerButtonText: { fontSize: 15, fontWeight: '600', color: C.accent },
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
  primary: { height: 52, borderRadius: 14, backgroundColor: C.accentFill, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  primaryPressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  primaryText: { ...TEXT.body, fontWeight: '700', color: '#ffffff' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginBottom: 4 },
  bannerText: { ...TEXT.meta, flex: 1 },
  bannerAction: { ...TEXT.meta, color: C.accent, fontWeight: '700' },
});
