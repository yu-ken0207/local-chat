import { Image, StyleSheet, Text, View } from 'react-native';

import { AVATARS } from '../agents/avatars';

// Agent 的頭像：相簿照片 > 像素頭像（圖鑑 788 個角色各一張，用本地生圖模型生的）> emoji 加底色。底色依 id 固定，同一個人永遠同一個顏色

const PALETTE = ['#F4D9C6', '#D9E8D3', '#D6E4F0', '#EBDDF2', '#F6E7B8', '#F2D4D7', '#D3EDEA', '#E4E0D6'];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// 頭像用的 id（store 也要用，放在 catalog）
export { EMOJI_AVATAR, avatarId } from '../agents/catalog';

/** 這個 id 有沒有像素頭像 */
export const hasPixelAvatar = (id: string) => id in AVATARS;

export function AgentAvatar({ id, emoji, photo, size = 32 }: { id: string; emoji: string; photo?: string | null; size?: number }) {
  const box = { width: size, height: size, borderRadius: size / 2 };
  if (photo) return <Image source={{ uri: `data:image/jpeg;base64,${photo}` }} style={box} accessibilityIgnoresInvertColors />;
  const pixel = AVATARS[id];
  if (pixel) return <Image source={pixel} style={[box, { backgroundColor: PALETTE[hash(id) % PALETTE.length] }]} accessibilityIgnoresInvertColors testID={`avatar-${id}`} />;
  return (
    <View style={[styles.circle, box, { backgroundColor: PALETTE[hash(id) % PALETTE.length] }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Text style={{ fontSize: size * 0.55, lineHeight: size * 0.7 }} allowFontScaling={false}>
        {emoji || '🙂'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
});
