import DateTimePicker from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { fmtEventTime } from '../lib/format';
import { parseLocal, toLocalText, type PhoneTool, type ToolInput } from '../lib/tools';
import type { Action } from '../store/repo';
import { C, TEXT } from '../ui/theme';
import { ActionButton } from './Messages';
import { getLanguage, t } from '../i18n';

type Handlers = {
  onApprove: (id: string, edited?: ToolInput) => Promise<void>;
  onDecline: (id: string, reason: string) => Promise<void>;
  onUndo: (id: string) => Promise<void>;
};

type ToolOf = (name: string) => PhoneTool | undefined;

/**
 * AI 要做的一件事：還沒確認時是確認卡（放在對話裡，App 關掉再開也還在）；
 * 做完之後縮成一行（做了什麼、可以復原）。選擇題是一排選項按鈕。
 */
export function ActionView({ action, tool, ...h }: { action: Action; tool: PhoneTool | undefined } & Handlers) {
  if (action.status === 'pending') return tool?.kind === 'question' ? <QuestionCard action={action} {...h} /> : <ActionCard action={action} tool={tool} {...h} />;
  const title = typeof action.input.title === 'string' ? action.input.title.trim() : '';
  // 沒做的那行也要看得出是哪一件（清單卡取消勾選時，同一張卡會有好幾行）
  const label = title ? t('{p0}「{p1}」', { p0: tool?.label ?? action.tool, p1: title }) : (tool?.label ?? action.tool);
  const what = action.summary || label;
  const text =
    tool?.kind === 'question'
      ? action.status === 'done'
        ? what
        : t('沒有回答')
      : action.status === 'done'
        ? `✓ ${what}`
        : action.status === 'undone'
          ? t('已復原：{p0}', { p0: what })
          : action.status === 'declined'
            ? t('沒有做：{p0}', { p0: label })
            : action.status === 'skipped'
              ? t('跳過：{p0}（你直接打字了）', { p0: label })
              : t('沒有做成：{p0}', { p0: label }) + (action.note ? t('（{p0}）', { p0: action.note }) : '');
  return (
    <View style={styles.doneRow} testID={`action-${action.id}`}>
      <Text style={[styles.small, action.status === 'failed' ? styles.red : styles.dim, styles.flex]}>{text}</Text>
      {action.status === 'done' && tool?.undo ? <ActionButton text={t('復原')} onPress={() => void h.onUndo(action.id)} /> : null}
      {action.status === 'failed' && (action.result as { error?: string } | null)?.error === 'permission_denied' ? (
        <ActionButton text={t('打開設定')} onPress={() => void Linking.openSettings()} />
      ) : null}
    </View>
  );
}

/**
 * 同一則回答裡有好幾件事要確認：合成一張清單卡，可以取消勾選、修改其中一件，最後一次做完。
 * 做的時候顯示做到第幾件。
 */
