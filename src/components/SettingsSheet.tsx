import * as Haptics from 'expo-haptics';
import * as Sharing from 'expo-sharing';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import appJson from '../../app.json';
import { fmtBytes, fmtWhen } from '../lib/format';
import { toolGroupName, type ToolGroup } from '../lib/tools';
import type { AppLanguage, ChatStore } from '../state/chatStore';
import { useChatState } from '../state/useChat';
import type { Db } from '../store/db';
import { TRASH_DAYS, type Action } from '../store/repo';
import { APP_NAME } from '../ui/brand';
import { C, TEXT } from '../ui/theme';
import { AgentsView } from './AgentsSheet';
import { chooseOption } from './Composer';
import { ConnectSheet } from './ConnectSheet';
import { UndoToast } from './UndoToast';
import { t } from '../i18n';

/** 語言名稱：繁體中文、English 用各自的寫法，不翻譯 */
const languageName = (k: 'system' | AppLanguage) => ({ system: t('跟著系統'), 'zh-Hant': '繁體中文', en: 'English' })[k]; // i18n-ignore

const groupIcon = (g: ToolGroup): SFSymbol => ({ calendar: 'calendar', reminders: 'checklist' } as const)[g];

type Props = {
  store: ChatStore;
  onClose: () => void;
  onOpenTrash: () => void;
  copyText: (text: string) => void;
  /** 選一個備份檔，載入成資料庫（取消回 null） */
  pickBackup?: () => Promise<Db | null>;
};

