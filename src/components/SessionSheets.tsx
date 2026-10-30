import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fmtWhen } from '../lib/format';
import { TRASH_DAYS } from '../store/repo';
import type { ChatStore } from '../state/chatStore';
import { useChatState } from '../state/useChat';
import type { Db } from '../store/db';
import type { Session } from '../store/repo';
import { C, TEXT } from '../ui/theme';
import { chooseOption } from './Composer';
import { SwipeRow } from './SwipeRow';
import { SettingsView } from './SettingsSheet';
import { UndoToast } from './UndoToast';
import { t } from '../i18n';

type ListItem = Session & { preview: string; pending?: number };

/** 刪除對話：直接移到最近刪除，畫面下方會出現「復原」，不用先確認 */
export async function deleteSession(store: ChatStore, id: string, after?: () => void) {
  await store.deleteSession(id);
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  after?.();
}

/** 對話清單（左邊的側邊欄）：搜尋、切換、長按或 ⋯ 改名／刪除；最下面是設定 */
export function SessionList({
  store,
  currentId,
  onClose,
  onOpenSettings,
  showUndo = true,
}: {
  store: ChatStore;
  currentId: string | null;
  onClose: () => void;
  onOpenSettings: () => void;
  /** 設定面板蓋在上面時，復原提示由設定面板顯示 */
  showUndo?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);
  const { undo, session } = useChatState(store);

  // 設定面板關上時也重新載入（可能在「最近刪除」救回了對話）
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const list = await store.listSessions(query);
      if (!cancelled) setItems(list);
    }, query ? 200 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, version, store, undo?.id, session?.title, showUndo]);

  function menu(s: ListItem) {
    const name = s.title || s.preview || t('新對話');
    chooseOption(name, [t('重新命名'), t('刪除')], (i) => {
      if (i === 0) Alert.prompt(t('重新命名'), undefined, async (t) => (await store.renameSession(s.id, t), reload()), 'plain-text', s.title);
      if (i === 1) void deleteSession(store, s.id, reload);
    }, 1);
  }

  const now = Date.now();
  return (
    <View style={[styles.drawer, { paddingTop: insets.top + 6 }]}>
      <Text style={styles.drawerTitle} accessibilityRole="header">
        {t('對話')}
      </Text>
      <View style={styles.search}>
        <SymbolView name="magnifyingglass" size={15} tintColor={C.secondary} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder={t('搜尋標題或內容')}
          placeholderTextColor={C.placeholder}
          clearButtonMode="while-editing"
          returnKeyType="search"
          accessibilityLabel={t('搜尋對話')}
        />
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
        <Pressable
          onPress={async () => {
            await store.newSession();
            onClose();
          }}
          accessibilityRole="button"
          accessibilityLabel={t('開始新對話')}
          style={({ pressed }) => [styles.newRow, pressed && styles.pressed]}>
          <SymbolView name="square.and.pencil" size={18} tintColor={C.accent} />
          <Text style={styles.newText}>{t('開始新對話')}</Text>
        </Pressable>
        <View style={styles.card}>
          {items === null ? null : items.length === 0 ? (
            <Text style={styles.empty}>{query ? t('沒有符合的對話') : t('還沒有對話')}</Text>
          ) : (
            items.map((s, i) => {
              const name = s.title || s.preview || t('新對話');
              return (
                <Pressable
                  key={s.id}
                  testID={`session-${s.id}`}
                  onPress={async () => {
                    Haptics.selectionAsync();
                    await store.openSession(s.id);
                    onClose();
                  }}
                  onLongPress={() => menu(s)}
                  accessibilityRole="button"
                  accessibilityLabel={t('對話 {p0}', { p0: name })}
                  accessibilityState={{ selected: s.id === currentId }}
                  accessibilityActions={[{ name: 'delete', label: t('刪除') }]}
                  onAccessibilityAction={(e) => {
                    if (e.nativeEvent.actionName === 'delete') void deleteSession(store, s.id, reload);
                  }}
                  style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                  <View style={styles.row}>
                    <View style={styles.flex}>
                      <View style={styles.rowTop}>
                        <Text style={[styles.rowTitle, s.id === currentId && { color: C.accent }]} numberOfLines={1}>
                          {name}
                        </Text>
                        <Text style={styles.when}>{fmtWhen(s.updatedAt, now)}</Text>
                      </View>
                      {s.pending ? (
                        <Text style={[styles.preview, { color: C.accent }]} numberOfLines={1}>
                          {t('等你確認')}
                        </Text>
                      ) : s.preview && s.title ? (
                        <Text style={styles.preview} numberOfLines={1}>
                          {s.preview.replace(/\s+/g, ' ')}
                        </Text>
                      ) : null}
                    </View>
                    <Pressable onPress={() => menu(s)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('{p0} 的選項', { p0: name })}>
                      <SymbolView name="ellipsis.circle" size={20} tintColor={C.secondary} />
                    </Pressable>
                  </View>
                  {i < items.length - 1 ? <View style={styles.separator} /> : null}
                </Pressable>
              );
            })
          )}
        </View>
        <Text style={styles.footnote}>{t('對話只存在這支手機。長按或按 ⋯ 可以改名、刪除。')}</Text>
      </ScrollView>
      {/* 設定固定在最下面，不用捲到底才找得到 */}
      <Pressable
        onPress={onOpenSettings}
        accessibilityRole="button"
        style={({ pressed }) => [styles.settingsBar, { paddingBottom: Math.max(insets.bottom, 10) }, pressed && { backgroundColor: C.pressed }]}>
        <SymbolView name="gearshape" size={18} tintColor={C.accent} />
        <Text style={[styles.rowTitle, styles.flex]}>{t('設定')}</Text>
        {/* 設定是從下面升起的面板，不是推進新的一頁：不放「›」（跟設定頁的規則一樣） */}
      </Pressable>
      {showUndo ? <UndoToast store={store} /> : null}
    </View>
  );
}

