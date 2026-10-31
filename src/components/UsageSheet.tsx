import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { describeHardware } from '../lib/catalog';
import { contextLevel, fmtBytes, fmtCount, fmtK, fmtRough, fmtUnload, type ContextLevel } from '../lib/format';
import { friendlyModelName } from '../lib/modelName';
import type { ChatStore, ContextInfo, UsagePartKey, UsageReport } from '../state/chatStore';
import type { UsageTotals } from '../store/repo';
import { C, TEXT } from '../ui/theme';
import { getLanguage, t } from '../i18n';

// 用量：最上面是上半圓的儀表（這段對話 AI 記住的內容用了幾成），下面是各部分、這台電腦、今天與這 7 天的累計。
// 指針用彈簧轉：打開時從 0 轉到現在的值；面板開著時又答完一則，從原本的位置接著轉過去。

/** 臨界阻尼（不回彈）：沒有手勢帶著動量，指針不該晃 */
const NEEDLE_SPRING = { stiffness: 160, damping: 26, mass: 1, useNativeDriver: true } as const;

const GAUGE_W = 232;
const STROKE = 12;
const R = (GAUGE_W - STROKE) / 2;
const CX = GAUGE_W / 2;
const CY = R + STROKE / 2;
const HUB = 16;
const GAUGE_H = CY + HUB / 2 + 2;
/** 指針尖端停在刻度點附近，看得出指到哪一段 */
const NEEDLE = R - STROKE / 2 - 6;
/** 三段之間留一點縫 */
const GAP = 0.004;
/** 刻度點：跟輸入框下方的儀表圖示一樣有點 */
const TICKS = [0, 0.25, 0.5, 0.75, 1];

/** 綠：還夠；橘：快滿了（跟輸入框下方變色同一個門檻 80%）；紅：差不多滿了 */
const ZONES = [
  { from: 0, to: 0.8, color: 'green' },
  { from: 0.8, to: 0.95, color: 'orange' },
  { from: 0.95, to: 1, color: 'red' },
] as const;

// react-native-svg 的顏色用實際的色碼：iOS 系統色的淺色、深色版本
const PALETTE = {
  light: { green: '#34C759', orange: '#FF9500', red: '#FF3B30', dot: '#C7C7CC' },
  dark: { green: '#30D158', orange: '#FF9F0A', red: '#FF453A', dot: '#48484A' },
} as const;

/** 上半圓上的點：v 是 0（左邊）到 1（右邊） */
function point(v: number, radius: number) {
  const a = Math.PI * (1 - v);
  return { x: CX + radius * Math.cos(a), y: CY - radius * Math.sin(a) };
}

function arc(from: number, to: number) {
  const a = point(from, R);
  const b = point(to, R);
  return `M ${a.x} ${a.y} A ${R} ${R} 0 0 1 ${b.x} ${b.y}`;
}

/** 右上角的字最多放大到 1.3 倍（跟標題列一樣，大字時還放得下） */
const METER_MAX_SCALE = 1.3;

/** 右上角的儀表圖示：指針停在最接近的位置（SF Symbols 只有這五格；確切的數字寫在旁邊） */
export function gaugeSymbol(ratio: number | null): SFSymbol {
  if (ratio === null || ratio < 0.17) return 'gauge.with.dots.needle.0percent';
  if (ratio < 0.42) return 'gauge.with.dots.needle.33percent';
  if (ratio < 0.59) return 'gauge.with.dots.needle.50percent';
  if (ratio < 0.84) return 'gauge.with.dots.needle.67percent';
  return 'gauge.with.dots.needle.100percent';
}

/**
 * 右上角的用量：儀表圖示加百分比，下面一行是用了多少／最多記住多少；AI 回答時一路跟著變，點了打開用量面板。
 * 快滿變橘、滿了變紅
 */
