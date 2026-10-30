import { DynamicColorIOS, Platform, PlatformColor, type ColorValue } from 'react-native';

// 外觀參考 Codex 終端介面：等寬字、› 是使用者、• 是 AI、次要資訊用淡色；顏色用 iOS 系統色，自動跟著深淺色模式。

export const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

const ios = (name: string, fallback: string): ColorValue => (Platform.OS === 'ios' ? PlatformColor(name) : fallback);
const dynamic = (light: string, dark: string): ColorValue => (Platform.OS === 'ios' ? DynamicColorIOS({ light, dark }) : light);

export const C = {
  bg: ios('systemBackground', '#ffffff'),
  surface: ios('secondarySystemBackground', '#f2f2f7'),
  groupedBg: ios('systemGroupedBackground', '#f2f2f7'),
  groupedCard: ios('secondarySystemGroupedBackground', '#ffffff'),
  label: ios('label', '#000000'),
  secondary: ios('secondaryLabel', '#3c3c4399'),
  tertiary: ios('tertiaryLabel', '#3c3c434d'),
  placeholder: ios('placeholderText', '#3c3c434d'),
  separator: ios('separator', '#3c3c434a'),
  pressed: ios('systemGray5', '#e5e5ea'),
  red: ios('systemRed', '#ff3b30'),
  green: ios('systemGreen', '#34c759'),
  orange: ios('systemOrange', '#ff9500'),
  /** 唯一的強調色：送出、選取、勾選、連結 */
  accent: dynamic('#c96442', '#e0896b'),
  /** 強調色當實心底、上面放白字時用：深淺色都用 #c96442（深色模式的 #e0896b 配白字只有 2.6:1） */
  accentFill: '#c96442',
  /** 實心底上放一般大小白字（整段內文、小字選項）：再深一點才有 4.6:1（#c96442 只有 3.9:1，只夠粗體大字） */
  accentFillStrong: '#B85A3A',
  /** 反白提示框（底色是 label：淺色黑、深色白）上的強調色：兩邊都要夠清楚 */
  accentOnInverse: dynamic('#e0896b', '#c96442'),
  /** 當文字用的橘、紅：Apple 高對比版本，小字也夠清楚（系統橘當字只有 2.2:1、系統紅 3.6:1） */
  warnText: dynamic('#C93400', '#FF9F0A'),
  errorText: dynamic('#D70015', '#FF6961'),
};

export const TEXT = {
  body: { fontFamily: MONO, fontSize: 15, lineHeight: 23 },
  small: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  meta: { fontFamily: MONO, fontSize: 12, lineHeight: 16 },
} as const;
