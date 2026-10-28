import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Alert, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
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
import { Composer, chooseOption, type PickSource } from './Composer';
import { ConnectSheet } from './ConnectSheet';
import { ImageViewer } from './ImageViewer';
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
      chooseOption(t('你的訊息'), [t('複製'), t('編輯並重送'), t('刪除')], (i) => [() => copy(m.content), () => startEdit(m), () => confirmDeleteMessage(m)][i]());
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
        ][i]()
      );
    } else {
      chooseOption(m.role === 'error' ? t('錯誤訊息') : t('提示'), [t('複製'), t('刪除')], (i) => [() => copy(m.content), () => void store.deleteMessage(m.id)][i]());
    }
  }
  const [viewer, setViewer] = useState<{ images: Attachment[]; index: number } | null>(null);
  const [keyboardUp, setKeyboardUp] = useState(false);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setKeyboardUp(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboardUp(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // 換對話時捲到最下面
  useEffect(() => {
    nearBottom.current = true;
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
  }, [state.session?.id]);

  const session = state.session;
  const model = store.currentModel();
  const anySheetOpen = sheetOpen || listOpen || appSettingsOpen || !!connect;
  const modelLabel = session?.hostUrl && session.model ? `${store.hostLabel(session.hostUrl)} · ${friendlyModelName(session.model)}` : null;
  const title = session?.title || (state.messages.length > 0 ? t('對話') : t('新對話'));
  const hasChat = !!session && state.messages.length > 0;

  /** 點標題：改名或刪除這段對話（跟對話清單的 ⋯ 一樣） */
  function sessionMenu() {
    if (!session || state.streaming) return;
    chooseOption(title, [t('重新命名'), t('刪除這段對話')], (i) => {
      if (i === 0) Alert.prompt(t('重新命名'), undefined, (text) => void store.renameSession(session.id, text), 'plain-text', session.title);
      if (i === 1) void deleteSession(store, session.id);
    });
  }

  return (
    <>
      <SideDrawer
        open={listOpen}
        onOpenChange={setListOpen}
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
        <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
            <View style={styles.headerSide}>
              <HeaderButton name="list.bullet" text={t('對話')} label={t('對話清單')} onPress={() => setListOpen(true)} />
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

          <ScrollView
            ref={scrollRef}
            style={styles.flex}
            contentContainerStyle={styles.transcript}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={100}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 120;
            }}
            onContentSizeChange={() => {
              if (nearBottom.current) scrollRef.current?.scrollToEnd({ animated: true });
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
                />
              ))
            )}
          </ScrollView>

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
            bottomInset={keyboardUp ? 8 : Math.max(insets.bottom, 8)}
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

          <Modal visible={sheetOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setSheetOpen(false)}>
            <ModelSheet store={store} state={state} copyText={p.copyText} onClose={() => setSheetOpen(false)} />
          </Modal>
          <Modal visible={!!connect} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setConnect(null)}>
            <ConnectSheet store={store} state={state} copyText={p.copyText} showHelp={connect?.help} onClose={() => setConnect(null)} />
          </Modal>
          <ImageViewer images={viewer?.images ?? null} index={viewer?.index ?? 0} onClose={() => setViewer(null)} />
        </KeyboardAvoidingView>
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
          <Text style={styles.hint}>{t('需要一台開著 Ollama 的電腦，跟手機連同一個 Wi-Fi。')}</Text>
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
      <Text style={[styles.bannerText, { color: tone === 'error' ? C.red : tone === 'warn' ? C.orange : C.secondary }]}>{text}</Text>
      {action ? (
        <Pressable onPress={action.onPress} hitSlop={8} accessibilityRole="button">
          <Text style={styles.bannerAction}>{action.text}</Text>
        </Pressable>
      ) : null}
      {onClose ? (
        <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('關閉提示')}>
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
  primary: { height: 52, borderRadius: 14, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  primaryPressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  primaryText: { ...TEXT.body, fontWeight: '700', color: '#ffffff' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginBottom: 4 },
  bannerText: { ...TEXT.meta, flex: 1 },
  bannerAction: { ...TEXT.meta, color: C.accent, fontWeight: '700' },
});
