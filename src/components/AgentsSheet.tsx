import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Linking, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { catalogLicenses, categories, entryIntro, entryName, entryVibe, searchCatalog, type CatalogEntry, type CategoryKey } from '../agents/catalog';
import type { AgentDraft, ChatStore } from '../state/chatStore';
import { useChatState } from '../state/useChat';
import type { Agent, AgentCard, AgentNote } from '../store/repo';
import { C, TEXT } from '../ui/theme';
import { AgentAvatar, avatarId } from './AgentAvatar';
import { chooseOption } from './Composer';
import { UndoToast } from './UndoToast';
import { t } from '../i18n';

// 設定裡的「Agent」：我的 Agent（自己建的、從圖鑑加的）與圖鑑（內建 788 個）

type Props = { store: ChatStore; onClose: () => void };

/** 積極度三段：安靜、普通、愛講 */
const TALK_LEVELS = [0.2, 0.5, 0.8] as const;
const talkLabel = (v: number) => [t('安靜'), t('普通'), t('愛講')][nearestTalk(v)];
const nearestTalk = (v: number) => TALK_LEVELS.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(TALK_LEVELS[best] - v) ? i : best), 0);

export function AgentsView({ store, onClose }: Props) {
  const state = useChatState(store);
  const [tab, setTab] = useState<'mine' | 'catalog'>('mine');
  const [editing, setEditing] = useState<{ id?: string } | null>(null);
  const [detail, setDetail] = useState<CatalogEntry | null>(null);
  const [licenses, setLicenses] = useState(false);

  useEffect(() => {
    void store.loadMyAgents();
  }, [store]);

  const mineByCatalog = useMemo(() => new Set(state.myAgents.flatMap((a) => (a.catalogId ? [a.catalogId] : []))), [state.myAgents]);

  return (
    <View style={styles.sheet}>
      <Header title={t('Agent')} right={t('完成')} onRight={onClose} />
      <View style={styles.segment} accessibilityRole="tablist">
        {(['mine', 'catalog'] as const).map((k) => (
          <Pressable
            key={k}
            onPress={() => setTab(k)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === k }}
            style={[styles.segmentItem, tab === k && styles.segmentOn]}>
            <Text style={[styles.segmentText, tab === k && styles.segmentTextOn]}>{k === 'mine' ? t('我的 Agent') : t('圖鑑')}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'mine' ? (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.card}>
            <Pressable onPress={() => setEditing({})} accessibilityRole="button" style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
              <View style={styles.row}>
                <SymbolView name="plus.circle.fill" size={22} tintColor={C.accent} />
                <Text style={[styles.rowTitle, styles.accentText]}>{t('建立新的 Agent')}</Text>
              </View>
            </Pressable>
            {state.myAgents.map((a) => (
              <View key={a.id}>
                <View style={styles.separator} />
                <AgentRow agent={a} onPress={() => setEditing({ id: a.id })} />
              </View>
            ))}
          </View>
          <Text style={styles.footnote}>
            {state.myAgents.length === 0 ? t('還沒有 Agent。寫一句話讓 AI 幫你建一個，或到「圖鑑」挑現成的。') : t('在對話上方點「成員」就能把他們加進討論。')}
          </Text>
          <Pressable onPress={() => setLicenses(true)} accessibilityRole="button" style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}>
            <Text style={styles.link}>{t('第三方授權')}</Text>
          </Pressable>
        </ScrollView>
      ) : (
        <CatalogList onOpen={setDetail} added={mineByCatalog} onAdd={(id) => void store.addCatalogToMine(id)} />
      )}
      <UndoToast store={store} />

      <Modal visible={!!editing} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setEditing(null)}>
        {editing ? <AgentEditor store={store} id={editing.id} onClose={() => setEditing(null)} /> : null}
      </Modal>
      <Modal visible={!!detail} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setDetail(null)}>
        {detail ? <CatalogDetail store={store} entry={detail} added={mineByCatalog.has(detail.id)} onClose={() => setDetail(null)} /> : null}
      </Modal>
      <Modal visible={licenses} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setLicenses(false)}>
        <Licenses onClose={() => setLicenses(false)} />
      </Modal>
    </View>
  );
}

