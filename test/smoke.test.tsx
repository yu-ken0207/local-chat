import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

test('元件測試環境可以用', async () => {
  await render(<Text>你好</Text>);
  expect(screen.getByText('你好')).toBeTruthy();
});
