import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { HostOfflineError, type ChatState, type ChatStore } from '../state/chatStore';
import { C, MONO, TEXT } from '../ui/theme';
import { chooseOption } from './Composer';
import { SwipeRow } from './SwipeRow';
import { UndoToast } from './UndoToast';
import { t } from '../i18n';

type Props = {
  store: ChatStore;
  state: ChatState;
  onClose: () => void;
  /** 打開時就展開「連不上嗎？」說明（例如從錯誤訊息的「連線說明」進來） */
  showHelp?: boolean;
  copyText: (text: string) => void;
};

/** 連接你的電腦：自動尋找、手動輸入位址、你的電腦清單、連不上時的說明 */
export function ConnectSheet({ store, state, onClose, showHelp, copyText }: Props) {
  const [helpOpen, setHelpOpen] = useState(!!showHelp);
  const scan = state.scan;
  const failed = !!scan && !scan.running && (!!scan.error || (scan.total > 0 && scan.found === 0));
  const current = state.session?.hostUrl;

  async function find() {
    Haptics.selectionAsync();
    const found = await store.scanLan({ userInitiated: true });
    if (found > 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (store.getState().session?.model) onClose();
    } else {
      setHelpOpen(true);
    }
  }

  function manual() {
    Alert.prompt(
      t('手動輸入位址'),
      t('輸入電腦的 IP 位址，例如 192.168.1.20\n（在電腦的網路設定裡可以看到）'),
      async (text) => {
        try {
          await store.addHost(text);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          if (store.getState().session?.model) onClose();
        } catch (e) {
          if (e instanceof HostOfflineError) {
            setHelpOpen(true);
            Alert.alert(t('連不到這個位址'), t('請看下方「連不上嗎？」的檢查項目。\n\n也可以先加入，等電腦準備好再連。'), [
              { text: t('取消'), style: 'cancel' },
              { text: t('先加入'), onPress: () => void store.addHost(text, { force: true }) },
            ]);
          } else {
            Alert.alert(t('位址格式不對'), e instanceof Error ? e.message : String(e));
          }
        }
      },
      'plain-text',
      '',
      'url'
    );
  }

  function hostMenu(url: string, label: string) {
    chooseOption(label, [t('重新命名'), t('移除這台電腦')], (i) => {
      if (i === 0) Alert.prompt(t('重新命名'), t('取一個好認的名字，例如「書房電腦」'), (name) => store.renameHost(url, name), 'plain-text', label);
      if (i === 1) void store.removeHost(url);
    });
  }

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('連接你的電腦')}</Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
          <Text style={styles.done}>{t('完成')}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.lead}>{t('在電腦上打開 Ollama，讓手機和電腦連同一個 Wi-Fi，再按「自動尋找」。')}</Text>

        {scan?.running ? (
          <View style={[styles.primary, styles.primaryBusy]} accessibilityLiveRegion="polite">
            <ActivityIndicator color="#ffffff" />
            <Text style={styles.primaryText}>{scan.total === 0 ? t('檢查網路中…') : t('尋找中… {p0} / {p1}', { p0: scan.done, p1: scan.total })}</Text>
            <Pressable onPress={() => store.stopScan()} hitSlop={10} accessibilityRole="button">
              <Text style={styles.stop}>{t('停止')}</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable onPress={find} accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && styles.pressedButton]}>
            <SymbolView name="wifi" size={18} tintColor="#ffffff" />
            <Text style={styles.primaryText}>{t('自動尋找')}</Text>
          </Pressable>
        )}
        <Text style={styles.footnote}>{t('第一次尋找時，iPhone 會問是否允許「尋找區域網路上的裝置」，請選「允許」。')}</Text>

        <Pressable onPress={manual} accessibilityRole="button" style={({ pressed }) => [styles.secondary, pressed && styles.pressedButton]}>
          <SymbolView name="keyboard" size={17} tintColor={C.accent} />
          <Text style={styles.secondaryText}>{t('手動輸入位址')}</Text>
        </Pressable>

        {scan && !scan.running && (scan.error || scan.total > 0) ? (
          <Text style={[styles.result, failed && { color: C.orange }]} accessibilityLiveRegion="polite">
            {scan.error || (scan.found > 0 ? t('找到 {p0} 台電腦。', { p0: scan.found }) : t('這個 Wi-Fi 裡沒有找到開著 Ollama 的電腦。'))}
          </Text>
        ) : null}

        {state.hosts.length > 0 ? (
          <>
            <Text style={styles.section}>{t('你的電腦')}</Text>
            <View style={styles.card}>
              {state.hosts.map((h, i) => {
                const st = state.hostStatus[h.url]?.state;
                const stText = st === 'online' ? t('可以使用') : st === 'offline' ? t('目前連不到') : t('檢查中…');
                return (
                  <SwipeRow key={h.url} label={t('移除')} testID={`swipe-host-${h.url}`} onDelete={() => void store.removeHost(h.url)}>
                  <Pressable
                    onPress={async () => {
                      Haptics.selectionAsync();
                      const model = await store.connectHost(h.url);
                      if (model) onClose();
                    }}
                    onLongPress={() => hostMenu(h.url, h.label)}
                    accessibilityRole="button"
                    accessibilityLabel={t('電腦 {p0}，{p1}', { p0: h.label, p1: stText })}
                    accessibilityState={{ selected: current === h.url }}
                    style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                    <View style={styles.row}>
                      {st === 'checking' ? <ActivityIndicator size="small" /> : <View style={[styles.dot, { backgroundColor: st === 'online' ? C.green : C.tertiary }]} />}
                      <View style={styles.flex}>
                        <Text style={styles.rowTitle}>{h.label}</Text>
                        <Text style={[styles.rowSub, st === 'offline' && { color: C.orange }]}>{stText}</Text>
                      </View>
                      {current === h.url ? <Text style={styles.using}>{t('使用中')}</Text> : null}
                      <Pressable onPress={() => hostMenu(h.url, h.label)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('{p0} 的選項', { p0: h.label })}>
                        <SymbolView name="ellipsis.circle" size={20} tintColor={C.secondary} />
                      </Pressable>
                    </View>
                    {i < state.hosts.length - 1 ? <View style={styles.separator} /> : null}
                  </Pressable>
                  </SwipeRow>
                );
              })}
            </View>
          </>
        ) : null}

        <Pressable
          onPress={() => setHelpOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: helpOpen }}
          style={({ pressed }) => [styles.helpHeader, pressed && styles.pressed]}>
          <SymbolView name="questionmark.circle" size={17} tintColor={C.accent} />
          <Text style={styles.helpTitle}>{t('連不上嗎？')}</Text>
          <SymbolView name={helpOpen ? 'chevron.up' : 'chevron.down'} size={12} tintColor={C.secondary} />
        </Pressable>
        {helpOpen ? <ConnectHelp copyText={copyText} /> : null}
      </ScrollView>
      <UndoToast store={store} />
    </View>
  );
}

