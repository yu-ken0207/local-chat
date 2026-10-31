import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Image, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { friendlyLevel } from '../lib/modelName';
import type { ThinkOption, ThinkSetting } from '../lib/ollama';
import { MAX_PHOTOS, dataUri, type NewPhoto } from '../lib/photos';
import { C, MONO, TEXT } from '../ui/theme';
import { t } from '../i18n';

export type PickSource = 'camera' | 'library';

type Props = {
  /** 「模型，電腦」；還沒選模型時是 null */
  modelLabel: string | null;
  canAttach: boolean;
  /** 讀得到目前模型的資訊（看不看得懂圖）；讀不到時（電腦沒連上、清單還在讀）不能說成「模型看不懂圖片」 */
  modelKnown?: boolean;
  think: ThinkOption | null;
  thinkValue: ThinkSetting | null;
  busy: boolean;
  bottomInset: number;
  onSend: (text: string, photos: NewPhoto[]) => Promise<void>;
  /** 開始在輸入框打字 */
  onInputFocus?: () => void;
  onStop: () => void;
  /** 點模型那顆：打開選模型（深入思考也在那裡開關） */
  onOpenModels: () => void;
  pickPhotos: (source: PickSource, limit: number) => Promise<NewPhoto[] | 'denied'>;
  /** 由外面塞進輸入框的文字（例如提示詞範本、編輯訊息） */
  injected?: { text: string; photos?: NewPhoto[]; nonce: number } | null;
  /** 塞進來的字套用好了（外面可以清掉，輸入框重建時才不會再放一次） */
  onInjected?: () => void;
  /** 輸入框上方的額外內容（例如「編輯中」提示） */
  accessory?: ReactNode;
  /** 還不能送出時輸入框的提示（例如「先連接你的電腦」） */
  notReadyHint?: string;
  /** 輸入框的字變了（多 AI 討論打 @ 時跳出成員清單） */
  onDraftChange?: (text: string) => void;
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

/** 下面那排的圓鈕、模型那顆是 36pt 高：用 hitSlop 補到 44pt */
const ROW_HIT = { top: 4, bottom: 4, left: 4, right: 4 };
/** 模型那顆的字最多放大到 1.3 倍（大字時整排還放得下；訊息內容照樣跟著放大） */
const PILL_MAX_SCALE = 1.3;

/** 輸入框的 nativeID：KeyboardGestureArea 靠它把「往下拖收鍵盤」的起點拉到輸入列上緣 */
export const COMPOSER_INPUT_ID = 'composer-input';

export function Composer(p: Props) {
  const [draft, setDraft] = useState('');
  // 程式換掉輸入框的字（編輯並重送放回訊息、送出後清空、沒送出去放回來）時換一個新的輸入框：
  // RN 0.88 的多行輸入框被程式改字時，量高度用的還是改之前的字（放回四行的訊息時框只有一行高、
  // 清空後還停在四行高），要等再打一個字才對。新的輸入框一開始就照現在的字量
  const [inputKey, setInputKey] = useState(0);
  // 換之前正在打字（鍵盤開著）：新的掛好後把游標放回去，不然鍵盤會收起來（送出時本來就要收，不用）
  const focused = useRef(false);
  const refocus = useRef(false);
  const replaceDraft = (text: string, keepFocus = true) => {
    setDraft(text);
    p.onDraftChange?.(text);
    refocus.current = keepFocus && focused.current;
    setInputKey((k) => k + 1);
  };
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    inputRef.current?.focus();
  }, [inputKey]);
  const [photos, setPhotos] = useState<NewPhoto[]>([]);
  const [hint, setHint] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);

  const modelKnown = p.modelKnown ?? true;
  // 換成看不懂圖的模型時，拿掉已附的照片並提示（讀不到模型資訊時不算：可能只是電腦一時連不上）
  useEffect(() => {
    if (modelKnown && !p.canAttach && photos.length > 0) {
      setPhotos([]);
      setHint(t('目前的模型看不懂圖片，已移除附上的照片。'));
    }
  }, [modelKnown, p.canAttach, photos.length]);
  // 按「＋」時說的原因（還沒選模型／讀不到模型資訊／看不懂圖片）：原因變了就收掉，不留著舊的說法
  const attachHintShown = useRef(false);
  useEffect(() => {
    if (!attachHintShown.current) return;
    attachHintShown.current = false;
    setHint('');
  }, [p.modelLabel, modelKnown, p.canAttach]);
  // 「＋」灰掉的原因：還沒選模型、讀不到模型資訊、模型看不懂圖，各說各的
  const attachBlocked =
    p.modelLabel === null
      ? { label: t('附加照片（還沒選模型）'), hint: t('先選一個模型，才能附照片。') }
      : !modelKnown
        ? { label: t('附加照片（還沒讀到模型的資訊）'), hint: t('還沒讀到這個模型的資訊（電腦可能沒連上），讀到了才知道能不能附照片。') }
        : { label: t('附加照片（目前的模型看不懂圖片）'), hint: t('目前的模型看不懂圖片。換一個看得懂圖的模型，才能附照片。') };

  useEffect(() => {
    if (!p.injected) return;
    replaceDraft(p.injected.text);
    // 確定模型看不懂圖片才不放回照片；讀不到模型資訊時照樣放回（之後送出時才會知道）
    if (p.injected.photos) setPhotos(modelKnown && !p.canAttach ? [] : p.injected.photos);
    p.onInjected?.();
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
    replaceDraft('', false);
    setPhotos([]);
    try {
      await p.onSend(text, pics);
    } catch (e: any) {
      replaceDraft(text, false);
      setPhotos(pics);
      Alert.alert(t('沒有送出'), e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  }

  // 模型那顆上的思考：開著才寫（分程度的寫程度、一定會思考的也寫）；讀螢幕另外唸開或關
  const always = p.think?.kind === 'always';
  const level = p.think?.kind === 'levels' ? friendlyLevel(String(p.thinkValue || p.think.defaultLevel)) : '';
  const thinkShort = !p.think ? '' : level ? t('思考：{p0}', { p0: level }) : always || p.thinkValue ? t('思考') : '';
  const thinkSpoken = !p.think ? '' : always ? t('一定會先思考') : level ? t('深入思考：{p0}', { p0: level }) : p.thinkValue ? t('深入思考：開') : t('深入思考：關');

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
        <TextInput
          key={inputKey}
          ref={inputRef}
          nativeID={COMPOSER_INPUT_ID}
          style={styles.input}
          value={draft}
          onChangeText={(text) => {
            setDraft(text);
            p.onDraftChange?.(text);
          }}
          onFocus={() => {
            focused.current = true;
            p.onInputFocus?.();
          }}
          onBlur={() => (focused.current = false)}
          placeholder={p.modelLabel ? t('輸入訊息') : (p.notReadyHint ?? t('先在下方選一個模型'))}
          placeholderTextColor={C.placeholder}
          multiline
          accessibilityLabel={t('訊息輸入框')}
        />
        {/* 下面一排：＋、模型（跟思考合成一顆）、送出 */}
        <View style={styles.toolbar}>
          <IconButton
            name="plus"
            label={p.canAttach ? t('附加照片') : attachBlocked.label}
            // 不能附照片：灰的但按得到，按了說原因（不然按了沒反應，不知道為什麼）
            onPress={
              p.canAttach
                ? openAttach
                : () => {
                    attachHintShown.current = true;
                    setHint(attachBlocked.hint);
                  }
            }
            dimmed={!p.canAttach}
            disabled={p.busy || photos.length >= MAX_PHOTOS}
          />
          <Pressable
            onPress={p.onOpenModels}
            hitSlop={ROW_HIT}
            accessibilityRole="button"
            accessibilityLabel={t('模型：{p0}，點一下切換', { p0: p.modelLabel ?? t('還沒選') })}
            accessibilityValue={thinkSpoken ? { text: thinkSpoken } : undefined}
            style={({ pressed }) => [styles.modelPill, pressed && styles.pressed]}
            testID="model-pill">
            <Text style={[styles.pillText, !p.modelLabel && { color: C.accent }]} numberOfLines={1} maxFontSizeMultiplier={PILL_MAX_SCALE}>
              {p.modelLabel ?? t('選擇模型')}
            </Text>
            {thinkShort ? (
              <Text style={styles.pillThink} numberOfLines={1} maxFontSizeMultiplier={PILL_MAX_SCALE}>
                {thinkShort}
              </Text>
            ) : null}
          </Pressable>
          <View style={styles.spacer} />
          {p.busy ? (
            <IconButton name="stop.fill" label={t('停止回答')} kind="stop" onPress={p.onStop} />
          ) : (
            <IconButton name="arrow.up" label={t('送出')} kind="send" disabled={!canSend} onPress={() => void send()} />
          )}
        </View>
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
  kind = 'plain',
}: {
  name: SFSymbol;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** 看起來是灰的、但還能按（按了說為什麼不能用） */
  dimmed?: boolean;
  /** plain：灰底圓鈕（＋）；send：強調色圓底白箭頭；stop：深色圓底 */
  kind?: 'plain' | 'send' | 'stop';
}) {
  const off = disabled || dimmed;
  const bg = kind === 'send' && !off ? C.accentFill : kind === 'stop' ? C.label : C.pressed;
  const tint = kind === 'send' && !off ? '#ffffff' : kind === 'stop' ? C.bg : off ? C.tertiary : C.label;
  return (
    <Pressable
      onPress={onPress}
      // 只在真的停用時才給 disabled：Pressable 收到 false 也會蓋掉 accessibilityState 的 disabled（灰掉但能按的就說不出來）
      disabled={disabled || undefined}
      hitSlop={ROW_HIT}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!dimmed }}
      style={({ pressed }) => [styles.circle, { backgroundColor: bg }, pressed && styles.pressedIcon]}>
      <SymbolView name={name} size={kind === 'stop' ? 13 : 17} weight="semibold" tintColor={tint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 6, gap: 6, backgroundColor: C.bg },
  hint: { ...TEXT.meta, color: C.warnText, marginHorizontal: 8 },
  // 一整塊圓角框：字在上面，下面一排按鈕（像 Claude App 的輸入框）
  composer: { backgroundColor: C.surface, borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 8, gap: 4 },
  attachments: { flexDirection: 'row', gap: 10, paddingHorizontal: 6, paddingTop: 8 },
  attachment: {},
  attachmentImage: { width: 56, height: 56, borderRadius: 8 },
  remove: { position: 'absolute', top: -8, right: -8, backgroundColor: C.surface, borderRadius: 10 },
  input: { fontFamily: MONO, fontSize: 15, lineHeight: 21, color: C.label, paddingVertical: 8, paddingHorizontal: 8, minHeight: 38, maxHeight: 140 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  spacer: { flex: 1 },
  circle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  pressedIcon: { opacity: 0.5, transform: [{ scale: 0.92 }] },
  // 模型那顆：放不下時縮模型名（截掉後面），思考的字不縮
  modelPill: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: C.pressed, flexShrink: 1 },
  pillText: { ...TEXT.small, color: C.label, flexShrink: 1 },
  pillThink: { ...TEXT.small, color: C.secondary, flexShrink: 0 },
  pressed: { opacity: 0.4 },
});
