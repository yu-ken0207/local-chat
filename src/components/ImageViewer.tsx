import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { dataUri } from '../lib/photos';
import type { Attachment } from '../store/repo';
import { MONO } from '../ui/theme';
import { t } from '../i18n';

/**
 * 全螢幕看照片；多張可以左右滑。雙指放大（iOS 內建的縮放），往下拉放手就關（跟「照片」App 一樣）。
 * 點一下不關：想放大時常常會先點到
 */
export function ImageViewer({ images, index, onClose }: { images: Attachment[] | null; index: number; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState(index);
  if (!images) return null;
  return (
    <Modal visible animationType="fade" presentationStyle="overFullScreen" transparent onRequestClose={onClose} onShow={() => setPage(index)}>
      <View style={styles.backdrop}>
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          contentOffset={{ x: index * width, y: 0 }}
          onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}>
          {images.map((img, i) => (
            <ScrollView
              key={img.id}
              testID={`photo-zoom-${i}`}
              style={{ width, height }}
              maximumZoomScale={4}
              minimumZoomScale={1}
              centerContent
              alwaysBounceVertical
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
              onScrollEndDrag={(e) => {
                // 沒放大時往下拉超過 80pt 放手：關閉
                if ((e.nativeEvent.zoomScale ?? 1) <= 1 && e.nativeEvent.contentOffset.y < -80) onClose();
              }}>
              <Image source={{ uri: dataUri(img.base64) }} style={{ width, height }} resizeMode="contain" accessibilityLabel={t('照片 {p0}', { p0: i + 1 })} />
            </ScrollView>
          ))}
        </ScrollView>
        <View style={[styles.top, { top: insets.top + 8 }]}>
          <Text style={styles.counter}>{images.length > 1 ? `${page + 1} / ${images.length}` : ''}</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('關閉')}>
            <SymbolView name="xmark.circle.fill" size={30} tintColor="rgba(255,255,255,0.85)" />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'black' },
  top: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  counter: { fontFamily: MONO, fontSize: 13, color: 'rgba(255,255,255,0.85)' },
});
