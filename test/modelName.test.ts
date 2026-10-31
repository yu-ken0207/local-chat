import { friendlyLevel, friendlyModelName } from '../src/lib/modelName';

test.each([
  ['gemma4:12b', 'Gemma 4 12B'],
  ['gemma4:e4b', 'Gemma 4 E4B'],
  ['gemma3', 'Gemma 3'],
  ['llama3:latest', 'Llama 3'],
  ['llama3.2:3b', 'Llama 3.2 3B'],
  ['gpt-oss:20b', 'GPT-OSS 20B'],
  ['qwen3-vl:4b', 'Qwen 3 VL 4B'],
  ['mistral', 'Mistral'],
  ['hf.co/nvjob/Mistral-24B-crack-ru:Q4_0', 'Mistral 24B Crack RU Q4_0'],
  ['deepseek-r1:7b', 'DeepSeek R1 7B'],
  ['qwen3:4b-instruct-2507-q4_K_M', 'Qwen 3 4B Instruct 2507 Q4_K_M'],
  ['gemma4:31b-it-q8_0', 'Gemma 4 31B IT Q8_0'],
])('%s → %s', (name, expected) => {
  expect(friendlyModelName(name)).toBe(expected);
});

test('思考等級白話', () => {
  expect(friendlyLevel('low')).toBe('快速');
  expect(friendlyLevel('medium')).toBe('平衡');
  expect(friendlyLevel('high')).toBe('仔細');
  expect(friendlyLevel('max')).toBe('max');
});
