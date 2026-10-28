import { useEffect, useState } from 'react';
import { AccessibilityInfo, Image, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';

import { fmtElapsed } from '../lib/format';
import { friendlyModelName } from '../lib/modelName';
import { dataUri } from '../lib/photos';
import type { Streaming } from '../state/chatStore';
import type { Attachment, Message } from '../store/repo';
import { C, TEXT } from '../ui/theme';
import { Markdown } from './Markdown';

type Handlers = {
  onOpenImage: (images: Attachment[], index: number) => void;
  onCopyCode: (code: string) => void;
  onLongPress?: (message: Message) => void;
  /** 最後一則是錯誤時的「重試」「連線說明」 */
  onRetry?: () => void;
  onHelp?: () => void;
  /** 最後一則回答下方直接顯示的「複製」「重新產生」 */
  onCopy?: () => void;
  onRegenerate?: () => void;
  isLast?: boolean;
};

/** 對話裡的一則訊息：› 是你說的、• 是 AI、■ 是錯誤或提示 */
export function MessageView({ message: m, streaming, ...h }: { message: Message; streaming: Streaming | null } & Handlers) {
  if (m.role === 'user') {
    return (
      <Pressable onLongPress={() => h.onLongPress?.(m)} delayLongPress={350} testID={`message-${m.id}`}>
        <View style={styles.userBlock}>
          <Text style={styles.userMark}>›</Text>
          <View style={styles.body}>
            {m.attachments.length > 0 && <Thumbnails images={m.attachments} onOpen={h.onOpenImage} />}
            <Text style={styles.text} selectable>
              {m.content}
            </Text>
          </View>
        </View>
      </Pressable>
    );
  }

  if (m.role === 'assistant') {
    const live = streaming?.messageId === m.id ? streaming : null;
    const content = live ? live.content : m.content;
    const thinking = live ? live.thinking : m.thinking;
    return (
      <Pressable onLongPress={() => !live && h.onLongPress?.(m)} delayLongPress={350} testID={`message-${m.id}`}>
        <View style={styles.aiBlock}>
          <Text style={styles.aiMark}>•</Text>
          <View style={styles.body}>
            {thinking ? <Thinking text={thinking} live={live?.phase === 'thinking'} /> : null}
            {content ? <Markdown text={content} onCopyCode={h.onCopyCode} /> : null}
            {live ? <Working streaming={live} /> : <Text style={styles.meta}>{metaLine(m)}</Text>}
            {!live && h.isLast && content ? (
              <View style={styles.actions}>
                {h.onCopy ? <ActionButton text="複製" onPress={h.onCopy} /> : null}
                {h.onRegenerate ? <ActionButton text="重新產生" onPress={h.onRegenerate} /> : null}
              </View>
            ) : null}
          </View>
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable onLongPress={() => h.onLongPress?.(m)} delayLongPress={350} testID={`message-${m.id}`}>
      <View style={styles.aiBlock}>
        <Text style={[styles.aiMark, m.role === 'error' && styles.red]}>■</Text>
        <View style={styles.body}>
          <Text style={[styles.text, m.role === 'error' ? styles.red : styles.dim]} selectable>
            {m.content}
          </Text>
          {h.isLast && m.role === 'error' ? <ErrorActions detail={m.detail} onRetry={h.onRetry} onHelp={h.onHelp} /> : null}
          {h.isLast && m.role === 'note' && h.onRetry ? (
            <View style={styles.actions}>
              <ActionButton text="重新回答" onPress={h.onRetry} />
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/** 錯誤下方：重試、連線說明、詳細資訊（技術細節預設收起） */
function ErrorActions({ detail, onRetry, onHelp }: { detail: string; onRetry?: () => void; onHelp?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.errorActions}>
      <View style={styles.actions}>
        {onRetry ? <ActionButton text="重試" onPress={onRetry} primary /> : null}
        {onHelp ? <ActionButton text="連線說明" onPress={onHelp} /> : null}
        {detail ? <ActionButton text={open ? '收起詳細資訊' : '詳細資訊'} onPress={() => setOpen((v) => !v)} /> : null}
      </View>
      {open ? (
        <Text style={[styles.meta, styles.detail]} selectable>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

export function ActionButton({ text, onPress, primary }: { text: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      style={({ pressed }) => [styles.actionButton, primary && styles.actionPrimary, pressed && styles.pressed]}>
      <Text style={[styles.actionText, primary && styles.actionTextPrimary]}>{text}</Text>
    </Pressable>
  );
}

/** 回答下方的小字：電腦 · 模型（速度、時間這些進階資訊放在長按的「詳細資訊」） */
export function metaLine(m: Message): string {
  return [m.hostLabel, m.model ? friendlyModelName(m.model) : null].filter(Boolean).join(' · ');
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
          accessibilityLabel={`照片 ${i + 1}，點一下放大`}
          style={({ pressed }) => pressed && styles.pressed}>
          <Image source={{ uri: dataUri(img.base64) }} style={styles.thumb} />
        </Pressable>
      ))}
    </View>
  );
}

/** 思考過程：預設收起來，只顯示一行；點了展開 */
function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const lastLine = text.trim().split('\n').filter(Boolean).at(-1) ?? '';
  return (
    <View style={styles.thinking}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? '收起思考過程' : '展開思考過程'}
        hitSlop={6}>
        <Text style={styles.thinkingHeader}>
          {live ? '✻ 思考中' : '✻ 思考過程'}
          <Text style={styles.dim}>（{text.length} 字）{open ? ' ▾' : ' ▸'}</Text>
        </Text>
      </Pressable>
      {open ? (
        <Markdown text={text} dim />
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
  const label = streaming.phase === 'waiting' ? '等待模型' : streaming.phase === 'thinking' ? '思考中' : '回答中';
  return (
    <View style={styles.working} accessibilityLiveRegion="polite" accessibilityLabel={`${label}，${Math.floor(seconds)} 秒`}>
      <Shimmer text={label} seconds={seconds} />
      <Text style={[styles.small, styles.dim]}> ({fmtElapsed(seconds)})</Text>
      {streaming.phase === 'waiting' && seconds > 8 ? (
        <Text style={[styles.small, styles.dim]}>　第一次用這個模型要先載入</Text>
      ) : null}
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
          <Text key={i} style={{ color: `rgba(${rgb},${0.45 + 0.55 * k})` }}>
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
  meta: { ...TEXT.meta, color: C.tertiary },
  dim: { color: C.secondary },
  red: { color: C.red },
  pressed: { opacity: 0.6 },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: C.bg },
  thinking: { gap: 6 },
  thinkingHeader: { ...TEXT.small, color: C.secondary, fontWeight: '600' },
  working: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  shimmer: { ...TEXT.body, fontWeight: '700' },
  errorActions: { gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  actionButton: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator },
  actionPrimary: { backgroundColor: C.accent, borderColor: C.accent },
  actionText: { ...TEXT.meta, color: C.label, fontWeight: '600' },
  actionTextPrimary: { color: '#ffffff' },
  detail: { backgroundColor: C.surface, borderRadius: 6, padding: 8 },
});
