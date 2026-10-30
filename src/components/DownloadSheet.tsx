import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View, type ColorValue } from 'react-native';

import { bestPick, describeHardware, suggestions, type Fit, type Suggestion } from '../lib/catalog';
import { fmtBytes } from '../lib/format';
import { friendlyModelName } from '../lib/modelName';
import type { DownloadJob } from '../lib/ollama';
import { describeError, type ChatState, type ChatStore } from '../state/chatStore';
import { C, TEXT } from '../ui/theme';
import { t } from '../i18n';

const ENGINE_NAMES: Record<string, string> = { ollama: 'Ollama', lmstudio: 'LM Studio' };

/** 跑不跑得動的白話說明與顏色 */
function fitLabel(fit: Fit): { text: string; color: ColorValue } | null {
  switch (fit) {
    case 'great':
      return { text: t('這台電腦跑得很順'), color: C.green };
    case 'ok':
      return { text: t('跑得動'), color: C.green };
    case 'slow':
      return { text: t('跑得動，但回答比較慢'), color: C.warnText };
    case 'too-big':
      return { text: t('這台電腦的記憶體可能不夠'), color: C.errorText };
    default:
      return null;
  }
}

/** 從手機下載模型：依電腦配備推薦，也可以自己輸入名稱 */
export function DownloadSheet({ store, state, url, onClose, onUse }: { store: ChatStore; state: ChatState; url: string; onClose: () => void; onUse: (model: string) => void }) {
  const info = state.helperInfo[url];
  const engine = info?.downloadEngines[0] ?? 'ollama';
  const viaHelper = !!state.hosts.find((h) => h.url === url)?.helperId;
  const hardware = info?.hardware ?? null;
  const list = suggestions(hardware, engine, state.models[url]?.list ?? []);
  const best = bestPick(list.filter((s) => !s.installed));
  const jobs = state.downloads[url] ?? [];
  const jobFor = (name: string) => [...jobs].reverse().find((j) => j.model === name && j.status !== 'cancelled');
  // 下載好的模型在清單裡的名稱（可能多了 :latest，或撞名時的 @引擎）
  const use = (name: string) => {
    const m = (state.models[url]?.list ?? []).find((x) => x.name === name || x.name === `${name}:latest` || x.name.startsWith(`${name}@`));
    if (m) onUse(m.name);
  };

  /** 用名稱下載的：等電腦說找得到才算開始（名稱打錯要馬上告訴使用者） */
  const [watching, setWatching] = useState<string | null>(null);
  useEffect(() => {
    if (!watching) return;
    const job = [...jobs].reverse().find((j) => j.model === watching);
    if (!job) return;
    if (job.status === 'failed') {
      setWatching(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(t('沒辦法下載「{p0}」', { p0: watching }), downloadError(job));
      void store.dismissDownload(url, job.id);
    } else if (job.status !== 'downloading' || job.total > 0) {
      // 開始有進度了：下面「其他下載」看得到
      setWatching(null);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, [jobs, watching]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start(name: string, byName = false) {
    try {
      await store.startDownload(url, name);
      if (byName) setWatching(name);
      else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (e) {
      Alert.alert(t('沒辦法開始下載'), describeError(e));
    }
  }

  function confirm(s: Suggestion) {
    const where = viaHelper ? t('下載在電腦上進行，關掉 App 也會繼續。') : t('下載完成前請讓 App 開著。');
    const warn = s.fit === 'too-big' ? t('這台電腦的記憶體可能不夠，下載後可能跑不動。') : s.fit === 'slow' ? t('這台電腦跑得動，但回答會比較慢。') : '';
    Alert.alert(t('下載 {p0}？', { p0: friendlyModelName(s.name) }), [t('大約 {p0} GB。', { p0: s.entry.sizeGB }) + where, warn].filter(Boolean).join('\n\n'), [
      { text: t('取消'), style: 'cancel' },
      { text: t('下載'), onPress: () => void start(s.name) },
    ]);
  }

  function byName() {
    const hint = engine === 'lmstudio' ? t('例如 qwen/qwen3-8b，也可以貼上 Hugging Face 的連結。') : t('例如 llama3.2:3b。名稱可以在 ollama.com/library 找到。');
    Alert.prompt(t('用名稱下載'), hint, [
      { text: t('取消'), style: 'cancel' },
      { text: t('下載'), onPress: (v?: string) => void (v?.trim() && start(v.trim(), true)) },
    ]);
  }

  const others = list.filter((s) => s !== best);
  // 用名稱下載的（不在推薦清單裡）
  const names = new Set(list.map((s) => s.name));
  const extra = jobs.filter((j) => !names.has(j.model) && j.model !== watching && (j.status === 'downloading' || j.status === 'failed'));

  return (
    <View style={styles.sheet}>
      {/* 跟設定、最近刪除一樣：標題置中，右邊「完成」（左邊放同寬的空位對稱） */}
      <View style={styles.header}>
        <View style={styles.headerSide} />
        <Text style={styles.title} accessibilityRole="header">
          {t('下載模型')}
        </Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={({ pressed }) => [styles.headerSide, styles.headerRight, pressed && styles.pressed]}>
          <Text style={styles.done}>{t('完成')}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.footnote}>
          {hardware ? t('這台電腦：{p0}', { p0: describeHardware(hardware) }) : t('不知道這台電腦的配備，大小給你參考。')}
        </Text>

        {best ? (
          <>
            <Text style={styles.section}>{t('最推薦')}</Text>
            <View style={styles.card}>
              <View style={styles.bestBody}>
                <Text style={styles.bestTitle}>{friendlyModelName(best.name)}</Text>
                <Text style={styles.blurb}>{best.entry.blurb()}</Text>
                <Meta s={best} />
                <Action s={best} job={jobFor(best.name)} onDownload={() => confirm(best)} onUse={() => use(best.name)} store={store} url={url} wide />
              </View>
            </View>
          </>
        ) : null}

        <Text style={styles.section}>{best ? t('其他模型') : t('模型')}</Text>
        <View style={styles.card}>
          {others.map((s, i) => (
            <View key={s.name}>
              <View style={styles.row}>
                <View style={styles.flex}>
                  <Text style={styles.rowTitle}>{friendlyModelName(s.name)}</Text>
                  <Text style={styles.blurb}>{s.entry.blurb()}</Text>
                  <Meta s={s} />
                </View>
                <Action s={s} job={jobFor(s.name)} onDownload={() => confirm(s)} onUse={() => use(s.name)} store={store} url={url} />
              </View>
              {i < others.length - 1 ? <View style={styles.separator} /> : null}
            </View>
          ))}
        </View>

        {extra.length > 0 || watching ? (
          <>
            <Text style={styles.section}>{t('其他下載')}</Text>
            <View style={styles.card}>
              {watching ? (
                <View style={styles.row}>
                  <View style={styles.flex}>
                    <Text style={styles.rowTitle}>{watching}</Text>
                    <Text style={styles.rowSub}>{t('確認這個名稱…')}</Text>
                  </View>
                </View>
              ) : null}
              {extra.map((j) => (
                <View key={j.id} style={styles.row}>
                  <View style={styles.flex}>
                    <Text style={styles.rowTitle}>{friendlyModelName(j.model)}</Text>
                    {j.status === 'failed' ? <Text style={[styles.rowSub, { color: C.errorText }]}>{downloadError(j)}</Text> : <DownloadProgress job={j} store={store} url={url} />}
                  </View>
                  {j.status === 'failed' ? (
                    <Pressable onPress={() => void store.dismissDownload(url, j.id)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('移除這個下載')}>
                      <SymbolView name="xmark.circle.fill" size={18} tintColor={C.secondary} />
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          </>
        ) : null}

        <Pressable onPress={byName} accessibilityRole="button" style={({ pressed }) => [styles.byName, pressed && styles.pressed]}>
          <Text style={styles.link}>{t('用名稱下載其他模型')}</Text>
        </Pressable>
        <Text style={styles.footnote}>
          {viaHelper
            ? t('會下載到這台電腦的 {p0}。下載在電腦上進行，關掉 App 也會繼續。', { p0: ENGINE_NAMES[engine] ?? engine })
            : t('下載完成前請讓 App 開著。')}
        </Text>
      </ScrollView>
    </View>
  );
}

function Meta({ s }: { s: Suggestion }) {
  const fit = fitLabel(s.fit);
  const parts = [`${s.entry.sizeGB} GB`, s.entry.vision ? t('看得懂圖片') : '', s.entry.think ? t('可以深入思考') : ''].filter(Boolean);
  return (
    <View style={styles.meta}>
      <Text style={styles.rowSub}>{parts.join(' · ')}</Text>
      {fit ? <Text style={[styles.rowSub, { color: fit.color }]}>{fit.text}</Text> : null}
    </View>
  );
}

/** 右邊的動作：下載、進度、已下載 */
function Action(p: { s: Suggestion; job?: DownloadJob; onDownload: () => void; onUse: () => void; store: ChatStore; url: string; wide?: boolean }) {
  const { s, job, onDownload, store, url, wide } = p;
  const name = friendlyModelName(s.name);
  if (s.installed) {
    return (
      <View style={wide ? styles.wide : styles.installed}>
        <View style={styles.installedLabel}>
          <SymbolView name="checkmark.circle.fill" size={14} tintColor={C.green} />
          <Text style={[styles.rowSub, { color: C.green }]}>{t('已下載')}</Text>
        </View>
        <Pressable
          onPress={p.onUse}
          accessibilityRole="button"
          accessibilityLabel={t('使用 {p0}', { p0: name })}
          style={({ pressed }) => [styles.button, wide && styles.buttonWide, pressed && styles.pressed]}>
          <Text style={[styles.buttonText, wide && styles.buttonTextWide]}>{t('開始使用')}</Text>
        </Pressable>
      </View>
    );
  }
  if (job?.status === 'downloading') {
    return (
      <View style={wide ? styles.wide : styles.progressBox}>
        <DownloadProgress job={job} store={store} url={url} />
      </View>
    );
  }
  return (
    <View style={wide ? styles.wide : null}>
      {job?.status === 'failed' ? <Text style={[styles.rowSub, { color: C.errorText }]}>{downloadError(job)}</Text> : null}
      <Pressable
        onPress={onDownload}
        accessibilityRole="button"
        accessibilityLabel={t('下載 {p0}', { p0: name })}
        style={({ pressed }) => [styles.button, wide && styles.buttonWide, pressed && styles.pressed]}>
        <Text style={[styles.buttonText, wide && styles.buttonTextWide]}>{job?.status === 'failed' ? t('重試') : t('下載')}</Text>
      </Pressable>
    </View>
  );
}

/** 下載失敗的白話原因 */
export function downloadError(job: DownloadJob): string {
  if (job.code === 'not_found') return t('找不到這個模型，請確認名稱。');
  return job.error ? t('下載失敗，可以再試一次。（{p0}）', { p0: job.error }) : t('下載失敗，可以再試一次。');
}

/** 進度條＋已下載多少＋取消 */
export function DownloadProgress({ job, store, url }: { job: DownloadJob; store: ChatStore; url: string }) {
  const pct = job.total > 0 ? Math.min(100, Math.floor((job.completed / job.total) * 100)) : 0;
  const text = job.total > 0 ? `${fmtBytes(job.completed)} / ${fmtBytes(job.total)} · ${pct}%` : t('準備中…');
  return (
    <View style={styles.progress} accessibilityLabel={t('下載中 {p0}', { p0: text })} accessibilityLiveRegion="polite">
      <View style={styles.progressTop}>
        <Text style={styles.rowSub} numberOfLines={1}>
          {text}
        </Text>
        {job.cancellable ? (
          <Pressable
            onPress={() =>
              Alert.alert(t('取消下載？'), t('已經下載的部分會保留，下次再下載會接著下載。'), [
                { text: t('繼續下載'), style: 'cancel' },
                { text: t('取消下載'), style: 'destructive', onPress: () => void store.cancelDownload(url, job.id).catch(() => {}) },
              ])
            }
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('取消下載 {p0}', { p0: friendlyModelName(job.model) })}>
            <SymbolView name="xmark.circle.fill" size={18} tintColor={C.secondary} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${pct}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: C.groupedBg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingBottom: 8 },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: C.label },
  headerSide: { minWidth: 72 },
  headerRight: { alignItems: 'flex-end' },
  done: { fontSize: 17, fontWeight: '600', color: C.accent },
  content: { padding: 16, paddingTop: 4, gap: 10, paddingBottom: 40 },
  section: { fontSize: 13, color: C.secondary, marginHorizontal: 4, marginTop: 6 },
  card: { backgroundColor: C.groupedCard, borderRadius: 12, overflow: 'hidden' },
  bestBody: { padding: 16, gap: 4 },
  bestTitle: { fontSize: 20, fontWeight: '700', color: C.label },
  row: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  flex: { flex: 1, gap: 2 },
  rowTitle: { ...TEXT.body, color: C.label },
  blurb: { ...TEXT.small, color: C.label },
  rowSub: { ...TEXT.meta, color: C.secondary },
  meta: { gap: 1 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 16 },
  button: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14, backgroundColor: C.surface, alignItems: 'center' },
  buttonWide: { marginTop: 10, paddingVertical: 11, borderRadius: 10, backgroundColor: C.accentFill },
  buttonText: { fontSize: 15, fontWeight: '600', color: C.accent },
  buttonTextWide: { color: '#ffffff' },
  wide: { marginTop: 10, alignSelf: 'stretch' },
  installed: { alignItems: 'flex-end', gap: 4 },
  installedLabel: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  progressBox: { width: 130 },
  progress: { gap: 6 },
  progressTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  track: { height: 4, borderRadius: 2, backgroundColor: C.surface, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2, backgroundColor: C.accent },
  byName: { alignSelf: 'flex-start', marginHorizontal: 4, marginTop: 4 },
  link: { fontSize: 15, fontWeight: '600', color: C.accent },
  footnote: { fontSize: 13, lineHeight: 18, color: C.secondary, marginHorizontal: 4 },
  pressed: { opacity: 0.4 },
});
