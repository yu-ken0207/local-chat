import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking, StyleSheet } from 'react-native';

import { Markdown } from '../src/components/Markdown';

const allText = () => screen.toJSON() && JSON.stringify(screen.toJSON());

describe('Markdown', () => {
  test('標題保留 # 符號、粗體斜體刪除線、行內程式碼', async () => {
    await render(<Markdown text={'## 結論\n\n這是 **重點**、*強調*、~~刪掉~~ 和 `code`。'} />);
    expect(screen.getByRole('header')).toBeTruthy();
    const json = allText();
    expect(json).toContain('"##"');
    expect(json).toContain('結論');
    for (const s of ['重點', '強調', '刪掉', 'code']) expect(json).toContain(s);
  });

  test('有序、無序、巢狀清單、待辦清單', async () => {
    await render(<Markdown text={'1. 第一\n2. 第二\n   - 子項目\n\n- [x] 完成\n- [ ] 未完成'} />);
    const json = allText();
    for (const s of ['1.', '2.', '第一', '第二', '子項目', '☑', '☐', '完成', '未完成']) expect(json).toContain(s);
  });

  test('程式碼區塊：顯示語言，按複製會把程式碼交出去並顯示已複製', async () => {
    const onCopy = jest.fn();
    await render(<Markdown text={'```python\nprint("hi")\n```'} onCopyCode={onCopy} />);
    expect(screen.getByText('python')).toBeTruthy();
    expect(screen.getByText('print("hi")')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('複製程式碼'));
    expect(onCopy).toHaveBeenCalledWith('print("hi")');
    expect(await screen.findByText('已複製')).toBeTruthy();
  });

  test('表格', async () => {
    await render(<Markdown text={'| 模型 | 速度 |\n|---|---:|\n| 31b | 42 |\n| 12b | 57 |'} />);
    for (const s of ['模型', '速度', '31b', '42', '12b', '57']) expect(screen.getByText(s)).toBeTruthy();
  });

  test('連結點了會開瀏覽器；HTML 字元正確顯示', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await render(<Markdown text={'看 [文件](https://docs.expo.dev) & a < b'} />);
    fireEvent.press(screen.getByRole('link'));
    expect(open).toHaveBeenCalledWith('https://docs.expo.dev');
    expect(allText()).toContain('& a < b');
  });

  test('串流中不完整的 Markdown 也不會壞掉', async () => {
    await render(<Markdown text={'**還沒結束的粗體\n```js\nconst a'} />);
    expect(allText()).toContain('還沒結束的粗體');
    expect(allText()).toContain('const a');
  });

  test('引用與分隔線', async () => {
    await render(<Markdown text={'> 引用的話\n\n---\n\n下一段'} />);
    expect(screen.getByText('引用的話')).toBeTruthy();
    expect(screen.getByText('下一段')).toBeTruthy();
  });
});

test('左右捲的程式碼、表格不設「可以選取」（iOS 的長按選取會跟長按訊息的選單打架）；一般段落照舊可以選', async () => {
  await render(<Markdown text={'一般段落\n\n```python\nprint(1)\n```\n\n| 欄 | 值 |\n|---|---|\n| a | b |'} />);
  expect(screen.getByText('一般段落').props.selectable).toBe(true);
  expect(screen.getByText('print(1)').props.selectable).toBeFalsy();
  expect(screen.getByText('b').props.selectable).toBeFalsy();
});


test('左右捲的程式碼、表格裡面自己接手指：點一下、長按做的事跟整則訊息一樣', async () => {
  // 外面整則訊息的 Pressable 一當 JS responder，iOS 就把它裡面的左右捲關掉（左右滑被外層上下捲接走、要滑很多次才成功）；
  // 改由捲動裡面的 Pressable 接手，外面那層就不是 responder
  const onPress = jest.fn();
  const onLongPress = jest.fn();
  await render(<Markdown text={'```python\nprint(1)\n```\n\n| 欄 | 值 |\n|---|---|\n| a | b |'} onPress={onPress} onLongPress={onLongPress} />);
  await fireEvent(screen.getByText('print(1)'), 'longPress');
  expect(onLongPress).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText('b'));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('表格每一欄一樣寬：先量出每一欄最寬的格子，各列照那個寬度排，格線才對得齊', async () => {
  await render(<Markdown text={'| 語言 | 適合場景 |\n|---|---|\n| Python | AI、數據分析 |\n| Go | 後端 API、微服務、雲端基礎設施 |'} />);
  // 往上找到那一格（有框線的 View）
  const width = (text: string) => {
    let el: any = screen.getByText(text);
    while (el && !(el.type === 'View' && StyleSheet.flatten(el.props.style)?.borderWidth)) el = el.parent;
    return StyleSheet.flatten(el.props.style).width;
  };
  // 還沒量到：照字的寬度排
  expect(width('Python')).toBeUndefined();
  const layout = (w: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width: w, height: 90 } } });
  await fireEvent(screen.getByTestId('table-measure-0', { includeHiddenElements: true }), 'layout', layout(96));
  await fireEvent(screen.getByTestId('table-measure-1', { includeHiddenElements: true }), 'layout', layout(210));
  for (const t of ['語言', 'Python', 'Go']) expect(width(t)).toBe(96);
  for (const t of ['適合場景', 'AI、數據分析', '後端 API、微服務、雲端基礎設施']) expect(width(t)).toBe(210);
  // 量的那份讀螢幕不唸、也點不到
  expect(screen.getAllByText('Python')).toHaveLength(1);
});

test('左右捲的區塊鍵盤開著時也把手指交給裡面（長按照樣開選單）', async () => {
  await render(<Markdown text={'```python\nprint(1)\n```'} onLongPress={jest.fn()} />);
  expect(screen.getByTestId('hscroll').props.keyboardShouldPersistTaps).toBe('handled');
});
