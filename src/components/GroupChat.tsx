import { SymbolView } from 'expo-symbols';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { entryIntro, entryName, getEntry, type CatalogEntry } from '../agents/catalog';
import { CONCLUSION, parseConclusion, type Conclusion } from '../agents/discussion';
import { ROLE_TRUNCATED, type ChatState, type ChatStore, type DiscussionPhase, type Streaming } from '../state/chatStore';
import { DEFAULT_GROUP, isRecordNote, type Agent, type Attachment, type GroupSettings, type JoinedBy, type Member, type Message, type SpeakMode } from '../store/repo';
import { C, TEXT } from '../ui/theme';
import { AgentAvatar, avatarId } from './AgentAvatar';
import { CatalogList } from './AgentsSheet';
import { chooseOption } from './Composer';
import { Markdown } from './Markdown';
import { ActionButton, Thinking, Thumbnails, Working } from './Messages';
import { t } from '../i18n';

// 多 AI 討論的畫面：聊天氣泡（你在右、AI 在左帶頭像和名字）、成員列、討論進行到哪、@ 選人、成員面板

const speakModeName = (m: SpeakMode) => ({ free: t('自由搶話'), host: t('主持人點名'), round: t('輪流'), mention: t('只回被 @ 的') })[m];
const joinedName = (j: JoinedBy) => ({ user: '', auto: t('自己加入'), mention: t('被 @ 拉進來'), thread: t('從原對話來') })[j];

type BubbleHandlers = {
  onOpenImage: (images: Attachment[], index: number) => void;
  onCopyCode: (code: string) => void;
  onLongPress?: (message: Message, pageY?: number) => void;
  /** 點「回覆 某某」跳到那一則 */
  onJump?: (messageId: string) => void;
  onCopy?: () => void;
  onRegenerate?: () => void;
  onSwitchVersion?: (delta: number) => void;
  isLast?: boolean;
  /** 結論卡怎麼畫（要用到 store：投票、釘選） */
  conclusion?: (m: Message, card: Conclusion) => ReactNode;
};