/** 設定面板（從對話清單最下面打開）：設定頁，裡面可以進「最近刪除」 */
export function SettingsPages({
  store,
  onClose,
  copyText,
  pickBackup,
}: {
  store: ChatStore;
  onClose: () => void;
  copyText: (text: string) => void;
  pickBackup?: () => Promise<Db | null>;
}) {
  const [view, setView] = useState<'settings' | 'trash'>('settings');
  if (view === 'trash') return <TrashView store={store} onBack={() => setView('settings')} />;
  return <SettingsView store={store} copyText={copyText} pickBackup={pickBackup} onClose={onClose} onOpenTrash={() => setView('trash')} />;
}

type TrashItem = Session & { preview: string; deletedAt: number };

/** 最近刪除：救回來、永久刪除、全部清空（永久刪除救不回來，要先確認） */
function TrashView({ store, onBack }: { store: ChatStore; onBack: () => void }) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);
  useEffect(() => {
    store.listTrash().then(setItems);
  }, [store, version]);

  const daysLeft = (deletedAt: number) => Math.max(1, TRASH_DAYS - Math.floor((Date.now() - deletedAt) / 86_400_000));
  // 「還會保留 N 天」：英文剩 1 天時要用單數（不然唸成 1 more days）
  const keptFor = (deletedAt: number) => {
    const n = daysLeft(deletedAt);
    return n === 1 ? t('還會保留 1 天') : t('還會保留 {n} 天', { n });
  };

  function forever(s: TrashItem, name: string) {
    Alert.alert(t('永久刪除「{p0}」？', { p0: name }), t('永久刪除後就救不回來了。'), [
      { text: t('取消'), style: 'cancel' },
      { text: t('永久刪除'), style: 'destructive', onPress: () => void store.deleteForever(s.id).then(reload) },
    ]);
  }

  function menu(s: TrashItem, name: string) {
    chooseOption(name, [t('救回這段對話'), t('永久刪除')], async (i) => {
      if (i === 0) await restore(s);
      if (i === 1) forever(s, name);
    }, 1);
  }

  async function restore(s: TrashItem) {
    await store.restoreSession(s.id);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    reload();
  }

  async function restoreAll() {
    await store.restoreAllTrash();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    reload();
  }

  function emptyAll() {
    Alert.alert(t('清空最近刪除？'), t('{p0} 段對話會永久刪除，救不回來。', { p0: items?.length ?? 0 }), [
      { text: t('取消'), style: 'cancel' },
      { text: t('全部清空'), style: 'destructive', onPress: () => void store.emptyTrash().then(reload) },
    ]);
  }

  return (
    <View style={styles.sheet}>
      {/* 兩邊一樣寬（各佔一半剩下的空間），標題才會在正中間；英文的「‹ Settings」比較寬也一樣 */}
      <View style={styles.header}>
        <View style={styles.headerSide}>
          <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('返回設定')} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
            <SymbolView name="chevron.left" size={16} tintColor={C.accent} />
            <Text style={styles.cancel}>{t('設定')}</Text>
          </Pressable>
        </View>
        <Text style={styles.title}>{t('最近刪除')}</Text>
        {/* 右邊在其他面板是「完成」：不放危險的「全部清空」，改到清單下面 */}
        <View style={styles.headerSide} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          {items === null ? null : items.length === 0 ? (
            <Text style={styles.empty}>{t('最近刪除是空的。刪除的對話會在這裡保留 {n} 天，之後才真的刪掉。', { n: TRASH_DAYS })}</Text>
          ) : (
            items.map((s, i) => {
              const name = s.title || s.preview || t('對話');
              return (
                <SwipeRow key={s.id} label={t('永久刪除')} testID={`swipe-trash-${s.id}`} onDelete={() => forever(s, name)}>
                  {/* VoiceOver 把整列合成一個元素，裡面的「救回」摸不到：用動作補上（上下滑選「救回」或「永久刪除」） */}
                  <Pressable
                    onPress={() => menu(s, name)}
                    accessibilityRole="button"
                    accessibilityLabel={t('已刪除的對話 {p0}，{p1}', { p0: name, p1: keptFor(s.deletedAt) })}
                    accessibilityActions={[{ name: 'restore', label: t('救回') }, { name: 'delete', label: t('永久刪除') }]}
                    onAccessibilityAction={(e) => {
                      if (e.nativeEvent.actionName === 'restore') void restore(s);
                      if (e.nativeEvent.actionName === 'delete') forever(s, name);
                    }}
                    style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                    <View style={styles.row}>
                      <View style={styles.flex}>
                        <Text style={styles.rowTitle} numberOfLines={1}>
                          {name}
                        </Text>
                        <Text style={styles.preview}>{keptFor(s.deletedAt)}</Text>
                      </View>
                      <Pressable onPress={() => void restore(s)} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('救回 {p0}', { p0: name })}>
                        <Text style={styles.restore}>{t('救回')}</Text>
                      </Pressable>
                    </View>
                    {i < items.length - 1 ? <View style={styles.separator} /> : null}
                  </Pressable>
                </SwipeRow>
              );
            })
          )}
        </View>
        {items?.length ? (
          <View style={styles.trashActions}>
            <Pressable onPress={() => void restoreAll()} hitSlop={10} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
              <Text style={styles.cancel}>{t('全部救回')}</Text>
            </Pressable>
            <Pressable onPress={emptyAll} hitSlop={10} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
              <Text style={[styles.cancel, { color: C.errorText }]}>{t('全部清空')}</Text>
            </Pressable>
          </View>
        ) : null}
        <Text style={styles.footnote}>{t('按「救回」就救回來；點一下那一列也可以永久刪除。')}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  trashActions: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  sheet: { flex: 1, backgroundColor: C.groupedBg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingBottom: 8 },
  title: { fontSize: 17, fontWeight: '600', color: C.label },
  cancel: { fontSize: 17, color: C.accent },
  pressed: { opacity: 0.4 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: C.pressed,
  },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 8, color: C.label },
  content: { padding: 16, paddingTop: 6, gap: 10, paddingBottom: 40 },
  newRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingVertical: 6 },
  newText: { fontSize: 17, fontWeight: '600', color: C.accent },
  card: { backgroundColor: C.groupedCard, borderRadius: 12, overflow: 'hidden' },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  flex: { flex: 1 },
  rowTitle: { ...TEXT.body, color: C.label, flexShrink: 1 },
  when: { ...TEXT.meta, color: C.secondary, marginLeft: 'auto' },
  preview: { ...TEXT.meta, color: C.secondary, marginTop: 2 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 16 },
  empty: { ...TEXT.small, color: C.secondary, padding: 16 },
  footnote: { fontSize: 13, lineHeight: 18, color: C.secondary, marginHorizontal: 4 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  headerSide: { flex: 1, alignItems: 'flex-start' },
  restore: { ...TEXT.small, color: C.accent, fontWeight: '700' },
  drawer: { flex: 1 },
  drawerTitle: { fontSize: 28, fontWeight: '700', color: C.label, marginHorizontal: 16, marginBottom: 10 },
  settingsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.separator,
  },
});
