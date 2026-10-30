import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { C, TEXT } from '../ui/theme';
import { t } from '../i18n';

// 開著 VoiceOver 時，要摸到「復原」得花時間：有按鈕的提示延長到 15 秒
let screenReaderOn = false;
AccessibilityInfo.isScreenReaderEnabled?.()
  .then((on) => (screenReaderOn = on))
  .catch(() => {});
AccessibilityInfo.addEventListener?.('screenReaderChanged', (on: boolean) => (screenReaderOn = on));

export type ToastData = { id: number; text: string; action?: { text: string; onPress: () => void }; ms?: number };

/** 畫面下方短暫出現的提示（例如「已複製」「已刪除・復原」），時間到自己消失 */
export function Toast({ toast, onDone }: { toast: ToastData | null; onDone: () => void }) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!toast) return;
    AccessibilityInfo.announceForAccessibility?.(toast.action ? t('{p0}，可以按「{p1}」', { p0: toast.text, p1: toast.action.text }) : toast.text);
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    const timer = setTimeout(onDone, toast.ms ?? (toast.action ? (screenReaderOn ? 15000 : 6000) : 1800));
    return () => clearTimeout(timer);
  }, [toast?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!toast) return null;
  return (
    <View pointerEvents="box-none" style={styles.layer}>
      <Animated.View style={[styles.toast, { opacity }]} accessibilityLiveRegion="polite" testID="toast">
        <Text style={styles.text}>{toast.text}</Text>
        {toast.action ? (
          <Pressable
            onPress={() => {
              toast.action!.onPress();
              onDone();
            }}
            hitSlop={10}
            accessibilityRole="button">
            <Text style={styles.action}>{toast.action.text}</Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 0, right: 0, bottom: 8, alignItems: 'center' },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: C.label,
    maxWidth: '90%',
  },
  text: { ...TEXT.small, color: C.bg },
  action: { ...TEXT.small, color: C.accent, fontWeight: '700' },
});
