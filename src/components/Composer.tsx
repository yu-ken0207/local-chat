import * as Haptics from 'expo-haptics';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useEffect, useState, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Image, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View, type ColorValue } from 'react-native';

import type { ThinkOption, ThinkSetting } from '../lib/ollama';
import { MAX_PHOTOS, dataUri, type NewPhoto } from '../lib/photos';
import { C, MONO, TEXT } from '../ui/theme';

export type PickSource = 'camera' | 'library' | 'clipboard';

type Props = {
  /** 「主機 · 模型」；還沒選模型時是 null */
  modelLabel: string | null;
  canAttach: boolean;
  think: ThinkOption | null;
  thinkValue: ThinkSetting | null;
  busy: boolean;
  bottomInset: number;
  onSend: (text: string, photos: NewPhoto[]) => Promise<void>;
  onStop: () => void;
  onOpenModels: () => void;
  onThink: (value: ThinkSetting) => void;
  pickPhotos: (source: PickSource, limit: number) => Promise<NewPhoto[] | 'denied'>;
  /** 由外面塞進輸入框的文字（例如提示詞範本、編輯訊息） */
  injected?: { text: string; photos?: NewPhoto[]; nonce: number } | null;
  /** 輸入框上方的額外按鈕列（提示詞範本） */
  accessory?: ReactNode;
};

/** 選項清單：iOS 用系統的動作表，其他平台用對話框 */
export function chooseOption(title: string, options: string[], onPick: (index: number) => void) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [...options, '取消'], cancelButtonIndex: options.length }, (i) => {
      if (i < options.length) onPick(i);
    });
  } else {
    Alert.alert(title, undefined, [...options.map((text, i) => ({ text, onPress: () => onPick(i) })), { text: '取消', style: 'cancel' as const }]);
  }
}

