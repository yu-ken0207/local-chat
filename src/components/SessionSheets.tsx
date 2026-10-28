import * as Haptics from 'expo-haptics';
import * as Sharing from 'expo-sharing';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';

import { fmtBytes, fmtWhen } from '../lib/format';
import { TRASH_DAYS } from '../store/repo';
import type { ChatStore } from '../state/chatStore';
import { useChatState } from '../state/useChat';
import type { Session } from '../store/repo';
import { C, TEXT } from '../ui/theme';
import { chooseOption } from './Composer';
import { SwipeRow } from './SwipeRow';
import { UndoToast } from './UndoToast';

type ListItem = Session & { preview: string };

/** 分享（匯出）某段對話的 Markdown */
export async function shareSession(store: ChatStore, id: string) {
  try {
    const { title, markdown } = await store.exportSession(id);
    await Share.share({ title, message: markdown });
  } catch (e: any) {
    Alert.alert('匯出失敗', String(e?.message ?? e));
  }
}

/** 刪除對話：直接移到最近刪除，畫面下方會出現「復原」，不用先確認 */
export async function deleteSession(store: ChatStore, id: string, after?: () => void) {
  await store.deleteSession(id);
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  after?.();
}

/** 對話清單最下面：資料存在哪裡、多大、匯出整個資料庫 */
function DataSection({ store, onChanged, onOpenTrash }: { store: ChatStore; onChanged: () => void; onOpenTrash: () => void }) {
  const [info, setInfo] = useState<{ path: string | null; bytes: number; sessions: number; trash: number } | null>(null);
  const [version, setVersion] = useState(0);
  const { undo, session } = useChatState(store);
  useEffect(() => {
    store.dataInfo().then(setInfo).catch(() => setInfo(null));
  }, [store, version, undo?.id, session?.id]);
  if (!info) return null;

  const after = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setVersion((v) => v + 1);
    onChanged();
  };

  /** 全部移到最近刪除，可以復原，不用先確認 */
  function deleteAll() {
    void store.deleteAllSessions().then(after);
  }

  /** 連電腦、範本、設定一起清掉，幾秒後就救不回來，所以先確認 */
  function resetAll() {
    Alert.alert(
      '清除全部資料？',
      '對話、照片、電腦、範本和設定全部刪除，回到第一次打開的樣子。按下後幾秒內還可以復原，之後就救不回來。\n\n建議先按「匯出資料庫」備份。',
      [
        { text: '取消', style: 'cancel' },
        { text: '清除', style: 'destructive', onPress: () => void store.resetAll().then(after) },
      ]
    );
  }

  async function exportDb() {
    try {
      const uri = await store.prepareDatabaseExport();
      if (!uri) return;
      await Sharing.shareAsync(uri, { dialogTitle: '匯出資料庫' });
    } catch (e: any) {
      Alert.alert('匯出失敗', String(e?.message ?? e));
    }
  }

  return (
    <View style={styles.data}>
      <Text style={styles.section}>資料</Text>
      <View style={styles.card}>
        <View style={styles.dataBody}>
          <Text style={styles.rowTitle}>local-chat.db · {fmtBytes(info.bytes)}</Text>
          <Text style={styles.footnote}>所有對話和照片都在這個檔案，只存在這支手機。iPhone 的「檔案」App 看不到這個位置，要拿出來請用「匯出資料庫」。</Text>
          {info.path ? (
            <Text style={styles.path} selectable accessibilityLabel="資料庫位置">
              {info.path}
            </Text>
          ) : null}
        </View>
        {info.path ? (
          <>
            <View style={styles.separator} />
            <Pressable onPress={exportDb} accessibilityRole="button" style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
              <View style={styles.row}>
                <SymbolView name="square.and.arrow.up" size={18} tintColor={C.accent} />
                <Text style={[styles.rowTitle, { color: C.accent }]}>匯出資料庫</Text>
              </View>
            </Pressable>
          </>
        ) : null}
      </View>
      <View style={[styles.card, styles.danger]}>
        <Pressable onPress={onOpenTrash} accessibilityRole="button" accessibilityLabel={`最近刪除，${info.trash} 段`} style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
          <View style={styles.row}>
            <SymbolView name="trash.slash" size={18} tintColor={C.accent} />
            <Text style={[styles.rowTitle, styles.flex]}>最近刪除</Text>
            <Text style={styles.count}>{info.trash}</Text>
            <SymbolView name="chevron.right" size={13} tintColor={C.tertiary} />
          </View>
        </Pressable>
        <View style={styles.separator} />
        <Pressable onPress={deleteAll} accessibilityRole="button" style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
          <View style={styles.row}>
            <SymbolView name="trash" size={18} tintColor={C.red} />
            <Text style={[styles.rowTitle, { color: C.red }]}>刪除所有對話</Text>
          </View>
        </Pressable>
        <View style={styles.separator} />
        <Pressable onPress={resetAll} accessibilityRole="button" style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
          <View style={styles.row}>
            <SymbolView name="arrow.counterclockwise" size={18} tintColor={C.red} />
            <Text style={[styles.rowTitle, { color: C.red }]}>清除全部資料</Text>
          </View>
        </Pressable>
      </View>
      <Text style={styles.footnote}>刪除的對話會在「最近刪除」保留 {TRASH_DAYS} 天。「清除全部資料」連電腦、範本、設定一起刪，只有按下後幾秒內可以復原。</Text>
    </View>
  );
}

