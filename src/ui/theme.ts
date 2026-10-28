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
};

export const TEXT = {
  body: { fontFamily: MONO, fontSize: 15, lineHeight: 23 },
  small: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  meta: { fontFamily: MONO, fontSize: 12, lineHeight: 16 },
} as const;
