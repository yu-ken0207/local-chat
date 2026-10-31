/// <reference types="node" />
// 快滿了自動整理的真模型實測共用劇本：規劃 120 人的員工旅遊。
// 先講 12 個關鍵事實（FACTS），再一直貼長文件撐滿上下文（tripDocs），最後出 15 題（QUIZ）對答案（answerKey、grade）

import type { ChatStore } from '../../../src/state/chatStore';

/** 每次都一樣的亂數（名單、報價每次跑都相同） */
export function rng(seed: number) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
}

const SURNAMES = '陳林黃張李王吳劉蔡楊許鄭謝洪郭邱曾廖賴徐周葉蘇莊呂江何蕭羅高潘簡朱鍾游彭詹胡施沈余盧梁趙顏柯翁魏孫戴'.split('');
const GIVEN = '家豪 志明 俊傑 建宏 俊宏 志豪 志偉 文雄 金龍 志強 淑芬 淑惠 美玲 雅婷 美惠 麗華 淑娟 淑貞 怡君 佳穎 宗翰 冠宇 承恩 柏翰 品妤 詠晴 子涵 宥廷 欣妤 思妤'.split(' ');
const DEPTS = ['研發部', '業務部', '行政部', '財務部', '人資部', '品保部', '生產部', '資訊部'];

/** 報名名單：120 人，編號、姓名、部門、飲食、同住 */
export function roster(): { text: string; who057: string } {
  const r = rng(7);
  let who057 = '';
  const rows = Array.from({ length: 120 }, (_, i) => {
    const no = String(i + 1).padStart(3, '0');
    const name = SURNAMES[Math.floor(r() * SURNAMES.length)] + GIVEN[Math.floor(r() * GIVEN.length)];
    const dept = DEPTS[Math.floor(r() * DEPTS.length)];
    const food = i % 7 === 3 ? '素食' : i === 40 || i === 88 ? '清真' : '一般';
    const mate = i % 2 === 0 ? `同住 ${String(i + 2).padStart(3, '0')}` : `同住 ${String(i).padStart(3, '0')}`;
    if (no === '057') who057 = `${name}（${dept}）`;
    return `${no}｜${name}｜${dept}｜${food}｜${mate}｜${i < 15 ? '眷屬' : '員工'}`;
  });
  return { text: rows.join('\n'), who057 };
}

/** 三家旅行社的報價，每家 18 項 */
export function quotes(seed = 11): string {
  const items = ['台鐵票', '遊覽車三天', '司機小費', '第一晚住宿', '第二晚住宿', '第一天午餐', '第一天晚餐', '第二天午餐', '頒獎晚會場地', '晚會音響燈光', '第三天午餐', '太魯閣導覽', '七星潭活動', '文創園區場租', '保險', '領隊', '雜支', '服務費'];
  const r = rng(seed);
  return ['甲旅行社（晴川）', '乙旅行社（青松）', '丙旅行社（遠帆）']
    .map((agency, k) => {
      let total = 0;
      const lines = items.map((it) => {
        const price = Math.round((20_000 + r() * 90_000 - k * 1_200) / 100) * 100;
        total += price;
        return `  ${it}：${price.toLocaleString('en-US')} 元，備註：${['含稅', '未稅', '可議價', '需提前 30 天付訂'][Math.floor(r() * 4)]}`;
      });
      return `${agency}\n${lines.join('\n')}\n  合計：${total.toLocaleString('en-US')} 元`;
    })
    .join('\n\n');
}

/** 去年的問卷意見 60 則（最多人抱怨的是遊覽車太擠、座位不夠） */
export function survey(seed = 23): string {
  const complaints = ['遊覽車太擠、座位不夠，很多人站著', '晚餐上菜太慢', '房間冷氣太吵', '行程太趕、沒有自由時間', '抽獎獎品太少', '集合時間常常延誤', '素食選擇太少', '導覽講解聽不清楚'];
  const weights = [16, 9, 6, 8, 5, 7, 5, 4];
  const r = rng(seed);
  const out: string[] = [];
  let n = 0;
  weights.forEach((w, i) => {
    for (let j = 0; j < w; j++) out.push(`${++n}. ${DEPTS[Math.floor(r() * DEPTS.length)]}同仁：${complaints[i]}。${['希望今年改善', '不然不想參加', '其他都還好', '建議換廠商'][Math.floor(r() * 4)]}。`);
  });
  return out.join('\n');
}

