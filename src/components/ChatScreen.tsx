import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { NewPhoto } from '../lib/photos';
import type { ChatStore } from '../state/chatStore';
import { useChatState } from '../state/useChat';
import type { Attachment, Message } from '../store/repo';
import { C, TEXT } from '../ui/theme';
import { Composer, type PickSource } from './Composer';
import { ImageViewer } from './ImageViewer';
import { MessageView } from './Messages';
import { ModelSheet } from './ModelSheet';

export type ChatScreenProps = {
  store: ChatStore;
  pickPhotos: (source: PickSource, limit: number) => Promise<NewPhoto[] | 'denied'>;
  copyText: (text: string) => void;
  /** 標題列左邊的按鈕（對話清單） */
  headerLeft?: ReactNode;
  /** 長按訊息 */
  onMessageMenu?: (message: Message) => void;
  /** 由外面塞進輸入框的內容 */
  injected?: { text: string; photos?: NewPhoto[]; nonce: number } | null;
  composerAccessory?: ReactNode;
};

export function ChatScreen(p: ChatScreenProps) {
  const { store } = p;
  const state = useChatState(store);
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const nearBottom = useRef(true);
  const [sheetOpen, setSheetOpen] = useState(false);
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
        <View style={styles.headerSide}>{p.headerLeft}</View>
        <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
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
          <Welcome hasHosts={state.hosts.length > 0} modelLabel={modelLabel} onOpenModels={() => setSheetOpen(true)} />
        ) : (
          state.messages.map((m) => (
            <MessageView
              key={m.id}
              message={m}
              streaming={state.streaming}
              onOpenImage={(images, index) => setViewer({ images, index })}
              onCopyCode={p.copyText}
              onLongPress={p.onMessageMenu}
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
          await store.send(text, photos);
        }}
        onStop={() => store.stop()}
        onOpenModels={() => setSheetOpen(true)}
        onThink={(v) => store.setThink(v)}
        pickPhotos={p.pickPhotos}
        injected={p.injected}
        accessory={p.composerAccessory}
      />

      <Modal visible={sheetOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <ModelSheet store={store} state={state} onClose={() => setSheetOpen(false)} />
      </Modal>
      <ImageViewer images={viewer?.images ?? null} index={viewer?.index ?? 0} onClose={() => setViewer(null)} />
    </KeyboardAvoidingView>
  );
}

const kTokens = (n: number | null) => (n === null ? '?' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function Welcome({ hasHosts, modelLabel, onOpenModels }: { hasHosts: boolean; modelLabel: string | null; onOpenModels: () => void }) {
  return (
    <View style={styles.welcome}>
      <Text style={styles.welcomeTitle}>
        <Text style={{ color: C.accent }}>◆ </Text>地端聊天
      </Text>
      <Text style={styles.dim}>跟自己電腦上的 Ollama 模型聊天，對話只存在這支手機。</Text>
      <View style={styles.tips}>
        {!hasHosts ? (
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

function Banner({ text, tone, onClose, action }: { text: string; tone: 'warn' | 'error'; onClose?: () => void; action?: { text: string; onPress: () => void } }) {
  return (
    <View style={styles.banner} accessibilityLiveRegion="polite">
      <Text style={[styles.bannerText, { color: tone === 'error' ? C.red : C.orange }]}>{text}</Text>
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
  headerTitle: { flex: 1, textAlign: 'center', ...TEXT.body, fontWeight: '700', color: C.label },
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