function AgentRow({ agent, onPress }: { agent: Agent; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${agent.name}，${agent.intro}`} style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
      <View style={styles.row}>
        <AgentAvatar id={avatarId(agent)} emoji={agent.emoji} photo={agent.photo} size={36} />
        <View style={styles.flex}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {agent.name}
          </Text>
          {agent.intro ? (
            <Text style={styles.sub} numberOfLines={2}>
              {agent.intro}
            </Text>
          ) : null}
        </View>
        <SymbolView name="chevron.right" size={13} tintColor={C.tertiary} />
      </View>
    </Pressable>
  );
}

/** 圖鑑：搜尋、分類、清單；右邊直接加到「我的 Agent」 */
export function CatalogList({ onOpen, added, onAdd }: { onOpen: (e: CatalogEntry) => void; added: Set<string>; onAdd: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<CategoryKey | null>(null);
  const list = useMemo(() => searchCatalog(query, cat), [query, cat]);
  const cats = useMemo(() => categories(), []);
  return (
    <View style={styles.flex}>
      <View style={styles.searchBox}>
        <SymbolView name="magnifyingglass" size={15} tintColor={C.secondary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('搜尋 {p0} 個角色', { p0: searchCatalog('').length })}
          placeholderTextColor={C.placeholder}
          style={styles.searchInput}
          clearButtonMode="while-editing"
          autoCorrect={false}
          accessibilityLabel={t('搜尋圖鑑')}
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled" style={styles.chipsBar}>
        {[{ key: null as CategoryKey | null, label: t('全部') }, ...cats].map((c) => (
          <Pressable
            key={c.key ?? 'all'}
            onPress={() => setCat(c.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: cat === c.key }}
            style={[styles.chip, cat === c.key && styles.chipOn]}>
            <Text style={[styles.chipText, cat === c.key && styles.chipTextOn]}>{c.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <FlatList
        data={list}
        keyExtractor={(e) => e.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={16}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={<Text style={[styles.sub, styles.empty]}>{t('找不到符合的角色。')}</Text>}
        renderItem={({ item }) => (
          <Pressable onPress={() => onOpen(item)} accessibilityRole="button" accessibilityLabel={`${entryName(item)}，${entryIntro(item)}`} style={({ pressed }) => [styles.catalogRow, pressed && { backgroundColor: C.pressed }]}>
            <AgentAvatar id={item.id} emoji={item.e} size={36} />
            <View style={styles.flex}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {entryName(item)}
              </Text>
              <Text style={styles.sub} numberOfLines={2}>
                {entryIntro(item)}
              </Text>
            </View>
            {added.has(item.id) ? (
              <SymbolView name="checkmark.circle.fill" size={24} tintColor={C.secondary} accessibilityLabel={t('已加入')} />
            ) : (
              <Pressable onPress={() => onAdd(item.id)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('加到我的 Agent：{p0}', { p0: entryName(item) })}>
                <SymbolView name="plus.circle" size={24} tintColor={C.accent} />
              </Pressable>
            )}
          </Pressable>
        )}
      />
    </View>
  );
}

/** 圖鑑的一個角色：介紹、個性、作者與來源、角色原文 */
function CatalogDetail({ store, entry, added, onClose }: { store: ChatStore; entry: CatalogEntry; added: boolean; onClose: () => void }) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isAdded, setAdded] = useState(added);
  const vibe = entryVibe(entry);
  const cat = categories().find((c) => c.key === entry.c)?.label ?? '';

  async function showPrompt() {
    setLoading(true);
    try {
      setPrompt(await store.catalogPrompt(entry.id));
    } catch (e) {
      Alert.alert(t('讀不到角色原文'), e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.sheet}>
      <Header title={entryName(entry)} right={t('完成')} onRight={onClose} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <AgentAvatar id={entry.id} emoji={entry.e} size={72} />
          <Text style={styles.heroName}>{entryName(entry)}</Text>
          <Text style={styles.sub}>{cat}</Text>
        </View>
        <View style={[styles.card, styles.pad]}>
          <Text style={styles.rowTitle}>{entryIntro(entry)}</Text>
          {vibe ? <Text style={[styles.sub, styles.vibe]}>「{vibe}」</Text> : null}
        </View>
        <Pressable
          disabled={isAdded}
          onPress={async () => {
            await store.addCatalogToMine(entry.id);
            setAdded(true);
          }}
          accessibilityRole="button"
          accessibilityState={{ disabled: isAdded }}
          style={({ pressed }) => [styles.primary, isAdded && styles.primaryDone, pressed && styles.pressed]}>
          <Text style={[styles.primaryText, isAdded && styles.primaryDoneText]}>{isAdded ? t('已在我的 Agent') : t('加到我的 Agent')}</Text>
        </Pressable>

        <Text style={styles.section}>{t('角色原文')}</Text>
        <View style={[styles.card, styles.pad]}>
          {prompt === null ? (
            <Pressable onPress={showPrompt} disabled={loading} accessibilityRole="button" style={({ pressed }) => [styles.inline, pressed && styles.pressed]}>
              {loading ? <ActivityIndicator /> : null}
              <Text style={styles.link}>{t('顯示角色原文')}</Text>
            </Pressable>
          ) : (
            <Text style={styles.prompt} selectable>
              {prompt || t('（沒有原文）')}
            </Text>
          )}
        </View>
        <Text style={styles.footnote}>{t('討論時會用這段原文當他的角色設定。')}</Text>

        <Text style={styles.section}>{t('來源')}</Text>
        <Pressable onPress={() => void Linking.openURL(entry.u)} accessibilityRole="link" style={({ pressed }) => [styles.card, styles.pad, pressed && { backgroundColor: C.pressed }]}>
          <Text style={styles.rowTitle}>{t('作者：{p0}', { p0: entry.a || '—' })}</Text>
          <Text style={styles.link} numberOfLines={1}>
            {entry.u}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

/** 建立或編輯 Agent。新的：先寫一句話，AI 生成角色卡，再逐欄改 */
function AgentEditor({ store, id, onClose }: { store: ChatStore; id?: string; onClose: () => void }) {
  const state = useChatState(store);
  const existing = id ? state.myAgents.find((a) => a.id === id) : undefined;
  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(existing?.name ?? '');
  const [intro, setIntro] = useState(existing?.intro ?? '');
  const [emoji, setEmoji] = useState(existing?.emoji ?? '');
  const [avatar, setAvatar] = useState<string | null>(existing?.avatar ?? null);
  const [pickingAvatar, setPickingAvatar] = useState(false);
  const [talk, setTalk] = useState(existing?.talk ?? 0.5);
  const [card, setCard] = useState<AgentCard | null>(existing ? existing.card : null);
  const [autoJoin, setAutoJoin] = useState(existing?.autoJoin ?? false);
  const [model, setModel] = useState<{ hostUrl: string | null; model: string | null }>({ hostUrl: existing?.hostUrl ?? null, model: existing?.model ?? null });
  const [notes, setNotes] = useState<AgentNote[]>([]);
  const [role, setRole] = useState<string | null>(null);
  const fromCatalog = !!existing?.catalogId;
  const drafted = !!existing || !!card || !!name;

  useEffect(() => {
    if (id) void store.listNotes(id).then(setNotes);
  }, [store, id]);

  async function generate(again: boolean) {
    if (!idea.trim()) return;
    setBusy(true);
    try {
      const d: AgentDraft = await store.generateAgent(idea, again ? name : undefined);
      setName(d.name);
      setIntro(d.intro);
      setEmoji(d.emoji);
      setAvatar(d.avatar);
      setTalk(d.talk);
      setCard(d.card);
    } catch (e) {
      Alert.alert(t('沒有生成'), e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!name.trim()) return;
    await store.saveAgent({ name: name.trim(), intro: intro.trim(), emoji, avatar, talk, card: fromCatalog ? (existing?.card ?? null) : card, autoJoin, hostUrl: model.hostUrl, model: model.model }, id);
    onClose();
  }

  function pickModel() {
    const options: { label: string; hostUrl: string | null; model: string | null }[] = [{ label: t('跟著對話'), hostUrl: null, model: null }];
    for (const h of state.hosts) for (const m of state.models[h.url]?.list ?? []) options.push({ label: `${m.name} · ${h.label}`, hostUrl: h.url, model: m.name });
    chooseOption(
      t('用哪個模型'),
      options.map((o) => o.label),
      (i) => setModel({ hostUrl: options[i].hostUrl, model: options[i].model })
    );
  }

  const setField = (k: keyof AgentCard) => (v: string) => setCard({ expertise: '', stance: '', style: '', blindSpot: '', ...card, [k]: v });
  const modelLabel = model.model ? `${model.model} · ${state.hosts.find((h) => h.url === model.hostUrl)?.label ?? ''}` : t('跟著對話');

  return (
    <View style={styles.sheet}>
      <Header title={existing ? t('編輯 Agent') : t('建立 Agent')} left={t('取消')} onLeft={onClose} right={t('儲存')} onRight={save} rightDisabled={!name.trim()} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
        {!existing ? (
          <>
            <Text style={styles.section}>{t('用一句話描述你想要的 Agent')}</Text>
            <View style={[styles.card, styles.pad]}>
              <TextInput
                value={idea}
                onChangeText={setIdea}
                placeholder={t('例如：一個愛挑毛病、凡事先看預算的財務長')}
                placeholderTextColor={C.placeholder}
                style={[styles.input, styles.multiline]}
                multiline
                accessibilityLabel={t('描述你想要的 Agent')}
              />
              <View style={styles.inline}>
                <Pressable
                  onPress={() => void generate(false)}
                  disabled={busy || !idea.trim()}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy || !idea.trim() }}
                  style={({ pressed }) => [styles.smallButton, (busy || !idea.trim()) && styles.disabled, pressed && styles.pressed]}>
                  <SymbolView name="sparkles" size={15} tintColor="#fff" />
                  <Text style={styles.smallButtonText}>{t('生成')}</Text>
                </Pressable>
                {card ? (
                  <Pressable onPress={() => void generate(true)} disabled={busy} accessibilityRole="button" style={({ pressed }) => [styles.inline, pressed && styles.pressed]}>
                    <Text style={styles.link}>{t('再生一個')}</Text>
                  </Pressable>
                ) : null}
                {busy ? <ActivityIndicator /> : null}
              </View>
            </View>
          </>
        ) : null}

        {drafted ? (
          <>
            <View style={styles.hero}>
              <AgentAvatar id={avatar ?? existing?.catalogId ?? existing?.id ?? name} emoji={emoji} photo={existing?.photo} size={64} />
              <Pressable onPress={() => setPickingAvatar(true)} hitSlop={8} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
                <Text style={styles.link}>{t('換頭像')}</Text>
              </Pressable>
            </View>
            <Field label={t('名字')} value={name} onChange={setName} />
            <Field label={t('一句話介紹')} value={intro} onChange={setIntro} multiline />
            <Field label={t('emoji')} value={emoji} onChange={(v) => setEmoji([...v].slice(-2).join(''))} />
            {fromCatalog ? (
              <>
                <Text style={styles.section}>{t('角色設定')}</Text>
                <View style={[styles.card, styles.pad]}>
                  <Text style={styles.sub}>{t('照圖鑑原文')}</Text>
                  {role === null ? (
                    <Pressable onPress={() => existing && void store.agentRole(existing).then(setRole)} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
                      <Text style={styles.link}>{t('顯示角色原文')}</Text>
                    </Pressable>
                  ) : (
                    <Text style={styles.prompt} selectable>
                      {role}
                    </Text>
                  )}
                </View>
              </>
            ) : (
              <>
                <Field label={t('專長')} value={card?.expertise ?? ''} onChange={setField('expertise')} multiline />
                <Field label={t('立場與個性')} value={card?.stance ?? ''} onChange={setField('stance')} multiline />
                <Field label={t('說話風格')} value={card?.style ?? ''} onChange={setField('style')} multiline />
                <Field label={t('盲點')} value={card?.blindSpot ?? ''} onChange={setField('blindSpot')} multiline />
              </>
            )}

            <Text style={styles.section}>{t('討論時')}</Text>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={[styles.rowTitle, styles.flex]}>{t('積極度')}</Text>
                <View style={styles.miniSegment}>
                  {TALK_LEVELS.map((v, i) => (
                    <Pressable
                      key={v}
                      onPress={() => setTalk(v)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: nearestTalk(talk) === i }}
                      style={[styles.miniItem, nearestTalk(talk) === i && styles.segmentOn]}>
                      <Text style={[styles.chipText, nearestTalk(talk) === i && styles.segmentTextOn]}>{talkLabel(v)}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
              <View style={styles.separator} />
              <View style={styles.row}>
                <Text style={[styles.rowTitle, styles.flex]}>{t('可以自己加入')}</Text>
                <Switch value={autoJoin} onValueChange={setAutoJoin} accessibilityLabel={t('可以自己加入')} />
              </View>
              <View style={styles.separator} />
              <Pressable onPress={pickModel} accessibilityRole="button" accessibilityLabel={t('模型，{p0}', { p0: modelLabel })} style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                <View style={styles.row}>
                  <Text style={[styles.rowTitle, styles.flex]}>{t('模型')}</Text>
                  <Text style={styles.value} numberOfLines={1}>
                    {modelLabel}
                  </Text>
                  <SymbolView name="chevron.up.chevron.down" size={13} tintColor={C.tertiary} />
                </View>
              </Pressable>
            </View>
            <Text style={styles.footnote}>{t('「可以自己加入」：對話開了「讓 AI 自己加入」時，話題跟他有關他就會加入。')}</Text>
          </>
        ) : null}

        {existing ? (
          <>
            <Text style={styles.section}>{t('筆記')}</Text>
            <View style={styles.card}>
              {notes.length === 0 ? (
                <Text style={[styles.sub, styles.empty]}>{t('還沒有筆記。討論收尾後他會寫下這次的立場。')}</Text>
              ) : (
                notes.map((n, i) => (
                  <View key={n.id}>
                    <View style={styles.row}>
                      <Text style={[styles.rowTitle, styles.flex]}>{n.content}</Text>
                      <Pressable
                        onPress={async () => {
                          await store.deleteNote(n.id);
                          setNotes(await store.listNotes(existing.id));
                        }}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel={t('刪除這則筆記')}>
                        <SymbolView name="xmark.circle.fill" size={20} tintColor={C.tertiary} />
                      </Pressable>
                    </View>
                    {i < notes.length - 1 ? <View style={styles.separator} /> : null}
                  </View>
                ))
              )}
            </View>
            {notes.length > 0 ? (
              <Pressable
                onPress={() =>
                  Alert.alert(t('清除全部筆記？'), t('他會忘記之前討論的立場。'), [
                    { text: t('取消'), style: 'cancel' },
                    {
                      text: t('清除'),
                      style: 'destructive',
                      onPress: async () => {
                        await store.clearNotes(existing.id);
                        setNotes([]);
                      },
                    },
                  ])
                }
                accessibilityRole="button"
                style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}>
                <Text style={styles.danger}>{t('清除全部筆記')}</Text>
              </Pressable>
            ) : null}

            <View style={[styles.card, styles.gap]}>
              <Pressable
                onPress={async () => {
                  await store.deleteAgent(existing.id);
                  onClose();
                }}
                accessibilityRole="button"
                style={({ pressed }) => pressed && { backgroundColor: C.pressed }}>
                <View style={styles.row}>
                  <SymbolView name="trash" size={18} tintColor={C.red} />
                  <Text style={[styles.rowTitle, styles.danger]}>{t('刪除這個 Agent')}</Text>
                </View>
              </Pressable>
            </View>
          </>
        ) : null}
      </ScrollView>
      <Modal visible={pickingAvatar} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setPickingAvatar(false)}>
        <AvatarPicker
          emoji={emoji}
          onClose={() => setPickingAvatar(false)}
          onPick={(id) => {
            setAvatar(id);
            setPickingAvatar(false);
          }}
        />
      </Modal>
    </View>
  );
}

/** 換頭像：從圖鑑的像素頭像挑一張（可以搜尋），或用 emoji */
function AvatarPicker({ emoji, onPick, onClose }: { emoji: string; onPick: (id: string | null) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const list = useMemo(() => searchCatalog(query), [query]);
  return (
    <View style={styles.sheet}>
      <Header title={t('換頭像')} right={t('完成')} onRight={onClose} />
      <View style={styles.searchBox}>
        <SymbolView name="magnifyingglass" size={15} tintColor={C.secondary} />
        <TextInput value={query} onChangeText={setQuery} placeholder={t('搜尋角色')} placeholderTextColor={C.placeholder} style={styles.searchInput} clearButtonMode="while-editing" accessibilityLabel={t('搜尋頭像')} />
      </View>
      <FlatList
        data={list}
        keyExtractor={(e) => e.id}
        numColumns={4}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={24}
        contentContainerStyle={styles.grid}
        ListHeaderComponent={
          <Pressable onPress={() => onPick(null)} accessibilityRole="button" style={({ pressed }) => [styles.emojiOption, pressed && styles.pressed]}>
            <AgentAvatar id="emoji" emoji={emoji} size={40} />
            <Text style={styles.link}>{t('用 emoji')}</Text>
          </Pressable>
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => onPick(item.id)} accessibilityRole="button" accessibilityLabel={t('用 {p0} 的頭像', { p0: entryName(item) })} style={({ pressed }) => [styles.gridCell, pressed && styles.pressed]}>
            <AgentAvatar id={item.id} emoji={item.e} size={56} />
            <Text style={styles.gridName} numberOfLines={1}>
              {entryName(item)}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

function Field({ label, value, onChange, multiline }: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean }) {
  return (
    <>
      <Text style={styles.section}>{label}</Text>
      <View style={[styles.card, styles.pad]}>
        <TextInput value={value} onChangeText={onChange} style={[styles.input, multiline && styles.multiline]} multiline={multiline} accessibilityLabel={label} placeholderTextColor={C.placeholder} />
      </View>
    </>
  );
}

function Licenses({ onClose }: { onClose: () => void }) {
  return (
    <View style={styles.sheet}>
      <Header title={t('第三方授權')} right={t('完成')} onRight={onClose} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.footnote}>{t('圖鑑裡的角色來自下面兩個開放原始碼專案（MIT 授權）。')}</Text>
        {catalogLicenses().map((l) => (
          <View key={l.name} style={[styles.card, styles.pad]}>
            <Text style={styles.rowTitle}>{l.name}</Text>
            <Text style={styles.link} onPress={() => void Linking.openURL(l.url)} accessibilityRole="link">
              {l.url}
            </Text>
            <Text style={styles.prompt} selectable>
              {l.text}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function Header({ title, left, onLeft, right, onRight, rightDisabled }: { title: string; left?: string; onLeft?: () => void; right: string; onRight: () => void; rightDisabled?: boolean }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerSide}>
        {left ? (
          <Pressable onPress={onLeft} hitSlop={10} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
            <Text style={styles.cancel}>{left}</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
        {title}
      </Text>
      <Pressable
        onPress={onRight}
        disabled={rightDisabled}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityState={{ disabled: !!rightDisabled }}
        style={({ pressed }) => [styles.headerSide, styles.headerRight, pressed && styles.pressed]}>
        <Text style={[styles.done, rightDisabled && styles.disabledText]}>{right}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: C.groupedBg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingBottom: 8, gap: 8 },
  title: { fontSize: 17, fontWeight: '600', color: C.label, flexShrink: 1, textAlign: 'center' },
  headerSide: { minWidth: 72 },
  headerRight: { alignItems: 'flex-end' },
  done: { fontSize: 17, fontWeight: '600', color: C.accent },
  cancel: { fontSize: 17, color: C.accent },
  disabledText: { color: C.tertiary },
  pressed: { opacity: 0.4 },
  content: { padding: 16, paddingTop: 4, gap: 8, paddingBottom: 48 },
  segment: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, padding: 2, borderRadius: 9, backgroundColor: C.pressed },
  segmentItem: { flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 7 },
  segmentOn: { backgroundColor: C.groupedCard },
  segmentText: { fontSize: 14, color: C.secondary },
  segmentTextOn: { color: C.label, fontWeight: '600' },
  miniSegment: { flexDirection: 'row', padding: 2, borderRadius: 8, backgroundColor: C.pressed },
  miniItem: { minHeight: 32, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  section: { fontSize: 13, color: C.secondary, marginHorizontal: 4, marginTop: 14 },
  card: { backgroundColor: C.groupedCard, borderRadius: 12, overflow: 'hidden' },
  pad: { padding: 14, gap: 8 },
  gap: { marginTop: 24 },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  catalogRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: C.groupedCard },
  flex: { flex: 1 },
  rowTitle: { ...TEXT.body, color: C.label },
  sub: { ...TEXT.small, color: C.secondary },
  value: { ...TEXT.small, color: C.secondary, flexShrink: 1, maxWidth: '55%' },
  accentText: { color: C.accent },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 64 },
  footnote: { fontSize: 13, lineHeight: 18, color: C.secondary, marginHorizontal: 4 },
  linkRow: { alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 16 },
  link: { ...TEXT.small, color: C.accent },
  danger: { ...TEXT.body, color: C.errorText },
  empty: { padding: 16 },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, paddingHorizontal: 10, minHeight: 40, borderRadius: 10, backgroundColor: C.pressed },
  searchInput: { ...TEXT.body, flex: 1, color: C.label, paddingVertical: 8 },
  chipsBar: { flexGrow: 0 },
  chips: { gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  chip: { minHeight: 32, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center', backgroundColor: C.groupedCard },
  chipOn: { backgroundColor: C.accentFill },
  chipText: { fontSize: 13, color: C.label },
  chipTextOn: { color: '#fff', fontWeight: '600' },
  listContent: { paddingBottom: 48 },
  hero: { alignItems: 'center', gap: 6, paddingVertical: 12 },
  heroName: { fontSize: 20, fontWeight: '700', color: C.label, textAlign: 'center' },
  vibe: { fontStyle: 'italic' },
  primary: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: C.accentFill, marginTop: 8 },
  primaryText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  primaryDone: { backgroundColor: C.groupedCard },
  primaryDoneText: { color: C.secondary },
  prompt: { ...TEXT.small, color: C.label },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 36 },
  input: { ...TEXT.body, color: C.label, padding: 0 },
  multiline: { minHeight: 44, textAlignVertical: 'top' },
  smallButton: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: C.accentFill },
  smallButtonText: { fontSize: 15, fontWeight: '600', color: '#fff' },
  disabled: { opacity: 0.4 },
  grid: { paddingHorizontal: 8, paddingBottom: 48 },
  gridCell: { flex: 1 / 4, alignItems: 'center', gap: 4, paddingVertical: 10 },
  gridName: { ...TEXT.meta, color: C.secondary, maxWidth: 80 },
  emojiOption: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
});
