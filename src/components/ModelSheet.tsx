import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fmtBytes } from '../lib/format';
import type { ChatState, ChatStore } from '../state/chatStore';
import { C, TEXT } from '../ui/theme';
import { chooseOption } from './Composer';
import { CommandBox, ConnectSheet } from './ConnectSheet';

/** 選擇模型：上面選電腦，下面選模型。主要任務只有「選一個模型」 */
export function ModelSheet({ store, state, onClose, copyText }: { store: ChatStore; state: ChatState; onClose: () => void; copyText: (text: string) => void }) {
  const [viewing, setViewing] = useState<string | null>(state.session?.hostUrl ?? state.hosts[0]?.url ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  useEffect(() => {
    if (!viewing && state.hosts[0]) setViewing(state.hosts[0].url);
    if (viewing && !state.hosts.some((h) => h.url === viewing)) setViewing(state.hosts[0]?.url ?? null);
  }, [state.hosts, viewing]);

  useEffect(() => {
    if (viewing && !state.models[viewing]) void store.loadModels(viewing);
  }, [viewing]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refresh() {
    setRefreshing(true);
    await Promise.all([store.refreshHosts(), viewing ? store.loadModels(viewing) : Promise.resolve()]);
    setRefreshing(false);
  }

  function modelMenu(url: string, name: string, loaded: boolean) {
    chooseOption(name, [loaded ? '卸載（釋放電腦的顯示卡記憶體）' : '預先載入（之後第一次回答比較快）'], async () => {
      try {
        if (!loaded) {
          await store.preload(url, name);
          return;
        }
        Alert.alert(`卸載 ${name}？`, '模型會離開電腦的顯示卡。如果其他人或程式正在用這個模型，下次使用要重新載入。', [
          { text: '取消', style: 'cancel' },
          { text: '卸載', style: 'destructive', onPress: () => store.unload(url, name).catch((e) => Alert.alert('卸載失敗', String(e?.message ?? e))) },
        ]);
      } catch (e: any) {
        Alert.alert('預先載入失敗', String(e?.message ?? e));
      }
    });
  }

  const models = viewing ? state.models[viewing] : undefined;
  const loaded = viewing ? (state.loaded[viewing] ?? []) : [];
  const session = state.session;
  const status = viewing ? state.hostStatus[viewing]?.state : undefined;

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Text style={styles.title}>選擇模型</Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
          <Text style={styles.done}>完成</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
        <Text style={styles.section}>電腦</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {state.hosts.map((h) => {
            const st = state.hostStatus[h.url]?.state;
            const on = viewing === h.url;
            return (
              <Pressable
                key={h.url}
                onPress={() => {
                  Haptics.selectionAsync();
                  setViewing(h.url);
                }}
                accessibilityRole="button"
                accessibilityLabel={`顯示 ${h.label} 的模型，${st === 'online' ? '可以使用' : st === 'offline' ? '目前連不到' : '檢查中'}`}
                accessibilityState={{ selected: on }}
                style={[styles.chip, on && styles.chipOn]}>
                <View style={[styles.dot, { backgroundColor: st === 'online' ? C.green : C.tertiary }]} />
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{h.label}</Text>
              </Pressable>
            );
          })}
          <Pressable onPress={() => setConnectOpen(true)} accessibilityRole="button" style={[styles.chip, styles.addChip]}>
            <SymbolView name="plus" size={12} tintColor={C.accent} />
            <Text style={[styles.chipText, { color: C.accent }]}>{state.hosts.length === 0 ? '連接你的電腦' : '新增電腦'}</Text>
          </Pressable>
        </ScrollView>

        {viewing ? (
          <>
            <Text style={styles.section}>模型</Text>
            <View style={styles.card}>
              {models?.loading && models.list.length === 0 ? (
                <View style={styles.row}>
                  <ActivityIndicator />
                  <Text style={styles.rowSub}>讀取中…</Text>
                </View>
              ) : models?.error || (status === 'offline' && !models?.list.length) ? (
                <View style={styles.empty}>
                  <Text style={[styles.emptyText, { color: C.orange }]}>連不到這台電腦。</Text>
                  <View style={styles.inlineButtons}>
                    <TextButton text="重試" onPress={() => store.connectHost(viewing)} />
                    <TextButton text="連線說明" onPress={() => setConnectOpen(true)} />
                  </View>
                </View>
              ) : models && models.list.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyText}>這台電腦還沒有模型。在電腦的終端機執行下面這行，就會下載一個：</Text>
                  <CommandBox command="ollama pull gemma3" copyText={copyText} />
                  <TextButton text="下載好了，重新整理" onPress={() => store.loadModels(viewing)} />
                </View>
              ) : (
                (models?.list ?? []).map((m, i) => {
                  const isLoaded = loaded.find((x) => x.name === m.name);
                  const current = session?.hostUrl === viewing && session?.model === m.name;
                  return (
                    <Pressable
                      key={m.name}
                      onPress={async () => {
                        Haptics.selectionAsync();
                        await store.selectModel(viewing, m.name);
                        onClose();
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`模型 ${m.name}${m.vision ? '，看得懂圖片' : ''}${m.think ? '，可以思考' : ''}${isLoaded ? '，已載入' : ''}`}
                      accessibilityState={{ selected: current }}
                      style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                      <View style={styles.row}>
                        <View style={styles.flex}>
                          <Text style={styles.rowTitle}>{m.name}</Text>
                          <View style={styles.badges}>
                            {m.vision ? <Badge icon="eye" text="看圖" /> : null}
                            {m.think ? <Badge icon="lightbulb" text={m.think.kind === 'toggle' ? '思考' : '思考分段'} /> : null}
                            {m.parameterSize ? <Text style={styles.rowSub}>{m.parameterSize}</Text> : null}
                            {isLoaded ? <Text style={styles.loaded}>已載入 {fmtBytes(isLoaded.sizeVram)}</Text> : null}
                          </View>
                        </View>
                        {current ? <SymbolView name="checkmark" size={16} weight="semibold" tintColor={C.accent} /> : null}
                        <Pressable onPress={() => modelMenu(viewing, m.name, !!isLoaded)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`${m.name} 的選項`}>
                          <SymbolView name="ellipsis.circle" size={20} tintColor={C.secondary} />
                        </Pressable>
                      </View>
                      {i < (models?.list.length ?? 0) - 1 ? <View style={styles.separator} /> : null}
                    </Pressable>
                  );
                })
              )}
            </View>
          </>
        ) : (
          <Text style={styles.footnote}>還沒有連接電腦。按上面的「連接你的電腦」開始。</Text>
        )}
      </ScrollView>

      <Modal visible={connectOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setConnectOpen(false)}>
        <ConnectSheet store={store} state={state} copyText={copyText} onClose={() => setConnectOpen(false)} showHelp={!!models?.error || status === 'offline'} />
      </Modal>
    </View>
  );
}