export function ActionListCard({
  actions,
  toolFor,
  progress,
  onApproveAll,
  onDeclineAll,
}: {
  actions: Action[];
  toolFor: ToolOf;
  progress: { done: number; total: number } | null;
  onApproveAll: (items: { id: string; edited?: ToolInput }[], skip: string[]) => Promise<void>;
  onDeclineAll: (ids: string[], reason: string) => Promise<void>;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(actions.map((a) => [a.id, true])));
  const [edits, setEdits] = useState<Record<string, ToolInput>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = actions.filter((a) => checked[a.id]);
  const tools = [...new Set(actions.map((a) => a.tool))];
  const single = tools.length === 1 ? toolFor(tools[0]) : undefined;
  const verb =
    chosen.length === 0
      ? t('都不要')
      : single?.verb
        ? t('{p0} {n} 個', { p0: single.verb, n: chosen.length })
        : t('做這 {n} 件', { n: chosen.length });

  const go = async () => {
    setBusy(true);
    try {
      await onApproveAll(
        chosen.map((a) => ({ id: a.id, ...(edits[a.id] ? { edited: edits[a.id] } : {}) })),
        actions.filter((a) => !checked[a.id]).map((a) => a.id)
      );
    } finally {
      setBusy(false);
    }
  };
  const declineAll = async () => {
    setBusy(true);
    try {
      await onDeclineAll(
        actions.map((a) => a.id),
        reason
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card} testID="action-list" accessibilityLabel={t('等你確認：{n} 件事', { n: actions.length })}>
      <Text style={styles.title}>{single ? t('{p0}（{n} 件）', { p0: single.label, n: actions.length }) : t('要做 {n} 件事', { n: actions.length })}</Text>
      {actions.map((a) => {
        const tool = toolFor(a.tool);
        const input = { ...a.input, ...edits[a.id] };
        const on = !!checked[a.id];
        return (
          <View key={a.id} style={styles.item}>
            <View style={styles.itemRow}>
              <Pressable
                onPress={() => setChecked((s) => ({ ...s, [a.id]: !on }))}
                hitSlop={8}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={tool?.describe?.(input) ?? tool?.label ?? a.tool}
                style={styles.itemMain}>
                <Text style={[styles.check, on && { color: C.accent }]}>{on ? '☑' : '☐'}</Text>
                <Text style={[styles.text, styles.flex, !on && styles.off]}>{tool?.describe?.(input) ?? tool?.label ?? a.tool}</Text>
              </Pressable>
              {tool?.fields && editing !== a.id ? <ActionButton text={t('修改')} onPress={() => setEditing(a.id)} /> : null}
            </View>
            {editing === a.id && tool ? (
              <FieldEditor
                indent
                tool={tool}
                input={input}
                done={t('好')}
                onCancel={() => setEditing(null)}
                onDone={(values) => {
                  setEdits((s) => ({ ...s, [a.id]: values }));
                  setEditing(null);
                }}
              />
            ) : null}
          </View>
        );
      })}

      {declining ? (
        <TextInput
          value={reason}
          onChangeText={setReason}
          placeholder={t('要改成怎樣？（可以不填）')}
          placeholderTextColor={C.placeholder}
          style={styles.input}
          // 不自動跳鍵盤（大多數人不寫原因，直接按送出）；鍵盤上的按鍵就是送出
          returnKeyType="send"
          onSubmitEditing={() => !busy && void declineAll()}
          accessibilityLabel={t('要改成怎樣？（可以不填）')}
        />
      ) : null}

      {progress ? (
        <Text style={[styles.small, styles.dim]} accessibilityLiveRegion="polite">
          {t('正在處理第 {p0} 件（共 {p1} 件）', { p0: progress.done + 1, p1: progress.total })}
        </Text>
      ) : (
        <View style={styles.buttons}>
          {declining ? (
            <>
              <ActionButton text={t('返回')} onPress={() => setDeclining(false)} />
              <ActionButton text={t('送出')} primary onPress={() => !busy && void declineAll()} />
            </>
          ) : (
            <>
              {/* 全部取消勾選時主按鈕已經是「都不要」，不再並排一顆「全部不要」 */}
              {chosen.length > 0 ? <ActionButton text={t('全部不要')} onPress={() => setDeclining(true)} /> : null}
              {/* 改到一半：主按鈕先按不了，並說要先按「好」或「取消」（以前按了沒反應） */}
              <ActionButton text={busy ? t('處理中…') : verb} primary disabled={editing !== null} onPress={() => !busy && void (chosen.length === 0 ? declineAll() : go())} />
            </>
          )}
        </View>
      )}
      {editing !== null && !progress ? <Text style={[styles.small, styles.dim]}>{t('先按「好」或「取消」結束修改')}</Text> : null}
    </View>
  );
}

const toText = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** 確認卡上顯示的值：時間改成白話（11/4（週三）15:00），其他照原樣 */
function shown(tool: PhoneTool | undefined, key: string, v: unknown): string {
  const format = tool?.inputSchema.properties[key]?.format;
  if (typeof v !== 'string' || !format) return toText(v);
  const d = parseLocal(v);
  if (isNaN(d.getTime())) return v;
  return fmtEventTime(d, null, format === 'date' || (format === 'date-time' && v.endsWith('T00:00')), getLanguage());
}

/**
 * 時間欄位：iPhone 內建的時間選擇器（跟「行事曆」App 一樣，點日期跳出月曆、點時間跳出滾輪）。
 * 日期、時間分成兩個，排在同一行：iPhone 量日期的寬度比字寬約 40pt（多的是左邊的空白，字靠右），
 * 所以只讓日期那個可以縮（縮掉的是空白），放不下時不會換行、也不會擠出畫面。
 * 值一樣是當地時間的文字（2026-11-04T15:00，只要日期的是 2026-11-04）。
 */
function TimeField({ value, dateOnly, label, onChange }: { value: string; dateOnly: boolean; label: string; onChange: (value: string) => void }) {
  const parsed = parseLocal(value);
  const current = isNaN(parsed.getTime()) ? new Date() : parsed;
  const locale = getLanguage() === 'en' ? 'en-US' : 'zh-TW';
  const pick = (part: 'date' | 'time', picked: Date) => {
    const next = new Date(current);
    if (part === 'date') next.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate());
    else next.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
    if (dateOnly) next.setHours(0, 0, 0, 0);
    onChange(toLocalText(next));
  };
  return (
    <>
      <DateTimePicker style={styles.shrink} value={current} mode="date" display="compact" locale={locale} accessibilityLabel={t('{p0}日期', { p0: label })} onValueChange={(_, d) => pick('date', d)} />
      {dateOnly ? null : (
        <DateTimePicker value={current} mode="time" display="compact" minuteInterval={5} locale={locale} accessibilityLabel={t('{p0}時間', { p0: label })} onValueChange={(_, d) => pick('time', d)} />
      )}
    </>
  );
}

