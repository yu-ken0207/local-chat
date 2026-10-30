import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';

import { C, TEXT } from '../ui/theme';
import { t } from '../i18n';

const ACTION_WIDTH = 88;

/**
 * 左滑露出「刪除」（iOS 清單的慣例）。滑過一半放開會停在打開的位置，滑很遠或很快直接刪除。
 * 用彈簧動畫、從手指放開的位置接續；也提供輔助使用的「刪除」動作（VoiceOver 轉輪）。
 */
export function SwipeRow({ children, onDelete, label: labelProp, testID }: { children: ReactNode; onDelete: () => void; label?: string; testID?: string }) {
  const label = labelProp ?? t('刪除');
  const x = useRef(new Animated.Value(0)).current;
  const open = useRef(false);
  const current = useRef(0); // 畫面上目前的位置（動畫中也會跟著更新）
  const start = useRef(0);
  useEffect(() => {
    const id = x.addListener(({ value }) => (current.current = value));
    return () => x.removeListener(id);
  }, [x]);

  const springTo = (toValue: number, velocity = 0) =>
    Animated.spring(x, { toValue, velocity, useNativeDriver: true, damping: 26, stiffness: 260, mass: 1 }).start();

  const responder = useMemo(
    () =>
      PanResponder.create({
        // 打開時點一下：先收回，不要直接執行那一列（跟 iOS 一樣）
        onStartShouldSetPanResponderCapture: () => open.current,
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderGrant: () => {
          // 從畫面上目前的位置接著拉：動畫中途也抓得住，不會跳
          x.stopAnimation();
          start.current = current.current;
        },
        onPanResponderMove: (_e, g) => {
          const pos = start.current + g.dx;
          // 往右拉超過原位時加阻力，不會整列飛走
          x.setValue(pos > 0 ? pos * 0.2 : pos);
        },
        onPanResponderRelease: (_e, g) => {
          const pos = start.current + g.dx;
          // 彈簧初速用 px/s（PanResponder 給的是 px/ms），接著手指放開的速度
          const v = g.vx * 1000;
          if (open.current && Math.abs(g.dx) < 10 && Math.abs(g.dy) < 10) {
            open.current = false;
            springTo(0);
          } else if (pos < -ACTION_WIDTH * 2.2 || (g.vx < -1.6 && pos < -ACTION_WIDTH)) {
            // 直接刪除：快速滑出去就刪，不用等彈簧慢慢停下來
            open.current = false;
            Animated.timing(x, { toValue: -400, duration: 160, useNativeDriver: true }).start(() => {
              onDelete();
              x.setValue(0);
            });
          } else if (pos < -ACTION_WIDTH / 2 || g.vx < -0.5) {
            open.current = true;
            springTo(-ACTION_WIDTH, v);
          } else {
            open.current = false;
            springTo(0, v);
          }
        },
        onPanResponderTerminate: () => {
          open.current = false;
          springTo(0);
        },
      }),
    [onDelete] // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <View
      style={styles.wrap}
      testID={testID}
      accessibilityActions={[{ name: 'delete', label }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'delete') onDelete();
      }}>
      <View style={styles.behind} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Pressable
          onPress={() => {
            open.current = false;
            x.setValue(0);
            onDelete();
          }}
          style={styles.action}>
          <Text style={styles.actionText}>{label}</Text>
        </Pressable>
      </View>
      <Animated.View
        style={[styles.front, { transform: [{ translateX: x }] }]}
        {...responder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
  behind: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'flex-end', backgroundColor: C.red },
  action: { width: ACTION_WIDTH, height: '100%', alignItems: 'center', justifyContent: 'center' },
  actionText: { ...TEXT.small, color: '#ffffff', fontWeight: '700' },
  front: { backgroundColor: C.groupedCard },
});
