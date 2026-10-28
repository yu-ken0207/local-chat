import { Lexer, type Token, type Tokens } from 'marked';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { C, MONO, TEXT } from '../ui/theme';

// 把 Markdown 畫成原生元件。串流時文字一直變長，每次重新解析（有 useMemo，內容沒變就不重算）。

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);

type Props = {
  text: string;
  /** 按程式碼區塊的「複製」 */
  onCopyCode?: (code: string) => void;
  /** 整段文字用淡色（例如思考過程） */
  dim?: boolean;
};

export const Markdown = memo(function Markdown({ text, onCopyCode, dim }: Props) {
  const tokens = useMemo(() => Lexer.lex(text), [text]);
  const base: TextStyle = { ...TEXT.body, color: dim ? C.secondary : C.label };
  return <View style={styles.blocks}>{blocks(tokens, { base, onCopyCode })}</View>;
});

type Ctx = { base: TextStyle; onCopyCode?: (code: string) => void };

function blocks(tokens: Token[], ctx: Ctx, keyPrefix = 'b'): ReactNode[] {
  return tokens.map((t, i) => block(t, ctx, `${keyPrefix}${i}`)).filter((n) => n !== null);
}

function block(t: Token, ctx: Ctx, key: string): ReactNode {
  switch (t.type) {
    case 'space':
    case 'def':
      return null;
    case 'paragraph':
    case 'text': {
      const tok = t as Tokens.Paragraph | Tokens.Text;
      return (
        <Text key={key} style={ctx.base} selectable>
          {tok.tokens ? inline(tok.tokens, ctx) : decode(tok.text)}
        </Text>
      );
    }
    case 'heading': {
      const h = t as Tokens.Heading;
      return (
        <Text key={key} style={[ctx.base, styles.heading]} selectable accessibilityRole="header">
          <Text style={styles.headingMark}>{'#'.repeat(h.depth)} </Text>
          {inline(h.tokens, ctx)}
        </Text>
      );
    }
    case 'code':
      return <CodeBlock key={key} code={(t as Tokens.Code).text} lang={(t as Tokens.Code).lang ?? ''} onCopy={ctx.onCopyCode} />;
    case 'blockquote':
      return (
        <View key={key} style={styles.quote}>
          {blocks((t as Tokens.Blockquote).tokens, { ...ctx, base: { ...ctx.base, color: C.secondary } }, key)}
        </View>
      );
    case 'list': {
      const list = t as Tokens.List;
      const start = typeof list.start === 'number' ? list.start : 1;
      return (
        <View key={key} style={styles.list}>
          {list.items.map((item, i) => (
            <View key={`${key}-${i}`} style={styles.listItem}>
              <Text style={[ctx.base, styles.bullet]}>
                {item.task ? (item.checked ? '☑' : '☐') : list.ordered ? `${start + i}.` : '-'}
              </Text>
              <View style={styles.listBody}>{blocks(item.tokens.filter((x) => x.type !== 'checkbox'), ctx, `${key}-${i}-`)}</View>
            </View>
          ))}
        </View>
      );
    }
    case 'table':
      return <Table key={key} table={t as Tokens.Table} ctx={ctx} />;
    case 'hr':
      return <View key={key} style={styles.hr} />;
    case 'html':
      return (
        <Text key={key} style={[ctx.base, { color: C.secondary }]} selectable>
          {(t as Tokens.HTML).text.trim()}
        </Text>
      );
    default:
      return 'text' in t && typeof t.text === 'string' ? (
        <Text key={key} style={ctx.base} selectable>
          {decode(t.text)}
        </Text>
      ) : null;
  }
}