/** 還沒填的時間要加上時：結束接在開始後 1 小時，其他用下一個整點 */
function defaultTime(values: Record<string, string | boolean>): string {
  const start = typeof values.start === 'string' ? parseLocal(values.start) : new Date(NaN);
  if (!isNaN(start.getTime())) return toLocalText(new Date(start.getTime() + 60 * 60 * 1000));
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return toLocalText(d);
}

/** 確認卡上可以改的欄位（文字、數字、是非；時間用時間選擇器） */
function FieldEditor({ tool, input, done, onDone, onCancel, indent }: { tool: PhoneTool; input: ToolInput; done: string; onDone: (values: ToolInput) => void; onCancel: () => void; indent?: boolean }) {
  const fields = Object.entries(tool.fields ?? {});
  const required = new Set(tool.inputSchema.required ?? []);
  // 全天：可能在欄位裡（可以切換），也可能只在 AI 給的輸入裡
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(fields.map(([key]) => [key, tool.inputSchema.properties[key]?.type === 'boolean' ? !!input[key] : toText(input[key])]))
  );
  // 清空的欄位也要送（空字串＝拿掉），不然會用回 AI 原本的值
  const collect = (): ToolInput => {
    const out: ToolInput = {};
    for (const [key] of fields) {
      const v = values[key];
      out[key] = typeof v === 'string' ? v.trim() : v;
    }
    return out;
  };
  // 結束早於開始：當場說，不要等送出後才跳出看不懂的錯誤
  const timeOf = (k: string) => (typeof values[k] === 'string' && values[k] ? parseLocal(String(values[k])).getTime() : NaN);
  const endTooEarly = timeOf('end') < timeOf('start');
  return (
    <View style={[styles.editor, indent && styles.editorIndent]}>
      {fields.map(([key, label]) => {
        const { type, format } = tool.inputSchema.properties[key] ?? {};
        const v = values[key];
        const set = (next: string | boolean) =>
          setValues((s) => {
            // 改開始時結束跟著移，保持原本的長度（跟 iPhone「行事曆」App 一樣）
            if (key === 'start' && typeof next === 'string' && typeof s.start === 'string' && typeof s.end === 'string' && s.end) {
              const [before, after, end] = [s.start, next, s.end].map((x) => parseLocal(x).getTime());
              if (![before, after, end].some(isNaN)) return { ...s, start: next, end: toLocalText(new Date(end + after - before)) };
            }
            return { ...s, [key]: next };
          });
        if (format === 'date-time' || format === 'date') {
          // 全天的行程只選日期；選填的時間可以拿掉、沒填的可以加上
          const text = String(v);
          return (
            <View key={key} style={styles.field}>
              <View style={styles.labelRow}>
                <Text style={[styles.small, styles.dim]}>{label}</Text>
                {text && !required.has(key) ? (
                  <Pressable onPress={() => set('')} accessibilityRole="button" accessibilityLabel={t('拿掉{p0}', { p0: label })} hitSlop={8}>
                    <Text style={[styles.small, styles.link]}>{t('拿掉')}</Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.timeRow}>
                {text ? <TimeField value={text} dateOnly={format === 'date' || ('allDay' in values ? values.allDay : input.allDay) === true} label={label} onChange={set} /> : null}
                {!text ? <ActionButton text={t('加上')} onPress={() => set(defaultTime(values))} /> : null}
              </View>
              {key === 'end' && endTooEarly ? <Text style={[styles.small, styles.red]}>{t('結束要比開始晚')}</Text> : null}
            </View>
          );
        }
        return (
          <View key={key} style={styles.field}>
            <Text style={[styles.small, styles.dim]}>{label}</Text>
            {type === 'boolean' ? (
              <Switch value={!!v} onValueChange={(next) => setValues((s) => ({ ...s, [key]: next }))} accessibilityLabel={label} />
            ) : (
              <TextInput
                value={String(v)}
                onChangeText={(text) => setValues((s) => ({ ...s, [key]: text }))}
                style={styles.input}
                keyboardType={type === 'number' || type === 'integer' ? 'numeric' : 'default'}
                accessibilityLabel={label}
              />
            )}
          </View>
        );
      })}
      <View style={styles.buttons}>
        {/* 「取消」會被誤會成取消整件事：改成「不改了」 */}
        <ActionButton text={t('不改了')} onPress={onCancel} />
        <ActionButton text={done} primary disabled={endTooEarly} onPress={() => onDone(collect())} />
      </View>
    </View>
  );
}

