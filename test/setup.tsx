// 畫面測試用：把 Expo Go 內建的原生元件換成簡單的替身
jest.mock('expo-symbols', () => {
  const { View } = jest.requireActual('react-native');
  return { SymbolView: ({ name, ...rest }: any) => <View testID={`symbol-${name}`} {...rest} /> };
});

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

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