export function UsageMeter({ context, onPress }: { context: ContextInfo | null; onPress: () => void }) {
  const ratio = context?.limit ? context.used / context.limit : null;
  const pct = ratio !== null ? Math.min(100, Math.round(ratio * 100)) : null;
  const color = levelColor(context?.level ?? 'ok');
  // 半形斜線、不留空白：標題列放得下，標題才維持置中
  const numbers = context ? (context.limit ? `${fmtK(context.used)}/${fmtK(context.limit)}` : fmtK(context.used)) : '';
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={pct !== null ? t('用量，這段用了 {p0}%', { p0: pct }) : t('用量')}
      accessibilityValue={context ? { text: context.limit ? t('{p0}／{p1} tokens', { p0: context.used.toLocaleString('en-US'), p1: context.limit.toLocaleString('en-US') }) : t('{p0} tokens', { p0: context.used.toLocaleString('en-US') }) } : undefined}
      style={({ pressed }) => [styles.meter, pressed && styles.pressed]}
      testID="usage-button">
      <SymbolView name={gaugeSymbol(ratio)} size={20} tintColor={color ?? C.secondary} />
      {context ? (
        <View>
          {pct !== null ? (
            <Text style={[styles.meterPct, color ? { color } : null]} maxFontSizeMultiplier={METER_MAX_SCALE}>
              {`${pct}%`}
            </Text>
          ) : null}
          <Text style={styles.meterNumbers} maxFontSizeMultiplier={METER_MAX_SCALE}>
            {numbers}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** 快滿、滿了的字色（橘、紅的高對比版本，小字也看得清楚） */
function levelColor(level: ContextLevel) {
  return level === 'full' ? C.errorText : level === 'near' ? C.warnText : undefined;
}

function partLabel(key: UsagePartKey | 'free'): string {
  switch (key) {
    case 'messages':
      return t('對話內容');
    case 'system':
      return t('系統說明');
    case 'tools':
      return t('工具說明');
    case 'role':
      return t('角色與筆記');
    case 'summary':
      return t('前情摘要');
    case 'images':
      return t('照片');
    case 'free':
      return t('剩餘空間');
  }
}

/** 佔了幾 %；有用到但不到 1% 寫「<1%」 */
function percent(n: number, of: number): string {
  if (of <= 0 || n <= 0) return '0%';
  const p = Math.round((n / of) * 100);
  return p === 0 ? '<1%' : `${p}%`;
}

export function UsageSheet({ store, version, reduceMotion, onClose }: { store: ChatStore; version: number; reduceMotion: boolean; onClose: () => void }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [range, setRange] = useState<'today' | 'week'>('today');

  // 面板開著時又答完一則（version 變了）就重讀，指針接著轉
  useEffect(() => {
    let alive = true;
    store.usageReport().then(
      (r) => alive && setReport(r),
      () => alive && setFailed(true)
    );
    return () => {
      alive = false;
    };
  }, [store, version]);

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <View style={styles.headerSide} />
        <Text style={styles.title} accessibilityRole="header">
          {t('用量')}
        </Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={({ pressed }) => [styles.headerSide, styles.headerRight, pressed && styles.pressed]}>
          <Text style={styles.done}>{t('完成')}</Text>
        </Pressable>
      </View>
      {report ? (
        <ScrollView contentContainerStyle={styles.content}>
          {report.context ? <ContextCard context={report.context} reduceMotion={reduceMotion} /> : null}
          {report.computer ? <ComputerCard computer={report.computer} now={Date.now()} /> : null}
          <TotalsCard store={store} totals={range === 'today' ? report.today : report.week} range={range} onRange={setRange} />
        </ScrollView>
      ) : failed ? (
        <Text style={[styles.footnote, styles.loading]}>{t('讀不到用量，關掉再打開試試。')}</Text>
      ) : (
        <ActivityIndicator style={styles.loading} />
      )}
    </View>
  );
}

function ContextCard({ context, reduceMotion }: { context: NonNullable<UsageReport['context']>; reduceMotion: boolean }) {
  const { used, limit, estimated, parts } = context;
  const level = contextLevel(used, limit);
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const total = estimated ? t('約 {p0}', { p0: fmtRough(used) }) : used.toLocaleString('en-US');
  const caption = limit ? t('{p0}／{p1} tokens', { p0: total, p1: limit.toLocaleString('en-US') }) : t('{p0} tokens', { p0: total });
  const status = level === 'full' ? t('滿了，AI 已經記不住最前面的內容') : level === 'near' ? t('快滿了') : '';
  const rows: { key: UsagePartKey | 'free'; tokens: number }[] = [...parts, ...(limit ? [{ key: 'free' as const, tokens: Math.max(0, limit - used) }] : [])];

  return (
    <>
      <Text style={styles.section}>{t('這段對話')}</Text>
      <View style={styles.card}>
        <View
          style={styles.gaugeBlock}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={t('AI 記住的內容')}
          accessibilityValue={pct !== null ? { min: 0, max: 100, now: pct, text: [`${pct}%`, caption, status].filter(Boolean).join(t('，')) } : { text: caption }}>
          {limit ? <Gauge ratio={used / limit} reduceMotion={reduceMotion} /> : null}
          <Text style={[styles.big, { color: levelColor(level) ?? C.label }]}>{pct !== null ? `${pct}%` : total}</Text>
          <Text style={styles.caption}>{limit ? caption : t('不知道這個模型最多能記住多少')}</Text>
          {status ? <Text style={[styles.status, { color: levelColor(level) }]}>{status}</Text> : null}
        </View>
        {rows.map((p) => (
          <View key={p.key}>
            <View style={styles.separator} />
            <View
              style={styles.partRow}
              accessible
              accessibilityLabel={t('{p0}：{p1} tokens，{p2}', {
                p0: partLabel(p.key),
                p1: p.key === 'free' ? p.tokens.toLocaleString('en-US') : t('約 {p0}', { p0: fmtRough(p.tokens) }),
                p2: percent(p.tokens, limit ?? used),
              })}>
              <Text style={styles.partLabel} numberOfLines={1}>
                {partLabel(p.key)}
              </Text>
              <Text style={styles.partValue}>{p.key === 'free' ? p.tokens.toLocaleString('en-US') : t('約 {p0}', { p0: fmtRough(p.tokens) })}</Text>
              <Text style={styles.partPct}>{percent(p.tokens, limit ?? used)}</Text>
            </View>
          </View>
        ))}
      </View>
      <Text style={styles.footnote}>{estimated ? t('這段還沒問過 AI，全部是估的。') : t('總數是模型回報的，各部分是照內容估的。')}</Text>
    </>
  );
}

function Gauge({ ratio, reduceMotion }: { ratio: number; reduceMotion: boolean }) {
  const colors = PALETTE[useColorScheme() === 'dark' ? 'dark' : 'light'];
  const v = Math.min(1, Math.max(0, ratio));
  const angle = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion) angle.setValue(v);
    else Animated.spring(angle, { toValue: v, ...NEEDLE_SPRING }).start();
  }, [angle, v, reduceMotion]);
  const rotate = angle.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });

  return (
    <View style={styles.gauge} pointerEvents="none" testID="usage-gauge">
      <Svg width={GAUGE_W} height={GAUGE_H}>
        {ZONES.map((z, i) => (
          <Path key={z.color} d={arc(z.from + (i > 0 ? GAP : 0), z.to - (i < ZONES.length - 1 ? GAP : 0))} stroke={colors[z.color]} strokeWidth={STROKE} fill="none" />
        ))}
        {TICKS.map((x) => {
          const p = point(x, R - STROKE / 2 - 9);
          return <Circle key={x} cx={p.x} cy={p.y} r={2} fill={colors.dot} />;
        })}
      </Svg>
      {/* 指針一開始朝左（0%），整塊以軸心為中心順時針轉到現在的值 */}
      <Animated.View style={[styles.needleBox, { transform: [{ rotate }] }]}>
        <View style={styles.needle} />
      </Animated.View>
      <View style={styles.hub}>
        <View style={styles.hubDot} />
      </View>
    </View>
  );
}

