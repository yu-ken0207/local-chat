import { Asset } from 'expo-asset';

import type { PromptShard } from './catalog';
import { PROMPT_SHARDS } from './shards';

/** 從 App 裡的檔案讀一個角色原文分片（開發時從 Metro 下載，正式版讀 App 內的檔案） */
export async function loadShard(index: number): Promise<PromptShard> {
  const asset = Asset.fromModule(PROMPT_SHARDS[index]);
  await asset.downloadAsync();
  const res = await fetch(asset.localUri ?? asset.uri);
  return JSON.parse(await res.text()) as PromptShard;
}