/** 對話清單：搜尋、切換、長按改名／匯出／刪除 */
export function SessionList({ store, currentId, onClose }: { store: ChatStore; currentId: string | null; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [version, setVersion] = useState(0);
  const [trashOpen, setTrashOpen] = useState(false);
  const reload = () => setVersion((v) => v + 1);
  const { undo } = useChatState(store);

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
  }, [query, version, store, undo?.id, trashOpen]);

  function menu(s: ListItem) {
    const name = s.title || s.preview || '新對話';
    chooseOption(name, ['重新命名', '匯出', '刪除'], (i) => {
      if (i === 0) Alert.prompt('重新命名', undefined, async (t) => (await store.renameSession(s.id, t), reload()), 'plain-text', s.title);
      if (i === 1) void shareSession(store, s.id);
      if (i === 2) void deleteSession(store, s.id, reload);
    });
  }

  if (trashOpen) return <TrashView store={store} onBack={() => setTrashOpen(false)} />;

  const now = Date.now();
  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Text style={styles.title}>對話</Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
          <Text style={styles.done}>完成</Text>
        </Pressable>
      </View>
      <View style={styles.search}>
        <SymbolView name="magnifyingglass" size={15} tintColor={C.secondary} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="搜尋標題或內容"
          placeholderTextColor={C.placeholder}
          clearButtonMode="while-editing"
          returnKeyType="search"
          accessibilityLabel="搜尋對話"
        />
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
        <Pressable
          onPress={async () => {
            await store.newSession();
            onClose();
          }}
          accessibilityRole="button"
          accessibilityLabel="開始新對話"
          style={({ pressed }) => [styles.newRow, pressed && styles.pressed]}>
          <SymbolView name="square.and.pencil" size={18} tintColor={C.accent} />
          <Text style={styles.newText}>開始新對話</Text>
        </Pressable>
        <View style={styles.card}>
          {items === null ? null : items.length === 0 ? (
            <Text style={styles.empty}>{query ? '沒有符合的對話' : '還沒有對話'}</Text>
          ) : (
            items.map((s, i) => {
              const name = s.title || s.preview || '新對話';
              return (
                <SwipeRow key={s.id} testID={`swipe-session-${s.id}`} onDelete={() => void deleteSession(store, s.id, reload)}>
                <Pressable
                  onPress={async () => {
                    Haptics.selectionAsync();
                    await store.openSession(s.id);
                    onClose();
                  }}
                  onLongPress={() => menu(s)}
                  accessibilityRole="button"
                  accessibilityLabel={`對話 ${name}`}
                  accessibilityState={{ selected: s.id === currentId }}
                  style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                  <View style={styles.row}>
                    <View style={styles.flex}>
                      <View style={styles.rowTop}>
                        <Text style={[styles.rowTitle, s.id === currentId && { color: C.accent }]} numberOfLines={1}>
                          {name}
                        </Text>
                        <Text style={styles.when}>{fmtWhen(s.updatedAt, now)}</Text>
                      </View>
                      {s.preview && s.title ? (
                        <Text style={styles.preview} numberOfLines={1}>
                          {s.preview.replace(/\s+/g, ' ')}
                        </Text>
                      ) : null}
                    </View>
                    <Pressable onPress={() => menu(s)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`${name} 的選項`}>
                      <SymbolView name="ellipsis.circle" size={20} tintColor={C.secondary} />
                    </Pressable>
                  </View>
                  {i < items.length - 1 ? <View style={styles.separator} /> : null}
                </Pressable>
                </SwipeRow>
              );
            })
          )}
        </View>
        <Text style={styles.footnote}>對話只存在這支手機。往左滑可以刪除；按 ⋯ 可以改名、匯出。</Text>
        <DataSection store={store} onChanged={reload} onOpenTrash={() => setTrashOpen(true)} />
      </ScrollView>
      <UndoToast store={store} />
    </View>
  );
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

  function forever(s: TrashItem, name: string) {
    Alert.alert(`永久刪除「${name}」？`, '永久刪除後就救不回來了。', [
      { text: '取消', style: 'cancel' },
      { text: '永久刪除', style: 'destructive', onPress: () => void store.deleteForever(s.id).then(reload) },
    ]);
  }

  function menu(s: TrashItem, name: string) {
    chooseOption(name, ['救回這段對話', '永久刪除'], async (i) => {
      if (i === 0) {
        await store.restoreSession(s.id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        reload();
      }
      if (i === 1) forever(s, name);
    });
  }

  function emptyAll() {
    Alert.alert('清空最近刪除？', `${items?.length ?? 0} 段對話會永久刪除，救不回來。`, [
      { text: '取消', style: 'cancel' },
      { text: '全部清空', style: 'destructive', onPress: () => void store.emptyTrash().then(reload) },
    ]);
  }

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="返回對話清單" style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
          <SymbolView name="chevron.left" size={16} tintColor={C.accent} />
          <Text style={styles.cancel}>對話</Text>
        </Pressable>
        <Text style={styles.title}>最近刪除</Text>
        <Pressable onPress={emptyAll} disabled={!items?.length} hitSlop={10} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
          <Text style={[styles.cancel, !items?.length && { color: C.tertiary }]}>全部清空</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          {items === null ? null : items.length === 0 ? (
            <Text style={styles.empty}>最近刪除是空的。刪除的對話會在這裡保留 {TRASH_DAYS} 天，之後才真的刪掉。</Text>
          ) : (
            items.map((s, i) => {
              const name = s.title || s.preview || '對話';
              return (
                <SwipeRow key={s.id} label="永久刪除" testID={`swipe-trash-${s.id}`} onDelete={() => forever(s, name)}>
                  <Pressable onPress={() => menu(s, name)} accessibilityRole="button" accessibilityLabel={`已刪除的對話 ${name}`} style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                    <View style={styles.row}>
                      <View style={styles.flex}>
                        <Text style={styles.rowTitle} numberOfLines={1}>
                          {name}
                        </Text>
                        <Text style={styles.preview}>還會保留 {daysLeft(s.deletedAt)} 天</Text>
                      </View>
                      <Text style={styles.restore}>救回</Text>
                    </View>
                    {i < items.length - 1 ? <View style={styles.separator} /> : null}
                  </Pressable>
                </SwipeRow>
              );
            })
          )}
        </View>
        <Text style={styles.footnote}>點一下可以救回或永久刪除。</Text>
      </ScrollView>
    </View>
  );
}

