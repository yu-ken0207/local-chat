import * as Haptics from 'expo-haptics';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Image, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View, type ColorValue } from 'react-native';

import { friendlyLevel } from '../lib/modelName';
import type { ThinkOption, ThinkSetting } from '../lib/ollama';
import { MAX_PHOTOS, dataUri, type NewPhoto } from '../lib/photos';
import { C, MONO, TEXT } from '../ui/theme';
import { t } from '../i18n';

export type PickSource = 'camera' | 'library';

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
  /** 輸入框上方的額外內容（例如「編輯中」提示） */
  accessory?: ReactNode;
  /** 還不能送出時輸入框的提示（例如「先連接你的電腦」） */
  notReadyHint?: string;
};

/** 選項清單：iOS 用系統的動作表，其他平台用對話框；destructive 是刪除這類危險選項的位置（顯示成紅色） */
export function chooseOption(title: string, options: string[], onPick: (index: number) => void, destructive?: number) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [...options, t('取消')], cancelButtonIndex: options.length, destructiveButtonIndex: destructive }, (i) => {
      if (i < options.length) onPick(i);
    });
  } else {
    Alert.alert(title, undefined, [
      ...options.map((text, i) => ({ text, onPress: () => onPick(i), style: i === destructive ? ('destructive' as const) : undefined })),
      { text: t('取消'), style: 'cancel' as const },
    ]);
  }
}

/** 底下那排的按鈕不到 44pt 高：外觀不變，用 hitSlop 補足可以按的範圍 */
const PILL_HIT = { top: 10, bottom: 10, left: 4, right: 4 };
/** 底下那排的字最多放大到 1.3 倍（大字時整排還放得下；訊息內容照樣跟著放大） */
const FOOTER_MAX_SCALE = 1.3;

/** 輸入框的 nativeID：KeyboardGestureArea 靠它把「往下拖收鍵盤」的起點拉到輸入列上緣 */
export const COMPOSER_INPUT_ID = 'composer-input';

