import { OllamaClient, OllamaError, isHashName, parseModelInfo, splitThink, type ChatDelta } from '../src/lib/ollama';
import { fakeFetch, splitBytes } from './helpers/fakeFetch';

// 以下 /api/show 回應取自兩台真實主機（Ollama 0.40.0、0.31.1），只留用得到的欄位
const SHOW_GEMMA4_31B_V040 = {
  capabilities: ['completion', 'vision', 'tools', 'thinking'],
  thinking: { values: [false, true], default: true },
  details: { family: 'gemma4', parameter_size: '31.3B', quantization_level: 'Q4_K_M' },
  model_info: { 'gemma4.context_length': 262144 },
};
const SHOW_GEMMA4_12B_V031 = {
  capabilities: ['completion', 'vision', 'audio', 'tools', 'thinking'],
  details: { family: 'gemma4', parameter_size: '12B', quantization_level: 'Q4_K_M' },
  model_info: { 'gemma4.context_length': 262144 },
};
const SHOW_GPTOSS_V031 = {
  capabilities: ['completion', 'tools', 'thinking'],
  details: { family: 'gptoss', parameter_size: '20.9B', quantization_level: 'MXFP4' },
  model_info: { 'gptoss.context_length': 131072, 'gptoss.rope.scaling.original_context_length': 4096 },
};
const SHOW_EMBED = { capabilities: ['embedding'], details: { family: 'bert' }, model_info: {} };
const SHOW_LLAMA3 = {
  capabilities: ['completion'],
  details: { family: 'llama', parameter_size: '8.0B', quantization_level: 'Q4_0' },
  model_info: { 'llama.context_length': 8192 },
};

const HASH = 'llamacpp:34095ebb7f49577e8e391475308b510a25d9e70611513b8f71be55a6e24158fe';

describe('parseModelInfo', () => {
  test('新版 Ollama：直接讀思考選項（開關型）', () => {
    expect(parseModelInfo('gemma4:31b', SHOW_GEMMA4_31B_V040)).toEqual({
      name: 'gemma4:31b',
      vision: true,
      think: { kind: 'toggle' },
      contextLength: 262144,
      family: 'gemma4',
      parameterSize: '31.3B',
      quantization: 'Q4_K_M',
      engine: '',
      engineName: '',
      canLoad: true,
    });
  });

  test('新版 Ollama：分段型思考', () => {
    const show = { ...SHOW_GPTOSS_V031, thinking: { values: ['low', 'medium', 'high'], default: 'high' } };
    expect(parseModelInfo('gpt-oss:20b', show)?.think).toEqual({
      kind: 'levels',
      levels: ['low', 'medium', 'high'],
      defaultLevel: 'high',
    });
  });

  test('舊版 Ollama 沒回報思考選項：gemma4 當開關型、gpt-oss 當分段型', () => {
    expect(parseModelInfo('gemma4:12b', SHOW_GEMMA4_12B_V031)?.think).toEqual({ kind: 'toggle' });
    const gptoss = parseModelInfo('gpt-oss:20b', SHOW_GPTOSS_V031)!;
    expect(gptoss.think).toEqual({ kind: 'levels', levels: ['low', 'medium', 'high'], defaultLevel: 'medium' });
    expect(gptoss.vision).toBe(false);
    expect(gptoss.contextLength).toBe(131072); // 不能誤抓 original_context_length
  });

  test('沒有思考能力的模型 think 是 null；嵌入模型不能聊天，回 null', () => {
    expect(parseModelInfo('llama3:latest', SHOW_LLAMA3)?.think).toBeNull();
    expect(parseModelInfo('bge-m3:latest', SHOW_EMBED)).toBeNull();
  });

  test('雜湊名稱', () => {
    expect(isHashName(HASH)).toBe(true);
    expect(isHashName('gemma4:31b')).toBe(false);
  });
});

