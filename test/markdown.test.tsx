import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';

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

test('左右捲的程式碼、表格不設「可以選取」（設了會讓左右滑被外層上下捲接走）；一般段落照舊可以選', async () => {
  await render(<Markdown text={'一般段落\n\n```python\nprint(1)\n```\n\n| 欄 | 值 |\n|---|---|\n| a | b |'} />);
  expect(screen.getByText('一般段落').props.selectable).toBe(true);
  expect(screen.getByText('print(1)').props.selectable).toBeFalsy();
  expect(screen.getByText('b').props.selectable).toBeFalsy();
});

