/**
 * @jest-environment node
 */
import { describeChanges, needsConfirmation, parseArguments, toOllamaTools, toolResultContent, toolSystemPrompt, validateInput, type InputSchema, type PhoneTool } from '../src/lib/tools';

const SCHEMA: InputSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    start: { type: 'string', format: 'date-time' },
    day: { type: 'string', format: 'date' },
    minutes: { type: 'integer' },
    allDay: { type: 'boolean' },
    kind: { type: 'string', enum: ['home', 'work'] },
  },
  required: ['title', 'start'],
};

describe('模型給的輸入', () => {
  test('arguments 可能是物件，也可能是 JSON 文字；壞掉的要說清楚', () => {
    expect(parseArguments({ a: 1 })).toEqual({ ok: true, value: { a: 1 } });
    expect(parseArguments('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseArguments('')).toEqual({ ok: true, value: {} });
    expect(parseArguments(null)).toEqual({ ok: true, value: {} });
    expect(parseArguments('{bad')).toEqual({ ok: false, error: 'The arguments are not valid JSON.' });
    expect(parseArguments('[1]')).toMatchObject({ ok: false });
  });

  test('照格式整理：數字和是非寫成文字會轉回來、不認得的欄位拿掉、時間去掉時區', () => {
    const r = validateInput(SCHEMA, { title: '看牙醫', start: '2026-11-04T15:00:00Z', minutes: '30', allDay: 'false', extra: 'x' });
    expect(r).toEqual({ ok: true, value: { title: '看牙醫', start: '2026-11-04T15:00:00', minutes: 30, allDay: false } });
  });

  test('缺必填、型別不對、不在選項裡、時間格式不對都退回（英文，交給模型重填）', () => {
    expect(validateInput(SCHEMA, { start: '2026-11-04T15:00' })).toEqual({ ok: false, error: '"title" is required.' });
    expect(validateInput(SCHEMA, { title: 'a', start: '2026-11-04T15:00', minutes: 1.5 })).toEqual({ ok: false, error: '"minutes" must be a whole number.' });
    expect(validateInput(SCHEMA, { title: 'a', start: '2026-11-04T15:00', kind: 'party' })).toMatchObject({ ok: false, error: expect.stringContaining('home, work') });
    expect(validateInput(SCHEMA, { title: 'a', start: '下週三三點' })).toMatchObject({ ok: false, error: expect.stringContaining('2026-11-04T15:00') });
    expect(validateInput(SCHEMA, { title: 'a', start: '2026-11-04T15:00', day: '11/4' })).toMatchObject({ ok: false });
    expect(validateInput(SCHEMA, { title: true as never, start: '2026-11-04T15:00' })).toEqual({ ok: false, error: '"title" must be a string.' });
  });
});

describe('審核與結果', () => {
  const tool = (annotations: PhoneTool['annotations'], extra: Partial<PhoneTool> = {}): PhoneTool => ({
    name: 'x',
    description: '',
    inputSchema: { type: 'object', properties: {} },
    annotations,
    label: 'x',
    run: async () => ({ data: null, summary: '' }),
    ...extra,
  });

  test('只讀的直接做；會改東西、會刪東西、一定要人按的都要確認', () => {
    expect(needsConfirmation(tool({ readOnlyHint: true }))).toBe(false);
    expect(needsConfirmation(tool({}))).toBe(true);
    expect(needsConfirmation(tool({ readOnlyHint: true, destructiveHint: true }))).toBe(true);
    expect(needsConfirmation(tool({ readOnlyHint: true }, { requiresUserInteraction: true }))).toBe(true);
  });

  test('送給 Ollama 的工具清單是 function 格式', () => {
    expect(toOllamaTools([tool({}, { name: 'create_event', description: 'Add', inputSchema: SCHEMA })])).toEqual([
      { type: 'function', function: { name: 'create_event', description: 'Add', parameters: SCHEMA } },
    ]);
  });

  test('交給模型的結果太長會截掉；改了哪些欄位寫清楚', () => {
    expect(toolResultContent({ ok: true, result: 'a'.repeat(5000) }).length).toBeLessThanOrEqual(2000);
    expect(toolResultContent({ ok: false, error: 'no' })).toBe('{"ok":false,"error":"no"}');
    expect(describeChanges({ start: '2026-11-04T15:00', title: 'a' }, { start: '2026-11-05T15:00', title: 'a' })).toBe('start: "2026-11-04T15:00" -> "2026-11-05T15:00"');
  });

  test('系統提示詞告訴模型現在幾點、星期幾、時區', () => {
    const now = new Date(2026, 9, 29, 16, 40).getTime();
    const text = toolSystemPrompt(now, 'Asia/Taipei');
    expect(text).toContain('2026-10-29 16:40 (Thursday), time zone Asia/Taipei');
    expect(text).toContain('Never invent missing details');
    // 日期對照表：今天是週四，這週六是 10/31，下週三是 11/4
    expect(text).toContain('today: 2026-10-29 Thu; tomorrow: 2026-10-30 Fri; day after tomorrow: 2026-10-31 Sat');
    expect(text).toContain('this week: 2026-10-26 Mon, 2026-10-27 Tue, 2026-10-28 Wed, 2026-10-29 Thu, 2026-10-30 Fri, 2026-10-31 Sat, 2026-11-01 Sun');
    expect(text).toContain('next week: 2026-11-02 Mon, 2026-11-03 Tue, 2026-11-04 Wed');
    // 週日時「這週」還是週一開始的那一週
    expect(toolSystemPrompt(new Date(2026, 10, 1, 9, 0).getTime(), 'Asia/Taipei')).toContain('this week: 2026-10-26 Mon');
  });
});
