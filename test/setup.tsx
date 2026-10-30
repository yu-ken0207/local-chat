// 畫面測試用：把 Expo Go 內建的原生元件換成簡單的替身
jest.mock('expo-symbols', () => {
  const { View } = jest.requireActual('react-native');
  return { SymbolView: ({ name, ...rest }: any) => <View testID={`symbol-${name}`} {...rest} /> };
});

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

// 鍵盤跟手的元件：測試裡換成一般的 ScrollView／View（套件附的替身）
jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(),
  notificationAsync: jest.fn(),
  impactAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));


jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => {}), isAvailableAsync: jest.fn(async () => true) }));

jest.mock('expo-camera', () => {
  const { View } = require('react-native');
  return {
    CameraView: (props: any) => <View {...props} />,
    useCameraPermissions: () => [{ granted: true, canAskAgain: true }, jest.fn(async () => ({ granted: true }))],
  };
});
jest.mock('expo-secure-store', () => {
  const map = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => map.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void map.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void map.delete(k)),
  };
});
jest.mock('expo-device', () => ({ deviceName: '測試 iPhone', modelName: 'iPhone 15' }));
// 時間選擇器：測試用 fireEvent(元件, 'valueChange', 新的時間) 模擬選了一個時間；mode 放在 accessibilityHint 方便檢查
jest.mock('@react-native-community/datetimepicker', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: (p: any) => <View accessibilityLabel={p.accessibilityLabel} accessibilityHint={p.mode} {...({ value: p.value } as any)} onValueChange={(d: Date) => p.onValueChange?.({ type: 'set' }, d)} />,
  };
});

// 討論串卡片後面墊的原對話截圖：測試裡沒有原生截圖，給一個假的檔案位址
jest.mock('react-native-view-shot', () => ({ captureScreen: jest.fn(async () => 'file:///tmp/shot.jpg'), releaseCapture: jest.fn() }));
