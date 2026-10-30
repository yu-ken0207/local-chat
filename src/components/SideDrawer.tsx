import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Keyboard, PanResponder, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

import { C } from '../ui/theme';

/** 側邊欄寬度：螢幕的 84%，最寬 360 */
export const drawerWidth = (screenWidth: number) => Math.min(Math.round(screenWidth * 0.84), 360);

/** 拉過頭時多露出的底色（彈性阻力用），避免側邊欄左邊露出縫 */
const OVERDRAG = 80;

/** 關著時，手指要從螢幕左邊這麼寬的範圍開始往右滑才拉出側邊欄（跟 iPhone 的返回手勢一樣） */
export const EDGE = 30;

/**
 * 是不是要拉側邊欄的水平滑動：開著時左右都認（往右拉過頭有阻力）；
 * 關著時只認從左邊緣開始往右滑。畫面中間往右滑要留給內容
 * （程式碼、表格往回捲，輸入框裡移游標），不然會被側邊欄搶走
 */
export function claimSwipe(open: boolean, dx: number, dy: number, x0: number): boolean {
  const horizontal = Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5;
  return horizontal && (open || (dx > 0 && x0 <= EDGE));
}

/** 依放開時的速度推算會停在哪裡（跟系統捲動的減速一樣），velocity 單位 px/s */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** 放開手指後要打開還是關上：看推算的落點有沒有過一半，vx 單位 px/ms（PanResponder 給的） */
export function shouldOpen(pos: number, vx: number, width: number): boolean {
  return pos + project(vx * 1000) > width / 2;
}

/** 超出範圍時越拉越緊 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

// 臨界阻尼的彈簧（不回彈），反應時間約 0.35 秒
const RESPONSE = 0.35;
const STIFFNESS = (2 * Math.PI / RESPONSE) ** 2;
const DAMPING = 2 * Math.sqrt(STIFFNESS);

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 側邊欄內容；只在看得到時才建立 */
  renderDrawer: () => ReactNode;
  /** 遮罩的輔助說明（點一下關閉） */
  closeLabel: string;
  /** 面板或看照片時關掉手勢，不要在背後把側邊欄拉出來（預設開） */
  swipeEnabled?: boolean;
  children: ReactNode;
};

/**
 * 從左邊滑出的側邊欄：手指往右滑打開、往左滑或點右邊變暗的地方關上。
 * 畫面跟著手指走；放開時接著手指的速度用彈簧動畫滑到定位，動畫中途也可以再抓住。
 */
export function SideDrawer({ open, onOpenChange, renderDrawer, closeLabel, swipeEnabled = true, children }: Props) {
  const { width: screenWidth } = useWindowDimensions();
  const width = drawerWidth(screenWidth);
  const x = useRef(new Animated.Value(0)).current;
  const current = useRef(0); // 畫面上目前的位置（動畫中也會跟著更新）
  const target = useRef(0);
  const start = useRef(0);
  const reduceMotion = useRef(false);
  const fade = useRef(new Animated.Value(1)).current; // 減少動態效果時用淡入淡出代替滑動
  const [mounted, setMounted] = useState(open);
  const latest = useRef({ open, onOpenChange, width, swipeEnabled });
  latest.current = { open, onOpenChange, width, swipeEnabled };

  useEffect(() => {
    const id = x.addListener(({ value }) => (current.current = value));
    return () => x.removeListener(id);
  }, [x]);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => (reduceMotion.current = v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => (reduceMotion.current = v));
    return () => sub?.remove();
  }, []);

  function animateTo(to: number, velocity = 0) {
    target.current = to;
    if (to > 0) setMounted(true);
    x.stopAnimation();
    const done = ({ finished }: { finished: boolean }) => {
      if (finished && target.current === 0) setMounted(false);
    };
    if (reduceMotion.current) {
      // 減少動態效果：不滑動。整個畫面淡出、直接換到新位置、再淡入（大面積換位置時不要移動）
      fade.stopAnimation();
      Animated.timing(fade, { toValue: 0, duration: 120, useNativeDriver: true }).start(() => {
        x.setValue(to);
        Animated.timing(fade, { toValue: 1, duration: 160, useNativeDriver: true }).start(() => done({ finished: target.current === to }));
      });
      return;
    }
    Animated.spring(x, { toValue: to, velocity, stiffness: STIFFNESS, damping: DAMPING, mass: 1, overshootClamping: true, useNativeDriver: true }).start(done);
  }

  // 外面改了 open（按「對話」、點遮罩、選了一段對話）就滑到對應的位置
  useEffect(() => {
    const want = open ? width : 0;
    if (target.current !== want) animateTo(want);
  }, [open, width]); // eslint-disable-line react-hooks/exhaustive-deps

  const responder = useMemo(
    () => {
      const finish = (pos: number, vx: number) => {
        const { width: w, open: isOpen, onOpenChange: change } = latest.current;
        const opening = shouldOpen(Math.min(Math.max(pos, 0), w), vx, w);
        // 彈簧的初速單位是 px/s，接著手指放開時的速度
        animateTo(opening ? w : 0, vx * 1000);
        if (opening !== isOpen) change(opening);
      };
      return PanResponder.create({
        // 起點用「目前位置減掉移動距離」算：接手之前 g.x0 還是 0
        onMoveShouldSetPanResponder: (_e, g) => latest.current.swipeEnabled && claimSwipe(target.current > 0 || current.current > 1, g.dx, g.dy, g.moveX - g.dx),
        onPanResponderGrant: () => {
          // 從畫面上目前的位置接著拉，不會跳
          x.stopAnimation();
          start.current = current.current;
          setMounted(true);
          Keyboard.dismiss();
        },
        onPanResponderMove: (_e, g) => {
          const w = latest.current.width;
          const pos = start.current + g.dx;
          const shown = pos > w ? w + rubberband(pos - w, w) : Math.max(0, pos);
          x.setValue(shown);
          current.current = shown;
        },
        onPanResponderRelease: (_e, g) => finish(start.current + g.dx, g.vx),
        onPanResponderTerminate: (_e, g) => finish(start.current + g.dx, 0),
        onPanResponderTerminationRequest: () => false,
      });
    },
    [x] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const scrimOpacity = x.interpolate({ inputRange: [0, width], outputRange: [0, 0.5], extrapolate: 'clamp' });

  return (
    <View style={styles.root} testID="side-drawer" {...responder.panHandlers}>
      <Animated.View
        style={[styles.fill, { opacity: fade, transform: [{ translateX: x }] }]}
        accessibilityElementsHidden={open}
        importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}>
        {children}
      </Animated.View>
      {/* 主畫面變暗，點一下關上 */}
      <Animated.View style={[styles.scrim, { opacity: scrimOpacity, transform: [{ translateX: x }] }]} pointerEvents={open ? 'auto' : 'none'}>
        <Pressable style={styles.fill} onPress={() => onOpenChange(false)} accessibilityRole="button" accessibilityLabel={closeLabel} />
      </Animated.View>
      <Animated.View
        style={[styles.drawer, { opacity: fade, width: width + OVERDRAG, left: -OVERDRAG, paddingLeft: OVERDRAG, transform: [{ translateX: Animated.subtract(x, width) }] }]}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
        onAccessibilityEscape={() => onOpenChange(false)}>
        {mounted ? renderDrawer() : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, overflow: 'hidden' },
  fill: { flex: 1 },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: '#000000' },
  drawer: { position: 'absolute', top: 0, bottom: 0, backgroundColor: C.groupedBg },
});
