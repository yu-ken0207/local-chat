import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { C, TEXT } from '../ui/theme';
import { t } from '../i18n';

type Props = {
  visible: boolean;
  onClose: () => void;
  /** 掃到東西：回傳 null 代表成功（外面會關掉），回傳文字就是錯誤說明（留在畫面上可以再掃） */
  onScanned: (data: string) => Promise<string | null>;
};

/** 全螢幕掃 QR code：對準電腦上小幫手畫面裡的 QR code */
export function QrScanner({ visible, onClose, onScanned }: Props) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 相機一秒會回報很多次，處理中或剛失敗時先不理
  const locked = useRef(false);

  useEffect(() => {
    if (!visible) return;
    setError('');
    setBusy(false);
    locked.current = false;
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handle(data: string) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    const problem = await onScanned(data);
    setBusy(false);
    if (problem) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(problem);
      // 讓使用者看一下說明再重新對準
      setTimeout(() => (locked.current = false), 1500);
    }
  }

  const denied = permission && !permission.granted && !permission.canAskAgain;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={styles.root}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={busy ? undefined : ({ data }) => void handle(data)}
            testID="qr-camera"
          />
        ) : null}

        <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('關閉')}>
            <SymbolView name="xmark.circle.fill" size={32} tintColor="rgba(255,255,255,0.9)" />
          </Pressable>
        </View>

        <View style={styles.center} pointerEvents="none">
          <View style={styles.frame} />
        </View>

        <View style={[styles.bottom, { paddingBottom: insets.bottom + 24 }]}>
          {denied ? (
            <>
              <Text style={styles.text}>{t('沒有相機權限，沒辦法掃描。請到「設定」允許 Expo Go 使用相機。')}</Text>
              <Pressable onPress={() => Linking.openSettings()} accessibilityRole="button" style={styles.button}>
                <Text style={styles.buttonText}>{t('前往設定')}</Text>
              </Pressable>
            </>
          ) : busy ? (
            <View style={styles.row} accessibilityLiveRegion="polite">
              <ActivityIndicator color="#ffffff" />
              <Text style={styles.text}>{t('正在配對…')}</Text>
            </View>
          ) : (
            <Text style={[styles.text, error ? styles.error : null]} accessibilityLiveRegion="polite">
              {error || t('對準電腦上小幫手畫面裡的 QR code')}
            </Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  top: { position: 'absolute', top: 0, left: 16, right: 16, flexDirection: 'row', justifyContent: 'flex-end' },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  frame: { width: 240, height: 240, borderRadius: 24, borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)' },
  bottom: { position: 'absolute', left: 24, right: 24, bottom: 0, alignItems: 'center', gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  text: { ...TEXT.small, color: '#ffffff', textAlign: 'center' },
  error: { color: '#ffb4a2' },
  button: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12, backgroundColor: C.accent },
  buttonText: { ...TEXT.small, fontWeight: '700', color: '#ffffff' },
});