export function Composer(p: Props) {
  const [draft, setDraft] = useState('');
  const [photos, setPhotos] = useState<NewPhoto[]>([]);
  const [hint, setHint] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);

  // 換成看不懂圖的模型時，拿掉已附的照片並提示
  useEffect(() => {
    if (!p.canAttach && photos.length > 0) {
      setPhotos([]);
      setHint(t('目前的模型看不懂圖片，已移除附上的照片。'));
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
      setHint(t('一則訊息最多附 {p0} 張照片。', { p0: MAX_PHOTOS }));
      return;
    }
    try {
      const got = await p.pickPhotos(source, room);
      if (got === 'denied') {
        Alert.alert(t('沒有相機權限'), t('請到「設定」允許 Expo Go 使用相機。'), [
          { text: t('取消'), style: 'cancel' },
          { text: t('前往設定'), onPress: () => Linking.openSettings() },
        ]);
        return;
      }
      setPhotos((prev) => [...prev, ...got].slice(0, MAX_PHOTOS));
    } catch (e: any) {
      Alert.alert(t('照片處理失敗'), e?.message ?? String(e));
    }
  }

  function openAttach() {
    chooseOption(t('附加照片'), [t('拍照'), t('從相簿選擇')], (i) => add((['camera', 'library'] as const)[i]));
  }

  async function send() {
    if (!canSend) return;
    // 按下就清空輸入框（回答要等很久）；訊息沒送出去才把字和照片放回來
    const text = draft;
    const pics = photos;
    setSending(true);
    setHint('');
    setDraft('');
    setPhotos([]);
    try {
      await p.onSend(text, pics);
    } catch (e: any) {
      setDraft(text);
      setPhotos(pics);
      Alert.alert(t('沒有送出'), e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  }

  function pressThink() {
    if (!p.think) return;
    Haptics.selectionAsync();
    if (p.think.kind === 'always') {
      Alert.alert(t('一定會先思考'), t('這個模型每次都會先思考再回答，沒辦法關掉。思考過程收在回答上方，可以點開看。'));
    } else if (p.think.kind === 'toggle') {
      p.onThink(!p.thinkValue);
    } else {
      const levels = p.think.levels;
      chooseOption(t('深入思考的程度（越仔細越慢）'), levels.map(friendlyLevel), (i) => p.onThink(levels[i]));
    }
  }

  const always = p.think?.kind === 'always';
  const thinkOn = always || !!p.thinkValue;
  const thinkText =
    p.think?.kind === 'always'
      ? t('一定會先思考')
      : p.think?.kind === 'toggle'
      ? t('深入思考：{p0}', { p0: p.thinkValue ? t('開') : t('關') })
      : p.think
        ? t('深入思考：{p0}', { p0: friendlyLevel(String(p.thinkValue ?? p.think.defaultLevel)) })
        : '';


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
                  hitSlop={12}
                  style={styles.remove}
                  accessibilityRole="button"
                  accessibilityLabel={t('移除照片 {p0}', { p0: i + 1 })}>
                  <SymbolView name="xmark.circle.fill" size={20} tintColor={C.secondary} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <View style={styles.inputRow}>
          <IconButton
            name="plus"
            label={p.canAttach ? t('附加照片') : t('附加照片（目前的模型看不懂圖片）')}
            // 模型看不懂圖：灰的但按得到，按了說原因（不然按了沒反應，不知道為什麼）
            onPress={p.canAttach ? openAttach : () => setHint(t('目前的模型看不懂圖片。換一個看得懂圖的模型，才能附照片。'))}
            dimmed={!p.canAttach}
            disabled={p.busy || photos.length >= MAX_PHOTOS}
          />
          <TextInput
            ref={inputRef}
            nativeID={COMPOSER_INPUT_ID}
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={p.modelLabel ? t('輸入訊息') : (p.notReadyHint ?? t('先在下方選一個模型'))}
            placeholderTextColor={C.placeholder}
            multiline
            accessibilityLabel={t('訊息輸入框')}
          />
          {p.busy ? (
            <IconButton name="stop.circle.fill" label={t('停止回答')} size={30} color={C.label} onPress={p.onStop} />
          ) : (
            <IconButton name="arrow.up.circle.fill" label={t('送出')} size={30} color={C.accent} disabled={!canSend} onPress={() => void send()} />
          )}
        </View>
      </View>
      <View style={styles.footer}>
        <Pressable
          onPress={p.onOpenModels}
          hitSlop={PILL_HIT}
          accessibilityRole="button"
          accessibilityLabel={t('模型：{p0}，點一下切換', { p0: p.modelLabel ?? t('還沒選') })}
          style={({ pressed }) => [styles.pill, pressed && styles.pressed]}>
          <Text style={[styles.footerText, !p.modelLabel && { color: C.accent }]} numberOfLines={1} maxFontSizeMultiplier={FOOTER_MAX_SCALE}>
            {p.modelLabel ?? t('選擇模型')}
          </Text>
          <SymbolView name="chevron.up.chevron.down" size={11} tintColor={C.secondary} />
        </Pressable>
        {p.think ? (
          <Pressable
            onPress={pressThink}
            hitSlop={PILL_HIT}
            accessibilityRole={p.think.kind === 'toggle' ? 'switch' : 'button'}
            accessibilityState={p.think.kind === 'toggle' ? { checked: !!p.thinkValue } : undefined}
            accessibilityLabel={thinkText}
            style={({ pressed }) => [styles.pill, styles.pillFixed, thinkOn ? styles.pillOn : null, pressed && styles.pressed]}>
            <SymbolView name="lightbulb" size={11} tintColor={thinkOn ? C.accent : C.secondary} />
            <Text style={[styles.footerText, thinkOn ? { color: C.accent } : null]} numberOfLines={1} maxFontSizeMultiplier={FOOTER_MAX_SCALE}>
              {thinkText}
            </Text>
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
  dimmed,
  size = 24,
  color,
}: {
  name: SFSymbol;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** 看起來是灰的、但還能按（按了說為什麼不能用） */
  dimmed?: boolean;
  size?: number;
  color?: ColorValue;
}) {
  return (
    <Pressable
      onPress={onPress}
      // 只在真的停用時才給 disabled：Pressable 收到 false 也會蓋掉 accessibilityState 的 disabled（灰掉但能按的就說不出來）
      disabled={disabled || undefined}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!dimmed }}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressedIcon]}>
      <SymbolView name={name} size={size} tintColor={disabled || dimmed ? C.tertiary : (color ?? C.label)} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 6, gap: 6, backgroundColor: C.bg },
  hint: { ...TEXT.meta, color: C.warnText, marginHorizontal: 8 },
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
  // 兩顆都有細框，看得出是按鈕；放不下時只縮模型那顆（截掉的是後面的電腦名），深入思考不縮，字不會跑出框外
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 12, flexShrink: 1, borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator },
  pillFixed: { flexShrink: 0 },
  pillOn: { backgroundColor: C.surface },
  footerText: { ...TEXT.meta, color: C.secondary },
  pressed: { opacity: 0.4 },
});
