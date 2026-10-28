import { useSyncExternalStore } from 'react';

import type { ChatState, ChatStore } from './chatStore';

/** 畫面讀取聊天狀態；狀態一變就重畫 */
export function useChatState(store: ChatStore): ChatState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
