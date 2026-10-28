import * as Speech from 'expo-speech';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Alert, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { NewPhoto } from '../lib/photos';
import { plainText } from '../lib/plainText';
import type { ChatStore } from '../state/chatStore';
import { useChatState } from '../state/useChat';
import type { Attachment, Message } from '../store/repo';
import { C, TEXT } from '../ui/theme';
import { Composer, chooseOption, type PickSource } from './Composer';
import { ImageViewer } from './ImageViewer';
import { MessageView } from './Messages';
import { ModelSheet } from './ModelSheet';
import { SessionList, SessionSettings } from './SessionSheets';
import { TemplatesSheet } from './TemplatesSheet';

export type ChatScreenProps = {
  store: ChatStore;
  pickPhotos: (source: PickSource, limit: number) => Promise<NewPhoto[] | 'denied'>;
  copyText: (text: string) => void;
};

export function ChatScreen(p: ChatScreenProps) {
  const { store } = p;
  const state = useChatState(store);
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const nearBottom = useRef(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: string; later: number } | null>(null);
  const [injected, setInjected] = useState<{ text: string; photos?: NewPhoto[]; nonce: number } | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  // 換對話時結束編輯與朗讀
  useEffect(() => {
    setEditing(null);
    Speech.stop();
    setSpeakingId(null);
  }, [state.session?.id]);

  function speak(m: Message) {
    Speech.stop();
    if (speakingId === m.id) {
      setSpeakingId(null);
      return;
    }
    setSpeakingId(m.id);
    const done = () => setSpeakingId((id) => (id === m.id ? null : id));
    Speech.speak(plainText(m.content), { language: 'zh-TW', onDone: done, onStopped: done, onError: done });
  }

  /** 重新產生前，如果後面還有訊息就先確認 */
  function confirmLater(m: Message, action: () => Promise<void>) {
    const later = store.laterCount(m.id);
    if (later === 0) return void action();
    Alert.alert('重新產生？', `之後的 ${later} 則訊息也會一起刪掉。`, [
      { text: '取消', style: 'cancel' },
      { text: '重新產生', onPress: () => void action() },
    ]);
  }

  function startEdit(m: Message) {
    setEditing({ id: m.id, later: store.laterCount(m.id) });
    setInjected({ text: m.content, photos: m.attachments.map(({ base64, width, height }) => ({ base64, width, height })), nonce: Date.now() });
  }

  function cancelEdit() {
    setEditing(null);
    setInjected({ text: '', photos: [], nonce: Date.now() });
  }

  function confirmDeleteMessage(m: Message) {
    Alert.alert('刪除這則訊息？', undefined, [
      { text: '取消', style: 'cancel' },
      { text: '刪除', style: 'destructive', onPress: () => void store.deleteMessage(m.id) },
    ]);
  }

  /** 長按訊息的選單 */
  function messageMenu(m: Message) {
    if (state.streaming) return;
    if (m.role === 'user') {
      chooseOption('你的訊息', ['複製', '編輯並重送', '刪除'], (i) => [() => p.copyText(m.content), () => startEdit(m), () => confirmDeleteMessage(m)][i]());
    } else if (m.role === 'assistant') {
      const hostUrl = state.session?.hostUrl;
      const others = hostUrl ? (state.models[hostUrl]?.list ?? []).map((x) => x.name) : [];
      chooseOption('AI 的回答', ['複製', '分享', '重新產生', '換個模型重新產生', speakingId === m.id ? '停止朗讀' : '朗讀', '刪除'], (i) =>
        [
          () => p.copyText(m.content),
          () => void Share.share({ message: m.content }),
          () => confirmLater(m, () => store.regenerate(m.id)),
          () =>
            hostUrl && others.length > 0
              ? chooseOption('用哪個模型重新產生', others, (j) => confirmLater(m, () => store.regenerate(m.id, { hostUrl, model: others[j] })))
              : Alert.alert('沒有其他模型', '先在下方的模型面板載入這台主機的模型。'),
          () => speak(m),
          () => confirmDeleteMessage(m),
        ][i]()
      );
    } else {
      chooseOption(m.role === 'error' ? '錯誤訊息' : '提示', ['複製', '刪除'], (i) => [() => p.copyText(m.content), () => void store.deleteMessage(m.id)][i]());
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
  const modelLabel = session?.hostUrl && session.model ? `${store.hostLabel(session.hostUrl)} · ${session.model}` : null;
  const title = session?.title || (state.messages.length > 0 ? '對話' : '新對話');

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <View style={styles.headerSide}>
          <HeaderButton name="list.bullet" label="對話清單" onPress={() => setListOpen(true)} />
        </View>
        <Pressable
          style={styles.flex}
          onPress={() => session && setSettingsOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`${title}，點一下打開對話設定`}>
          <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">
            {title}
            {session?.systemPrompt.trim() ? <Text style={styles.roleMark}>  ◆ 角色</Text> : null}
          </Text>
        </Pressable>
        <View style={[styles.headerSide, styles.headerRight]}>
          <HeaderButton name="square.and.pencil" label="新對話" disabled={state.messages.length === 0 || !!state.streaming} onPress={() => store.newSession()} />
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
          <Welcome
            hasHosts={state.hosts.length > 0}
            scanning={state.scan?.running ? `› 正在區網找 Ollama 主機…（${state.scan.done}/${state.scan.total}）` : ''}
            modelLabel={modelLabel}
            onOpenModels={() => setSheetOpen(true)}
          />
        ) : (
          state.messages.map((m) => (
            <MessageView
              key={m.id}
              message={m}
              streaming={state.streaming}
              onOpenImage={(images, index) => setViewer({ images, index })}
              onCopyCode={p.copyText}
              onLongPress={messageMenu}
            />
          ))
        )}
      </ScrollView>

      {speakingId ? (
        <Banner
          text="朗讀中…"
          tone="info"
          action={{
            text: '停止',
            onPress: () => {
              Speech.stop();
              setSpeakingId(null);
            },
          }}
        />
      ) : null}
      {state.notice ? <Banner text={state.notice} tone="warn" onClose={() => store.dismissNotice()} /> : null}
      {state.context && state.context.level !== 'ok' ? (
        <Banner
          tone={state.context.level === 'full' ? 'error' : 'warn'}
          text={
            state.context.level === 'full'
              ? `對話已超過模型能記住的長度（${kTokens(state.context.used)} / ${kTokens(state.context.limit)}），前面的內容可能被忘記。`
              : `對話快超過模型能記住的長度（${kTokens(state.context.used)} / ${kTokens(state.context.limit)}）。`
          }
          action={{ text: '開新對話', onPress: () => store.newSession() }}
        />
      ) : null}

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
              text={`編輯中：送出後會取代這則訊息${editing.later > 0 ? `和之後的 ${editing.later} 則` : ''}`}
              action={{ text: '取消編輯', onPress: cancelEdit }}
            />
          ) : null
        }
        templates={state.templates}
        showTemplateChips={state.messages.length === 0}
        onManageTemplates={() => setTemplatesOpen(true)}
      />

      <Modal visible={sheetOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <ModelSheet store={store} state={state} onClose={() => setSheetOpen(false)} />
      </Modal>
      <Modal visible={listOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setListOpen(false)}>
        <SessionList store={store} currentId={session?.id ?? null} onClose={() => setListOpen(false)} />
      </Modal>
      <Modal visible={settingsOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setSettingsOpen(false)}>
        {session ? <SessionSettings store={store} session={session} onClose={() => setSettingsOpen(false)} /> : null}
      </Modal>
      <Modal visible={templatesOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setTemplatesOpen(false)}>
        <TemplatesSheet store={store} templates={state.templates} onClose={() => setTemplatesOpen(false)} />
      </Modal>
      <ImageViewer images={viewer?.images ?? null} index={viewer?.index ?? 0} onClose={() => setViewer(null)} />
    </KeyboardAvoidingView>
  );
}

