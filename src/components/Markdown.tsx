import { Lexer, type Token, type Tokens } from 'marked';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { C, MONO, TEXT } from '../ui/theme';
import { t } from '../i18n';

// 把 Markdown 畫成原生元件。串流時文字一直變長，每次重新解析（有 useMemo，內容沒變就不重算）。

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);

type Props = {
  text: string;
  /** 按程式碼區塊的「複製」 */
  onCopyCode?: (code: string) => void;
  /** 整段文字用淡色（例如思考過程） */
  dim?: boolean;
  /** 點一下、長按左右捲的區塊（程式碼、表格）時要做的事，跟外面整則訊息一樣；原因見 HScroll */
  onPress?: () => void;
  onLongPress?: () => void;
};

export const Markdown = memo(function Markdown({ text, onCopyCode, dim, onPress, onLongPress }: Props) {
  const tokens = useMemo(() => Lexer.lex(text), [text]);
  const base: TextStyle = { ...TEXT.body, color: dim ? C.secondary : C.label };
  return <View style={styles.blocks}>{blocks(tokens, { base, onCopyCode, onPress, onLongPress })}</View>;
});

type Ctx = { base: TextStyle; onCopyCode?: (code: string) => void; onPress?: () => void; onLongPress?: () => void };

function blocks(tokens: Token[], ctx: Ctx, keyPrefix = 'b'): ReactNode[] {
  return tokens.map((t, i) => block(t, ctx, `${keyPrefix}${i}`)).filter((n) => n !== null);
}

function block(token: Token, ctx: Ctx, key: string): ReactNode {
  switch (token.type) {
    case 'space':
    case 'def':
      return null;
    case 'paragraph':
    case 'text': {
      const tok = token as Tokens.Paragraph | Tokens.Text;
      return (
        <Text key={key} style={ctx.base} selectable>
          {tok.tokens ? inline(tok.tokens, ctx) : decode(tok.text)}
        </Text>
      );
    }
    case 'heading': {
      const h = token as Tokens.Heading;
      return (
        <Text key={key} style={[ctx.base, styles.heading]} selectable accessibilityRole="header">
          <Text style={styles.headingMark}>{'#'.repeat(h.depth)} </Text>
          {inline(h.tokens, ctx)}
        </Text>
      );
    }
    case 'code':
      return <CodeBlock key={key} code={(token as Tokens.Code).text} lang={(token as Tokens.Code).lang ?? ''} ctx={ctx} />;
    case 'blockquote':
      return (
        <View key={key} style={styles.quote}>
          {blocks((token as Tokens.Blockquote).tokens, { ...ctx, base: { ...ctx.base, color: C.secondary } }, key)}
        </View>
      );
    case 'list': {
      const list = token as Tokens.List;
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
      return <Table key={key} table={token as Tokens.Table} ctx={ctx} />;
    case 'hr':
      return <View key={key} style={styles.hr} />;
    case 'html':
      return (
        <Text key={key} style={[ctx.base, { color: C.secondary }]} selectable>
          {(token as Tokens.HTML).text.trim()}
        </Text>
      );
    default:
      return 'text' in token && typeof token.text === 'string' ? (
        <Text key={key} style={ctx.base} selectable>
          {decode(token.text)}
        </Text>
      ) : null;
  }
}

function inline(tokens: Token[], ctx: Ctx): ReactNode[] {
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'text':
      case 'escape': {
        const tok = token as Tokens.Text;
        return tok.tokens ? <Text key={i}>{inline(tok.tokens, ctx)}</Text> : decode(tok.text);
      }
      case 'strong':
        return (
          <Text key={i} style={styles.strong}>
            {inline((token as Tokens.Strong).tokens, ctx)}
          </Text>
        );
      case 'em':
        return (
          <Text key={i} style={styles.em}>
            {inline((token as Tokens.Em).tokens, ctx)}
          </Text>
        );
      case 'del':
        return (
          <Text key={i} style={styles.del}>
            {inline((token as Tokens.Del).tokens, ctx)}
          </Text>
        );
      case 'codespan':
        return (
          <Text key={i} style={styles.codespan}>
            {decode((token as Tokens.Codespan).text)}
          </Text>
        );
      case 'br':
        return '\n';
      case 'link': {
        const link = token as Tokens.Link;
        return (
          <Text key={i} style={styles.link} onPress={() => Linking.openURL(link.href)} accessibilityRole="link">
            {inline(link.tokens, ctx)}
          </Text>
        );
      }
      case 'image': {
        const img = token as Tokens.Image;
        return (
          <Text key={i} style={styles.link} onPress={() => Linking.openURL(img.href)}>
            {t('[圖片：{name}]', { name: img.text || img.href })}
          </Text>
        );
      }
      default:
        return 'text' in token && typeof token.text === 'string' ? decode(token.text) : '';
    }
  });
}

function CodeBlock({ code, lang, ctx }: { code: string; lang: string; ctx: Ctx }) {
  const onCopy = ctx.onCopyCode;
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
            hitSlop={13}
            accessibilityRole="button"
            accessibilityLabel={t('複製程式碼')}
            onPress={() => {
              onCopy(code);
              setCopied(true);
            }}
            style={({ pressed }) => pressed && styles.pressed}>
            <Text style={styles.codeCopy}>{copied ? t('已複製') : t('複製')}</Text>
          </Pressable>
        )}
      </View>
      {/* 字不設 selectable：iOS 會在字上加長按選取，跟長按訊息的選單打架；要複製用右上角的「複製」 */}
      <HScroll ctx={ctx}>
        <Text style={styles.codeText}>{code}</Text>
      </HScroll>
    </View>
  );
}

function Table({ table, ctx }: { table: Tokens.Table; ctx: Ctx }) {
  const cell = (c: Tokens.TableCell, header: boolean, key: string) => (
    <View key={key} style={[styles.cell, header && styles.headerCell]}>
      {/* 不設 selectable（原因同程式碼區塊）；要複製就長按訊息選「複製」 */}
      <Text style={[ctx.base, header && styles.strong, { textAlign: c.align ?? 'left' }]}>
        {inline(c.tokens, ctx)}
      </Text>
    </View>
  );
  return (
    <HScroll ctx={ctx}>
      <View style={styles.table}>
        <View style={styles.row}>{table.header.map((c, i) => cell(c, true, `h${i}`))}</View>
        {table.rows.map((r, ri) => (
          <View key={`r${ri}`} style={styles.row}>
            {r.map((c, ci) => cell(c, false, `r${ri}-${ci}`))}
          </View>
        ))}
      </View>
    </HScroll>
  );
}

/**
 * 左右捲的區塊。裡面要有自己的 Pressable 先接住手指：外面整則訊息是 Pressable，
 * 手指一按下它就成了 JS responder，而 iOS 的 RN 只要看到捲動的「祖先」是 responder，
 * 就不讓這個捲動動（RCTScrollViewComponentView 的 _shouldDisableScrollInteraction），左右滑全被外層上下捲接走。
 * 改由捲動「裡面」的 Pressable 接手，祖先就不是 responder；點一下、長按照樣做訊息那邊的事。
 */
function HScroll({ ctx, children }: { ctx: Ctx; children: ReactNode }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <Pressable accessible={false} onPress={ctx.onPress} onLongPress={ctx.onLongPress} delayLongPress={350}>
        {children}
      </Pressable>
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
