import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Image, Keyboard, Linking, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';

import { fmtElapsed } from '../lib/format';
import { friendlyModelName } from '../lib/modelName';
import { dataUri } from '../lib/photos';
import type { Streaming } from '../state/chatStore';
import { isRecordNote, type Attachment, type Message } from '../store/repo';
import { C, TEXT } from '../ui/theme';
import { Markdown } from './Markdown';
import { t } from '../i18n';

type Handlers = {
  /** 回答下方的「模型 · 電腦」：只在換了模型或電腦時顯示（沒給就顯示） */
  showMeta?: boolean;
  onOpenImage: (images: Attachment[], index: number) => void;
  onCopyCode: (code: string) => void;
  onLongPress?: (message: Message) => void;
  /** 最後一則是錯誤時的「重試」「連線說明」 */
  onRetry?: () => void;
  onHelp?: () => void;
  /** 最後一則回答下方直接顯示的「複製」「重新產生」 */
  onCopy?: () => void;
  onRegenerate?: () => void;
  /** 切換回答版本（‹ ›） */
  onSwitchVersion?: (delta: number) => void;
  isLast?: boolean;
  /** 放在 AI 訊息下面的東西（確認卡、做了什麼） */
  extra?: ReactNode;
};

// VoiceOver：整則訊息不能當成一個元素（RN 的 Pressable 預設是），不然裡面的確認卡、重試、複製都按不到；
// 長按選單改成「更多動作」掛在文字上，› • ■ 這些記號不唸
const decorative = { accessibilityElementsHidden: true, importantForAccessibility: 'no' } as const;
function moreActions(onMore?: () => void) {
  return onMore ? { accessibilityActions: [{ name: 'more', label: t('更多動作') }], onAccessibilityAction: () => onMore() } : {};
}

/** 開著 VoiceOver：回答下的「模型 · 電腦」一律顯示（「更多動作」掛在那一行） */
function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isScreenReaderEnabled?.()
      .then(setOn)
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('screenReaderChanged', setOn);
    return () => sub?.remove();
  }, []);
  return on;
}

/** 長按訊息：先輕震一下（跟 iPhone 長按一樣的手感），再開選單 */
function longPress(open: () => void) {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  open();
}