describe('OllamaClient', () => {
  const URL = 'http://192.168.1.5:11434';

  test('version：回傳版本與回應時間；不是 Ollama 就報錯', async () => {
    const ok = fakeFetch({ '/api/version': () => ({ json: { version: '0.40.0' } }) });
    const v = await new OllamaClient(URL + '/', { fetch: ok.fetch }).version();
    expect(v.version).toBe('0.40.0');
    expect(v.latencyMs).toBeGreaterThanOrEqual(0);
    expect(ok.calls[0].url).toBe(URL + '/api/version'); // 結尾的 / 要去掉

    const other = fakeFetch({ '/api/version': () => ({ json: { hello: 'world' } }) });
    await expect(new OllamaClient(URL, { fetch: other.fetch }).version()).rejects.toMatchObject({ kind: 'server' });
  });

  test('listModels：去重、略過雜湊名稱與查不到的模型、排除嵌入模型、依名稱排序', async () => {
    const shows: Record<string, unknown> = {
      'gemma4:31b': SHOW_GEMMA4_31B_V040,
      'bge-m3:latest': SHOW_EMBED,
      'llama3:latest': SHOW_LLAMA3,
    };
    const f = fakeFetch({
      '/api/tags': () => ({
        json: {
          models: [{ name: 'llama3:latest' }, { name: 'gemma4:31b' }, { name: 'gemma4:31b' }, { name: HASH }, { name: 'bge-m3:latest' }, { name: 'broken:1' }],
        },
      }),
      '/api/show': (body) => (shows[body.model] ? { json: shows[body.model] } : { status: 500, text: 'boom' }),
    });
    const models = await new OllamaClient(URL, { fetch: f.fetch }).listModels();
    expect(models.map((m) => m.name)).toEqual(['gemma4:31b', 'llama3:latest']);
    expect(f.calls.filter((c) => c.url.endsWith('/api/show')).map((c) => c.body.model)).not.toContain(HASH);
  });

  test('loaded：整理 /api/ps', async () => {
    const f = fakeFetch({
      '/api/ps': () => ({
        json: { models: [{ name: 'gemma4:12b', size_vram: 8060739255, context_length: 8192, expires_at: '2319-02-07T17:32:34+08:00' }] },
      }),
    });
    expect(await new OllamaClient(URL, { fetch: f.fetch }).loaded()).toEqual([
      { name: 'gemma4:12b', sizeVram: 8060739255, contextLength: 8192, expiresAt: '2319-02-07T17:32:34+08:00' },
    ]);
  });

  test('preload / unload 送出正確的 keep_alive', async () => {
    const f = fakeFetch({ '/api/generate': () => ({ json: { done: true } }) });
    const client = new OllamaClient(URL, { fetch: f.fetch });
    await client.preload('gemma4:e2b');
    await client.unload('gemma4:e2b');
    expect(f.calls.map((c) => c.body)).toEqual([
      { model: 'gemma4:e2b', keep_alive: '30m', stream: false },
      { model: 'gemma4:e2b', keep_alive: 0, stream: false },
    ]);
  });

  describe('chat 串流', () => {
    const line = (obj: unknown) => JSON.stringify(obj) + '\n';
    const FINAL = { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 202, eval_duration: 1e9, prompt_eval_count: 47, total_duration: 1.8e9, load_duration: 2e6 };

    test('思考與回答分開送出；中文字的位元組被切斷也能接回來；回傳統計', async () => {
      const answer = line({ message: { role: 'assistant', content: '現在有六顆蘋果。' }, done: false });
      const [a, b] = splitBytes(answer, 30); // 從中文字中間切開
      const f = fakeFetch({
        '/api/chat': () => ({
          chunks: [
            line({ message: { role: 'assistant', content: '', thinking: '先算 3-1' }, done: false }) +
              line({ message: { role: 'assistant', content: '', thinking: '=2，再加 4' }, done: false }),
            a,
            b,
            line(FINAL).slice(0, 10),
            line(FINAL).slice(10),
          ],
        }),
      });
      const deltas: ChatDelta[] = [];
      const result = await new OllamaClient(URL, { fetch: f.fetch }).chat(
        { model: 'gemma4:e2b', messages: [{ role: 'user', content: '算一下' }], think: true },
        (d) => deltas.push(d)
      );
      expect(deltas.filter((d) => d.thinking).map((d) => d.thinking).join('')).toBe('先算 3-1=2，再加 4');
      expect(deltas.filter((d) => d.content).map((d) => d.content).join('')).toBe('現在有六顆蘋果。');
      expect(result).toEqual({ doneReason: 'stop', evalCount: 202, evalDurationNs: 1e9, promptEvalCount: 47, totalDurationNs: 1.8e9, loadDurationNs: 2e6 });
      expect(f.calls[0].body).toEqual({
        model: 'gemma4:e2b',
        messages: [{ role: 'user', content: '算一下' }],
        stream: true,
        think: true,
      });
    });

    test('沒有指定思考時不送 think 參數；照片照原樣送出', async () => {
      const f = fakeFetch({ '/api/chat': () => ({ chunks: [line(FINAL)] }) });
      await new OllamaClient(URL, { fetch: f.fetch }).chat(
        { model: 'llama3', messages: [{ role: 'user', content: 'hi', images: ['AAAA'] }] },
        () => {}
      );
      expect(f.calls[0].body).not.toHaveProperty('think');
      expect(f.calls[0].body.messages[0].images).toEqual(['AAAA']);
    });

    test('分段型思考送等級字串', async () => {
      const f = fakeFetch({ '/api/chat': () => ({ chunks: [line(FINAL)] }) });
      await new OllamaClient(URL, { fetch: f.fetch }).chat({ model: 'gpt-oss:20b', messages: [], think: 'high' }, () => {});
      expect(f.calls[0].body.think).toBe('high');
    });

    test('串流中途回報錯誤', async () => {
      const f = fakeFetch({ '/api/chat': () => ({ chunks: [line({ error: 'model requires more system memory' })] }) });
      await expect(new OllamaClient(URL, { fetch: f.fetch }).chat({ model: 'x', messages: [] }, () => {})).rejects.toEqual(
        new OllamaError('server', 'model requires more system memory')
      );
    });

    test('HTTP 錯誤（例如模型不存在）', async () => {
      const f = fakeFetch({ '/api/chat': () => ({ status: 404, text: '{"error":"model \\"x\\" not found"}' }) });
      await expect(new OllamaClient(URL, { fetch: f.fetch }).chat({ model: 'x', messages: [] }, () => {})).rejects.toMatchObject({
        kind: 'http',
        message: expect.stringContaining('404'),
      });
    });

    test('還沒收到結束訊號連線就斷了', async () => {
      const f = fakeFetch({ '/api/chat': () => ({ chunks: [line({ message: { content: '一半' }, done: false })] }) });
      await expect(new OllamaClient(URL, { fetch: f.fetch }).chat({ model: 'x', messages: [] }, () => {})).rejects.toMatchObject({
        kind: 'network',
      });
    });

    test('連不到主機', async () => {
      const f = fakeFetch({});
      await expect(new OllamaClient(URL, { fetch: f.fetch }).chat({ model: 'x', messages: [] }, () => {})).rejects.toMatchObject({
        kind: 'network',
      });
    });

    test('使用者按停止：回報 cancelled，已收到的字保留', async () => {
      const controller = new AbortController();
      const f = fakeFetch({ '/api/chat': () => ({ chunks: [line({ message: { content: '前半' }, done: false })], hang: true }) });
      const got: string[] = [];
      const p = new OllamaClient(URL, { fetch: f.fetch }).chat({ model: 'x', messages: [] }, (d) => {
        got.push(d.content ?? '');
        controller.abort();
      }, controller.signal);
      await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
      expect(got).toEqual(['前半']);
    });

    test('開始回答後太久沒有新字：逾時', async () => {
      const f = fakeFetch({ '/api/chat': () => ({ chunks: [line({ message: { content: '前半' }, done: false })], hang: true }) });
      const client = new OllamaClient(URL, { fetch: f.fetch, timeouts: { firstToken: 5000, idle: 30 } });
      await expect(client.chat({ model: 'x', messages: [] }, () => {})).rejects.toMatchObject({ kind: 'timeout' });
    });

    test('一直等不到第一個字：逾時', async () => {
      const f = fakeFetch({ '/api/chat': () => ({ hang: true }) });
      const client = new OllamaClient(URL, { fetch: f.fetch, timeouts: { firstToken: 30 } });
      await expect(client.chat({ model: 'x', messages: [] }, () => {})).rejects.toMatchObject({ kind: 'timeout' });
    });
  });
});

describe('一定會思考的模型', () => {
  test('思考混在回答裡：拆回思考與回答', () => {
    expect(splitThink('想一下這題</think>\n\n答案是 2')).toEqual({ thinking: '想一下這題', content: '答案是 2' });
    expect(splitThink('<think>想一下</think>答案')).toEqual({ thinking: '想一下', content: '答案' });
    expect(splitThink('<think>還在想')).toEqual({ thinking: '還在想', content: '' });
    expect(splitThink('一般的回答')).toBeNull();
  });

  test('新版 Ollama 說只能開：一定會思考', () => {
    const show = { capabilities: ['completion', 'thinking'], thinking: { values: [true] }, details: {} };
    expect(parseModelInfo('qwen3:4b', show)?.think).toEqual({ kind: 'always' });
  });
});