/** 對話設定：標題、角色（系統提示詞）、匯出、刪除 */
export function SessionSettings({ store, session, onClose }: { store: ChatStore; session: Session; onClose: () => void }) {
  const [title, setTitle] = useState(session.title);
  const [role, setRole] = useState(session.systemPrompt);

  async function save() {
    if (title.trim() !== session.title) await store.renameSession(session.id, title);
    if (role !== session.systemPrompt) await store.setSystemPrompt(role);
    onClose();
  }

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
          <Text style={styles.cancel}>取消</Text>
        </Pressable>
        <Text style={styles.title}>對話設定</Text>
        <Pressable onPress={save} hitSlop={10} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
          <Text style={styles.done}>完成</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.section}>標題</Text>
        <View style={styles.card}>
          <TextInput
            style={styles.field}
            value={title}
            onChangeText={setTitle}
            placeholder="第一次回答後會自動取標題"
            placeholderTextColor={C.placeholder}
            accessibilityLabel="對話標題"
          />
        </View>
        <Text style={styles.section}>自訂指示</Text>
        <View style={styles.card}>
          <TextInput
            style={[styles.field, styles.multiline]}
            value={role}
            onChangeText={setRole}
            placeholder="例如：用簡單的話解釋，回答不要太長。"
            placeholderTextColor={C.placeholder}
            multiline
            accessibilityLabel="自訂指示"
          />
        </View>
        <Text style={styles.footnote}>告訴 AI 在這段對話裡要怎麼回答，只用在這段對話。留空就照預設。</Text>
        <View style={[styles.card, styles.actions]}>
          <Pressable onPress={() => shareSession(store, session.id)} accessibilityRole="button" style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
            <View style={styles.row}>
              <SymbolView name="square.and.arrow.up" size={18} tintColor={C.accent} />
              <Text style={[styles.rowTitle, { color: C.accent }]}>匯出成 Markdown</Text>
            </View>
          </Pressable>
          <View style={styles.separator} />
          <Pressable
            onPress={() => void deleteSession(store, session.id, onClose)}
            accessibilityRole="button"
            style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
            <View style={styles.row}>
              <SymbolView name="trash" size={18} tintColor={C.red} />
              <Text style={[styles.rowTitle, { color: C.red }]}>刪除這段對話</Text>
            </View>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: C.groupedBg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingBottom: 8 },
  title: { fontSize: 17, fontWeight: '600', color: C.label },
  done: { fontSize: 17, fontWeight: '600', color: C.accent },
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
  actions: { marginTop: 12 },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  flex: { flex: 1 },
  rowTitle: { ...TEXT.body, color: C.label, flexShrink: 1 },
  when: { ...TEXT.meta, color: C.secondary, marginLeft: 'auto' },
  preview: { ...TEXT.meta, color: C.secondary, marginTop: 2 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 16 },
  empty: { ...TEXT.small, color: C.secondary, padding: 16 },
  footnote: { fontSize: 13, lineHeight: 18, color: C.secondary, marginHorizontal: 4 },
  section: { fontSize: 13, color: C.secondary, marginHorizontal: 4, marginTop: 6 },
  field: { ...TEXT.body, color: C.label, paddingHorizontal: 16, paddingVertical: 12 },
  multiline: { minHeight: 110, textAlignVertical: 'top' },
  data: { gap: 6, marginTop: 14 },
  dataBody: { padding: 16, gap: 6 },
  path: { ...TEXT.meta, color: C.secondary },
  count: { ...TEXT.small, color: C.secondary },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  restore: { ...TEXT.small, color: C.accent, fontWeight: '700' },
  danger: { marginTop: 4 },
});