/** 對話裡的一則訊息：› 是你說的、• 是 AI、■ 是錯誤或提示 */
export function MessageView({ message: m, streaming, ...h }: { message: Message; streaming: Streaming | null } & Handlers) {
  const screenReader = useScreenReader();
  const live = streaming?.messageId === m.id ? streaming : null;
  // 程式碼、表格的左右捲裡面要自己接手指（見 Markdown 的 HScroll），點一下、長按做的事跟整則訊息一樣。
  // 函式要固定同一個（Markdown 有 memo，每次換新函式整段都要重畫），內容從 ref 拿最新的
  const latest = useRef({ m, live, onLongPress: h.onLongPress });
  latest.current = { m, live, onLongPress: h.onLongPress };
  const press = useMemo(
    () => ({
      onPress: () => Keyboard.dismiss(),
      onLongPress: () => {
        const { m, live, onLongPress } = latest.current;
        if (!live) longPress(() => onLongPress?.(m));
      },
    }),
    [],
  );
  if (m.role === 'user') {
    return (
      <Pressable accessible={false} onPress={() => Keyboard.dismiss()} onLongPress={() => longPress(() => h.onLongPress?.(m))} delayLongPress={350} testID={`message-${m.id}`}>
        <View style={styles.userBlock}>
          <Text style={styles.userMark} {...decorative}>›</Text>
          <View style={styles.body}>
            {m.attachments.length > 0 && <Thumbnails images={m.attachments} onOpen={h.onOpenImage} />}
            <Text style={styles.text} selectable {...moreActions(h.onLongPress && (() => h.onLongPress!(m)))}>
              {m.content}
            </Text>
          </View>
        </View>
      </Pressable>
    );
  }

  if (m.role === 'tool') {
    // 工具做了什麼，一行帶過（例如「看了行事曆（3 筆）」）；沒有要給使用者看的就不顯示
    if (!m.detail) return null;
    return (
      <View style={styles.aiBlock} testID={`message-${m.id}`}>
        <Text style={styles.aiMark} {...decorative}>•</Text>
        <View style={styles.body}>
          <Text style={[styles.small, styles.dim]}>{m.detail}</Text>
          {m.content.includes('"permission_denied') ? (
            <View style={styles.actions}>
              <ActionButton text={t('打開設定')} onPress={() => void Linking.openSettings()} />
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  if (m.role === 'assistant') {
    const content = live ? live.content : m.content;
    const thinking = live ? live.thinking : m.thinking;
    // 只是叫工具、沒有說話的那一輪：不顯示電腦和模型名稱，也不給複製、重新產生
    const toolTurn = !live && !content && !!m.toolCalls?.length;
    if (toolTurn && !thinking && !h.extra) return null;
    return (
      <Pressable accessible={false} {...press} delayLongPress={350} testID={`message-${m.id}`}>
        <View style={styles.aiBlock}>
          <Text style={styles.aiMark} {...decorative}>•</Text>
          <View style={styles.body}>
            {thinking ? <Thinking text={thinking} live={live?.phase === 'thinking'} press={press} /> : null}
            {content ? <Markdown text={content} onCopyCode={h.onCopyCode} {...press} /> : null}
            {/* 模型回了空白（不是只叫工具）：說清楚，最後一則還可以重新產生 */}
            {!live && !content && !toolTurn ? <Text style={styles.emptyAnswer}>{t('AI 沒有回答。')}</Text> : null}
            {h.extra}
            {live ? (
              <Working streaming={live} />
            ) : toolTurn || (h.showMeta === false && !screenReader && !m.versions) ? null : (
              <View style={styles.metaRow}>
                {m.versions && h.onSwitchVersion ? <Versions versions={m.versions} onSwitch={h.onSwitchVersion} /> : null}
                <Text style={[styles.meta, styles.flex]} {...moreActions(h.onLongPress && (() => h.onLongPress!(m)))}>
                  {metaLine(m)}
                </Text>
              </View>
            )}
            {!live && h.isLast && !toolTurn ? (
              <View style={styles.actions}>
                {content && h.onCopy ? <ActionButton text={t('複製')} onPress={h.onCopy} /> : null}
                {h.onRegenerate ? <ActionButton text={t('重新產生')} onPress={h.onRegenerate} /> : null}
              </View>
            ) : null}
          </View>
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable accessible={false} onPress={() => Keyboard.dismiss()} onLongPress={() => longPress(() => h.onLongPress?.(m))} delayLongPress={350} testID={`message-${m.id}`}>
      <View style={styles.aiBlock}>
        <Text style={[styles.aiMark, m.role === 'error' && styles.red]} {...decorative}>■</Text>
        <View style={styles.body}>
          <Text style={[styles.text, m.role === 'error' ? styles.red : styles.dim]} selectable {...moreActions(h.onLongPress && (() => h.onLongPress!(m)))}>
            {m.content}
          </Text>
          {h.isLast && m.role === 'error' ? <ErrorActions detail={m.detail} onRetry={h.onRetry} onHelp={h.onHelp} /> : null}
          {h.isLast && m.role === 'note' && !isRecordNote(m) && h.onRetry ? (
            <View style={styles.actions}>
              <ActionButton text={t('重新回答')} onPress={h.onRetry} />
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/** 回答版本切換：‹ 2 / 3 › */
function Versions({ versions, onSwitch }: { versions: { index: number; total: number }; onSwitch: (delta: number) => void }) {
  const first = versions.index <= 1;
  const last = versions.index >= versions.total;
  return (
    <View style={styles.versions} accessibilityLabel={t('第 {p0} 個回答，共 {p1} 個', { p0: versions.index, p1: versions.total })}>
      <Pressable onPress={() => onSwitch(-1)} disabled={first} hitSlop={{ top: 14, bottom: 14, left: 16, right: 4 }} accessibilityRole="button" accessibilityLabel={t('上一個回答')}>
        <Text style={[styles.versionArrow, first && styles.versionOff]}>‹</Text>
      </Pressable>
      <Text style={styles.meta}>
        {versions.index} / {versions.total}
      </Text>
      <Pressable onPress={() => onSwitch(1)} disabled={last} hitSlop={{ top: 14, bottom: 14, left: 4, right: 16 }} accessibilityRole="button" accessibilityLabel={t('下一個回答')}>
        <Text style={[styles.versionArrow, last && styles.versionOff]}>›</Text>
      </Pressable>
    </View>
  );
}

/** 錯誤下方：重試、連線說明、詳細資訊（技術細節預設收起） */
function ErrorActions({ detail, onRetry, onHelp }: { detail: string; onRetry?: () => void; onHelp?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.errorActions}>
      <View style={styles.actions}>
        {onRetry ? <ActionButton text={t('重試')} onPress={onRetry} primary /> : null}
        {onHelp ? <ActionButton text={t('連線說明')} onPress={onHelp} /> : null}
        {detail ? <ActionButton text={open ? t('收起詳細資訊') : t('詳細資訊')} onPress={() => setOpen((v) => !v)} /> : null}
      </View>
      {open ? (
        <Text style={[styles.meta, styles.detail]} selectable>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

export function ActionButton({ text, onPress, primary, disabled }: { text: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
      accessibilityRole="button"
      accessibilityState={disabled ? { disabled: true } : undefined}
      style={({ pressed }) => [styles.actionButton, primary && styles.actionPrimary, disabled && styles.actionDisabled, pressed && styles.pressed]}>
      <Text style={[styles.actionText, primary && styles.actionTextPrimary]}>{text}</Text>
    </Pressable>
  );
}

/** 回答下方的小字：電腦 · 模型（速度、時間這些進階資訊放在長按的「詳細資訊」） */
export function metaLine(m: Message): string {
  return [m.model ? friendlyModelName(m.model) : null, m.hostLabel].filter(Boolean).join(' · ');
}

/** 照片縮圖，點了看大圖 */
export function Thumbnails({ images, onOpen }: { images: Attachment[]; onOpen: (images: Attachment[], index: number) => void }) {
  return (
    <View style={styles.thumbs}>
      {images.map((img, i) => (
        <Pressable
          key={img.id}
          onPress={() => onOpen(images, i)}
          accessibilityRole="imagebutton"
          accessibilityLabel={t('照片 {p0}，點一下放大', { p0: i + 1 })}
          style={({ pressed }) => pressed && styles.pressed}>
          <Image source={{ uri: dataUri(img.base64) }} style={styles.thumb} />
        </Pressable>
      ))}
    </View>
  );
}

/** 思考過程：預設收起來，只顯示一行；點了展開 */
function Thinking({ text, live, press }: { text: string; live: boolean; press: { onPress: () => void; onLongPress: () => void } }) {
  const [open, setOpen] = useState(false);
  const lastLine = text.trim().split('\n').filter(Boolean).at(-1) ?? '';
  return (
    <View style={styles.thinking}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? t('收起思考過程') : t('展開思考過程')}
        hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
        <Text style={styles.thinkingHeader}>
          {live ? t('✻ 思考中') : t('✻ 思考過程')}
          <Text style={styles.dim}>{t('（{n} 字）', { n: text.length })}{open ? ' ▾' : ' ▸'}</Text>
        </Text>
      </Pressable>
      {open ? (
        <Markdown text={text} dim {...press} />
      ) : live ? (
        <Text style={[styles.small, styles.dim]} numberOfLines={2}>
          {lastLine}
        </Text>
      ) : null}
    </View>
  );
}

/** 「等待模型 (3s)」「回答中 (12s)」，文字上有一道微光掃過（照 Codex 的 shimmer 做法） */
function Working({ streaming }: { streaming: Streaming }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 80);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, (now - streaming.startedAt) / 1000);
  const waiting = streaming.phase === 'waiting';
  const label = waiting ? (streaming.loading ? t('正在載入模型') : t('等待模型')) : streaming.phase === 'thinking' ? t('思考中') : t('回答中');
  // 等第一個字比較久時說明在等什麼
  const hint = !waiting
    ? null
    : seconds > 90
      ? t('比平常久很多：電腦可能很忙，或記憶體不夠，模型只能用比較慢的方式跑。')
      : streaming.loading && seconds > 3
        ? t('第一次用這個模型，電腦要先把它載入記憶體，大模型可能要 30 秒到 1 分鐘，之後就快了。')
        : streaming.loading === false && seconds > 10
          ? t('電腦正在讀前面的對話，對話越長要越久。')
          : null;
  return (
    <View accessibilityLiveRegion="polite">
      <View style={styles.working} accessible accessibilityLabel={t('{p0}，{p1} 秒', { p0: label, p1: Math.floor(seconds) })}>
        <Shimmer text={label} seconds={seconds} />
        <Text style={[styles.small, styles.dim]}> ({fmtElapsed(seconds)})</Text>
      </View>
      {hint ? <Text style={[styles.small, styles.dim, styles.waitHint]}>{hint}</Text> : null}
    </View>
  );
}

export function Shimmer({ text, seconds }: { text: string; seconds: number }) {
  const scheme = useColorScheme();
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotion)
      .catch(() => {});
  }, []);
  const rgb = scheme === 'dark' ? '235,235,245' : '60,60,67';
  const chars = [...text];
  const padding = 3;
  const band = 2;
  const pos = ((seconds % 2) / 2) * (chars.length + padding * 2); // 每 2 秒掃過一次
  return (
    <Text style={styles.shimmer}>
      {chars.map((ch, i) => {
        const d = Math.abs(i + padding - pos);
        const k = reduceMotion || d > band ? 0 : 0.5 * (1 + Math.cos((Math.PI * d) / band));
        return (
          <Text key={i} style={{ color: `rgba(${rgb},${0.6 + 0.4 * k})` }}>
            {ch}
          </Text>
        );
      })}
    </Text>
  );
}

const styles = StyleSheet.create({
  userBlock: { flexDirection: 'row', gap: 8, backgroundColor: C.surface, borderRadius: 10, padding: 12 },
  userMark: { ...TEXT.body, fontWeight: '700', color: C.secondary },
  aiBlock: { flexDirection: 'row', gap: 8, paddingHorizontal: 12 },
  aiMark: { ...TEXT.body, color: C.secondary },
  body: { flex: 1, gap: 8 },
  text: { ...TEXT.body, color: C.label },
  small: { ...TEXT.small },
  meta: { ...TEXT.meta, color: C.secondary },
  dim: { color: C.secondary },
  red: { color: C.errorText },
  pressed: { opacity: 0.6 },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: C.bg },
  thinking: { gap: 6 },
  thinkingHeader: { ...TEXT.small, color: C.secondary, fontWeight: '600' },
  working: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  waitHint: { marginTop: 2 },
  shimmer: { ...TEXT.body, fontWeight: '700' },
  errorActions: { gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  actionButton: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator },
  emptyAnswer: { ...TEXT.body, color: C.secondary },
  actionDisabled: { opacity: 0.35 },
  actionPrimary: { backgroundColor: C.accentFill, borderColor: C.accentFill },
  actionText: { ...TEXT.meta, color: C.label, fontWeight: '600' },
  actionTextPrimary: { color: '#ffffff' },
  detail: { backgroundColor: C.surface, borderRadius: 6, padding: 8 },
  flex: { flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  versions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  versionArrow: { ...TEXT.body, color: C.accent, fontWeight: '700' },
  versionOff: { color: C.tertiary },
});