/** 設定：一般、資料、進階、關於。進階的東西放最下面 */
export function SettingsView({ store, onClose, onOpenTrash, copyText, pickBackup }: Props) {
  const state = useChatState(store);
  const { prefs } = state;
  const [info, setInfo] = useState<{ path: string | null; bytes: number; sessions: number; trash: number } | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const groups = store.toolGroups();

  useEffect(() => {
    store.dataInfo().then(setInfo).catch(() => setInfo(null));
  }, [store, state.undo?.id, state.session?.id, state.messages.length]);

  useEffect(() => {
    void store.loadMyAgents();
  }, [store]);

  function pickLanguage() {
    const keys = ['system', 'zh-Hant', 'en'] as const;
    chooseOption(t('語言'), keys.map((k) => languageName(k)), (i) => void store.setPref('language', keys[i]));
  }

  async function backup() {
    try {
      const uri = await store.prepareDatabaseExport();
      if (!uri) return;
      await Sharing.shareAsync(uri, { dialogTitle: t('備份所有對話') });
    } catch (e: any) {
      Alert.alert(t('備份失敗'), String(e?.message ?? e));
    }
  }

  async function restore() {
    if (!pickBackup) return;
    let source: Db | null;
    try {
      source = await pickBackup();
    } catch (e: any) {
      Alert.alert(t('讀不到這個檔案'), String(e?.message ?? e));
      return;
    }
    if (!source) return;
    Alert.alert(t('用備份取代目前的資料？'), t('手機上目前的對話、電腦和設定都會換成備份裡的。還原後幾秒內可以按「復原」換回來。'), [
      { text: t('取消'), style: 'cancel' },
      {
        text: t('還原'),
        style: 'destructive',
        onPress: async () => {
          try {
            await store.restoreFromBackup(source!);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          } catch (e: any) {
            Alert.alert(t('沒有還原'), String(e?.message ?? e));
          }
        },
      },
    ]);
  }

  function resetAll() {
    Alert.alert(
      t('清除全部資料？'),
      t('對話、照片、電腦和設定全部刪除，回到第一次打開的樣子。按下後幾秒內還可以復原，之後就救不回來。\n\n建議先「備份所有對話」。'),
      [
        { text: t('取消'), style: 'cancel' },
        { text: t('清除'), style: 'destructive', onPress: () => void store.resetAll() },
      ]
    );
  }

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <View style={styles.headerSide} />
        <Text style={styles.title} accessibilityRole="header">
          {t('設定')}
        </Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={({ pressed }) => [styles.headerSide, styles.headerRight, pressed && styles.pressed]}>
          <Text style={styles.done}>{t('完成')}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {/* 說明緊跟著它在講的那一列：語言的說明以前排在「你的電腦」下面，看起來像在講電腦 */}
        <Section title={t('一般')}>
          <Row icon="globe" label={t('語言')} value={languageName(prefs.language)} onPress={pickLanguage} accessory="menu" last />
        </Section>
        <Text style={styles.footnote}>{t('AI 也會用這個語言回答。')}</Text>

        <Section title={t('電腦')}>
          <Row icon="desktopcomputer" label={t('你的電腦')} value={t('{p0} 台', { p0: state.hosts.length })} onPress={() => setConnectOpen(true)} last />
        </Section>

        <Section title={t('多 AI 討論')}>
          <Row icon="person.3" label={t('Agent')} value={t('{p0} 個', { p0: state.myAgents.length })} onPress={() => setAgentsOpen(true)} last />
        </Section>
        <Text style={styles.footnote}>{t('在一段對話裡加好幾個 Agent，他們會自己搶話討論，你也是其中一員。')}</Text>

        {groups.length > 0 ? (
          <>
            <Section title={t('AI 可以做的事')}>
              {groups.map((g) => (
                <SwitchRow key={g} icon={groupIcon(g)} label={toolGroupName(g)} value={!prefs.toolsOff.includes(g)} onChange={(on) => void store.setToolGroup(g, on)} />
              ))}
              <Row icon="clock.arrow.circlepath" label={t('做過的事')} onPress={() => setDoneOpen(true)} last />
            </Section>
            {/* 「會叫工具的模型」是術語：直接說目前的模型做不做得到 */}
            <Text style={styles.footnote}>
              {t('AI 改任何東西之前都會先問你，做完也可以復原。')}
              {store.currentModel() ? (store.currentModel()!.tools ? t('目前的模型做得到這些事。') : t('目前的模型做不到這些事，要換一個做得到的模型。')) : ''}
            </Text>
          </>
        ) : null}

        <Section title={t('資料')}>
          <Row icon="trash.slash" label={t('最近刪除')} value={info ? t('{p0} 段', { p0: info.trash }) : ''} onPress={onOpenTrash} accessibilityLabel={t('最近刪除，{p0} 段', { p0: info?.trash ?? 0 })} />
          <Row icon="square.and.arrow.up" label={t('備份所有對話')} onPress={backup} accessory="none" />
          {pickBackup ? <Row icon="square.and.arrow.down" label={t('從備份還原')} onPress={restore} accessory="none" last /> : null}
        </Section>
        <Text style={styles.footnote}>{t('對話只存在這支手機。刪除的對話會在「最近刪除」保留 {n} 天。', { n: TRASH_DAYS })}</Text>

        {/* 紅色的危險操作獨立一組，不跟備份、還原混在一起（iOS 設定的慣例） */}
        <Section title={t('刪除')}>
          <Row icon="trash" label={t('刪除所有對話')} danger onPress={() => void store.deleteAllSessions()} />
          <Row icon="arrow.counterclockwise" label={t('清除全部資料')} danger onPress={resetAll} last />
        </Section>
        <Text style={styles.footnote}>{t('「清除全部資料」連電腦、設定一起刪，只有按下後幾秒內可以復原。')}</Text>

        <Section title={t('進階')}>
          <View style={styles.infoBox}>
            <Text style={styles.rowTitle}>{info ? t('{p0}（{p1}）', { p0: t('資料庫：local-chat.db'), p1: fmtBytes(info.bytes) }) : t('資料庫：local-chat.db')}</Text>
            {info?.path ? (
              <Text style={styles.path} selectable accessibilityLabel={t('資料庫位置')}>
                {info.path}
              </Text>
            ) : null}
          </View>
        </Section>

        <Section title={t('關於')}>
          <View style={styles.infoBox}>
            <Text style={styles.rowTitle}>
              {t('{app} 版本 {version}', { app: APP_NAME, version: appJson.expo.version })}
            </Text>
          </View>
        </Section>
      </ScrollView>
      <UndoToast store={store} />

      <Modal visible={connectOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setConnectOpen(false)}>
        <ConnectSheet store={store} state={state} copyText={copyText} onClose={() => setConnectOpen(false)} manage />
      </Modal>
      <Modal visible={doneOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setDoneOpen(false)}>
        <DoneActions store={store} onClose={() => setDoneOpen(false)} />
      </Modal>
      <Modal visible={agentsOpen} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setAgentsOpen(false)}>
        <AgentsView store={store} onClose={() => setAgentsOpen(false)} />
      </Modal>
    </View>
  );
}

