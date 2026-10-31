import { matchBlock, matchInline, texToText } from '../src/lib/math';

describe('texToText：LaTeX 轉成看得懂的文字', () => {
  test.each([
    ['\\sqrt{n}', '√n'],
    ['\\sqrt{n+1}', '√(n+1)'],
    ['\\sqrt[3]{x}', '³√x'],
    ['x^2 + y^2 = r^2', 'x² + y² = r²'],
    ['a_{ij}', 'aᵢⱼ'],
    ['x_{max}', 'xₘₐₓ'],
    ['e^{i\\pi}', 'e^(iπ)'],
    ['\\frac{1}{2}', '1/2'],
    ['\\frac{a+b}{2}', '(a+b)/2'],
    ['\\sum_{i=1}^{n} i', '∑ᵢ₌₁ⁿ i'],
    ['\\alpha \\leq \\beta \\times 2', 'α ≤ β × 2'],
    ['O(n \\log n)', 'O(n log n)'],
    ['\\text{if } x > 0', 'if x > 0'],
    ['\\left( \\frac{x}{y} \\right)', '( x/y )'],
    ['\\mathbb{R}^n', 'ℝⁿ'],
    ['\\bar{x}', 'x̄'],
    ['\\binom{n}{k}', 'C(n, k)'],
    ['A^T', 'Aᵀ'],
    ['f\'(x)', 'f′(x)'],
    ['\\unknown{x}', 'unknownx'],
  ])('%s', (tex, text) => {
    expect(texToText(tex)).toBe(text);
  });

  test('多行（cases、aligned）：\\\\ 換行、& 變空白', () => {
    expect(texToText('f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}')).toBe('f(x) = 1 x > 0\n0 x ≤ 0');
  });
});

describe('找出數學式', () => {
  test('行內 $...$ 與 \\(...\\)', () => {
    expect(matchInline('$\\sqrt{n}$ 之間')).toEqual({ raw: '$\\sqrt{n}$', tex: '\\sqrt{n}' });
    expect(matchInline('\\(x^2\\) 是')).toEqual({ raw: '\\(x^2\\)', tex: 'x^2' });
    expect(matchInline('$$x$$ 中間')).toEqual({ raw: '$$x$$', tex: 'x' });
  });

  test('金額不算數學：「$5 和 $10」「$5/$10」「$ 20」', () => {
    expect(matchInline('$5 和 $10')).toBeNull();
    expect(matchInline('$5/$10')).toBeNull();
    expect(matchInline('$ 20 元 $')).toBeNull();
  });

  test('不跨段落、沒有結尾就不算', () => {
    expect(matchInline('$x\n\ny$')).toBeNull();
    expect(matchInline('$x 還沒寫完')).toBeNull();
  });

  test('獨立一段：$$...$$ 與 \\[...\\]，前後符號要配對', () => {
    expect(matchBlock('$$\nE = mc^2\n$$\n下一段')).toEqual({ raw: '$$\nE = mc^2\n$$\n', tex: '\nE = mc^2\n' });
    expect(matchBlock('\\[a^2\\]')).toEqual({ raw: '\\[a^2\\]', tex: 'a^2' });
    expect(matchBlock('$$a\\]')).toBeNull();
  });
});