function ActionCard({ action, tool, onApprove, onDecline }: { action: Action; tool: PhoneTool | undefined } & Handlers) {
  const [mode, setMode] = useState<'view' | 'edit' | 'decline'>('view');
  const fields = Object.entries(tool?.fields ?? {});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const verb = tool?.verb ?? t('確定');
  const guessed = new Set(action.guessed);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card} testID={`action-${action.id}`} accessibilityLabel={t('等你確認：{p0}', { p0: tool?.label ?? action.tool })}>
      <Text style={styles.title}>{tool?.label ?? action.tool}</Text>
      {tool?.describe && mode !== 'edit' ? <Text style={styles.text}>{tool.describe(action.input)}</Text> : null}
      {!tool ? <Text style={[styles.small, styles.dim]}>{t('這個 App 版本沒有這個功能。')}</Text> : null}

      {mode === 'view'
        ? fields
            .filter(([key]) => action.input[key] !== undefined && action.input[key] !== '')
            .map(([key, label]) => (
              <Text key={key} style={[styles.small, guessed.has(key) ? styles.guessed : styles.dim]} accessibilityLabel={guessed.has(key) ? t('{p0}：{p1}（AI 猜的）', { p0: label, p1: shown(tool, key, action.input[key]) }) : undefined}>
                {label}：{shown(tool, key, action.input[key])}
              </Text>
            ))
        : null}

      {mode === 'edit' && tool ? (
        <FieldEditor tool={tool} input={action.input} done={busy ? t('處理中…') : verb} onCancel={() => setMode('view')} onDone={(values) => !busy && void run(() => onApprove(action.id, values))} />
      ) : null}

      {mode === 'decline' ? (
        <TextInput
          value={reason}
          onChangeText={setReason}
          placeholder={t('要改成怎樣？（可以不填）')}
          placeholderTextColor={C.placeholder}
          style={styles.input}
          // 不自動跳鍵盤（大多數人不寫原因，直接按送出）；鍵盤上的按鍵就是送出
          returnKeyType="send"
          onSubmitEditing={() => !busy && void run(() => onDecline(action.id, reason))}
          accessibilityLabel={t('要改成怎樣？（可以不填）')}
        />
      ) : null}

      {mode === 'edit' ? null : (
        <View style={styles.buttons}>
          {mode === 'view' ? (
            <>
              <ActionButton text={t('不要')} onPress={() => setMode('decline')} />
              {tool && fields.length > 0 ? <ActionButton text={t('修改')} onPress={() => setMode('edit')} /> : null}
              {tool ? <ActionButton text={busy ? t('處理中…') : verb} primary onPress={() => !busy && void run(() => onApprove(action.id))} /> : null}
            </>
          ) : (
            <>
              <ActionButton text={t('返回')} onPress={() => setMode('view')} />
              <ActionButton text={t('送出')} primary onPress={() => !busy && void run(() => onDecline(action.id, reason))} />
            </>
          )}
        </View>
      )}
    </View>
  );
}

