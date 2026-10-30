import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { HostOfflineError, NeedsPairingError, PairError, type ChatState, type ChatStore } from '../state/chatStore';
import { C, MONO, TEXT } from '../ui/theme';
import { chooseOption } from './Composer';
import { QrScanner } from './QrScanner';
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
  /** 從設定的「你的電腦」進來：管理用，電腦清單放最上面，點一台只出選單、不直接切換目前的對話 */
  manage?: boolean;
  /** 配對成功但電腦還沒有模型：按「選一個模型下載」時（外面關掉這個面板、接著打開選模型） */
  onNeedModel?: () => void;
};

/** 連接你的電腦：自動尋找、手動輸入位址、你的電腦清單、連不上時的說明 */
export function ConnectSheet({ store, state, onClose, showHelp, copyText, manage, onNeedModel }: Props) {
  // 配對成功但還不能聊：電腦還沒有模型（給下載），或讀不到電腦上的模型（給再試一次）；面板最上面說清楚
  const [pairedNoModel, setPairedNoModel] = useState<{ url: string; name: string; failed: boolean } | null>(null);
  const [helpOpen, setHelpOpen] = useState(!!showHelp);
  /** 手動輸入的位址正在連線（最久要等幾秒，畫面要讓人知道還在動） */
  const [adding, setAdding] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  /** 掃描畫面關好之後要做的事（iOS 兩層畫面同時關會卡住，要等裡面那層關好） */
  const afterScanner = useRef<(() => void) | null>(null);
  const scannerClosed = () => {
    const next = afterScanner.current;
    afterScanner.current = null;
    next?.();
  };
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

  /**
   * 配對成功：選好模型就關掉面板，可以直接聊天；電腦還沒有模型就說清楚、給「選一個模型下載」。
   * 讀模型清單失敗（例如電腦上的模型服務還沒開）不是「沒有模型」：說讀不到、給「再試一次」
   */
  function paired(url: string) {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const st = store.getState();
    if (st.session?.model) return onClose();
    setPairedNoModel({ url, name: store.hostLabel(url) || t('你的電腦'), failed: !!st.models[url]?.error });
  }

  async function retryModels(url: string) {
    await store.connectHost(url);
    if (store.getState().session?.model) return onClose();
    setPairedNoModel({ url, name: store.hostLabel(url) || t('你的電腦'), failed: !!store.getState().models[url]?.error });
  }

  /** 掃到 QR code：配對成功回 null，失敗回說明（掃描畫面會顯示） */
  async function scanned(data: string): Promise<string | null> {
    try {
      const url = await store.pairFromQr(data);
      afterScanner.current = () => paired(url);
      setScannerOpen(false);
      // 保險：iOS 沒回報關好時也要繼續
      setTimeout(scannerClosed, 1500);
      return null;
    } catch (e) {
      return e instanceof PairError ? e.message : String(e instanceof Error ? e.message : e);
    }
  }

  /** 輸入電腦上小幫手顯示的 6 位數配對碼 */
  function enterCode(url: string, name: string) {
    Alert.prompt(
      t('輸入配對碼'),
      t('在「{p0}」的小幫手按「配對新手機」，輸入畫面上的 6 位數字。', { p0: name || t('這台電腦') }),
      async (code) => {
        setAdding(name || url);
        try {
          paired(await store.pairHelper(url, code));
        } catch (e) {
          Alert.alert(t('沒有配對成功'), e instanceof Error ? e.message : String(e));
        } finally {
          setAdding(null);
        }
      },
      'plain-text',
      '',
      'number-pad'
    );
  }

  function manual() {
    Alert.prompt(
      t('手動輸入位址'),
      t('輸入電腦的 IP 位址，例如 192.168.1.20\n（在電腦的網路設定裡可以看到）'),
      async (text) => {
        setAdding(text.trim());
        try {
          await store.addHost(text);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          if (store.getState().session?.model) onClose();
        } catch (e) {
          if (e instanceof NeedsPairingError) {
            setAdding(null);
            enterCode(e.url, e.name);
          } else if (e instanceof HostOfflineError) {
            setHelpOpen(true);
            Alert.alert(t('連不到這個位址'), t('請看下方「連不上嗎？」的檢查項目。\n\n也可以先加入，等電腦準備好再連。'), [
              { text: t('取消'), style: 'cancel' },
              { text: t('先加入'), onPress: () => void store.addHost(text, { force: true }) },
            ]);
          } else {
            Alert.alert(t('位址格式不對'), e instanceof Error ? e.message : String(e));
          }
        } finally {
          setAdding(null);
        }
      },
      'plain-text',
      '',
      'url'
    );
  }

  function hostMenu(url: string, label: string) {
    // 管理用的頁面：要改用哪台由使用者自己選，不要點一下就切換目前的對話
    if (manage) {
      chooseOption(label, [t('改用這台電腦'), t('移除這台電腦')], (i) => (i === 0 ? void use(url, label) : void store.removeHost(url)), 1);
      return;
    }
    chooseOption(label, [t('移除這台電腦')], () => void store.removeHost(url), 0);
  }

  /** 改用這台電腦；連不到就直接說，並打開「連不上嗎？」 */
  async function use(url: string, label: string) {
    Haptics.selectionAsync();
    if (store.needsPairing(url)) {
      chooseOption(t('「{p0}」要重新配對', { p0: label }), [t('掃描 QR code'), t('輸入配對碼')], (i) => (i === 0 ? setScannerOpen(true) : enterCode(url, label)));
      return;
    }
    const model = await store.connectHost(url);
    if (model) return onClose();
    if (store.getState().models[url]?.error) {
      setHelpOpen(true);
      Alert.alert(t('連不到「{p0}」', { p0: label }), t('請確認這台電腦開著 Ollama，手機也連得到它。下方「連不上嗎？」有檢查步驟。'));
    }
  }

  const hostList =
    state.hosts.length > 0 ? (
          <>
            <Text style={styles.section}>{t('你的電腦')}</Text>
            <View style={styles.card}>
              {state.hosts.map((h, i) => {
                return (
                  <SwipeRow key={h.url} label={t('移除')} testID={`swipe-host-${h.url}`} onDelete={() => void store.removeHost(h.url)}>
                  <Pressable
                    onPress={() => (manage ? hostMenu(h.url, h.label) : void use(h.url, h.label))}
                    onLongPress={() => hostMenu(h.url, h.label)}
                    accessibilityRole="button"
                    accessibilityLabel={t('電腦 {p0}', { p0: h.label })}
                    accessibilityState={{ selected: current === h.url }}
                    style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                    <View style={styles.row}>
                      <SymbolView name="desktopcomputer" size={18} tintColor={C.secondary} />
                      <Text style={[styles.rowTitle, styles.flex]}>{h.label}</Text>
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
    ) : null;

  return (
    <View style={styles.sheet}>
      {/* 跟設定、最近刪除一樣：標題置中，右邊「完成」（左邊放同寬的空位對稱） */}
      <View style={styles.header}>
        <View style={styles.headerSide} />
        <Text style={styles.title} accessibilityRole="header">
          {manage ? t('你的電腦') : t('連接你的電腦')}
        </Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={({ pressed }) => [styles.headerSide, styles.headerRight, pressed && styles.pressed]}>
          <Text style={styles.done}>{t('完成')}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {pairedNoModel?.failed ? (
          <View style={styles.pairedCard} accessibilityLiveRegion="polite">
            <Text style={styles.lead}>{t('已配對「{p0}」，但讀不到電腦上的模型。電腦上的模型服務可能還沒開，開好再試一次。', { p0: pairedNoModel.name })}</Text>
            <Pressable onPress={() => void retryModels(pairedNoModel.url)} accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && styles.pressedButton]}>
              <Text style={styles.primaryText}>{t('再試一次')}</Text>
            </Pressable>
          </View>
        ) : pairedNoModel ? (
          <View style={styles.pairedCard} accessibilityLiveRegion="polite">
            <Text style={styles.lead}>{t('已連上「{p0}」。這台電腦還沒有模型，下載一個就能開始聊天。', { p0: pairedNoModel.name })}</Text>
            <Pressable onPress={() => (onNeedModel ? onNeedModel() : onClose())} accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && styles.pressedButton]}>
              <Text style={styles.primaryText}>{t('選一個模型下載')}</Text>
            </Pressable>
          </View>
        ) : null}
        {manage ? hostList : null}
        {manage ? <Text style={styles.section}>{t('新增電腦')}</Text> : null}
        <Text style={styles.lead}>{t('在電腦上打開 Local AI 小幫手，按「配對新手機」，再用手機掃描電腦畫面上的 QR code。')}</Text>

        <Pressable onPress={() => setScannerOpen(true)} accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && styles.pressedButton]}>
          <SymbolView name="qrcode.viewfinder" size={20} tintColor="#ffffff" />
          <Text style={styles.primaryText}>{t('掃描 QR code')}</Text>
        </Pressable>

        {scan?.running ? (
          <View style={styles.secondary} accessibilityLiveRegion="polite">
            <ActivityIndicator />
            <Text style={styles.secondaryText}>{scan.total === 0 ? t('檢查網路中…') : t('尋找中… {p0} / {p1}', { p0: scan.done, p1: scan.total })}</Text>
            <Pressable onPress={() => store.stopScan()} hitSlop={10} accessibilityRole="button">
              <Text style={styles.stopSecondary}>{t('停止')}</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable onPress={find} accessibilityRole="button" style={({ pressed }) => [styles.secondary, pressed && styles.pressedButton]}>
            <SymbolView name="wifi" size={17} tintColor={C.accent} />
            <Text style={styles.secondaryText}>{t('自動尋找')}</Text>
          </Pressable>
        )}

        {adding ? (
          <View style={styles.secondary} accessibilityLiveRegion="polite">
            <ActivityIndicator />
            <Text style={styles.secondaryText}>{t('正在連線 {p0}…', { p0: adding })}</Text>
          </View>
        ) : (
          <Pressable onPress={manual} accessibilityRole="button" style={({ pressed }) => [styles.secondary, pressed && styles.pressedButton]}>
            <SymbolView name="keyboard" size={17} tintColor={C.accent} />
            <Text style={styles.secondaryText}>{t('手動輸入位址')}</Text>
          </Pressable>
        )}

        {scan && !scan.running && (scan.error || scan.total > 0) ? (
          <Text style={[styles.result, failed && { color: C.warnText }]} accessibilityLiveRegion="polite">
            {scan.error || (scan.found > 0 ? t('找到 {p0} 台電腦。', { p0: scan.found }) : t('這個 Wi-Fi 裡沒有找到開著小幫手或 Ollama 的電腦。'))}
          </Text>
        ) : null}
        <Text style={styles.footnote}>{t('第一次尋找時，iPhone 會問是否允許「尋找區域網路上的裝置」，請選「允許」。')}</Text>

        {(scan?.helpers ?? []).length > 0 ? (
          <>
            <Text style={styles.section}>{t('找到的小幫手')}</Text>
            <View style={styles.card}>
              {scan!.helpers!.map((h, i) => (
                <Pressable
                  key={h.id}
                  onPress={() => enterCode(h.url, h.name)}
                  accessibilityRole="button"
                  accessibilityLabel={t('小幫手 {p0}，點一下輸入配對碼', { p0: h.name })}
                  style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                  <View style={styles.row}>
                    <SymbolView name="desktopcomputer" size={18} tintColor={C.secondary} />
                    <Text style={[styles.rowTitle, styles.flex]}>{h.name}</Text>
                    <Text style={styles.using}>{t('輸入配對碼')}</Text>
                  </View>
                  {i < scan!.helpers!.length - 1 ? <View style={styles.separator} /> : null}
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        {manage ? null : hostList}

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
      <QrScanner visible={scannerOpen} onClose={() => setScannerOpen(false)} onDismissed={scannerClosed} onScanned={scanned} />
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
      <Text style={styles.helpHeading}>{t('用 Local AI 小幫手（建議）')}</Text>
      <Step n={1} text={t('在電腦上安裝並打開 Local AI 小幫手。')} />
      <Step n={2} text={t('在小幫手按「配對新手機」，手機按「掃描 QR code」。')} />
      <Step n={3} text={t('手機和電腦要連同一個 Wi-Fi。電腦問要不要允許小幫手連線時，請選「允許」。')} />
      <Text style={[styles.helpHeading, styles.helpHeadingGap]}>{t('沒有小幫手：直接連 Ollama（進階）')}</Text>
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
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: C.label },
  headerSide: { minWidth: 72 },
  headerRight: { alignItems: 'flex-end' },
  done: { fontSize: 17, fontWeight: '600', color: C.accent },
  pressed: { opacity: 0.4 },
  content: { padding: 16, paddingTop: 4, gap: 12, paddingBottom: 48 },
  lead: { ...TEXT.small, color: C.label },
  pairedCard: { gap: 10, marginBottom: 8 },
  primary: { height: 52, borderRadius: 14, backgroundColor: C.accentFill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
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
  helpHeading: { ...TEXT.small, fontWeight: '700', color: C.label },
  helpHeadingGap: { marginTop: 10 },
  stopSecondary: { ...TEXT.small, color: C.accent, textDecorationLine: 'underline', marginLeft: 6 },
  result: { ...TEXT.small, color: C.secondary },
  section: { fontSize: 13, color: C.secondary, marginHorizontal: 4, marginTop: 8 },
  card: { backgroundColor: C.groupedCard, borderRadius: 12, overflow: 'hidden' },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  flex: { flex: 1 },
  rowTitle: { ...TEXT.body, color: C.label },
  using: { ...TEXT.meta, color: C.accent, fontWeight: '700' },
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
  tabOn: { backgroundColor: C.accentFill },
  tabText: { ...TEXT.small, color: C.label },
  tabTextOn: { color: '#ffffff', fontWeight: '700' },
  command: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.surface, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  commandText: { flex: 1, fontFamily: MONO, fontSize: 12, lineHeight: 17, color: C.label },
  copy: { ...TEXT.meta, color: C.accent, fontWeight: '700' },
});
