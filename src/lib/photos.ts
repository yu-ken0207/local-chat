import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import type { Attachment } from '../store/repo';

/** 照片長邊縮到這個大小再送，4G 上傳比較快，模型也看得清楚 */
export const MAX_SIDE = 1024;
/** 一則訊息最多附幾張 */
export const MAX_PHOTOS = 4;

/** 等比例縮小後的尺寸；本來就夠小就不動 */
export function fitSize(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max || longest <= 0) return { width, height };
  const scale = max / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export type NewPhoto = Omit<Attachment, 'id'>;

/** 縮小並轉成 base64 JPEG（手機上才能跑） */
export async function shrinkPhoto(uri: string, width: number, height: number): Promise<NewPhoto> {
  const ctx = ImageManipulator.manipulate(uri);
  const size = fitSize(width, height);
  if (size.width !== width || size.height !== height) ctx.resize(size);
  const image = await ctx.renderAsync();
  const out = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
  return { base64: out.base64!, width: out.width, height: out.height };
}

/** 拍照，或從相簿選（可以一次選多張） */
export async function pickPhotos(source: 'camera' | 'library', limit: number): Promise<NewPhoto[] | 'denied'> {
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return 'denied';
  }
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'] })
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: limit > 1,
          selectionLimit: limit,
          orderedSelection: true,
        });
  if (result.canceled) return [];
  return Promise.all(result.assets.slice(0, limit).map((a) => shrinkPhoto(a.uri, a.width, a.height)));
}

export const dataUri = (base64: string) => `data:image/jpeg;base64,${base64}`;
