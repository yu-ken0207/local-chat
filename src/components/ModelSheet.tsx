import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fmtBytes } from '../lib/format';
import { friendlyModelName } from '../lib/modelName';
import type { ModelInfo } from '../lib/ollama';
import { diagnosisText, type ChatState, type ChatStore } from '../state/chatStore';
import { C, TEXT } from '../ui/theme';
import { chooseOption } from './Composer';
import { ConnectSheet } from './ConnectSheet';
import { DownloadProgress, DownloadSheet, downloadError } from './DownloadSheet';
import { t } from '../i18n';

/** 選擇模型：上面選電腦，下面選模型。主要任務只有「選一個模型」 */
export function ModelSheet({ store, state, onClose, copyText }: { store: ChatStore; state: ChatState; onClose: () => void; copyText: (text: string) => void }) {
  const [viewing, setViewing] = useState<string | null>(state.session?.hostUrl ?? state.hosts[0]?.url ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  /** 下載畫面關好之後要做的事（iOS 兩層畫面同時關會卡住，要等裡面那層關好） */
  const afterDownload = useRef<(() => void) | null>(null);
  const downloadClosed = () => {
    const next = afterDownload.current;
    afterDownload.current = null;
    next?.();
  };
  /** 正在預先載入或卸載的模型（載入大模型要幾十秒） */
  const [working, setWorking] = useState<{ name: string; text: string } | null>(null);

  async function run(name: string, text: string, task: () => Promise<void>, failTitle: string) {
    setWorking({ name, text });
    try {
      await task();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert(failTitle, String(e?.message ?? e));
    } finally {
      setWorking(null);
    }
  }

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

  function modelMenu(url: string, m: ModelInfo, loadedBytes: number | null) {
    const name = m.name;
    const loaded = loadedBytes !== null;
    // 預先載入／卸載只有 Ollama 與 LM Studio 做得到
    const options = [t('詳細資訊'), ...(m.canLoad ? [loaded ? t('卸載（釋放電腦的顯示卡記憶體）') : t('預先載入（之後第一次回答比較快）')] : [])];
    chooseOption(friendlyModelName(name), options, async (i) => {
      if (i === 0) {
        Alert.alert(
          t('詳細資訊'),
          [
            t('原始名稱：{p0}', { p0: name }),
            m.engineName ? t('在電腦的：{p0}', { p0: m.engineName }) : '',
            m.parameterSize ? t('大小：{p0} 參數', { p0: m.parameterSize }) : '',
            m.quantization ? t('壓縮格式：{p0}', { p0: m.quantization }) : '',
            m.contextLength ? t('最多能記住：{p0} tokens', { p0: m.contextLength.toLocaleString() }) : '',
            loaded ? t('目前佔用顯示卡：{p0}', { p0: fmtBytes(loadedBytes) }) : t('目前沒有載入顯示卡'),
          ]
            .filter(Boolean)
            .join('\n')
        );
        return;
      }
      if (!loaded) {
        void run(name, t('載入中…'), () => store.preload(url, name), t('預先載入失敗'));
        return;
      }
      Alert.alert(t('卸載 {p0}？', { p0: name }), t('模型會離開電腦的顯示卡。如果其他人或程式正在用這個模型，下次使用要重新載入。'), [
        { text: t('取消'), style: 'cancel' },
        { text: t('卸載'), style: 'destructive', onPress: () => void run(name, t('卸載中…'), () => store.unload(url, name), t('卸載失敗')) },
      ]);
    });
  }

  const models = viewing ? state.models[viewing] : undefined;
  const loaded = viewing ? (state.loaded[viewing] ?? []) : [];
  // 還沒問到小幫手前先當作可以下載（小幫手會說清楚做不到的原因）
  const canDownload = !!viewing && (state.helperInfo[viewing]?.downloadEngines.length ?? 1) > 0;
  const jobs = viewing ? (state.downloads[viewing] ?? []).filter((j) => j.status === 'downloading' || j.status === 'failed') : [];
  // 模型來自不只一個引擎時，標出是哪個（例如 LM Studio）
  const multiEngine = new Set((models?.list ?? []).map((m) => m.engine)).size > 1;
  const session = state.session;
  const status = viewing ? state.hostStatus[viewing]?.state : undefined;

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('選擇模型')}</Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
          <Text style={styles.done}>{t('完成')}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
        <Text style={styles.section}>{t('電腦')}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {state.hosts.map((h) => {
            const on = viewing === h.url;
            return (
              <Pressable
                key={h.url}
                onPress={() => {
                  Haptics.selectionAsync();
                  setViewing(h.url);
                }}
                accessibilityRole="button"
                accessibilityLabel={t('顯示 {p0} 的模型', { p0: h.label })}
                accessibilityState={{ selected: on }}
                style={[styles.chip, on && styles.chipOn]}>
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{h.label}</Text>
              </Pressable>
            );
          })}
          <Pressable onPress={() => setConnectOpen(true)} accessibilityRole="button" style={[styles.chip, styles.addChip]}>
            <SymbolView name="plus" size={12} tintColor={C.accent} />
            <Text style={[styles.chipText, { color: C.accent }]}>{state.hosts.length === 0 ? t('連接你的電腦') : t('新增電腦')}</Text>
          </Pressable>
        </ScrollView>

        {viewing ? (
          <>
            <Text style={styles.section}>{t('模型')}</Text>
            <View style={styles.card}>
              {models?.loading && models.list.length === 0 ? (
                <View style={styles.row}>
                  <ActivityIndicator />
                  <Text style={styles.rowSub}>{t('讀取中…')}</Text>
                </View>
              ) : models?.errorCode === 'no_engine' || models?.errorCode === 'engine_unreachable' ? (
                <View style={styles.empty}>
                  <Text style={[styles.emptyText, { color: C.orange }]}>{models.error}</Text>
                  <TextButton text={t('重試')} onPress={() => store.connectHost(viewing)} />
                </View>
              ) : models?.error || (status === 'offline' && !models?.list.length) ? (
                <Unreachable
                  key={viewing}
                  store={store}
                  url={viewing}
                  message={models?.error}
                  onMoved={(url) => setViewing(url)}
                  onHelp={() => setConnectOpen(true)}
                />
              ) : models && models.list.length === 0 && jobs.length === 0 ? (
                <View style={styles.empty}>
                  {canDownload ? (
                    <>
                      <Text style={styles.emptyText}>{t('這台電腦還沒有模型。從手機下載一個就可以開始聊天。')}</Text>
                      <Pressable onPress={() => setDownloadOpen(true)} accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
                        <Text style={styles.primaryText}>{t('選一個模型下載')}</Text>
                      </Pressable>
                    </>
                  ) : (
                    <>
                      <Text style={styles.emptyText}>{t('這台電腦還沒有模型。請在電腦上的 AI 程式裡下載模型，再回來重新整理。')}</Text>
                      <TextButton text={t('重新整理')} onPress={() => store.loadModels(viewing)} />
                    </>
                  )}
                </View>
              ) : (
                <>
                {jobs.map((j) => (
                  <View key={j.id}>
                    <View style={styles.jobRow}>
                      <View style={styles.flex}>
                        <Text style={styles.rowTitle}>{friendlyModelName(j.model)}</Text>
                        {j.status === 'failed' ? <Text style={[styles.rowSub, { color: C.red }]}>{downloadError(j)}</Text> : <DownloadProgress job={j} store={store} url={viewing} />}
                      </View>
                      {j.status === 'failed' ? (
                        <Pressable onPress={() => void store.dismissDownload(viewing, j.id)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('移除這個下載')}>
                          <SymbolView name="xmark.circle.fill" size={18} tintColor={C.secondary} />
                        </Pressable>
                      ) : null}
                    </View>
                    <View style={styles.separator} />
                  </View>
                ))}
                {(models?.list ?? []).map((m, i) => {
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
                      accessibilityLabel={t('模型 {p0}{p1}{p2}{p3}', { p0: friendlyModelName(m.name), p1: m.vision ? t('，看得懂圖片') : '', p2: m.think ? t('，可以深入思考') : '', p3: isLoaded ? t('，回答較快') : '' })}
                      accessibilityState={{ selected: current }}
                      style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                      <View style={styles.row}>
                        <View style={styles.flex}>
                          <Text style={styles.rowTitle}>{friendlyModelName(m.name)}</Text>
                          <View style={styles.badges}>
                            {multiEngine && m.engineName ? <Badge icon="desktopcomputer" text={m.engineName} /> : null}
                            {m.vision ? <Badge icon="eye" text={t('看得懂圖片')} /> : null}
                            {m.think ? <Badge icon="lightbulb" text={m.think.kind === 'always' ? t('一定會先思考') : t('可以深入思考')} /> : null}
                            {isLoaded && working?.name !== m.name ? <Badge icon="bolt.fill" text={t('回答較快')} color={C.green} /> : null}
                            {working?.name === m.name ? (
                              <View style={styles.badge} accessibilityLiveRegion="polite">
                                <ActivityIndicator size="small" />
                                <Text style={styles.rowSub}>{working.text}</Text>
                              </View>
                            ) : null}
                          </View>
                        </View>
                        {current ? <SymbolView name="checkmark" size={16} weight="semibold" tintColor={C.accent} /> : null}
                        <Pressable onPress={() => modelMenu(viewing, m, isLoaded ? isLoaded.sizeVram : null)} disabled={working?.name === m.name} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('{p0} 的選項', { p0: friendlyModelName(m.name) })}>
                          <SymbolView name="ellipsis.circle" size={20} tintColor={C.secondary} />
                        </Pressable>
                      </View>
                      {i < (models?.list.length ?? 0) - 1 || canDownload ? <View style={styles.separator} /> : null}
                    </Pressable>
                  );
                })}
                {canDownload ? (
                  <Pressable onPress={() => setDownloadOpen(true)} accessibilityRole="button" style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                    <View style={styles.row}>
                      <SymbolView name="arrow.down.circle" size={20} tintColor={C.accent} />
                      <Text style={[styles.rowTitle, { color: C.accent }]}>{t('下載更多模型')}</Text>
                    </View>
                  </Pressable>
                ) : null}
                </>
              )}
            </View>
          </>
        ) : (
          <Text style={styles.footnote}>{t('還沒有連接電腦。按上面的「連接你的電腦」開始。')}</Text>
        )}
      </ScrollView>

      <Modal visible={downloadOpen && !!viewing} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setDownloadOpen(false)} onDismiss={downloadClosed}>
        {viewing ? (
          <DownloadSheet
            store={store}
            state={state}
            url={viewing}
            onClose={() => setDownloadOpen(false)}
            onUse={async (model) => {
              Haptics.selectionAsync();
              await store.selectModel(viewing, model);
              afterDownload.current = onClose;
              setDownloadOpen(false);
              setTimeout(downloadClosed, 1500);
            }}
          />
        ) : null}
      </Modal>
      <Modal visible={connectOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setConnectOpen(false)}>
        <ConnectSheet store={store} state={state} copyText={copyText} onClose={() => setConnectOpen(false)} showHelp={!!models?.error || status === 'offline'} />
      </Modal>
    </View>
  );
}

