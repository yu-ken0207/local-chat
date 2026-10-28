import * as Haptics from 'expo-haptics';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Image, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ColorValue } from 'react-native';

import { friendlyLevel } from '../lib/modelName';
import type { ThinkOption, ThinkSetting } from '../lib/ollama';
import { MAX_PHOTOS, dataUri, type NewPhoto } from '../lib/photos';
import type { Template } from '../store/repo';
import { C, MONO, TEXT } from '../ui/theme';
import { t } from '../i18n';

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
  /** 輸入框上方的額外內容（例如「編輯中」提示） */
  accessory?: ReactNode;
  templates?: Template[];
  /** 輸入框空白時顯示範本按鈕（新對話時） */
  showTemplateChips?: boolean;
  onManageTemplates?: () => void;
};

/** 輸入 / 開頭時，依 / 後面的字篩選範本（比對標題） */
export function matchTemplates(draft: string, templates: Template[]): Template[] | null {
  if (!draft.startsWith('/') || draft.includes('\n')) return null;
  const q = draft.slice(1).trim().toLowerCase();
  return templates.filter((t) => t.title.toLowerCase().includes(q));
}

/** 選項清單：iOS 用系統的動作表，其他平台用對話框 */
export function chooseOption(title: string, options: string[], onPick: (index: number) => void) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [...options, t('取消')], cancelButtonIndex: options.length }, (i) => {
      if (i < options.length) onPick(i);
    });
  } else {
    Alert.alert(title, undefined, [...options.map((text, i) => ({ text, onPress: () => onPick(i) })), { text: t('取消'), style: 'cancel' as const }]);
  }
}

export function Composer(p: Props) {
  const [draft, setDraft] = useState('');
  const [photos, setPhotos] = useState<NewPhoto[]>([]);
  const [hint, setHint] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);

  function applyTemplate(tpl: Template) {
    setDraft(tpl.content);
    inputRef.current?.focus();
  }

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
      if (source === 'clipboard' && got.length === 0) setHint(t('剪貼簿裡沒有圖片。'));
      setPhotos((prev) => [...prev, ...got].slice(0, MAX_PHOTOS));
    } catch (e: any) {
      Alert.alert(t('照片處理失敗'), e?.message ?? String(e));
    }
  }

  function openAttach() {
    chooseOption(t('附加照片'), [t('拍照'), t('從相簿選擇'), t('從剪貼簿貼上')], (i) => add((['camera', 'library', 'clipboard'] as const)[i]));
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
    if (p.think.kind === 'toggle') {
      p.onThink(!p.thinkValue);
    } else {
      const levels = p.think.levels;
      chooseOption(t('深入思考的程度（越仔細越慢）'), levels.map(friendlyLevel), (i) => p.onThink(levels[i]));
    }
  }

  const thinkText =
    p.think?.kind === 'toggle'
      ? t('深入思考 {p0}', { p0: p.thinkValue ? t('開') : t('關') })
      : p.think
        ? t('深入思考：{p0}', { p0: friendlyLevel(String(p.thinkValue ?? p.think.defaultLevel)) })
        : '';

  const slash = matchTemplates(draft, p.templates ?? []);
  const chips = p.showTemplateChips && !draft && photos.length === 0 && (p.templates?.length ?? 0) > 0;

  return (
    <View style={[styles.wrap, { paddingBottom: p.bottomInset }]}>
      {p.accessory}
      {slash ? (
        <View style={styles.slash} accessibilityLabel={t('範本清單')}>
          {slash.length === 0 ? (
            <Text style={styles.slashEmpty}>{t('沒有符合的範本')}</Text>
          ) : (
            slash.slice(0, 6).map((tpl) => (
              <Pressable
                key={tpl.id}
                onPress={() => applyTemplate(tpl)}
                accessibilityRole="button"
                accessibilityLabel={t('範本 {p0}', { p0: tpl.title })}
                style={({ pressed }) => [styles.slashRow, pressed && { backgroundColor: C.pressed }]}>
                <Text style={styles.slashTitle}>/{tpl.title}</Text>
                <Text style={styles.slashBody} numberOfLines={1}>
                  {tpl.content.replace(/\s+/g, ' ')}
                </Text>
              </Pressable>
            ))
          )}
        </View>
      ) : null}
      {chips ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.chips}>
          {p.templates!.map((tpl) => (
            <Pressable
              key={tpl.id}
              onPress={() => applyTemplate(tpl)}
              accessibilityRole="button"
              accessibilityLabel={t('範本 {p0}', { p0: tpl.title })}
              style={({ pressed }) => [styles.chip, pressed && styles.pressed]}>
              <Text style={styles.chipText}>{tpl.title}</Text>
            </Pressable>
          ))}
          {p.onManageTemplates ? (
            <Pressable onPress={p.onManageTemplates} accessibilityRole="button" accessibilityLabel={t('管理範本')} style={({ pressed }) => [styles.chip, pressed && styles.pressed]}>
              <SymbolView name="slider.horizontal.3" size={13} tintColor={C.secondary} />
            </Pressable>
          ) : null}
        </ScrollView>
      ) : null}
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
            onPress={openAttach}
            disabled={!p.canAttach || p.busy || photos.length >= MAX_PHOTOS}
          />
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={p.modelLabel ? t('輸入訊息，或打 / 叫出範本') : t('先在下方選一個模型')}
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
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t('模型：{p0}，點一下切換', { p0: p.modelLabel ?? t('還沒選') })}
          style={({ pressed }) => [styles.pill, pressed && styles.pressed]}>
          <Text style={[styles.footerText, !p.modelLabel && { color: C.accent }]} numberOfLines={1}>
            {p.modelLabel ?? t('選擇模型')}
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
  chips: { gap: 8, paddingHorizontal: 2 },
  chip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator },
  chipText: { ...TEXT.small, color: C.label },
  slash: { backgroundColor: C.surface, borderRadius: 12, overflow: 'hidden' },
  slashRow: { paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
  slashTitle: { ...TEXT.small, color: C.accent, fontWeight: '600' },
  slashBody: { ...TEXT.meta, color: C.secondary },
  slashEmpty: { ...TEXT.meta, color: C.secondary, padding: 12 },
});