export function Composer(p: Props) {
  const [draft, setDraft] = useState('');
  const [photos, setPhotos] = useState<NewPhoto[]>([]);
  const [hint, setHint] = useState('');
  const [sending, setSending] = useState(false);

  // 換成看不懂圖的模型時，拿掉已附的照片並提示
  useEffect(() => {
    if (!p.canAttach && photos.length > 0) {
      setPhotos([]);
      setHint('目前的模型看不懂圖片，已移除附上的照片。');
    }
  }, [p.canAttach, photos.length]);

  useEffect(() => {
    if (!p.injected) return;
    setDraft(p.injected.text);
    if (p.injected.photos) setPhotos(p.canAttach ? p.injected.photos : []);
  }, [p.injected?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const canSend = !p.busy && !sending && !!p.modelLabel && (draft.trim().length > 0 || photos.length > 0);

  async function add(source: PickSource) {
    setHint('');
    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) {
      setHint(`一則訊息最多附 ${MAX_PHOTOS} 張照片。`);
      return;
    }
    try {
      const got = await p.pickPhotos(source, room);
      if (got === 'denied') {
        Alert.alert('沒有相機權限', '請到「設定」允許 Expo Go 使用相機。', [
          { text: '取消', style: 'cancel' },
          { text: '前往設定', onPress: () => Linking.openSettings() },
        ]);
        return;
      }
      if (source === 'clipboard' && got.length === 0) setHint('剪貼簿裡沒有圖片。');
      setPhotos((prev) => [...prev, ...got].slice(0, MAX_PHOTOS));
    } catch (e: any) {
      Alert.alert('照片處理失敗', e?.message ?? String(e));
    }
  }

  function openAttach() {
    chooseOption('附加照片', ['拍照', '從相簿選擇', '從剪貼簿貼上'], (i) => add((['camera', 'library', 'clipboard'] as const)[i]));
  }

  async function send() {
    if (!canSend) return;
    setSending(true);
    setHint('');
    try {
      await p.onSend(draft, photos);
      setDraft('');
      setPhotos([]);
    } catch (e: any) {
      Alert.alert('沒有送出', e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  }

  function pressThink() {
    if (!p.think) return;
    Haptics.selectionAsync();
    if (p.think.kind === 'toggle') {
      p.onThink(!p.thinkValue);
    } else {
      const levels = p.think.levels;
      chooseOption('思考程度', levels, (i) => p.onThink(levels[i]));
    }
  }

  const thinkText =
    p.think?.kind === 'toggle' ? `思考 ${p.thinkValue ? '開' : '關'}` : p.think ? `思考 ${String(p.thinkValue ?? p.think.defaultLevel)}` : '';

  return (
    <View style={[styles.wrap, { paddingBottom: p.bottomInset }]}>
      {p.accessory}
      {hint ? (
        <Text style={styles.hint} accessibilityLiveRegion="polite">
          {hint}
        </Text>
      ) : null}
      <View style={styles.composer}>
        {photos.length > 0 && (
          <View style={styles.attachments}>
            {photos.map((ph, i) => (
              <View key={i} style={styles.attachment}>
                <Image source={{ uri: dataUri(ph.base64) }} style={styles.attachmentImage} />
                <Pressable
                  onPress={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                  hitSlop={8}
                  style={styles.remove}
                  accessibilityRole="button"
                  accessibilityLabel={`移除照片 ${i + 1}`}>
                  <SymbolView name="xmark.circle.fill" size={20} tintColor={C.secondary} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <View style={styles.inputRow}>
          <IconButton
            name="plus"
            label={p.canAttach ? '附加照片' : '附加照片（目前的模型看不懂圖片）'}
            onPress={openAttach}
            disabled={!p.canAttach || p.busy || photos.length >= MAX_PHOTOS}
          />
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={p.modelLabel ? '輸入訊息…' : '先在下方選一個模型'}
            placeholderTextColor={C.placeholder}
            multiline
            accessibilityLabel="訊息輸入框"
          />
          {p.busy ? (
            <IconButton name="stop.circle.fill" label="停止回答" size={30} color={C.label} onPress={p.onStop} />
          ) : (
            <IconButton name="arrow.up.circle.fill" label="送出" size={30} color={C.accent} disabled={!canSend} onPress={() => void send()} />
          )}
        </View>
      </View>
      <View style={styles.footer}>
        <Pressable
          onPress={p.onOpenModels}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`模型：${p.modelLabel ?? '還沒選'}，點一下切換`}
          style={({ pressed }) => [styles.pill, pressed && styles.pressed]}>
          <Text style={[styles.footerText, !p.modelLabel && { color: C.accent }]} numberOfLines={1}>
            {p.modelLabel ?? '選擇模型'}
          </Text>
          <SymbolView name="chevron.up.chevron.down" size={11} tintColor={C.secondary} />
        </Pressable>
        {p.think ? (
          <Pressable
            onPress={pressThink}
            hitSlop={6}
            accessibilityRole={p.think.kind === 'toggle' ? 'switch' : 'button'}
            accessibilityState={p.think.kind === 'toggle' ? { checked: !!p.thinkValue } : undefined}
            accessibilityLabel={thinkText}
            style={({ pressed }) => [styles.pill, p.thinkValue ? styles.pillOn : null, pressed && styles.pressed]}>
            <SymbolView name="lightbulb" size={11} tintColor={p.thinkValue ? C.accent : C.secondary} />
            <Text style={[styles.footerText, p.thinkValue ? { color: C.accent } : null]}>{thinkText}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function IconButton({
  name,
  label,
  onPress,
  disabled,
  size = 24,
  color,
}: {
  name: SFSymbol;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  size?: number;
  color?: ColorValue;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressedIcon]}>
      <SymbolView name={name} size={size} tintColor={disabled ? C.tertiary : (color ?? C.label)} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 6, gap: 6, backgroundColor: C.bg },
  hint: { ...TEXT.meta, color: C.orange, marginHorizontal: 8 },
  composer: { backgroundColor: C.surface, borderRadius: 20, padding: 6, gap: 6 },
  attachments: { flexDirection: 'row', gap: 10, paddingHorizontal: 8, paddingTop: 6 },
  attachment: {},
  attachmentImage: { width: 56, height: 56, borderRadius: 8 },
  remove: { position: 'absolute', top: -8, right: -8, backgroundColor: C.surface, borderRadius: 10 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  input: { flex: 1, fontFamily: MONO, fontSize: 15, lineHeight: 21, color: C.label, paddingVertical: 8, paddingHorizontal: 4, minHeight: 38, maxHeight: 140 },
  iconButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 19 },
  pressedIcon: { opacity: 0.5, transform: [{ scale: 0.92 }] },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 6 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 12, flexShrink: 1 },
  pillOn: { backgroundColor: C.surface },
  footerText: { ...TEXT.meta, color: C.secondary },
  pressed: { opacity: 0.4 },
});