/** 飯店合約條款 32 條 */
export function contract(seed = 31): string {
  const r = rng(seed);
  const topics = ['訂金', '取消', '延期', '加床', '早餐', '停車', '寵物', '吸菸', '損壞賠償', '退房時間', '入住時間', '會議室', '音響', '舞台', '餐飲最低消費', '開瓶費'];
  return Array.from({ length: 32 }, (_, i) => `第 ${i + 1} 條（${topics[i % topics.length]}）：甲方應於入住前 ${Math.floor(r() * 30) + 5} 日完成相關事項，逾期乙方得收取費用 ${Math.round(r() * 20_000).toLocaleString('en-US')} 元；如遇天災等不可抗力因素，雙方得協議延期，不另收費，惟須以書面通知對方並經雙方簽章確認後始生效力。`).join('\n');
}

/** 每天的行程草稿（每 30 分鐘一格） */
export function itinerary(seed = 43): string {
  const spots = ['集合點名', '搭車', '休息站', '午餐', '景點導覽', '自由活動', '飯店入住', '晚餐', '晚會彩排', '休息'];
  const r = rng(seed);
  return [1, 2, 3]
    .map((d) => {
      const rows = Array.from({ length: 24 }, (_, i) => {
        const h = 7 + Math.floor(i / 2);
        return `  ${String(h).padStart(2, '0')}:${i % 2 ? '30' : '00'} ${spots[Math.floor(r() * spots.length)]}，負責人：${SURNAMES[Math.floor(r() * SURNAMES.length)]}${GIVEN[Math.floor(r() * GIVEN.length)]}，備註：${['準時', '留意人數', '確認餐點', '注意安全'][Math.floor(r() * 4)]}`;
      });
      return `第 ${d} 天\n${rows.join('\n')}`;
    })
    .join('\n\n');
}

export const FACTS = [
  `我是行政部的王小美，要規劃公司員工旅遊，先把基本條件告訴你，之後會一直用到：
- 日期：2026 年 12 月 12 日（週六）到 12 月 14 日（週一），三天兩夜
- 地點：花蓮
- 人數：120 人（含眷屬 15 人）
- 預算：每人 12,000 元，總預算 144 萬，老闆說絕對不能超過
- 交通：去程搭台鐵太魯閣號 408 次（台北 07:10 出發），花蓮當地包 3 台遊覽車
- 決策：最後要總經理林雅婷簽核
請先簡短確認你記下了什麼。`,
  `再補充幾個限制：
- 素食 18 人、清真 2 人；研發部的張家豪對花生過敏
- 不要安排泛舟：去年在秀姑巒溪有同事受傷，公司規定禁止
- 第二天晚上一定要有頒獎晚會，要 3 小時、有舞台和音響
- 下雨的備案：改去花蓮文創園區做室內活動
- 我的分機是 2317，有事找我
- 保險：每人旅平險 300 萬，由公司負擔
請一句話確認。`,
  `飯店我們比較過了，決定住花蓮雲澗酒店，訂 60 間雙人房，每晚 3,800 元含早餐，訂房代號 HL-2026-1212。請一句話確認。`,
];

export const QUIZ = `考考你，請逐題簡短回答，一題一行，不知道就寫「不知道」：
1. 員工旅遊的日期？
2. 地點？
3. 每人預算和總預算？
4. 去程搭哪一班車、幾點出發？
5. 最後要誰簽核？
6. 素食、清真各幾人？誰對花生過敏？
7. 哪個活動不能安排？為什麼？
8. 頒獎晚會在哪一天、要多久？
9. 下雨的備案？
10. 我的分機？
11. 住哪家飯店、幾間房、每晚多少、訂房代號？
12. 旅平險保額多少、誰負擔？
13. 報名名單編號 057 是誰、哪個部門？
14. 三家旅行社哪一家合計最便宜？
15. 去年問卷最多人抱怨什麼？`;