type Os = 'mac' | 'windows' | 'linux';

const commands = (): Record<Os, { steps: string[]; command: string; after: string }> => ({
  mac: {
    steps: [t('點選單列的 Ollama 圖示，打開「Settings（設定）」'), t('開啟「Expose Ollama to the network（允許網路上的其他裝置連線）」')],
    command: 'launchctl setenv OLLAMA_HOST "0.0.0.0"',
    after: t('舊版 Ollama 沒有這個選項：在「終端機」執行下面這行，再結束並重新打開 Ollama。'),
  },
  windows: {
    steps: [t('在工作列右下角的 Ollama 圖示按右鍵，打開「Settings（設定）」'), t('開啟「Expose Ollama to the network（允許網路上的其他裝置連線）」')],
    command: 'setx OLLAMA_HOST 0.0.0.0',
    after: t('舊版 Ollama 沒有這個選項：在「命令提示字元」執行下面這行，再結束並重新打開 Ollama。'),
  },
  linux: {
    steps: [t('在終端機執行 sudo systemctl edit ollama.service'), t('在 [Service] 底下加入 Environment="OLLAMA_HOST=0.0.0.0" 後存檔')],
    command: 'sudo systemctl daemon-reload && sudo systemctl restart ollama',
    after: t('存檔後執行下面這行讓設定生效：'),
  },
});