function Badge({ icon, text }: { icon: 'eye' | 'lightbulb'; text: string }) {
  return (
    <View style={styles.badge}>
      <SymbolView name={icon} size={11} tintColor={C.secondary} />
      <Text style={styles.rowSub}>{text}</Text>
    </View>
  );
}

function TextButton({ text, onPress }: { text: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
      <Text style={styles.textButton}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: C.groupedBg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingBottom: 8 },
  title: { fontSize: 17, fontWeight: '600', color: C.label },
  done: { fontSize: 17, fontWeight: '600', color: C.accent },
  content: { padding: 16, paddingTop: 4, gap: 10, paddingBottom: 40 },
  section: { fontSize: 13, color: C.secondary, marginHorizontal: 4, marginTop: 6 },
  chips: { gap: 8, paddingVertical: 2 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: C.groupedCard },
  chipOn: { backgroundColor: C.accent },
  chipText: { ...TEXT.small, color: C.label },
  chipTextOn: { color: '#ffffff', fontWeight: '700' },
  addChip: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.accent, backgroundColor: 'transparent' },
  textButton: { fontSize: 15, fontWeight: '600', color: C.accent },
  card: { backgroundColor: C.groupedCard, borderRadius: 12, overflow: 'hidden' },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  flex: { flex: 1 },
  rowTitle: { ...TEXT.body, color: C.label },
  rowSub: { ...TEXT.meta, color: C.secondary },
  loaded: { ...TEXT.meta, color: C.green },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 2 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 16 },
  empty: { padding: 16, gap: 10 },
  emptyText: { ...TEXT.small, color: C.label },
  inlineButtons: { flexDirection: 'row', gap: 20 },
  footnote: { fontSize: 13, lineHeight: 18, color: C.secondary, marginHorizontal: 4 },
  pressed: { opacity: 0.4 },
});