const kTokens = (n: number | null) => (n === null ? '?' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function Welcome({ hasHosts, scanning, modelLabel, onOpenModels }: { hasHosts: boolean; scanning: string; modelLabel: string | null; onOpenModels: () => void }) {
  return (
    <View style={styles.welcome}>
      <Text style={styles.welcomeTitle}>
        <Text style={{ color: C.accent }}>◆ </Text>地端聊天
      </Text>
      <Text style={styles.dim}>跟自己電腦上的 Ollama 模型聊天，對話只存在這支手機。</Text>
      <View style={styles.tips}>
        {scanning ? (
          <Text style={styles.dim} accessibilityLiveRegion="polite">
            {scanning}
          </Text>
        ) : !hasHosts ? (
          <Text style={styles.dim}>
            › 還沒有主機：
            <Text style={styles.link} onPress={onOpenModels}>
              按這裡
            </Text>
            掃描區網或手動新增
          </Text>
        ) : (
          <Text style={styles.dim}>› 目前模型：{modelLabel ?? '還沒選，點下方「選擇模型」'}</Text>
        )}
        <Text style={styles.dim}>› 模型看得懂圖時，按 ＋ 可以附照片</Text>
        <Text style={styles.dim}>› 支援思考的模型，下方會出現「思考」開關</Text>
      </View>
    </View>
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
        <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="關閉提示">
          <SymbolView name="xmark" size={12} tintColor={C.secondary} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function HeaderButton({ name, label, onPress, disabled }: { name: SFSymbol; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
      <SymbolView name={name} size={22} tintColor={disabled ? C.tertiary : C.label} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 8 },
  headerSide: { width: 76, flexDirection: 'row' },
  headerRight: { justifyContent: 'flex-end' },
  headerTitle: { textAlign: 'center', ...TEXT.body, fontWeight: '700', color: C.label },
  roleMark: { ...TEXT.meta, color: C.accent, fontWeight: '400' },
  headerButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.4 },
  transcript: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 16, gap: 14 },
  welcome: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator, borderRadius: 10, padding: 16, gap: 6, marginTop: 8 },
  welcomeTitle: { ...TEXT.body, fontSize: 17, fontWeight: '700', color: C.label },
  tips: { marginTop: 10, gap: 4 },
  dim: { ...TEXT.small, color: C.secondary },
  link: { color: C.accent, textDecorationLine: 'underline' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginBottom: 4 },
  bannerText: { ...TEXT.meta, flex: 1 },
  bannerAction: { ...TEXT.meta, color: C.accent, fontWeight: '700' },
});
