import * as Haptics from 'expo-haptics';
import * as Sharing from 'expo-sharing';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';

import { fmtBytes, fmtWhen } from '../lib/format';
import type { ChatStore } from '../state/chatStore';
import type { Session } from '../store/repo';
import { C, TEXT } from '../ui/theme';
import { chooseOption } from './Composer';

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

/** 確認後刪除對話 */
export function confirmDelete(store: ChatStore, session: { id: string; title: string }, after?: () => void) {
  Alert.alert(`刪除「${session.title || '這段對話'}」？`, '對話和裡面的照片都會從手機刪除，不能復原。', [
    { text: '取消', style: 'cancel' },
    {
      text: '刪除',
      style: 'destructive',
      onPress: async () => {
        await store.deleteSession(session.id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        after?.();
      },
    },
  ]);
}

/** 對話清單最下面：資料存在哪裡、多大、匯出整個資料庫 */
function DataSection({ store }: { store: ChatStore }) {
  const [info, setInfo] = useState<{ path: string | null; bytes: number } | null>(null);
  useEffect(() => {
    store.dataInfo().then(setInfo).catch(() => setInfo(null));
  }, [store]);
  if (!info) return null;

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
    </View>
  );
}

/** 對話清單：搜尋、切換、長按改名／匯出／刪除 */
export function SessionList({ store, currentId, onClose }: { store: ChatStore; currentId: string | null; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);

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
  }, [query, version, store]);

  function menu(s: ListItem) {
    const name = s.title || s.preview || '新對話';
    chooseOption(name, ['重新命名', '匯出', '刪除'], (i) => {
      if (i === 0) Alert.prompt('重新命名', undefined, async (t) => (await store.renameSession(s.id, t), reload()), 'plain-text', s.title);
      if (i === 1) void shareSession(store, s.id);
      if (i === 2) confirmDelete(store, { id: s.id, title: name }, reload);
    });
  }

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
          style={({ pressed }) => [styles.newRow, pressed && styles.pressed]}>
          <SymbolView name="square.and.pencil" size={18} tintColor={C.accent} />
          <Text style={styles.newText}>新對話</Text>
        </Pressable>
        <View style={styles.card}>
          {items === null ? null : items.length === 0 ? (
            <Text style={styles.empty}>{query ? '沒有符合的對話' : '還沒有對話'}</Text>
          ) : (
            items.map((s, i) => {
              const name = s.title || s.preview || '新對話';
              return (
                <Pressable
                  key={s.id}
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
              );
            })
          )}
        </View>
        <Text style={styles.footnote}>對話只存在這支手機。長按可以改名、匯出或刪除。</Text>
        <DataSection store={store} />
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
        <Text style={styles.section}>角色</Text>
        <View style={styles.card}>
          <TextInput
            style={[styles.field, styles.multiline]}
            value={role}
            onChangeText={setRole}
            placeholder="例如：你是工廠巡檢專家，回答時先列出檢查重點。"
            placeholderTextColor={C.placeholder}
            multiline
            accessibilityLabel="角色設定"
          />
        </View>
        <Text style={styles.footnote}>角色會當成系統提示詞，只用在這段對話。留空就用預設：「請用繁體中文（台灣用語）回答。」</Text>
        <View style={[styles.card, styles.actions]}>
          <Pressable onPress={() => shareSession(store, session.id)} accessibilityRole="button" style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
            <View style={styles.row}>
              <SymbolView name="square.and.arrow.up" size={18} tintColor={C.accent} />
              <Text style={[styles.rowTitle, { color: C.accent }]}>匯出成 Markdown</Text>
            </View>
          </Pressable>
          <View style={styles.separator} />
          <Pressable
            onPress={() => confirmDelete(store, session, onClose)}
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
});
