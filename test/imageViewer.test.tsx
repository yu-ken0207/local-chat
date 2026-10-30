import { fireEvent, render, screen } from '@testing-library/react-native';

import { ImageViewer } from '../src/components/ImageViewer';

const photo = { id: 'p1', base64: 'AAAA', width: 10, height: 10 };
const drag = (y: number, zoomScale = 1) => ({ nativeEvent: { contentOffset: { x: 0, y }, zoomScale } });

test('看大圖：雙指可以放大；往下拉超過一段放手才關，點一下不關', async () => {
  const onClose = jest.fn();
  await render(<ImageViewer images={[photo]} index={0} onClose={onClose} />);
  const page = screen.getByTestId('photo-zoom-0');
  expect(page.props.maximumZoomScale).toBe(4);
  await fireEvent(page, 'scrollEndDrag', drag(-20));
  expect(onClose).not.toHaveBeenCalled();
  // 放大中往下拉是在移動照片，不關
  await fireEvent(page, 'scrollEndDrag', drag(-120, 2));
  expect(onClose).not.toHaveBeenCalled();
  await fireEvent(page, 'scrollEndDrag', drag(-120));
  expect(onClose).toHaveBeenCalledTimes(1);
});
