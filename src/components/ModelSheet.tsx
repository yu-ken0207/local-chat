import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fmtBytes } from '../lib/format';
import { HostOfflineError, type ChatState, type ChatStore } from '../state/chatStore';
import { C, TEXT } from '../ui/theme';
import { chooseOption } from './Composer';

/** 主機與模型面板：上半部是主機（掃描、新增、在線狀態），下半部是選中主機的模型 */
export function ModelSheet({ store, state, onClose }: { store: ChatStore; state: ChatState; onClose: () => void }) {
  const [viewing, setViewing] = useState<string | null>(state.session?.hostUrl ?? state.hosts[0]?.url ?? null);
  const [refreshing, setRefreshing] = useState(false);

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

  function addHost() {
    Alert.prompt(
      '新增主機',
      '輸入 IP 位址或名稱，例如\n192.168.1.5、100.100.0.31、my-pc',
      async (text) => {
        try {
          const h = await store.addHost(text);
          setViewing(h.url);
        } catch (e) {
          if (e instanceof HostOfflineError) {
            Alert.alert('連不到這台主機', `${e.message}\n\n仍要加入嗎？之後連得到就能用。`, [
              { text: '取消', style: 'cancel' },
              {
                text: '仍要加入',
                onPress: async () => {
                  const h = await store.addHost(text, { force: true });
                  setViewing(h.url);
                },
              },
            ]);
          } else {
            Alert.alert('位址不對', e instanceof Error ? e.message : String(e));
          }
        }
      },
      'plain-text',
      '',
      'url'
    );
  }

  function hostMenu(url: string, label: string) {
    chooseOption(label, ['重新命名', '刪除這台主機'], (i) => {
      if (i === 0) {
        Alert.prompt('重新命名', undefined, (name) => store.renameHost(url, name), 'plain-text', label);
      } else {
        Alert.alert(`刪除「${label}」？`, '只會從清單拿掉，不會影響那台電腦。', [
          { text: '取消', style: 'cancel' },
          { text: '刪除', style: 'destructive', onPress: () => store.removeHost(url) },
        ]);
      }
    });
  }

  function modelMenu(url: string, name: string, loaded: boolean) {
    chooseOption(name, [loaded ? '卸載（離開顯示卡）' : '預熱（先載入顯示卡）'], async () => {
      try {
        if (!loaded) {
          await store.preload(url, name);
          return;
        }
        Alert.alert(`卸載 ${name}？`, '模型會離開顯示卡。如果其他人或服務正在用這台主機的這個模型，下次用要重新載入。', [
          { text: '取消', style: 'cancel' },
          { text: '卸載', style: 'destructive', onPress: () => store.unload(url, name).catch((e) => Alert.alert('卸載失敗', String(e?.message ?? e))) },
        ]);
      } catch (e: any) {
        Alert.alert('預熱失敗', String(e?.message ?? e));
      }
    });
  }

  const scan = state.scan;
  const models = viewing ? state.models[viewing] : undefined;
  const loaded = viewing ? (state.loaded[viewing] ?? []) : [];
  const session = state.session;

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Text style={styles.title}>主機與模型</Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
          <Text style={styles.done}>完成</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>主機</Text>
          <View style={styles.actions}>
            <TextButton text={scan?.running ? '停止掃描' : '掃描區網'} onPress={() => (scan?.running ? store.stopScan() : void store.scanLan())} />
            <TextButton text="新增" onPress={addHost} />
          </View>
        </View>
        {scan && (scan.running || scan.error || scan.total > 0) ? (
          <View style={styles.scanRow} accessibilityLiveRegion="polite">
            {scan.running ? <ActivityIndicator size="small" /> : null}
            <Text style={[styles.footnote, scan.error ? { color: C.orange } : null]}>
              {scan.error || (scan.running ? `掃描中 ${scan.done}/${scan.total}，找到 ${scan.found} 台` : `掃描完成，找到 ${scan.found} 台`)}
            </Text>
          </View>
        ) : null}
        <View style={styles.card}>
          {state.hosts.length === 0 ? (
            <Text style={[styles.footnote, styles.empty]}>
              還沒有主機。連 Wi-Fi 時按「掃描區網」；用 4G 或 Tailscale 時按「新增」輸入位址（例如 100.x.x.x 或電腦名稱）。
            </Text>
          ) : (
            state.hosts.map((h, i) => {
              const st = state.hostStatus[h.url];
              const sub = [h.url.replace(/^https?:\/\//, ''), st?.version || h.version ? `v${st?.version || h.version}` : '', st?.state === 'online' && st.latencyMs !== null ? `${st.latencyMs} ms` : '', st?.state === 'offline' ? '離線' : '', h.source === 'manual' ? '手動' : '掃描']
                .filter(Boolean)
                .join(' · ');
              return (
                <Pressable
                  key={h.url}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setViewing(h.url);
                  }}
                  onLongPress={() => hostMenu(h.url, h.label)}
                  accessibilityRole="button"
                  accessibilityLabel={`主機 ${h.label}，${st?.state === 'online' ? '在線' : st?.state === 'offline' ? '離線' : '檢查中'}`}
                  accessibilityState={{ selected: viewing === h.url }}
                  style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                  <View style={styles.row}>
                    <StatusDot state={st?.state} />
                    <View style={styles.flex}>
                      <Text style={styles.rowTitle}>{h.label}</Text>
                      <Text style={styles.rowSub} numberOfLines={1}>
                        {sub}
                      </Text>
                    </View>
                    {viewing === h.url ? <SymbolView name="checkmark" size={16} weight="semibold" tintColor={C.accent} /> : null}
                    <Pressable onPress={() => hostMenu(h.url, h.label)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`${h.label} 的選項`}>
                      <SymbolView name="ellipsis.circle" size={20} tintColor={C.secondary} />
                    </Pressable>
                  </View>
                  {i < state.hosts.length - 1 ? <View style={styles.separator} /> : null}
                </Pressable>
              );
            })
          )}
        </View>

        {viewing ? (
          <>
            <Text style={[styles.sectionTitle, styles.sectionTitleAlone]}>模型（{store.hostLabel(viewing)}）</Text>
            <View style={styles.card}>
              {models?.loading && models.list.length === 0 ? (
                <View style={styles.row}>
                  <ActivityIndicator />
                  <Text style={styles.rowSub}>讀取模型中…</Text>
                </View>
              ) : models?.error ? (
                <View style={[styles.row, styles.top]}>
                  <Text style={[styles.footnote, styles.flex, { color: C.red }]}>{models.error}</Text>
                  <TextButton text="重試" onPress={() => store.loadModels(viewing)} />
                </View>
              ) : models && models.list.length === 0 ? (
                <Text style={[styles.footnote, styles.empty]}>這台主機沒有可以聊天的模型。</Text>
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
        ) : null}
        <Text style={styles.footnote}>往下拉可以重新檢查。長按主機可以改名或刪除；按模型右邊的 ⋯ 可以預熱或卸載。</Text>
      </ScrollView>
    </View>
  );
}

function StatusDot({ state }: { state?: 'checking' | 'online' | 'offline' }) {
  if (state === 'checking') return <ActivityIndicator size="small" />;
  return <View style={[styles.dot, { backgroundColor: state === 'online' ? C.green : C.tertiary }]} />;
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
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: 4, marginTop: 6 },
  sectionTitle: { fontSize: 13, color: C.secondary },
  sectionTitleAlone: { marginHorizontal: 4, marginTop: 14 },
  actions: { flexDirection: 'row', gap: 18 },
  textButton: { fontSize: 15, fontWeight: '600', color: C.accent },
  scanRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 4 },
  card: { backgroundColor: C.groupedCard, borderRadius: 12, overflow: 'hidden' },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  top: { alignItems: 'flex-start' },
  flex: { flex: 1 },
  rowTitle: { ...TEXT.body, color: C.label },
  rowSub: { ...TEXT.meta, color: C.secondary },
  loaded: { ...TEXT.meta, color: C.green },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 2 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 16 },
  footnote: { fontSize: 13, lineHeight: 18, color: C.secondary, marginHorizontal: 4 },
  empty: { padding: 16 },
  pressed: { opacity: 0.4 },
});
