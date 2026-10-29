import { useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import type { PhoneTool, ToolInput } from '../lib/tools';
import type { Action } from '../store/repo';
import { C, TEXT } from '../ui/theme';
import { ActionButton } from './Messages';
import { t } from '../i18n';

type Handlers = {
  onApprove: (id: string, edited?: ToolInput) => Promise<void>;
  onDecline: (id: string, reason: string) => Promise<void>;
  onUndo: (id: string) => Promise<void>;
};

/**
 * AI 要做的一件事：還沒確認時是確認卡（放在對話裡，App 關掉再開也還在）；
 * 做完之後縮成一行（做了什麼、可以復原）。
 */
export function ActionView({ action, tool, ...h }: { action: Action; tool: PhoneTool | undefined } & Handlers) {
  if (action.status === 'pending') return <ActionCard action={action} tool={tool} {...h} />;
  const label = tool?.label ?? action.tool;
  const what = action.summary || label;
  const text =
    action.status === 'done'
      ? `✓ ${what}`
      : action.status === 'undone'
        ? t('已復原：{p0}', { p0: what })
        : action.status === 'declined'
          ? t('沒有做：{p0}', { p0: label })
          : t('沒有做成：{p0}', { p0: label }) + (action.note ? t('（{p0}）', { p0: action.note }) : '');
  return (
    <View style={styles.doneRow} testID={`action-${action.id}`}>
      <Text style={[styles.small, action.status === 'failed' ? styles.red : styles.dim, styles.flex]}>{text}</Text>
      {action.status === 'done' && tool?.undo ? <ActionButton text={t('復原')} onPress={() => void h.onUndo(action.id)} /> : null}
    </View>
  );
}

const toText = (v: unknown) => (v === undefined || v === null ? '' : String(v));

function ActionCard({ action, tool, onApprove, onDecline }: { action: Action; tool: PhoneTool | undefined } & Handlers) {
  const [mode, setMode] = useState<'view' | 'edit' | 'decline'>('view');
  const fields = Object.entries(tool?.fields ?? {});
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(fields.map(([key]) => [key, tool?.inputSchema.properties[key]?.type === 'boolean' ? !!action.input[key] : toText(action.input[key])]))
  );
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
  const edited = (): ToolInput => {
    const out: ToolInput = {};
    for (const [key] of fields) {
      const v = values[key];
      if (typeof v === 'boolean' || v.trim() !== '') out[key] = typeof v === 'string' ? v.trim() : v;
    }
    return out;
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
              <Text key={key} style={[styles.small, guessed.has(key) ? styles.guessed : styles.dim]} accessibilityLabel={guessed.has(key) ? t('{p0}：{p1}（AI 猜的）', { p0: label, p1: toText(action.input[key]) }) : undefined}>
                {label}：{toText(action.input[key])}
              </Text>
            ))
        : null}

      {mode === 'edit'
        ? fields.map(([key, label]) => {
            const type = tool?.inputSchema.properties[key]?.type;
            const v = values[key];
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
          })
        : null}

      {mode === 'decline' ? (
        <TextInput
          value={reason}
          onChangeText={setReason}
          placeholder={t('要改成怎樣？（可以不填）')}
          placeholderTextColor={C.placeholder}
          style={styles.input}
          autoFocus
          accessibilityLabel={t('要改成怎樣？（可以不填）')}
        />
      ) : null}

      <View style={styles.buttons}>
        {mode === 'view' ? (
          <>
            <ActionButton text={t('不要')} onPress={() => setMode('decline')} />
            {tool && fields.length > 0 ? <ActionButton text={t('修改')} onPress={() => setMode('edit')} /> : null}
            {tool ? <ActionButton text={busy ? t('處理中…') : verb} primary onPress={() => !busy && void run(() => onApprove(action.id))} /> : null}
          </>
        ) : mode === 'edit' ? (
          <>
            <ActionButton text={t('取消')} onPress={() => setMode('view')} />
            <ActionButton text={busy ? t('處理中…') : verb} primary onPress={() => !busy && void run(() => onApprove(action.id, edited()))} />
          </>
        ) : (
          <>
            <ActionButton text={t('返回')} onPress={() => setMode('view')} />
            <ActionButton text={t('送出')} primary onPress={() => !busy && void run(() => onDecline(action.id, reason))} />
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 6, padding: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator, backgroundColor: C.bg },
  title: { ...TEXT.small, color: C.label, fontWeight: '700' },
  text: { ...TEXT.body, color: C.label },
  small: { ...TEXT.small },
  dim: { color: C.secondary },
  guessed: { color: C.tertiary, fontStyle: 'italic' },
  red: { color: C.red },
  flex: { flex: 1 },
  field: { gap: 2 },
  input: { ...TEXT.body, color: C.label, borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