function ComputerCard({ computer, now }: { computer: NonNullable<UsageReport['computer']>; now: number }) {
  const hw = describeHardware(computer.hardware);
  return (
    <>
      <Text style={styles.section}>{t('電腦')}</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <SymbolView name="desktopcomputer" size={20} tintColor={C.secondary} />
          <View style={styles.flex}>
            <Text style={styles.rowTitle}>{computer.label}</Text>
            {hw ? <Text style={styles.rowSub}>{hw}</Text> : null}
          </View>
        </View>
        {!computer.reachable || computer.models.length === 0 ? (
          <>
            <View style={styles.separator} />
            <Text style={styles.empty}>{!computer.reachable ? t('現在連不上這台電腦。') : t('現在沒有載入的模型，下次回答要先載入，會慢一點。')}</Text>
          </>
        ) : (
          computer.models.map((m) => (
            <View key={m.name}>
              <View style={styles.separator} />
              <View style={styles.row}>
                <View style={styles.flex}>
                  <Text style={styles.rowTitle}>{friendlyModelName(m.name)}</Text>
                  <Text style={styles.rowSub}>
                    {[
                      m.sizeVram > 0 ? t('顯示卡記憶體 {p0}', { p0: fmtBytes(m.sizeVram) }) : '',
                      m.contextLength ? t('最多記住 {p0} tokens', { p0: m.contextLength.toLocaleString('en-US') }) : '',
                      fmtUnload(m.expiresAt, now),
                    ]
                      .filter(Boolean)
                      .join(t('，'))}
                  </Text>
                </View>
              </View>
            </View>
          ))
        )}
      </View>
    </>
  );
}

