import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ChatStore } from '../state/chatStore';
import type { Template } from '../store/repo';
import { SwipeRow } from './SwipeRow';
import { UndoToast } from './UndoToast';
import { C, TEXT } from '../ui/theme';
import { t } from '../i18n';

/** 有改過才問要不要放棄；沒改過直接離開 */
export function confirmDiscard(dirty: boolean, leave: () => void) {
  if (!dirty) return leave();
  Alert.alert(t('放棄修改？'), t('剛剛輸入的內容不會儲存。'), [
    { text: t('繼續編輯'), style: 'cancel' },
    { text: t('放棄'), style: 'destructive', onPress: leave },
  ]);
}

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

  const filled = !!title.trim() && !!content.trim();
  const dirty = editing === 'new' ? !!(title.trim() || content.trim()) : !!editing && (title !== editing.title || content !== editing.content);

  async function save() {
    if (!filled) return;
    if (editing === 'new') await store.addTemplate(title, content);
    else if (editing) await store.updateTemplate(editing.id, title, content);
    setEditing(null);
  }

  /** 直接刪，畫面下方可以復原 */
  function remove(t: Template) {
    void store.deleteTemplate(t.id);
  }

  if (editing) {
    return (
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Pressable onPress={() => confirmDiscard(dirty, () => setEditing(null))} hitSlop={10} accessibilityRole="button">
            <Text style={styles.cancel}>{t('取消')}</Text>
          </Pressable>
          <Text style={styles.title}>{editing === 'new' ? t('新增範本') : t('修改範本')}</Text>
          <Pressable onPress={save} disabled={!filled} hitSlop={10} accessibilityRole="button" accessibilityState={{ disabled: !filled }}>
            <Text style={[styles.done, !filled && { color: C.tertiary }]}>{t('儲存')}</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.section}>{t('標題（打 / 時用來找）')}</Text>
          <View style={styles.card}>
            <TextInput style={styles.field} value={title} onChangeText={setTitle} placeholder={t('例如：寫日報')} placeholderTextColor={C.placeholder} accessibilityLabel={t('範本標題')} />
          </View>
          <Text style={styles.section}>{t('內容（會放進輸入框）')}</Text>
          <View style={styles.card}>
            <TextInput
              style={[styles.field, styles.multiline]}
              value={content}
              onChangeText={setContent}
              placeholder={t('例如：幫我把下面的工作紀錄整理成日報：')}
              placeholderTextColor={C.placeholder}
              multiline
              accessibilityLabel={t('範本內容')}
            />
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('提示詞範本')}</Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
          <Text style={styles.done}>{t('完成')}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable onPress={() => edit('new')} accessibilityRole="button" style={({ pressed }) => [styles.newRow, pressed && styles.pressed]}>
          <SymbolView name="plus.circle.fill" size={18} tintColor={C.accent} />
          <Text style={styles.newText}>{t('新增範本')}</Text>
        </Pressable>
        <View style={styles.card}>
          {templates.length === 0 ? (
            <Text style={styles.empty}>{t('還沒有範本')}</Text>
          ) : (
            templates.map((tpl, i) => (
              <SwipeRow key={tpl.id} testID={`swipe-template-${tpl.id}`} onDelete={() => remove(tpl)}>
                <Pressable onPress={() => edit(tpl)} accessibilityRole="button" accessibilityLabel={t('修改範本 {p0}', { p0: tpl.title })} style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                  <View style={styles.row}>
                    <View style={styles.flex}>
                      <Text style={styles.rowTitle}>/{tpl.title}</Text>
                      <Text style={styles.rowSub} numberOfLines={1}>
                        {tpl.content.replace(/\s+/g, ' ')}
                      </Text>
                    </View>
                    <Pressable onPress={() => remove(tpl)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('刪除範本 {p0}', { p0: tpl.title })}>
                      <SymbolView name="trash" size={17} tintColor={C.red} />
                    </Pressable>
                  </View>
                </Pressable>
                {i < templates.length - 1 ? <View style={styles.separator} /> : null}
              </SwipeRow>
            ))
          )}
        </View>
        <Text style={styles.footnote}>{t('在輸入框打 / 可以叫出範本；新對話時，範本也會出現在輸入框上方。往左滑可以刪除。')}</Text>
      </ScrollView>
      <UndoToast store={store} />
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