/** 做過的事：AI 加的行程、提醒，最近的在上面，還沒復原的可以復原 */
function DoneActions({ store, onClose }: { store: ChatStore; onClose: () => void }) {
  const [items, setItems] = useState<Action[] | null>(null);
  const reload = () => store.listDoneActions().then(setItems).catch(() => setItems([]));
  useEffect(() => {
    void reload();
  }, []);
  const now = Date.now();
  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <View style={styles.headerSide} />
        <Text style={styles.title} accessibilityRole="header">
          {t('做過的事')}
        </Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={({ pressed }) => [styles.headerSide, styles.headerRight, pressed && styles.pressed]}>
          <Text style={styles.done}>{t('完成')}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          {items === null ? null : items.length === 0 ? (
            <Text style={[styles.rowTitle, styles.empty]}>{t('AI 還沒有幫你做過事。')}</Text>
          ) : (
            items.map((a, i) => {
              const undone = a.status === 'undone';
              const canUndo = !undone && !!store.toolFor(a.tool)?.undo;
              return (
                <View key={a.id}>
                  <View style={styles.row}>
                    <View style={styles.flex}>
                      <Text style={[styles.rowTitle, undone && { color: C.secondary }]}>{a.summary || store.toolFor(a.tool)?.label || a.tool}</Text>
                      <Text style={styles.path}>{undone ? t('{p0}，已復原', { p0: fmtWhen(a.createdAt, now) }) : fmtWhen(a.createdAt, now)}</Text>
                    </View>
                    {canUndo ? (
                      <Pressable
                        onPress={() =>
                          store
                            .undoAction(a.id)
                            .then(reload)
                            .catch((e) => Alert.alert(t('沒辦法復原'), e instanceof Error ? e.message : String(e)))
                        }
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={t('復原：{p0}', { p0: a.summary })}>
                        <Text style={styles.undo}>{t('復原')}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {i < items.length - 1 ? <View style={styles.separator} /> : null}
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function SwitchRow({ icon, label, value, onChange }: { icon: SFSymbol; label: string; value: boolean; onChange: (on: boolean) => void }) {
  return (
    <>
      <View style={styles.row}>
        <SymbolView name={icon} size={18} tintColor={C.accent} />
        <Text style={[styles.rowTitle, styles.flex]}>{label}</Text>
        <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
      </View>
      <View style={styles.separator} />
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <Text style={styles.section}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </>
  );
}

function Row({
  icon,
  label,
  value,
  onPress,
  danger,
  last,
  accessibilityLabel,
  accessory = 'push',
}: {
  icon: SFSymbol;
  label: string;
  value?: string;
  onPress: () => void;
  danger?: boolean;
  last?: boolean;
  accessibilityLabel?: string;
  /** 右邊的符號照 iOS 慣例：推進新的一頁「›」、跳出選單「⌃⌄」、直接執行不放 */
  accessory?: 'push' | 'menu' | 'none';
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (value ? t('{p0}，{p1}', { p0: label, p1: value }) : label)}
      style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
      <View style={styles.row}>
        <SymbolView name={icon} size={18} tintColor={danger ? C.red : C.accent} />
        <Text style={[styles.rowTitle, value ? styles.rowLabel : styles.flex, danger && { color: C.errorText }]}>{label}</Text>
        {value ? (
          <Text style={styles.value} numberOfLines={1}>
            {value}
          </Text>
        ) : null}
        {danger || accessory === 'none' ? null : <SymbolView name={accessory === 'menu' ? 'chevron.up.chevron.down' : 'chevron.right'} size={13} tintColor={C.tertiary} />}
      </View>
      {!last ? <View style={styles.separator} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: C.groupedBg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingBottom: 8 },
  title: { fontSize: 17, fontWeight: '600', color: C.label },
  headerSide: { minWidth: 72 },
  headerRight: { alignItems: 'flex-end' },
  done: { fontSize: 17, fontWeight: '600', color: C.accent },
  pressed: { opacity: 0.4 },
  content: { padding: 16, paddingTop: 4, gap: 8, paddingBottom: 48 },
  section: { fontSize: 13, color: C.secondary, marginHorizontal: 4, marginTop: 14 },
  card: { backgroundColor: C.groupedCard, borderRadius: 12, overflow: 'hidden' },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  flex: { flex: 1 },
  rowTitle: { ...TEXT.body, color: C.label },
  /** 有右邊的值時，標題保持完整寬度（最多 6 成），值放不下就截斷 */
  rowLabel: { flexShrink: 0, maxWidth: '62%' },
  value: { ...TEXT.small, color: C.secondary, flexShrink: 1, marginLeft: 'auto', textAlign: 'right' },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 46 },
  footnote: { fontSize: 13, lineHeight: 18, color: C.secondary, marginHorizontal: 4 },
  infoBox: { padding: 16, gap: 6 },
  path: { ...TEXT.meta, color: C.secondary },
  empty: { padding: 16, color: C.secondary },
  undo: { ...TEXT.small, color: C.accent, fontWeight: '600' },
});
