import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ChatScreen } from './src/components/ChatScreen';
import { wifiIp } from './src/lib/network';
import { OllamaClient } from './src/lib/ollama';
import { pickPhotos } from './src/lib/photos';
import { ChatStore, type ChatEvent } from './src/state/chatStore';
import { openPhoneDb } from './src/store/db';
import { Repo } from './src/store/repo';
import { C, TEXT } from './src/ui/theme';

function haptic(event: ChatEvent) {
  if (event === 'answered') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  if (event === 'failed') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  if (event === 'stopped') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

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
      const s = new ChatStore({ repo, client: (url) => new OllamaClient(url), wifiIp, onEvent: haptic });
      await s.init();
      setStore(s);
    })().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      {store ? (
        <ChatScreen store={store} pickPhotos={pickPhotos} copyText={copyText} />
      ) : (
        <View style={styles.center}>
          {error ? <Text style={styles.error}>開啟失敗：{error}</Text> : <ActivityIndicator />}
        </View>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg, padding: 24 },
  error: { ...TEXT.small, color: C.red },
});