/** AI 問的選擇題：選項按鈕，「自己輸入…」可以自己打字；「不回答」是不顯眼的文字按鈕，跟選項分開 */
function QuestionCard({ action, onApprove, onDecline }: { action: Action } & Handlers) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const question = toText(action.input.question);
  const options = Array.isArray(action.input.options) ? action.input.options : [];
  const answer = async (value: string) => {
    if (busy || !value.trim()) return;
    setBusy(true);
    try {
      await onApprove(action.id, { answer: value.trim() });
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.card} testID={`action-${action.id}`} accessibilityLabel={t('AI 問你：{p0}', { p0: question })}>
      <Text style={styles.text}>{question}</Text>
      {typing ? (
        <>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={t('你的回答')}
            placeholderTextColor={C.placeholder}
            style={styles.input}
            autoFocus
            accessibilityLabel={t('你的回答')}
            onSubmitEditing={() => void answer(text)}
          />
          <View style={styles.buttons}>
            <ActionButton text={t('返回')} onPress={() => setTyping(false)} />
            <ActionButton text={t('送出')} primary onPress={() => void answer(text)} />
          </View>
        </>
      ) : (
        <View style={styles.buttons}>
          {options.map((o) => (
            <ActionButton key={o} text={o} onPress={() => void answer(o)} />
          ))}
          <ActionButton text={t('自己輸入…')} onPress={() => setTyping(true)} />
          <Pressable onPress={() => !busy && void onDecline(action.id, '')} accessibilityRole="button" hitSlop={12} style={styles.skip}>
            <Text style={[styles.small, styles.dim]}>{t('不回答')}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 6, padding: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator, backgroundColor: C.bg },
  title: { ...TEXT.small, color: C.label, fontWeight: '700' },
  text: { ...TEXT.body, color: C.label },
  small: { ...TEXT.small },
  dim: { color: C.secondary },
  off: { color: C.tertiary, textDecorationLine: 'line-through' },
  guessed: { color: C.tertiary, fontStyle: 'italic' },
  red: { color: C.errorText },
  flex: { flex: 1 },
  field: { gap: 2 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  link: { color: C.accent },
  skip: { justifyContent: 'center', paddingHorizontal: 6 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  shrink: { flexShrink: 1 },
  editor: { gap: 6 },
  // 清單卡裡的編輯區跟項目文字對齊（勾選框右邊）；單張卡不用多縮
  editorIndent: { paddingLeft: 24 },
  // 輸入框不設 lineHeight：iOS 的 TextInput 設了 lineHeight 字會偏下
  input: { fontFamily: TEXT.body.fontFamily, fontSize: TEXT.body.fontSize, color: C.label, borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  item: { gap: 6 },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  itemMain: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  check: { ...TEXT.body, color: C.secondary },
});