/** 連不到這台電腦：先找原因（手機沒連 Wi-Fi、小幫手沒開、電腦沒回應…），電腦換了位址就直接改好 */
function Unreachable({ store, url, message, onMoved, onHelp }: { store: ChatStore; url: string; message?: string; onMoved: (url: string) => void; onHelp: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let alive = true;
    setText(null);
    void store.diagnose(url).then(async (d) => {
      if (!alive) return;
      if (d.kind === 'moved') {
        onMoved(d.url);
        await store.loadModels(d.url);
        return;
      }
      if (d.kind === 'ok') {
        await store.connectHost(url);
        if (alive) setText(message || t('連不到這台電腦。'));
        return;
      }
      setText(diagnosisText(d));
    });
    return () => {
      alive = false;
    };
  }, [url, tries]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={styles.empty} accessibilityLiveRegion="polite">
      {text === null ? (
        <View style={styles.badge}>
          <ActivityIndicator size="small" />
          <Text style={styles.rowSub}>{t('連不到這台電腦，正在找原因…')}</Text>
        </View>
      ) : (
        <>
          <Text style={[styles.emptyText, { color: C.orange }]}>{text}</Text>
          <View style={styles.inlineButtons}>
            <TextButton text={t('重試')} onPress={() => setTries((n) => n + 1)} />
            <TextButton text={t('連線說明')} onPress={onHelp} />
          </View>
        </>
      )}
    </View>
  );
}

function Badge({ icon, text, color }: { icon: 'eye' | 'lightbulb' | 'bolt.fill' | 'desktopcomputer'; text: string; color?: typeof C.green }) {
  return (
    <View style={styles.badge}>
      <SymbolView name={icon} size={11} tintColor={color ?? C.secondary} />
      <Text style={[styles.rowSub, color ? { color } : null]}>{text}</Text>
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
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 2 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 16 },
  empty: { padding: 16, gap: 10 },
  emptyText: { ...TEXT.small, color: C.label },
  inlineButtons: { flexDirection: 'row', gap: 20 },
  jobRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  primary: { alignSelf: 'stretch', alignItems: 'center', paddingVertical: 11, borderRadius: 10, backgroundColor: C.accent },
  primaryText: { fontSize: 15, fontWeight: '600', color: '#ffffff' },
  footnote: { fontSize: 13, lineHeight: 18, color: C.secondary, marginHorizontal: 4 },
  pressed: { opacity: 0.4 },
});