/** 連不上時的檢查項目（只在使用者需要時展開，不是教學頁） */
export function ConnectHelp({ copyText }: { copyText: (text: string) => void }) {
  const [os, setOs] = useState<Os>('mac');
  const c = commands()[os];
  return (
    <View style={styles.help} accessibilityLabel={t('連線說明')}>
      <Step n={1} text={t('電腦上的 Ollama 要開著。')} />
      <Step n={2} text={t('手機和電腦要連同一個 Wi-Fi。')} />
      <Step n={3} text={t('讓 Ollama 接受其他裝置連線（Ollama 剛裝好時只接受電腦自己）：')} />
      <View style={styles.tabs} accessibilityRole="tablist">
        {(['mac', 'windows', 'linux'] as const).map((k) => (
          <Pressable
            key={k}
            onPress={() => setOs(k)}
            accessibilityRole="tab"
            accessibilityState={{ selected: os === k }}
            style={[styles.tab, os === k && styles.tabOn]}>
            <Text style={[styles.tabText, os === k && styles.tabTextOn]}>{k === 'mac' ? 'Mac' : k === 'windows' ? 'Windows' : 'Linux'}</Text>
          </Pressable>
        ))}
      </View>
      {c.steps.map((s, i) => (
        <Text key={i} style={styles.helpText}>
          {i + 1}. {s}
        </Text>
      ))}
      <Text style={styles.helpText}>{c.after}</Text>
      <CommandBox command={c.command} copyText={copyText} />
      <Step n={4} text={t('電腦的防火牆要允許 Ollama（連接埠 11434）。Mac 第一次被連線時會跳出詢問，請選「允許」。')} />
      <Step n={5} text={t('電腦上要有模型。在終端機執行下面這行，就會下載一個看得懂圖片的模型：')} />
      <CommandBox command="ollama pull gemma3" copyText={copyText} />
      <Step n={6} text={t('iPhone 的「設定」裡，這個 App 的「區域網路」要打開。')} />
    </View>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <View style={styles.step}>
      <Text style={styles.stepNo}>{n}</Text>
      <Text style={[styles.helpText, styles.flex]}>{text}</Text>
    </View>
  );
}

export function CommandBox({ command, copyText }: { command: string; copyText: (text: string) => void }) {
  return (
    <View style={styles.command}>
      <Text style={styles.commandText} selectable>
        {command}
      </Text>
      <Pressable onPress={() => copyText(command)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('複製指令 {p0}', { p0: command })}>
        <Text style={styles.copy}>{t('複製')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: C.groupedBg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingBottom: 8 },
  title: { fontSize: 17, fontWeight: '600', color: C.label },
  done: { fontSize: 17, fontWeight: '600', color: C.accent },
  pressed: { opacity: 0.4 },
  content: { padding: 16, paddingTop: 4, gap: 12, paddingBottom: 48 },
  lead: { ...TEXT.small, color: C.label },
  primary: { height: 52, borderRadius: 14, backgroundColor: C.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  primaryBusy: { opacity: 0.9 },
  primaryText: { ...TEXT.body, fontWeight: '700', color: '#ffffff' },
  stop: { ...TEXT.small, color: '#ffffff', textDecorationLine: 'underline', marginLeft: 6 },
  pressedButton: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  secondary: {
    height: 48,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.separator,
    backgroundColor: C.groupedCard,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  secondaryText: { ...TEXT.body, fontWeight: '600', color: C.accent },
  result: { ...TEXT.small, color: C.secondary },
  section: { fontSize: 13, color: C.secondary, marginHorizontal: 4, marginTop: 8 },
  card: { backgroundColor: C.groupedCard, borderRadius: 12, overflow: 'hidden' },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  flex: { flex: 1 },
  rowTitle: { ...TEXT.body, color: C.label },
  rowSub: { ...TEXT.meta, color: C.secondary, marginTop: 2 },
  using: { ...TEXT.meta, color: C.accent, fontWeight: '700' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 16 },
  footnote: { fontSize: 13, lineHeight: 18, color: C.secondary, marginHorizontal: 4 },
  helpHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, paddingVertical: 6 },
  helpTitle: { ...TEXT.body, fontWeight: '600', color: C.accent, flex: 1 },
  help: { backgroundColor: C.groupedCard, borderRadius: 12, padding: 16, gap: 10 },
  helpText: { ...TEXT.small, color: C.label },
  step: { flexDirection: 'row', gap: 10 },
  stepNo: { ...TEXT.small, color: C.accent, fontWeight: '700', minWidth: 14 },
  tabs: { flexDirection: 'row', gap: 6, marginLeft: 24 },
  tab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: C.pressed },
  tabOn: { backgroundColor: C.accent },
  tabText: { ...TEXT.small, color: C.label },
  tabTextOn: { color: '#ffffff', fontWeight: '700' },
  command: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.surface, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  commandText: { flex: 1, fontFamily: MONO, fontSize: 12, lineHeight: 17, color: C.label },
  copy: { ...TEXT.meta, color: C.accent, fontWeight: '700' },
});
