// 把 AI 回答裡的 LaTeX 數學式轉成看得懂的文字（Unicode 符號），例如 \sqrt{n} 變 √n、x^2 變 x²、\frac{a}{b} 變 a/b。
// Expo Go 不能裝排版數學的原生套件，這裡只處理聊天裡常見的寫法；不認得的指令拿掉反斜線照原樣顯示。

const SYMBOLS: Record<string, string> = {
  // 希臘字母
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ',
  varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // 運算與關係
  times: '×', cdot: '⋅', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '∙',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅',
  propto: '∝', ll: '≪', gg: '≫', mid: '∣', parallel: '∥', perp: '⊥', angle: '∠', degree: '°',
  // 集合與邏輯
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩',
  emptyset: '∅', varnothing: '∅', forall: '∀', exists: '∃', neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨',
  setminus: '∖',
  // 箭頭
  to: '→', rightarrow: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐',
  Leftrightarrow: '⇔', implies: '⟹', iff: '⟺', mapsto: '↦', uparrow: '↑', downarrow: '↓',
  // 大型運算子與其他
  sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮', infty: '∞', partial: '∂', nabla: '∇', ell: 'ℓ', hbar: 'ℏ',
  ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', prime: '′', therefore: '∴', because: '∵',
  langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋', vert: '|', Vert: '‖',
  // 函數名稱
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc', arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan',
  sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', log: 'log', ln: 'ln', lg: 'lg', exp: 'exp', lim: 'lim', max: 'max', min: 'min',
  sup: 'sup', inf: 'inf', det: 'det', gcd: 'gcd', deg: 'deg', dim: 'dim', ker: 'ker', arg: 'arg', mod: 'mod', bmod: 'mod',
  // 空白
  quad: '  ', qquad: '    ', ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ',
  // 跳脫字元
  '{': '{', '}': '}', '%': '%', '$': '$', '&': '&', '_': '_', '#': '#', '|': '‖',
};

// 只改樣子、不影響內容的指令：拿掉，留下參數
const PASS = new Set(['text', 'textrm', 'textbf', 'textit', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathcal', 'boldsymbol', 'operatorname', 'mbox', 'displaystyle', 'textstyle', 'left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'limits', 'nolimits']);

// 放在字母上方的記號（組合字元）
const ACCENTS: Record<string, string> = { bar: '̄', overline: '̅', hat: '̂', widehat: '̂', tilde: '̃', widetilde: '̃', vec: '⃗', dot: '̇', ddot: '̈' };

const BB: Record<string, string> = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ' };

const SUP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻',
  '=': '⁼', '(': '⁽', ')': '⁾', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ',
  m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ', T: 'ᵀ', '′': '′', '*': '*',
};
const SUB: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '−': '₋',
  '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ',
  r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

/** 一整段要不要加括號：只有一個字（或一個符號、一個數字）就不用 */
const simple = (s: string) => /^(?:[\p{L}\p{N}]|\p{N}+(?:\.\p{N}+)?|[\p{L}\p{N}]′*)$/u.test(s) || /^[√∑∏∫]?[\p{L}\p{N}]+$/u.test(s);
const wrap = (s: string) => (simple(s) ? s : `(${s})`);