/** 每題要出現的關鍵字（全部都有才算對） */
export function answerKey(who057: string, cheapest: string): string[][] {
  // 同義的寫法都算（例如「文化創意產業園區」「巴士擁擠」「1.44M」），名字要一字不差（雲澗不能寫成別的字）
  return [
    ['12', '14'],
    ['花蓮'],
    ['12,000|12000|1.2 萬|一萬二|1.2萬', '144|1.44'],
    ['408', '07:10|7:10|7點10'],
    ['林雅婷'],
    ['18', '2', '張家豪'],
    ['泛舟', '受傷'],
    ['第二天|第2天|12 月 13|12/13|13 日|第二晚', '3'],
    ['文創|文化創意'],
    ['2317'],
    ['雲澗', '60', '3,800|3800', 'HL-2026-1212'],
    ['300', '公司'],
    [who057.replace(/（.*$/, ''), who057.match(/（(.*)）/)![1]],
    [cheapest],
    ['遊覽車|座位|巴士'],
  ];
}

/** 照題號把回答分開（一題可能好幾行，到下一個題號為止），每組關鍵字有一個出現就算 */
export function grade(answer: string, key: string[][]): boolean[] {
  const lines = answer.split('\n');
  const numbered = (l: string, n: number) => new RegExp(`^\\s*\\**\\s*${n}\\s*[.、．):：]`).test(l);
  return key.map((need, i) => {
    const at = lines.findIndex((l) => numbered(l, i + 1));
    if (at < 0) return false;
    let end = at + 1;
    while (end < lines.length && !numbered(lines[end], i + 2)) end++;
    const text = lines.slice(at, end).join(' ');
    return need.every((alt) => alt.split('|').some((x) => text.includes(x)));
  });
}


/** 要貼的長文件：先貼要考的三份（名單、報價、問卷），之後輪流貼合約、行程撐滿上下文 */
export function tripDocs(rosterText: string, quoteText: string): string[] {
  return [
    `這是報名名單（編號｜姓名｜部門｜飲食｜同住｜身分），先幫我收著，之後排房會用到，用一句話告訴我重點就好：\n${rosterText}`,
    `這是三家旅行社的報價，先收著，用一句話告訴我重點就好：\n${quoteText}`,
    `這是去年員工旅遊的問卷意見，先收著，用一句話告訴我重點就好：\n${survey()}`,
    ...Array.from({ length: 14 }, (_, k) =>
      [
        `這是飯店合約條款（第 ${k + 1} 版），先收著，用一句話告訴我重點就好：\n${contract(100 + k)}`,
        `這是行程草稿（第 ${k + 1} 版），先收著，用一句話告訴我重點就好：\n${itinerary(200 + k)}`,
      ][k % 2]
    ),
  ];
}

/** 最便宜的那家：回答寫「乙旅行社」、品牌名、或「乙 (」都算 */
export function cheapestOf(quoteText: string): string {
  const best = quoteText
    .split('\n\n')
    .map((block) => {
      const head = block.split('\n')[0];
      return { head, total: Number(block.match(/合計：([\d,]+)/)![1].replace(/,/g, '')) };
    })
    .sort((x, y) => x.total - y.total)[0].head;
  const name = best.replace(/（.*$/, '');
  return `${name}|${best.match(/（(.*)）/)![1]}|${name.replace('旅行社', '')} (|${name.replace('旅行社', '')}（|${name.replace('旅行社', '')}(`;
}

/** 講完事實、一直貼文件，直到自動整理成功（或文件貼完）；每輪印出用量 */
export async function fillUntilCompacted(store: ChatStore, docs: string[], log: (line: string) => void): Promise<boolean> {
  const show = (label: string) => {
    const c = store.getState().context;
    log(`${label}：${c ? `${c.used.toLocaleString('en-US')}／${c.limit?.toLocaleString('en-US')}（${c.limit ? Math.round((c.used / c.limit) * 100) : '?'}%）` : '沒有'}`);
  };
  for (const [i, text] of FACTS.entries()) {
    await store.send(text);
    show(`事實 ${i + 1}`);
  }
  for (const [i, text] of docs.entries()) {
    await store.send(text);
    show(`文件 ${i + 1}`);
    const last = store.getState().messages.at(-1)!;
    if (last.role === 'error') log(`  這輪出錯：${last.content}`);
    await Promise.all([...store.compactTasks.values()]);
    if (store.getState().session!.summary) return true;
  }
  return false;
}