function TotalsCard({ store, totals, range, onRange }: { store: ChatStore; totals: UsageTotals; range: 'today' | 'week'; onRange: (r: 'today' | 'week') => void }) {
  const all = totals.promptTokens + totals.outputTokens;
  const background = all > 0 && totals.backgroundTokens > 0 ? t('其中 {p0} 是背景工作，例如取標題、整理摘要、找 Agent。', { p0: percent(totals.backgroundTokens, all) }) : '';
  return (
    <>
      <Text style={styles.section}>{t('累計')}</Text>
      <View style={styles.segment} accessibilityRole="tablist">
        {(['today', 'week'] as const).map((k) => (
          <Pressable
            key={k}
            onPress={() => onRange(k)}
            accessibilityRole="tab"
            accessibilityState={{ selected: range === k }}
            style={[styles.segmentItem, range === k && styles.segmentOn]}>
            <Text style={[styles.segmentText, range === k && styles.segmentTextOn]}>{k === 'today' ? t('今天') : t('這 7 天')}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.card}>
        {totals.calls === 0 ? (
          <Text style={styles.empty}>{range === 'today' ? t('今天還沒用到 AI。') : t('這 7 天還沒用到 AI。')}</Text>
        ) : (
          <>
            <View style={styles.stats}>
              <Stat label={t('輸入 tokens')} value={fmtCount(totals.promptTokens)} />
              <Stat label={t('輸出 tokens')} value={fmtCount(totals.outputTokens)} />
              <Stat label={t('次數')} value={fmtCount(totals.calls)} />
            </View>
            {totals.byModel.map((m) => {
              const speed = m.evalMs > 0 && m.outputTokens > 0 ? t('每秒 {p0} tokens', { p0: Math.round(m.outputTokens / (m.evalMs / 1000)) }) : '';
              return (
                <View key={`${m.hostUrl} ${m.model}`}>
                  <View style={styles.separator} />
                  <View style={styles.row}>
                    <View style={styles.flex}>
                      <Text style={styles.rowTitle}>{friendlyModelName(m.model)}</Text>
                      <Text style={styles.rowSub}>{[store.hostLabel(m.hostUrl), m.calls === 1 ? t('1 次') : t('{n} 次', { n: m.calls }), speed].filter(Boolean).join(t('，'))}</Text>
                    </View>
                    <Text style={styles.rowValue}>{fmtCount(m.promptTokens + m.outputTokens)}</Text>
                  </View>
                </View>
              );
            })}
          </>
        )}
      </View>
      <Text style={styles.footnote}>{[background, t('只算這支手機用的，紀錄留 90 天。')].filter(Boolean).join(getLanguage() === 'en' ? ' ' : '')}</Text>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label} ${value}`}>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
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
  pressed: { opacity: 0.4 },
  loading: { marginTop: 40, textAlign: 'center' },
  content: { padding: 16, paddingTop: 4, gap: 8, paddingBottom: 48 },
  section: { fontSize: 13, color: C.secondary, marginHorizontal: 4, marginTop: 14 },
  card: { backgroundColor: C.groupedCard, borderRadius: 12, overflow: 'hidden' },
  footnote: { fontSize: 13, lineHeight: 18, color: C.secondary, marginHorizontal: 4 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 16 },
  gaugeBlock: { alignItems: 'center', paddingTop: 20, paddingBottom: 16, paddingHorizontal: 16 },
  gauge: { width: GAUGE_W, height: GAUGE_H },
  needleBox: { position: 'absolute', left: CX - NEEDLE, top: CY - NEEDLE, width: NEEDLE * 2, height: NEEDLE * 2 },
  // 從尖端到軸心後面一點
  needle: { position: 'absolute', left: 0, top: NEEDLE - 2, width: NEEDLE + 8, height: 4, borderRadius: 2, backgroundColor: C.label },
  hub: { position: 'absolute', left: CX - HUB / 2, top: CY - HUB / 2, width: HUB, height: HUB, borderRadius: HUB / 2, backgroundColor: C.label, alignItems: 'center', justifyContent: 'center' },
  hubDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.groupedCard },
  // 大數字用系統字、等寬數字、字距收一點（大字的字距要負的）
  big: { marginTop: 6, fontSize: 40, lineHeight: 46, fontWeight: '700', letterSpacing: -0.6, fontVariant: ['tabular-nums'] },
  caption: { ...TEXT.small, color: C.secondary, textAlign: 'center' },
  status: { ...TEXT.small, fontWeight: '600', textAlign: 'center', marginTop: 4 },
  partRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, paddingHorizontal: 16, paddingVertical: 8 },
  partLabel: { ...TEXT.small, color: C.label, flex: 1 },
  partValue: { ...TEXT.small, color: C.label },
  partPct: { ...TEXT.small, color: C.secondary, minWidth: 40, textAlign: 'right' },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  flex: { flex: 1 },
  rowTitle: { ...TEXT.body, color: C.label },
  rowSub: { ...TEXT.meta, color: C.secondary, marginTop: 2 },
  rowValue: { ...TEXT.small, color: C.label },
  empty: { ...TEXT.small, color: C.secondary, padding: 16 },
  segment: { flexDirection: 'row', padding: 2, borderRadius: 9, backgroundColor: C.pressed },
  segmentItem: { flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 7 },
  segmentOn: { backgroundColor: C.groupedCard },
  segmentText: { fontSize: 14, color: C.secondary },
  segmentTextOn: { color: C.label, fontWeight: '600' },
  meter: { height: 38, flexDirection: 'row', alignItems: 'center', gap: 6 },
  meterPct: { fontSize: 13, lineHeight: 15, fontWeight: '600', color: C.label, fontVariant: ['tabular-nums'] },
  meterNumbers: { fontSize: 10, lineHeight: 12, color: C.secondary, fontVariant: ['tabular-nums'] },
  stats: { flexDirection: 'row', paddingVertical: 14, paddingHorizontal: 8 },
  stat: { flex: 1, alignItems: 'center', gap: 2, paddingHorizontal: 4 },
  statLabel: { ...TEXT.meta, color: C.secondary },
  statValue: { fontSize: 22, lineHeight: 28, fontWeight: '600', color: C.label, fontVariant: ['tabular-nums'] },
});
