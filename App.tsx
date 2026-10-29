import * as Clipboard from 'expo-clipboard';
import * as Device from 'expo-device';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { getLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ChatScreen } from './src/components/ChatScreen';
import { wifiIp } from './src/lib/network';
import { OllamaClient } from './src/lib/ollama';
import { pickPhotos } from './src/lib/photos';
import { ChatStore, type AppLanguage, type ChatEvent, type SecretStore } from './src/state/chatStore';
import { openBackupBytes, openMemoryDb, openPhoneDb, type Db } from './src/store/db';
import { Repo } from './src/store/repo';
import { C, TEXT } from './src/ui/theme';
import { t } from './src/i18n';

function haptic(event: ChatEvent) {
  if (event === 'answered' || event === 'downloaded') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  if (event === 'failed') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  if (event === 'stopped') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/** 手機系統語言：中文（不分繁簡）用繁體中文，其他用英文 */
function deviceLanguage(): AppLanguage {
  return getLocales()[0]?.languageCode === 'zh' ? 'zh-Hant' : 'en';
}

/** 設定 > 從備份還原：選一個備份檔，載入成暫時的資料庫（不會動到手機上的資料） */
async function pickBackup(): Promise<Db | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
  if (result.canceled || !result.assets?.[0]) return null;
  const bytes = await new File(result.assets[0].uri).bytes();
  return openBackupBytes(bytes);
}

/** 小幫手的權杖放 iOS 鑰匙圈，不放資料庫（備份檔裡就不會有） */
const secrets: SecretStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
};

/** 配對時告訴電腦這支手機的名字（iOS 16 起拿不到使用者取的名字，就用型號） */
const deviceName = () => Device.deviceName || Device.modelName || 'iPhone';

function copyText(text: string) {
  Clipboard.setStringAsync(text);
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

export default function App() {
  const [store, setStore] = useState<ChatStore | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const repo = new Repo(await openPhoneDb());
      const s = new ChatStore({ repo, client: (url, token) => new OllamaClient(url, { token }), secrets, deviceName, wifiIp, onEvent: haptic, deviceLanguage, openMemoryDb });
      await s.init();
      setStore(s);
    })().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      {store ? (
        <ChatScreen store={store} pickPhotos={pickPhotos} copyText={copyText} pickBackup={pickBackup} />
      ) : (
        <View style={styles.center}>
          {error ? <Text style={styles.error}>{t('開啟失敗：')}{error}</Text> : <ActivityIndicator />}
        </View>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg, padding: 24 },
  error: { ...TEXT.small, color: C.red },
});
