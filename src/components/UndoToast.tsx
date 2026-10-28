import type { ChatStore } from '../state/chatStore';
import { useChatState } from '../state/useChat';
import { Toast } from './Toast';
import { t } from '../i18n';

/** 「已刪除・復原」：顯示控制器裡剛做的可復原操作；時間到就確定 */
export function UndoToast({ store }: { store: ChatStore }) {
  const { undo } = useChatState(store);
  return (
    <Toast
      toast={undo ? { id: undo.id, text: undo.message, action: { text: t('復原'), onPress: () => void store.undoLast() } } : null}
      onDone={() => void store.dismissUndo()}
    />
  );
}
