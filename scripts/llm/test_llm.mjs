/* Проверка языковой модели BLOOP AI: загрузка весов, генерация ответов. */
import { readFileSync } from 'node:fs';
import { createBloopLLM } from '../../src/ai/llm.js';

const data = JSON.parse(readFileSync(new URL('../../public/vendor/bloop-llm.json', import.meta.url), 'utf8'));
console.time('загрузка весов');
const llm = createBloopLLM(data);
console.timeEnd('загрузка весов');

const questions = ['привет', 'как дела', 'что ты умеешь', 'о чем снять клип', 'какой фильм посмотреть вечером', 'скучно, чем заняться'];
for (const q of questions) {
  console.time('генерация');
  const a = llm.chat(q);
  console.timeEnd('генерация');
  console.log(`\nП: ${q}\nB: ${a ?? '(пусто — сработает классификатор)'}`);
}
