import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';

import type { PromptShard } from './catalog';
import { PROMPT_SHARDS } from './shards';

/** 從 App 裡的檔案讀一個角色原文分片（開發時從 Metro 下載到暫存，正式版讀 App 內的檔案） */
export async function loadShard(index: number): Promise<PromptShard> {
  const asset = Asset.fromModule(PROMPT_SHARDS[index]);
  await asset.downloadAsync();
  const text = asset.localUri ? await new File(asset.localUri).text() : await (await fetch(asset.uri)).text();
  return JSON.parse(text) as PromptShard;
}