function script(s: string, map: Record<string, string>, mark: string): string {
  const chars = [...s];
  if (chars.length > 0 && chars.every((ch) => map[ch] !== undefined)) return chars.map((ch) => map[ch]).join('');
  // 沒有對應的上下標字元：超過一個字就加括號，例如 e^(iπ)
  return `${mark}${chars.length === 1 ? s : `(${s})`}`;
}

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  get done() {
    return this.i >= this.s.length;
  }
  peek() {
    return this.s[this.i];
  }
  skipSpaces() {
    while (this.s[this.i] === ' ') this.i++;
  }
  /** 讀一個參數：{...} 整組，或下一個字、下一個指令 */
  arg(): string {
    this.skipSpaces();
    if (this.peek() === '{') {
      this.i++;
      return this.until('}');
    }
    if (this.peek() === '\\') return this.command();
    const ch = [...this.s.slice(this.i)][0] ?? '';
    this.i += ch.length;
    return ch;
  }
  /** [選填參數] */
  optional(): string | null {
    this.skipSpaces();
    if (this.peek() !== '[') return null;
    const end = this.s.indexOf(']', this.i);
    if (end < 0) return null;
    const inner = this.s.slice(this.i + 1, end);
    this.i = end + 1;
    return convert(inner);
  }
  /** 轉換到配對的右括號為止 */
  until(close: string): string {
    let depth = 0;
    const start = this.i;
    while (!this.done) {
      const ch = this.s[this.i];
      if (ch === '\\') {
        this.i += 2;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        if (depth === 0) break;
        depth--;
      }
      this.i++;
    }
    const inner = this.s.slice(start, this.i);
    if (this.s[this.i] === close) this.i++;
    return convert(inner);
  }
  command(): string {
    this.i++; // 反斜線
    const m = /^(?:[A-Za-z]+|.)/s.exec(this.s.slice(this.i));
    const name = m ? m[0] : '';
    this.i += name.length;
    if (name === '\\') return '\n';
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
      const a = this.arg();
      const b = this.arg();
      return `${wrap(a)}/${wrap(b)}`;
    }
    if (name === 'sqrt') {
      const n = this.optional();
      const x = this.arg();
      return `${n ? script(n, SUP, '') : ''}√${wrap(x)}`;
    }
    if (name === 'binom' || name === 'tbinom' || name === 'dbinom') {
      const n = this.arg();
      const k = this.arg();
      return `C(${n}, ${k})`;
    }
    if (name === 'mathbb') {
      const x = this.arg();
      return [...x].map((ch) => BB[ch] ?? ch).join('');
    }
    if (ACCENTS[name]) {
      const x = this.arg();
      return [...x].map((ch) => ch + ACCENTS[name]).join('');
    }
    if (name === 'begin' || name === 'end') {
      this.arg(); // 環境名稱（cases、aligned、matrix…）：拿掉，裡面的 \\ 換行、& 變空白
      return '';
    }
    if (PASS.has(name)) {
      this.skipSpaces();
      // \left( 這類後面直接接括號；\text{...} 這類接一組參數
      if (name === 'left' || name === 'right' || name.startsWith('big') || name.startsWith('Big')) {
        if (this.peek() === '.') {
          this.i++;
          return '';
        }
        return this.peek() === '\\' ? this.command() : this.arg();
      }
      return this.peek() === '{' ? this.arg() : '';
    }
    if (SYMBOLS[name] !== undefined) return SYMBOLS[name];
    return name; // 不認得的指令：拿掉反斜線
  }
}

/** LaTeX 數學式轉成一般文字 */
export function convert(tex: string): string {
  const r = new Reader(tex);
  let out = '';
  while (!r.done) {
    const ch = r.peek();
    if (ch === '\\') out += r.command();
    else if (ch === '^' || ch === '_') {
      r.i++;
      const x = r.arg();
      out += script(x, ch === '^' ? SUP : SUB, ch);
    } else if (ch === '{') {
      r.i++;
      out += r.until('}');
    } else if (ch === '}') r.i++;
    else if (ch === '&') {
      r.i++;
      out += ' ';
    } else if (ch === '~') {
      r.i++;
      out += ' ';
    } else if (ch === "'") {
      r.i++;
      out += '′';
    } else {
      out += ch;
      r.i++;
    }
  }
  return out;
}

/** 整段數學式：轉換後把多餘的空白收掉 */
export function texToText(tex: string): string {
  return convert(tex.trim())
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, i, all) => line || (i > 0 && i < all.length - 1))
    .join('\n');
}

// ---- 從 Markdown 文字裡找出數學式 ----

/** 行內：$...$（左邊緊接非空白、右邊緊接非空白，後面不是數字，免得把「$5 和 $10」當成數學）或 \(...\) */
export function matchInline(src: string): { raw: string; tex: string } | null {
  if (src.startsWith('\\(')) {
    const end = src.indexOf('\\)', 2);
    if (end < 0) return null;
    return { raw: src.slice(0, end + 2), tex: src.slice(2, end) };
  }
  if (src.startsWith('$$')) {
    // 夾在一行文字中間的 $$...$$：當成行內的數學式
    const end = src.indexOf('$$', 2);
    if (end < 3 || src.slice(2, end).includes('\n\n')) return null;
    return { raw: src.slice(0, end + 2), tex: src.slice(2, end) };
  }
  if (src[0] !== '$') return null;
  if (!src[1] || /\s/.test(src[1])) return null;
  for (let i = 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '\n' && src[i + 1] === '\n') return null; // 不跨段落
    if (ch === '$') {
      if (/\s/.test(src[i - 1]) || /\d/.test(src[i + 1] ?? '')) return null;
      return { raw: src.slice(0, i + 1), tex: src.slice(1, i) };
    }
  }
  return null;
}

/** 獨立一段：$$...$$ 或 \[...\] */
export function matchBlock(src: string): { raw: string; tex: string } | null {
  const m = /^ {0,3}(\$\$|\\\[)([\s\S]+?)(\$\$|\\\])[ \t]*(?:\n|$)/.exec(src);
  if (!m) return null;
  if ((m[1] === '$$') !== (m[3] === '$$')) return null;
  return { raw: m[0], tex: m[2] };
}
