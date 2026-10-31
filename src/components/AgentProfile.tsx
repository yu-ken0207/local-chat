import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, Animated, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, View, findNodeHandle, useWindowDimensions } from 'react-native';

import { categories, entryVibe, getEntry } from '../agents/catalog';
import type { ChatStore } from '../state/chatStore';
import type { Agent, AgentNote } from '../store/repo';
import { C, TEXT } from '../ui/theme';
import { AgentAvatar, avatarId } from './AgentAvatar';
import { talkLabel } from './AgentsSheet';
import { ActionButton } from './Messages';
import { project, rubberband } from './SideDrawer';
import { t } from '../i18n';

// 點 Agent 的頭像：像 Teams 的聯絡人卡，從頭像長出來、蓋在對話上；點外面、往下拉或兩指畫 Z 就縮回頭像

/** 跟討論串卡片一樣的臨界阻尼彈簧 */
const SPRING = { stiffness: 500, damping: 45, mass: 1, useNativeDriver: true } as const;

export type ProfileAction = 'mention' | 'edit' | 'remove';

export function AgentProfile({
  store,
  agent,
  anchor,
  spoken,
  member,
  reduceMotion,
  onClose,
}: {
  store: ChatStore;
  agent: Agent;
  /** 點的頭像在畫面上的位置（卡片從這裡長出來、縮回這裡） */
  anchor: { x: number; y: number } | null;
  /** 這段對話裡說了幾次 */
  spoken: number;
  /** 還在這段討論裡（離開的人沒有「移除」） */
  member: boolean;
  reduceMotion: boolean;
  /** 縮回去之後才呼叫；action：按了哪個按鈕（例如「編輯」要等卡片收好才打開編輯面板） */
  onClose: (action?: ProfileAction) => void;
}) {
  const { width, height } = useWindowDimensions();
  const open = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);
  const titleRef = useRef<ComponentRef<typeof Text>>(null);
  const [notes, setNotes] = useState<AgentNote[]>([]);

  useEffect(() => {
    void store.listNotes(agent.id).then((list) => setNotes(list.slice(-3).reverse()));
  }, [store, agent.id]);

  useEffect(() => {
    const anim = reduceMotion ? Animated.timing(open, { toValue: 1, duration: 200, useNativeDriver: true }) : Animated.spring(open, { toValue: 1, ...SPRING });
    anim.start(() => {
      const node = findNodeHandle(titleRef.current);
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** 縮回頭像（從現在的位置接著縮，不會跳） */
  function close(action?: ProfileAction) {
    if (closing.current) return;
    closing.current = true;
    const out = reduceMotion ? Animated.timing(open, { toValue: 0, duration: 160, useNativeDriver: true }) : Animated.spring(open, { toValue: 0, ...SPRING });
    Animated.parallel([out, Animated.spring(drag, { toValue: 0, ...SPRING })]).start(() => onClose(action));
  }
  const closeRef = useRef(close);
  closeRef.current = close;

  // 往下拉：1:1 跟手指，往上拉有阻力；放手時看推算的落點，夠遠就縮回去，不然彈回來。
  // 彈回去的途中再抓住：從現在的位置接手（不會先跳回原位）
  const grabbedAt = useRef(0);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => !closing.current && Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderGrant: () => drag.stopAnimation((v) => (grabbedAt.current = v)),
        onPanResponderMove: (_e, g) => {
          const y = grabbedAt.current + g.dy;
          drag.setValue(y > 0 ? y : rubberband(y, 160));
        },
        onPanResponderRelease: (_e, g) => {
          if (grabbedAt.current + g.dy + project(g.vy * 1000) > 120) closeRef.current();
          else Animated.spring(drag, { toValue: 0, velocity: g.vy * 1000, ...SPRING }).start();
        },
        onPanResponderTerminate: () => Animated.spring(drag, { toValue: 0, ...SPRING }).start(),
      }),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const cardWidth = Math.min(width - 32, 360);
  // 從頭像長出來：卡片中心從頭像的位置移到畫面中間
  const dx = anchor ? anchor.x - width / 2 : 0;
  const dy = anchor ? anchor.y - height / 2 : 0;
  const motion = reduceMotion
    ? { opacity: open, transform: [{ translateY: drag }] }
    : {
        opacity: open.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 1, 1] }),
        transform: [
          { translateX: open.interpolate({ inputRange: [0, 1], outputRange: [dx, 0] }) },
          { translateY: Animated.add(open.interpolate({ inputRange: [0, 1], outputRange: [dy, 0] }), drag) },
          { scale: open.interpolate({ inputRange: [0, 1], outputRange: [0.1, 1] }) },
        ],
      };

  // 自己建的：角色卡；圖鑑來的：分類與個性
  const entry = agent.catalogId ? getEntry(agent.catalogId) : undefined;
  const rows: [string, string][] = agent.card
    ? [
        [t('專長'), agent.card.expertise],
        [t('立場'), agent.card.stance],
        [t('風格'), agent.card.style],
      ]
    : entry
      ? [
          [t('分類'), categories().find((c) => c.key === entry.c)?.label ?? ''],
          [t('個性'), entryVibe(entry)],
        ]
      : [];
  const shown = rows.filter(([, v]) => v.trim());
  // 刪掉的 Agent：只看資料（說過的話還在），不給 @他、編輯、移除
  const deleted = !!agent.deletedAt;
  const stats = [spoken === 1 ? t('這段說了 1 次') : spoken > 1 ? t('這段說了 {n} 次', { n: spoken }) : t('這段還沒說話'), t('積極度：{p0}', { p0: talkLabel(agent.talk) })].join(t('，'));

  return (
    <Modal visible transparent animationType="none" onRequestClose={() => close()} statusBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: Animated.multiply(open, 0.35) }]} pointerEvents="none" />
      <Pressable style={StyleSheet.absoluteFill} onPress={() => close()} accessibilityRole="button" accessibilityLabel={t('關閉')} testID="profile-backdrop" />
      <View style={styles.center} pointerEvents="box-none">
        <Animated.View
          style={[styles.card, { width: cardWidth, maxHeight: height * 0.75 }, motion]}
          accessibilityViewIsModal
          onAccessibilityEscape={() => close()}
          testID="agent-profile">
          {/* 上半部（拉桿、頭像、名字）可以抓著往下拉；下面的內容太長時自己捲動 */}
          <View style={styles.hero} {...pan.panHandlers}>
            <View style={styles.grabber} />
            <AgentAvatar id={avatarId(agent)} emoji={agent.emoji} photo={agent.photo} size={64} />
            <Text ref={titleRef} style={styles.name} accessibilityRole="header" numberOfLines={2}>
              {agent.name}
            </Text>
            {/* 上半部不能捲：介紹最多三行，大字時下面的按鈕才不會被擠掉 */}
            {agent.intro ? (
              <Text style={styles.intro} numberOfLines={3}>
                {agent.intro}
              </Text>
            ) : null}
            <Text style={styles.stats}>{stats}</Text>
          </View>
          <ScrollView contentContainerStyle={styles.content} bounces={false}>
            {shown.length > 0 ? (
              <View style={styles.section}>
                {shown.map(([label, value]) => (
                  <View key={label} style={styles.row} accessible accessibilityLabel={t('{p0}：{p1}', { p0: label, p1: value })}>
                    <Text style={styles.label}>{label}</Text>
                    <Text style={styles.value} numberOfLines={3}>
                      {value}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
            {notes.length > 0 ? (
              <View style={styles.section}>
                <Text style={styles.label} accessibilityRole="header">
                  {t('筆記')}
                </Text>
                {notes.map((n) => (
                  <Text key={n.id} style={styles.note} numberOfLines={3}>
                    {n.content}
                  </Text>
                ))}
              </View>
            ) : null}
            {deleted ? (
              <Text style={[styles.stats, styles.deleted]}>{t('這個 Agent 已經刪除，可以在設定的 Agent 頁復原。')}</Text>
            ) : (
              <View style={styles.buttons}>
                <ActionButton text={t('@他')} primary onPress={() => close('mention')} />
                <ActionButton text={t('編輯')} onPress={() => close('edit')} />
                {member ? <ActionButton text={t('移除')} onPress={() => close('remove')} /> : null}
              </View>
            )}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: '#000' },
  center: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  card: {
    borderRadius: 16,
    backgroundColor: C.groupedCard,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    overflow: 'hidden',
  },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: C.separator, marginBottom: 6 },
  content: { padding: 20, paddingTop: 16, gap: 16 },
  hero: { alignItems: 'center', gap: 6, paddingTop: 8, paddingHorizontal: 20 },
  name: { ...TEXT.body, fontSize: 17, fontWeight: '700', color: C.label, textAlign: 'center' },
  intro: { ...TEXT.small, color: C.secondary, textAlign: 'center' },
  stats: { ...TEXT.meta, color: C.secondary, textAlign: 'center' },
  section: { gap: 8 },
  // 欄位名稱放不下（英文、大字）就排到值的上面，不會從字中間斷開
  row: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 2 },
  label: { ...TEXT.small, color: C.secondary, minWidth: 40 },
  value: { ...TEXT.small, color: C.label, flexGrow: 1, flexShrink: 1, flexBasis: 200 },
  note: { ...TEXT.small, color: C.label },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  deleted: { paddingHorizontal: 8 },
});