function inline(tokens: Token[], ctx: Ctx): ReactNode[] {
  return tokens.map((t, i) => {
    switch (t.type) {
      case 'text':
      case 'escape': {
        const tok = t as Tokens.Text;
        return tok.tokens ? <Text key={i}>{inline(tok.tokens, ctx)}</Text> : decode(tok.text);
      }
      case 'strong':
        return (
          <Text key={i} style={styles.strong}>
            {inline((t as Tokens.Strong).tokens, ctx)}
          </Text>
        );
      case 'em':
        return (
          <Text key={i} style={styles.em}>
            {inline((t as Tokens.Em).tokens, ctx)}
          </Text>
        );
      case 'del':
        return (
          <Text key={i} style={styles.del}>
            {inline((t as Tokens.Del).tokens, ctx)}
          </Text>
        );
      case 'codespan':
        return (
          <Text key={i} style={styles.codespan}>
            {decode((t as Tokens.Codespan).text)}
          </Text>
        );
      case 'br':
        return '\n';
      case 'link': {
        const link = t as Tokens.Link;
        return (
          <Text key={i} style={styles.link} onPress={() => Linking.openURL(link.href)} accessibilityRole="link">
            {inline(link.tokens, ctx)}
          </Text>
        );
      }
      case 'image': {
        const img = t as Tokens.Image;
        return (
          <Text key={i} style={styles.link} onPress={() => Linking.openURL(img.href)}>
            [圖片：{img.text || img.href}]
          </Text>
        );
      }
      default:
        return 'text' in t && typeof t.text === 'string' ? decode(t.text) : '';
    }
  });
}

function CodeBlock({ code, lang, onCopy }: { code: string; lang: string; onCopy?: (code: string) => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <View style={styles.code}>
      <View style={styles.codeHeader}>
        <Text style={styles.codeLang}>{lang || 'code'}</Text>
        {onCopy && (
          <Pressable
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="複製程式碼"
            onPress={() => {
              onCopy(code);
              setCopied(true);
            }}
            style={({ pressed }) => pressed && styles.pressed}>
            <Text style={styles.codeCopy}>{copied ? '已複製' : '複製'}</Text>
          </Pressable>
        )}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={styles.codeText} selectable>
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}

function Table({ table, ctx }: { table: Tokens.Table; ctx: Ctx }) {
  const cell = (c: Tokens.TableCell, header: boolean, key: string) => (
    <View key={key} style={[styles.cell, header && styles.headerCell]}>
      <Text style={[ctx.base, header && styles.strong, { textAlign: c.align ?? 'left' }]} selectable>
        {inline(c.tokens, ctx)}
      </Text>
    </View>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={styles.table}>
        <View style={styles.row}>{table.header.map((c, i) => cell(c, true, `h${i}`))}</View>
        {table.rows.map((r, ri) => (
          <View key={`r${ri}`} style={styles.row}>
            {r.map((c, ci) => cell(c, false, `r${ri}-${ci}`))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  blocks: { gap: 10 },
  heading: { fontWeight: '700' },
  headingMark: { color: C.secondary },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  codespan: { fontFamily: MONO, backgroundColor: C.surface, color: C.accent },
  link: { color: C.accent, textDecorationLine: 'underline' },
  quote: { borderLeftWidth: 2, borderLeftColor: C.separator, paddingLeft: 10, gap: 8 },
  list: { gap: 4 },
  listItem: { flexDirection: 'row', gap: 8 },
  bullet: { color: C.secondary, minWidth: 14 },
  listBody: { flex: 1, gap: 4 },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginVertical: 4 },
  code: { backgroundColor: C.surface, borderRadius: 8, overflow: 'hidden' },
  codeHeader: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 10, paddingTop: 6 },
  codeLang: { ...TEXT.meta, color: C.secondary },
  codeCopy: { ...TEXT.meta, color: C.accent, fontWeight: '600' },
  codeText: { fontFamily: MONO, fontSize: 13, lineHeight: 19, color: C.label, padding: 10 },
  pressed: { opacity: 0.4 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator, borderRadius: 6 },
  row: { flexDirection: 'row' },
  cell: { minWidth: 80, maxWidth: 220, padding: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: C.separator },
  headerCell: { backgroundColor: C.surface },
});
