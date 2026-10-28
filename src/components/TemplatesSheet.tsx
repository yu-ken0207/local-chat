import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ChatStore } from '../state/chatStore';
import type { Template } from '../store/repo';
import { C, TEXT } from '../ui/theme';

/** 管理提示詞範本：新增、修改、刪除 */
export function TemplatesSheet({ store, templates, onClose }: { store: ChatStore; templates: Template[]; onClose: () => void }) {
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  function edit(t: Template | 'new') {
    setEditing(t);
    setTitle(t === 'new' ? '' : t.title);
    setContent(t === 'new' ? '' : t.content);
  }

  async function save() {
    if (!title.trim() || !content.trim()) {
      Alert.alert('還沒填完', '標題和內容都要填。');
      return;
    }
    if (editing === 'new') await store.addTemplate(title, content);
    else if (editing) await store.updateTemplate(editing.id, title, content);
    setEditing(null);
  }

  function remove(t: Template) {
    Alert.alert(`刪除範本「${t.title}」？`, undefined, [
      { text: '取消', style: 'cancel' },
      { text: '刪除', style: 'destructive', onPress: () => store.deleteTemplate(t.id) },
    ]);
  }

  if (editing) {
    return (
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Pressable onPress={() => setEditing(null)} hitSlop={10} accessibilityRole="button">
            <Text style={styles.cancel}>取消</Text>
          </Pressable>
          <Text style={styles.title}>{editing === 'new' ? '新增範本' : '修改範本'}</Text>
          <Pressable onPress={save} hitSlop={10} accessibilityRole="button">
            <Text style={styles.done}>儲存</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.section}>標題（打 / 時用來找）</Text>
          <View style={styles.card}>
            <TextInput style={styles.field} value={title} onChangeText={setTitle} placeholder="例如：寫日報" placeholderTextColor={C.placeholder} accessibilityLabel="範本標題" />
          </View>
          <Text style={styles.section}>內容（會放進輸入框）</Text>
          <View style={styles.card}>
            <TextInput
              style={[styles.field, styles.multiline]}
              value={content}
              onChangeText={setContent}
              placeholder="例如：幫我把下面的工作紀錄整理成日報："
              placeholderTextColor={C.placeholder}
              multiline
              accessibilityLabel="範本內容"
            />
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Text style={styles.title}>提示詞範本</Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
          <Text style={styles.done}>完成</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable onPress={() => edit('new')} accessibilityRole="button" style={({ pressed }) => [styles.newRow, pressed && styles.pressed]}>
          <SymbolView name="plus.circle.fill" size={18} tintColor={C.accent} />
          <Text style={styles.newText}>新增範本</Text>
        </Pressable>
        <View style={styles.card}>
          {templates.length === 0 ? (
            <Text style={styles.empty}>還沒有範本</Text>
          ) : (
            templates.map((t, i) => (
              <View key={t.id}>
                <Pressable onPress={() => edit(t)} accessibilityRole="button" accessibilityLabel={`修改範本 ${t.title}`} style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                  <View style={styles.row}>
                    <View style={styles.flex}>
                      <Text style={styles.rowTitle}>/{t.title}</Text>
                      <Text style={styles.rowSub} numberOfLines={1}>
                        {t.content.replace(/\s+/g, ' ')}
                      </Text>
                    </View>
                    <Pressable onPress={() => remove(t)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`刪除範本 ${t.title}`}>
                      <SymbolView name="trash" size={17} tintColor={C.red} />
                    </Pressable>
                  </View>
                </Pressable>
                {i < templates.length - 1 ? <View style={styles.separator} /> : null}
              </View>
            ))
          )}
        </View>
        <Text style={styles.footnote}>在輸入框打 / 可以叫出範本；新對話時，範本也會出現在輸入框上方。</Text>
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
  content: { padding: 16, paddingTop: 6, gap: 10, paddingBottom: 40 },
  newRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingVertical: 6 },
  newText: { fontSize: 17, fontWeight: '600', color: C.accent },
  card: { backgroundColor: C.groupedCard, borderRadius: 12, overflow: 'hidden' },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  flex: { flex: 1 },
  rowTitle: { ...TEXT.body, color: C.label },
  rowSub: { ...TEXT.meta, color: C.secondary, marginTop: 2 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 16 },
  empty: { ...TEXT.small, color: C.secondary, padding: 16 },
  footnote: { fontSize: 13, lineHeight: 18, color: C.secondary, marginHorizontal: 4 },
  section: { fontSize: 13, color: C.secondary, marginHorizontal: 4, marginTop: 6 },
  field: { ...TEXT.body, color: C.label, paddingHorizontal: 16, paddingVertical: 12 },
  multiline: { minHeight: 120, textAlignVertical: 'top' },
});