/** 一則訊息（聊天氣泡）。錯誤、停止這類提示交給原本的樣式（fallback） */
export function BubbleView({
  message: m,
  streaming,
  agent,
  replyTarget,
  fallback,
  ...h
}: {
  message: Message;
  streaming: Streaming | null;
  agent: Agent | null;
  /** 要顯示「回覆 某某：…」時才給（回的就是上一則就不顯示） */
  replyTarget: { id: string; name: string; content: string } | null;
  fallback: ReactNode;
} & BubbleHandlers) {
  const live = streaming?.messageId === m.id ? streaming : null;
  const latest = useRef({ m, onLongPress: h.onLongPress, onCopyCode: h.onCopyCode });
  latest.current = { m, onLongPress: h.onLongPress, onCopyCode: h.onCopyCode };
  const press = useMemo(
    () => ({
      onPress: () => Keyboard.dismiss(),
      onLongPress: (e?: { nativeEvent?: { pageY?: number } }) => latest.current.onLongPress?.(latest.current.m, e?.nativeEvent?.pageY),
    }),
    []
  );
  const copyCode = useMemo(() => (code: string) => latest.current.onCopyCode(code), []);

  if (m.role === 'user') {
    return (
      <Pressable accessible={false} {...press} delayLongPress={350} testID={`message-${m.id}`} style={styles.userRow}>
        <View style={styles.userBubble}>
          {m.attachments.length > 0 ? <Thumbnails images={m.attachments} onOpen={h.onOpenImage} /> : null}
          <Text style={styles.userText} selectable accessibilityLabel={t('你說：{p0}', { p0: m.content })}>
            {m.content}
          </Text>
        </View>
      </Pressable>
    );
  }
  if (m.role === 'note' && m.detail === CONCLUSION) {
    const card = parseConclusion(m.content);
    return card ? <View testID={`message-${m.id}`}>{h.conclusion?.(m, card)}</View> : null;
  }
  if (m.role === 'note' && isRecordNote(m)) {
    return (
      <Text style={styles.system} testID={`message-${m.id}`}>
        {m.content}
      </Text>
    );
  }
  if (m.role !== 'assistant') return <>{fallback}</>;

  const content = live ? live.content : m.content;
  const thinking = live ? live.thinking : m.thinking;
  const name = agent?.name ?? 'AI';
  return (
    <Pressable accessible={false} {...press} delayLongPress={350} testID={`message-${m.id}`} style={styles.aiRow}>
      <AgentAvatar id={agent ? avatarId(agent) : 'ai'} emoji={agent?.emoji || '🤖'} photo={agent?.photo} size={32} />
      <View style={styles.aiCol}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        {replyTarget ? (
          <Pressable onPress={() => h.onJump?.(replyTarget.id)} hitSlop={6} accessibilityRole="button" accessibilityLabel={t('回覆 {p0}，點一下看那則', { p0: replyTarget.name })}>
            <Text style={styles.quote} numberOfLines={1}>
              {t('回覆 {p0}：', { p0: replyTarget.name })}
              {replyTarget.content}
            </Text>
          </Pressable>
        ) : null}
        <View style={styles.aiBubble} accessible={false}>
          {thinking ? <Thinking text={thinking} live={live?.phase === 'thinking'} press={press} onCopyCode={copyCode} /> : null}
          {content ? (
            <View accessibilityLabel={t('{p0} 說', { p0: name })}>
              <Markdown text={content} onCopyCode={copyCode} {...press} />
            </View>
          ) : null}
          {!live && !content ? <Text style={styles.dim}>{t('沒有說話。')}</Text> : null}
          {live ? <Working streaming={live} /> : null}
        </View>
        {m.detail === ROLE_TRUNCATED ? <Text style={styles.note}>{t('角色說明太長，這次只用了前面一部分。')}</Text> : null}
        {!live && (m.versions || h.isLast) ? (
          <View style={styles.actions}>
            {m.versions && h.onSwitchVersion ? (
              <Text style={styles.note} accessibilityLabel={t('第 {p0} 個回答，共 {p1} 個', { p0: m.versions.index, p1: m.versions.total })}>
                <Text onPress={() => h.onSwitchVersion!(-1)} style={styles.arrow}>
                  ‹
                </Text>{' '}
                {m.versions.index} / {m.versions.total}{' '}
                <Text onPress={() => h.onSwitchVersion!(1)} style={styles.arrow}>
                  ›
                </Text>
              </Text>
            ) : null}
            {h.isLast && content && h.onCopy ? <ActionButton text={t('複製')} onPress={h.onCopy} /> : null}
            {h.isLast && h.onRegenerate ? <ActionButton text={t('重新產生')} onPress={h.onRegenerate} /> : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/** 結論卡的文字版（複製、分享用） */
export function conclusionText(c: Conclusion): string {
  const lines = [`${t('結論')}：${c.question}`, ''];
  c.options.forEach((o, i) => {
    lines.push(`${i + 1}. ${o.text}（${t('{p0} 票', { p0: o.votes.length })}）`);
    for (const v of o.votes) lines.push(`   - ${v.name}${v.reason ? `：${v.reason}` : ''}`);
  });
  if (c.consensus) lines.push('', `${t('共識')}：${c.consensus}`);
  if (c.disagreements.length) lines.push('', `${t('還有分歧')}：`, ...c.disagreements.map((x) => `- ${x}`));
  if (c.todos.length) lines.push('', `${t('接下來')}：`, ...c.todos.map((x) => `- ${x}`));
  return lines.join('\n');
}

/** 結論卡：問題、各方案的票數與理由、共識、分歧、待辦；可以投你的一票、釘選、複製 */
export function ConclusionCard({
  card,
  agents,
  pinned,
  onVote,
  onPin,
  onCopy,
}: {
  card: Conclusion;
  agents: Record<string, Agent>;
  pinned: boolean;
  onVote: (index: number) => void;
  onPin: (on: boolean) => void;
  onCopy: () => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const total = card.options.reduce((n, o) => n + o.votes.length, 0);
  const top = Math.max(...card.options.map((o) => o.votes.length));
  return (
    <View style={styles.conclusion}>
      <View style={styles.conclusionHead}>
        <SymbolView name="checkmark.seal.fill" size={18} tintColor={C.accent} />
        <Text style={[styles.conclusionTitle, styles.flex]} accessibilityRole="header">
          {t('結論')}
        </Text>
        <Pressable onPress={() => onPin(!pinned)} hitSlop={10} accessibilityRole="button" accessibilityLabel={pinned ? t('取消釘選') : t('釘在最上面')}>
          <SymbolView name={pinned ? 'pin.fill' : 'pin'} size={16} tintColor={C.secondary} />
        </Pressable>
      </View>
      <Text style={styles.rowTitle}>{card.question}</Text>
      {card.options.map((o, i) => {
        const mine = o.votes.some((v) => v.who === 'user');
        const lead = o.votes.length > 0 && o.votes.length === top;
        return (
          <View key={i} style={[styles.option, lead && styles.optionLead]}>
            <Pressable
              onPress={() => setOpen(open === i ? null : i)}
              accessibilityRole="button"
              accessibilityState={{ expanded: open === i }}
              accessibilityLabel={t('方案 {p0}：{p1}，{p2} 票', { p0: i + 1, p1: o.text, p2: o.votes.length })}
              style={styles.optionHead}>
              <Text style={[styles.optionText, styles.flex]}>
                {i + 1}. {o.text}
              </Text>
              <Text style={[styles.votes, lead && styles.accent]}>{t('{p0} 票', { p0: o.votes.length })}</Text>
            </Pressable>
            {total > 0 ? (
              <View style={styles.meter}>
                <View style={[styles.meterFill, { width: `${(o.votes.length / total) * 100}%` }]} />
              </View>
            ) : null}
            <View style={styles.voters}>
              {o.votes.map((v) => {
                const a = agents[v.who];
                return v.who === 'user' ? (
                  <Text key="user" style={styles.voterYou}>
                    {t('你')}
                  </Text>
                ) : (
                  <View key={v.who} style={styles.voter}>
                    <AgentAvatar id={a ? avatarId(a) : v.who} emoji={a?.emoji ?? '🙂'} photo={a?.photo} size={18} />
                    <Text style={styles.voterName}>{v.name}</Text>
                  </View>
                );
              })}
              <Pressable onPress={() => onVote(i)} disabled={mine} hitSlop={8} accessibilityRole="button" accessibilityLabel={mine ? t('你投了方案 {p0}', { p0: i + 1 }) : t('投方案 {p0}', { p0: i + 1 })} style={({ pressed }) => [styles.voteButton, mine && styles.voteMine, pressed && styles.pressed]}>
                <Text style={[styles.voteText, mine && styles.voteTextMine]}>{mine ? t('你投了這個') : t('投這個')}</Text>
              </Pressable>
            </View>
            {open === i
              ? o.votes
                  .filter((v) => v.reason)
                  .map((v) => (
                    <Text key={v.who} style={styles.reason}>
                      {v.name}：{v.reason}
                    </Text>
                  ))
              : null}
          </View>
        );
      })}
      {card.consensus ? (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>{t('共識')}</Text>
          <Text style={styles.rowTitle}>{card.consensus}</Text>
        </View>
      ) : null}
      {card.disagreements.length ? (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>{t('還有分歧')}</Text>
          {card.disagreements.map((x, i) => (
            <Text key={i} style={styles.rowTitle}>
              • {x}
            </Text>
          ))}
        </View>
      ) : null}
      {card.todos.length ? (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>{t('接下來')}</Text>
          {card.todos.map((x, i) => (
            <Text key={i} style={styles.rowTitle}>
              • {x}
            </Text>
          ))}
        </View>
      ) : null}
      <View style={styles.actions}>
        <ActionButton text={t('複製')} onPress={onCopy} />
      </View>
    </View>
  );
}

/** 釘在最上面的結論：一行，點了跳到結論卡 */
export function PinnedConclusion({ card, onPress, onUnpin }: { card: Conclusion; onPress: () => void; onUnpin: () => void }) {
  return (
    <View style={styles.pinned}>
      <SymbolView name="pin.fill" size={13} tintColor={C.accent} />
      <Pressable onPress={onPress} style={styles.flex} accessibilityRole="button" accessibilityLabel={t('釘選的結論：{p0}，點一下看完整內容', { p0: card.consensus || card.question })}>
        <Text style={styles.pinnedText} numberOfLines={1}>
          {t('結論')}：{card.consensus || card.question}
        </Text>
      </Pressable>
      <Pressable onPress={onUnpin} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('取消釘選')}>
        <SymbolView name="xmark" size={11} tintColor={C.secondary} />
      </Pressable>
    </View>
  );
}

/** 標題下面那一列：成員頭像疊在一起、幾位、發言方式；點了打開成員面板 */
export function MembersBar({ members, group, onPress }: { members: Member[]; group: GroupSettings | null; onPress: () => void }) {
  const g = { ...DEFAULT_GROUP, ...group };
  const shown = members.slice(0, 5);
  const summary = [t('{p0} 位成員', { p0: members.length }), speakModeName(g.mode), g.autopilot ? t('全自動') : ''].filter(Boolean).join(' · ');
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={t('成員：{p0}。{p1}', { p0: members.map((m) => m.agent.name).join('、'), p1: summary })} style={({ pressed }) => [styles.bar, pressed && styles.pressed]}>
      <View style={styles.stack}>
        {shown.map((m, i) => (
          <View key={m.agent.id} style={[styles.stackItem, { marginLeft: i === 0 ? 0 : -8, zIndex: 10 - i }]}>
            <AgentAvatar id={avatarId(m.agent)} emoji={m.agent.emoji} photo={m.agent.photo} size={22} />
          </View>
        ))}
      </View>
      <Text style={styles.barText} numberOfLines={1}>
        {summary}
      </Text>
      <SymbolView name="chevron.right" size={11} tintColor={C.secondary} />
    </Pressable>
  );
}

/** 輸入框上面：討論進行到哪、暫停、繼續、要不要收尾 */
export function DiscussionStatus({
  phase,
  running,
  agents,
  suggest,
  canContinue,
  onPause,
  onContinue,
  onConclude,
  onDismissSuggest,
}: {
  phase: DiscussionPhase | null;
  running: boolean;
  agents: Record<string, Agent>;
  suggest: boolean;
  canContinue: boolean;
  onPause: () => void;
  onContinue: () => void;
  onConclude?: () => void;
  onDismissSuggest: () => void;
}) {
  if (running) {
    const text = !phase
      ? t('討論中…')
      : phase.phase === 'bidding'
        ? t('大家在想要不要說話…')
        : phase.phase === 'hosting'
          ? t('主持人在決定下一位…')
          : phase.phase === 'summarizing'
            ? t('正在整理前情摘要…')
            : phase.phase === 'concluding'
              ? t('正在收尾…')
              : t('{p0} 正在說話…', { p0: (phase.agentId && agents[phase.agentId]?.name) || 'AI' });
    return (
      <View style={styles.status} accessibilityLiveRegion="polite">
        <ActivityIndicator size="small" />
        <Text style={[styles.statusText, styles.flex]} numberOfLines={1}>
          {text}
        </Text>
        <ActionButton text={t('暫停')} onPress={onPause} />
      </View>
    );
  }
  if (suggest) {
    return (
      <View style={styles.status} accessibilityLiveRegion="polite">
        <SymbolView name="checkmark.seal" size={16} tintColor={C.accent} />
        <Text style={[styles.statusText, styles.flex]}>{t('大家覺得可以收尾了')}</Text>
        {onConclude ? <ActionButton text={t('收尾')} onPress={onConclude} primary /> : null}
        <ActionButton text={t('繼續聊')} onPress={onContinue} />
        <Pressable onPress={onDismissSuggest} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('先不要')}>
          <SymbolView name="xmark" size={12} tintColor={C.secondary} />
        </Pressable>
      </View>
    );
  }
  if (canContinue) {
    return (
      <View style={styles.status}>
        <Text style={[styles.statusText, styles.flex]}>{t('大家說完了')}</Text>
        <ActionButton text={t('繼續討論')} onPress={onContinue} />
        {onConclude ? <ActionButton text={t('收尾')} onPress={onConclude} /> : null}
      </View>
    );
  }
  return null;
}

/** 打 @ 時跳出的名單（成員在前，「我的 Agent」裡還不是成員的在後，選了會拉進來） */
export function MentionPicker({ query, members, mine, onPick }: { query: string; members: Agent[]; mine: Agent[]; onPick: (name: string) => void }) {
  const q = query.toLowerCase();
  const ids = new Set(members.map((a) => a.id));
  const list = [...members, ...mine.filter((a) => !ids.has(a.id))].filter((a) => a.name.toLowerCase().includes(q)).slice(0, 8);
  if (list.length === 0) return null;
  return (
    <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.mentions} testID="mention-picker">
      {list.map((a) => (
        <Pressable key={a.id} onPress={() => onPick(a.name)} accessibilityRole="button" accessibilityLabel={t('提到 {p0}', { p0: a.name })} style={({ pressed }) => [styles.mention, pressed && styles.pressed]}>
          <AgentAvatar id={avatarId(a)} emoji={a.emoji} photo={a.photo} size={20} />
          <Text style={styles.mentionText}>{a.name}</Text>
          {!ids.has(a.id) ? <Text style={styles.dim}>＋</Text> : null}
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** 成員面板：誰在討論、加人（我的 Agent、圖鑑、幫我挑）、討論設定 */
export function MembersSheet({ store, state, topic, onClose }: { store: ChatStore; state: ChatState; topic: string; onClose: () => void }) {
  const g = { ...DEFAULT_GROUP, ...state.session?.group };
  const [adding, setAdding] = useState<'mine' | 'catalog' | null>(null);
  const [picks, setPicks] = useState<CatalogEntry[] | null>(null);
  const [picking, setPicking] = useState(false);
  const memberIds = new Set(state.members.map((m) => m.agent.id));
  const memberCatalog = new Set(state.members.flatMap((m) => (m.agent.catalogId ? [m.agent.catalogId] : [])));
  const candidates = state.myAgents.filter((a) => !memberIds.has(a.id));
  const failed = (title: string) => (e: unknown) => Alert.alert(title, e instanceof Error ? e.message : String(e));

  async function suggest() {
    const run = async (text: string) => {
      if (!text.trim()) return;
      setPicking(true);
      try {
        setPicks(await store.suggestMembers(text));
      } catch (e) {
        failed(t('沒有挑到'))(e);
      } finally {
        setPicking(false);
      }
    };
    if (topic.trim()) return run(topic);
    Alert.prompt(t('要討論什麼？'), t('寫一句話，AI 照話題挑幾個觀點不同的角色。'), (text) => void run(text), 'plain-text');
  }

  function pickMode() {
    const modes: SpeakMode[] = ['free', 'host', 'round', 'mention'];
    chooseOption(t('發言方式'), modes.map(speakModeName), (i) => void store.setGroupSettings({ mode: modes[i] }));
  }

  function pickStreak() {
    const values = [4, 8, 12, 20];
    chooseOption(t('你說一句後，AI 最多連續講幾則'), values.map((v) => t('{p0} 則', { p0: v })), (i) => void store.setGroupSettings({ maxStreak: values[i] }));
  }

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <View style={styles.headerSide} />
        <Text style={styles.title} accessibilityRole="header">
          {t('成員')}
        </Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={({ pressed }) => [styles.headerSide, styles.headerRight, pressed && styles.pressed]}>
          <Text style={styles.done}>{t('完成')}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.section}>{state.members.length ? t('{p0} 位成員', { p0: state.members.length }) : t('還沒有成員')}</Text>
        <View style={styles.card}>
          {state.members.map((m) => (
            <View key={m.agent.id}>
              <View style={styles.row}>
                <AgentAvatar id={avatarId(m.agent)} emoji={m.agent.emoji} photo={m.agent.photo} size={34} />
                <View style={styles.flex}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {m.agent.name}
                    {joinedName(m.joinedBy) ? <Text style={styles.dim}>{` · ${joinedName(m.joinedBy)}`}</Text> : null}
                  </Text>
                  {m.agent.intro ? (
                    <Text style={styles.sub} numberOfLines={1}>
                      {m.agent.intro}
                    </Text>
                  ) : null}
                </View>
                <Pressable onPress={() => void store.removeMember(m.agent.id)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('拿掉 {p0}', { p0: m.agent.name })}>
                  <SymbolView name="minus.circle.fill" size={22} tintColor={C.red} />
                </Pressable>
              </View>
              <View style={styles.separator} />
            </View>
          ))}
          <AddRow icon="person.crop.circle.badge.plus" text={t('從我的 Agent 加')} onPress={() => setAdding(adding === 'mine' ? null : 'mine')} />
          {adding === 'mine' ? (
            candidates.length === 0 ? (
              <Text style={[styles.sub, styles.pad]}>{t('「我的 Agent」都已經在討論裡了（或還沒有）。到設定的「Agent」建立或從圖鑑加。')}</Text>
            ) : (
              candidates.map((a) => (
                <Pressable key={a.id} onPress={() => void store.addMember(a.id)} accessibilityRole="button" accessibilityLabel={t('加入 {p0}', { p0: a.name })} style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                  <View style={[styles.row, styles.indent]}>
                    <AgentAvatar id={avatarId(a)} emoji={a.emoji} photo={a.photo} size={28} />
                    <Text style={[styles.rowTitle, styles.flex]} numberOfLines={1}>
                      {a.name}
                    </Text>
                    <SymbolView name="plus.circle" size={22} tintColor={C.accent} />
                  </View>
                </Pressable>
              ))
            )
          ) : null}
          <View style={styles.separator} />
          <AddRow icon="books.vertical" text={t('從圖鑑加')} onPress={() => setAdding('catalog')} />
          <View style={styles.separator} />
          <AddRow icon="sparkles" text={t('幫我挑')} onPress={() => void suggest()} busy={picking} />
          {picks ? (
            picks.map((e) => (
              <View key={e.id} style={[styles.row, styles.indent]}>
                <AgentAvatar id={e.id} emoji={e.e} size={28} />
                <View style={styles.flex}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {entryName(e)}
                  </Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {entryIntro(e)}
                  </Text>
                </View>
                {memberCatalog.has(e.id) ? (
                  <SymbolView name="checkmark.circle.fill" size={22} tintColor={C.secondary} accessibilityLabel={t('已加入')} />
                ) : (
                  <Pressable
                    onPress={() => void store.addCatalogMember(e.id, { name: entryName(e), intro: entryIntro(e), emoji: e.e })}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={t('加入 {p0}', { p0: entryName(e) })}>
                    <SymbolView name="plus.circle" size={22} tintColor={C.accent} />
                  </Pressable>
                )}
              </View>
            ))
          ) : null}
        </View>
        <Text style={styles.footnote}>{t('「幫我挑」會照目前的話題，從圖鑑挑幾個觀點不同的角色。')}</Text>

        <Text style={styles.section}>{t('討論設定')}</Text>
        <View style={styles.card}>
          <SettingRow label={t('發言方式')} value={speakModeName(g.mode)} onPress={pickMode} />
          <View style={styles.separator} />
          <View style={styles.row}>
            <Text style={[styles.rowTitle, styles.flex]}>{t('讓 AI 自己加入')}</Text>
            <Switch value={g.autoJoin} onValueChange={(v) => void store.setGroupSettings({ autoJoin: v })} accessibilityLabel={t('讓 AI 自己加入')} />
          </View>
          <View style={styles.separator} />
          <SettingRow label={t('連續上限')} value={t('{p0} 則', { p0: g.maxStreak })} onPress={pickStreak} />
          <View style={styles.separator} />
          <View style={styles.row}>
            <Text style={[styles.rowTitle, styles.flex]}>{t('全自動')}</Text>
            <Switch value={g.autopilot} onValueChange={(v) => void store.setGroupSettings({ autopilot: v })} accessibilityLabel={t('全自動')} />
          </View>
        </View>
        <Text style={styles.footnote}>
          {t('自由搶話：每則說完，大家先舉手，最想講的人講。讓 AI 自己加入：「我的 Agent」裡勾了「可以自己加入」的，話題相關就會加入。連續上限：你說一句後 AI 最多連續講幾則就停下等你。全自動：不等你，聊到沒人想講就自己收尾。')}
        </Text>
      </ScrollView>

      <Modal visible={adding === 'catalog'} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setAdding(null)}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerSide} />
            <Text style={styles.title} accessibilityRole="header">
              {t('從圖鑑加')}
            </Text>
            <Pressable onPress={() => setAdding(null)} hitSlop={10} accessibilityRole="button" style={({ pressed }) => [styles.headerSide, styles.headerRight, pressed && styles.pressed]}>
              <Text style={styles.done}>{t('完成')}</Text>
            </Pressable>
          </View>
          <CatalogList
            added={memberCatalog}
            onOpen={(e) => void store.addCatalogMember(e.id, { name: entryName(e), intro: entryIntro(e), emoji: e.e })}
            onAdd={(id) => {
              const e = getEntry(id);
              if (e) void store.addCatalogMember(id, { name: entryName(e), intro: entryIntro(e), emoji: e.e });
            }}
          />
        </View>
      </Modal>
    </View>
  );
}


function AddRow({ icon, text, onPress, busy }: { icon: 'person.crop.circle.badge.plus' | 'books.vertical' | 'sparkles'; text: string; onPress: () => void; busy?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={busy} accessibilityRole="button" style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
      <View style={styles.row}>
        <SymbolView name={icon} size={20} tintColor={C.accent} />
        <Text style={[styles.rowTitle, styles.accent, styles.flex]}>{text}</Text>
        {busy ? <ActivityIndicator /> : null}
      </View>
    </Pressable>
  );
}

function SettingRow({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={t('{p0}，{p1}', { p0: label, p1: value })} style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
      <View style={styles.row}>
        <Text style={[styles.rowTitle, styles.flex]}>{label}</Text>
        <Text style={styles.sub}>{value}</Text>
        <SymbolView name="chevron.up.chevron.down" size={13} tintColor={C.tertiary} />
      </View>
    </Pressable>
  );
}

/** 「回覆 某某」要不要顯示：回的就是上一則（看得到的 AI 或你說的話）就不顯示 */
export function replyTargets(messages: Message[], agents: Record<string, Agent>, userName: string): Map<string, { id: string; name: string; content: string }> {
  const out = new Map<string, { id: string; name: string; content: string }>();
  const spoken = messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim());
  spoken.forEach((m, i) => {
    if (!m.replyTo || spoken[i - 1]?.id === m.replyTo) return;
    const target = spoken.find((x) => x.id === m.replyTo);
    if (!target) return;
    const name = target.role === 'user' ? userName : (target.agentId && agents[target.agentId]?.name) || 'AI';
    out.set(m.id, { id: target.id, name, content: target.content.replace(/\s+/g, ' ').slice(0, 60) });
  });
  return out;
}

const styles = StyleSheet.create({
  userRow: { alignItems: 'flex-end', paddingLeft: 48 },
  userBubble: { backgroundColor: C.accentFill, borderRadius: 18, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 10, gap: 6, maxWidth: '100%' },
  userText: { ...TEXT.body, color: '#ffffff' },
  aiRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingRight: 24 },
  aiCol: { flex: 1, gap: 4, alignItems: 'flex-start' },
  name: { ...TEXT.meta, color: C.secondary, fontWeight: '600' },
  quote: { ...TEXT.meta, color: C.secondary, borderLeftWidth: 2, borderLeftColor: C.separator, paddingLeft: 6 },
  aiBubble: { backgroundColor: C.surface, borderRadius: 18, borderTopLeftRadius: 6, paddingHorizontal: 14, paddingVertical: 10, gap: 8, maxWidth: '100%' },
  system: { ...TEXT.meta, color: C.secondary, textAlign: 'center', paddingVertical: 2 },
  note: { ...TEXT.meta, color: C.secondary },
  arrow: { color: C.accent, fontWeight: '700' },
  dim: { color: C.secondary },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.separator },
  stack: { flexDirection: 'row' },
  stackItem: { borderRadius: 12, borderWidth: 1.5, borderColor: C.bg },
  barText: { ...TEXT.meta, color: C.secondary, flex: 1 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 6 },
  statusText: { ...TEXT.small, color: C.secondary },
  flex: { flex: 1 },
  pressed: { opacity: 0.5 },
  mentions: { gap: 8, paddingHorizontal: 12, paddingVertical: 6 },
  mention: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 10, borderRadius: 18, backgroundColor: C.surface },
  mentionText: { ...TEXT.small, color: C.label },
  sheet: { flex: 1, backgroundColor: C.groupedBg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingBottom: 8 },
  title: { fontSize: 17, fontWeight: '600', color: C.label },
  headerSide: { minWidth: 72 },
  headerRight: { alignItems: 'flex-end' },
  done: { fontSize: 17, fontWeight: '600', color: C.accent },
  content: { padding: 16, paddingTop: 4, gap: 8, paddingBottom: 48 },
  section: { fontSize: 13, color: C.secondary, marginHorizontal: 4, marginTop: 14 },
  card: { backgroundColor: C.groupedCard, borderRadius: 12, overflow: 'hidden' },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  indent: { paddingLeft: 32 },
  pad: { padding: 16 },
  rowTitle: { ...TEXT.body, color: C.label },
  sub: { ...TEXT.small, color: C.secondary },
  accent: { color: C.accent },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 62 },
  footnote: { fontSize: 13, lineHeight: 18, color: C.secondary, marginHorizontal: 4 },
  conclusion: { marginHorizontal: 4, padding: 14, gap: 10, borderRadius: 16, backgroundColor: C.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator },
  conclusionHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  conclusionTitle: { ...TEXT.body, fontWeight: '700', color: C.label },
  option: { gap: 6, padding: 10, borderRadius: 12, backgroundColor: C.bg },
  optionLead: { borderWidth: 1, borderColor: C.accent },
  optionHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  optionText: { ...TEXT.body, color: C.label },
  votes: { ...TEXT.small, color: C.secondary, fontWeight: '600' },
  meter: { height: 4, borderRadius: 2, backgroundColor: C.pressed, overflow: 'hidden' },
  meterFill: { height: 4, backgroundColor: C.accentFill },
  voters: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  voter: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  voterName: { ...TEXT.meta, color: C.secondary },
  voterYou: { ...TEXT.meta, color: C.accent, fontWeight: '700' },
  voteButton: { marginLeft: 'auto', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator },
  voteMine: { borderColor: C.accent },
  voteText: { ...TEXT.meta, color: C.label, fontWeight: '600' },
  voteTextMine: { color: C.accent },
  reason: { ...TEXT.small, color: C.secondary },
  block: { gap: 4 },
  blockTitle: { ...TEXT.meta, color: C.secondary, fontWeight: '700' },
  pinned: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 6, backgroundColor: C.surface },
  pinnedText: { ...TEXT.small, color: C.label },
});
