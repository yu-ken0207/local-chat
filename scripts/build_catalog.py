#!/usr/bin/env python3
"""把兩個 MIT 授權的 Agent 集合轉成 App 的「圖鑑」。

來源（固定版本，要更新就改下面的 SOURCES）：
- lobehub/lobe-chat-agents：505 個，每個都有繁中與英文
- msitarzewski/agency-agents：283 個，英文；名字、介紹、個性的繁中在 scripts/catalog/agency-zh.json

產生：
- src/agents/catalog.json：索引（名字、介紹、分類、emoji、作者、原文在哪個分片），打包進 App
- assets/agents/prompts-NN.txt：角色原文（JSON），分片放，用到才讀
- scripts/catalog/simplified-chars.txt：簡體專用字（測試用來檢查圖鑑裡沒有簡體）

中文一律台灣正體、台灣用語：lobe 的繁中版有些沒翻（還是英文）、有些混著簡體、很多是大陸用語。
沒翻的名字和介紹由模型翻（scripts/catalog/lobe-zh.json）；含簡體的用 OpenCC 轉成台灣正體（s2twp）；
大陸用語照 TW_TERMS 換成台灣說法；最後檢查還有簡體就失敗。
要先裝 OpenCC：pip install opencc-python-reimplemented（純 Python）

用法：
  python3 scripts/build_catalog.py                       下載（有快取）並產生上面的檔案
  python3 scripts/build_catalog.py --translate URL       用 Ollama（URL 例如 http://100.100.0.31:11434）把還沒翻的 agency 欄位翻成繁中
  python3 scripts/build_catalog.py --translate-lobe URL  同上，翻 lobe 繁中版沒翻到的名字和介紹
"""

import argparse
import io
import json
import re
import sys
import tarfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    from opencc import OpenCC
    import opencc as _opencc
except ImportError:  # 轉檔一定要 OpenCC（確保沒有簡體）
    sys.exit('要先裝 OpenCC：pip install opencc-python-reimplemented')

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path.home() / '.cache' / 'local-chat-catalog'
ZH_FILE = ROOT / 'scripts' / 'catalog' / 'agency-zh.json'
LOBE_ZH_FILE = ROOT / 'scripts' / 'catalog' / 'lobe-zh.json'
SIMPLIFIED_FILE = ROOT / 'scripts' / 'catalog' / 'simplified-chars.txt'
OUT_INDEX = ROOT / 'src' / 'agents' / 'catalog.json'
OUT_DIR = ROOT / 'assets' / 'agents'
SHARD_BYTES = 400_000

SOURCES = {
    'lobe': {'repo': 'lobehub/lobe-chat-agents', 'sha': 'ba090ca25a0981107589568210b056f427c1c843'},
    'agency': {'repo': 'msitarzewski/agency-agents', 'sha': 'b37b5bb33b78f2c1d6567d98e25ca818e3259219'},
}

# 兩邊的分類合併成 App 的 12 類（名稱在 src/agents/catalog.ts）
CATEGORY = {
    'lobe': {
        'general': 'general', 'programming': 'code', 'design': 'design', 'copywriting': 'writing',
        'translation': 'language', 'education': 'education', 'academic': 'academic', 'career': 'business',
        'office': 'business', 'marketing': 'marketing', 'life': 'life', 'emotions': 'emotions',
        'entertainment': 'fun', 'games': 'fun',
    },
    'agency': {
        'engineering': 'code', 'testing': 'code', 'spatial-computing': 'code', 'gis': 'code', 'security': 'code',
        'design': 'design', 'academic': 'academic', 'research': 'academic', 'finance': 'business',
        'product': 'business', 'project-management': 'business', 'sales': 'business', 'support': 'business',
        'specialized': 'business', 'marketing': 'marketing', 'paid-media': 'marketing', 'healthcare': 'life',
        'game-development': 'fun',
    },
}

# 暫時不公開所以照原樣放；公開前要再檢查（越獄、髒話）
REVIEW = {'lobe:dan', 'lobe:gpt-4-dan-assistant', 'lobe:profanity-assistant', 'lobe:bad-language-helper'}


# ---- 台灣正體 ----

def simplified_chars() -> set[str]:
    """簡體專用字：OpenCC 簡轉繁時一定會變的字（自己不在對照的繁體裡），扣掉台灣正體的寫法（群、床、峰這些台灣照用）"""
    d = Path(_opencc.__file__).parent / 'dictionary'
    tw = set()
    for line in (d / 'TWVariants.txt').read_text(encoding='utf-8').splitlines():
        if '\t' in line:
            tw.update(line.split('\t')[1].split())
    out = set()
    for line in (d / 'STCharacters.txt').read_text(encoding='utf-8').splitlines():
        if '\t' not in line:
            continue
        k, v = line.split('\t')
        if k not in v.split() and k not in tw:
            out.add(k)
    return out


SIMPLIFIED = simplified_chars()
S2TWP = OpenCC('s2twp')
# OpenCC 轉出來不是台灣說法的，轉完再修（只換完整的詞：單獨換「保安」會把「確保安全」改成「確安全全」）
TW_FIX = {
    '資訊保安': '資訊安全', '網路保安': '網路安全',
    # OpenCC 把「循環」「代碼」一律換成程式用語：不是程式的意思換回來
    '惡性迴圈': '惡性循環', '良性迴圈': '良性循環', '迴圈經濟': '循環經濟', '自然迴圈': '自然循環', '空氣迴圈': '空氣循環',
    '血液迴圈': '血液循環', '迴圈播放': '循環播放', '迴圈利用': '循環利用', '迴圈使用': '循環使用', '水迴圈': '水循環', '碳迴圈': '碳循環',
    '國家程式碼': '國家代碼', '語言程式碼': '語言代碼', '股票程式碼': '股票代碼', '貨幣程式碼': '貨幣代碼', '地區程式碼': '地區代碼',
}

# 大陸用語換成台灣用語（字是正體、說法是大陸的）：只放「一定是大陸說法」的詞，
# 從 OpenCC 台灣詞彙表裡挑過；兩岸都通用或意思會跟著變的不換（支持、對象、項目、文件、優化、權限、像素、程序…），
# OpenCC 會換錯的也不用（圖像→影象、擴展→擴充套件、通過→透過、萬象→永珍、回調→回撥）
TW_TERMS = {
    '用戶名稱': '使用者名稱', '用戶名': '使用者名稱', '用戶': '使用者', '源代碼': '原始碼', '代碼': '程式碼', '源碼': '原始碼', '信息': '資訊', '消息': '訊息',
    '創建': '建立', '數據庫': '資料庫', '數據': '資料', '編程語言': '程式語言', '編程': '程式設計', '程序員': '程式設計師',
    '性能': '效能', '搜索': '搜尋', '插件': '外掛', '函數': '函式', '算法': '演算法', '文檔': '文件', '運行': '執行', '組件': '元件',
    '設置': '設定', '交互': '互動', '內核': '核心', '網絡': '網路', '互聯網': '網際網路', '在線': '線上', '發送': '傳送', '聯繫': '聯絡',
    '調用': '呼叫', '視頻': '影片', '音頻': '音訊', '高清': '高畫質', '界面': '介面', '接口': '介面', '計算機科學': '電腦科學',
    '人工智能': '人工智慧', '智能手機': '智慧型手機', '智能': '智慧', '循環': '迴圈', '遞歸': '遞迴', '優先級': '優先順序', '半角': '半形', '全角': '全形',
    '字符': '字元', '點擊': '點選', '視圖': '檢視', '博客': '部落格', '打印': '列印', '存儲': '儲存', '物理內存': '實體記憶體', '內存': '記憶體',
    '調試': '除錯', '查找': '查詢', '可視化': '視覺化', '表達式': '表示式', '默認': '預設', '圖標': '圖示', '通信': '通訊', '字體': '字型',
    '端口': '埠', '運算符': '運算子', '操作符': '運算子', '異步': '非同步', '兼容': '相容', '信號': '訊號', '鏈接': '連結', '模塊': '模組',
    '單片機': '微控制器', '綁定': '繫結', '粘貼': '貼上', '集成': '整合', '變量': '變數', '字段': '欄位', '模擬電路': '類比電路',
    '數字電路': '數位電路', '命令行': '命令列', '文件夾': '資料夾', '文件名': '檔名', '文字處理': '文書處理', '矢量': '向量', '批量': '批次',
    '窗口': '視窗', '調色板': '調色盤', '知識產權': '智慧財產權', '黑客': '駭客', '激活': '啟用', '仿真': '模擬', '中間件': '中介軟體',
    '密鑰': '金鑰', '調度': '排程', '導出': '匯出', '加載': '載入', '演示文稿': '簡報', '線程': '執行緒', '意大利': '義大利',
    '面向對象': '物件導向', '嵌套': '巢狀', '文本': '文字',
    '反饋': '回饋', '運營': '營運', '營銷': '行銷', '小程序': '小程式', '博主': '部落客', '移動端': '行動端', '服務端': '伺服器端',
    # 「質量」在這裡都是品質（沒有物理的質量）；「活動性質量身打造」是「性質」＋「量身」，原樣保留
    '性質量身': '性質量身', '質量': '品質',
    # 台灣不用的寫法（字本身是正體，OpenCC 不會動，簡體檢查也抓不到）
    '周報': '週報', '周末': '週末', '每周': '每週', '本周': '本週', '上周': '上週', '下周': '下週',
    '周一': '週一', '周二': '週二', '周三': '週三', '周四': '週四', '周五': '週五', '周六': '週六', '周日': '週日',
    '制作': '製作', '標題里': '標題裡', '這里': '這裡', '那里': '那裡', '哪里': '哪裡', '之后': '之後', '然后': '然後', '以后': '以後', '最后': '最後',
    # 保護詞：已經是台灣說法、或不是程式的意思，原樣保留（長的先對到，裡面的短詞就不會再換）
    '演算法': '演算法', '在線上': '在線上',
    '惡性循環': '惡性循環', '良性循環': '良性循環', '循環經濟': '循環經濟', '自然循環': '自然循環', '空氣循環': '空氣循環',
    '血液循環': '血液循環', '循環播放': '循環播放', '循環利用': '循環利用', '循環使用': '循環使用', '水循環': '水循環', '碳循環': '碳循環',
    '國家代碼': '國家代碼', '語言代碼': '語言代碼', '股票代碼': '股票代碼', '貨幣代碼': '貨幣代碼', '地區代碼': '地區代碼',
}
# 產出裡不能有的寫法：替換疊在一起、改壞的詞、台灣不用的寫法
BAD_PATTERNS = ['演演算法', '線上上', '程式程式碼', '確安全全', '名稱稱', '惡性迴圈', '自然迴圈', '空氣迴圈', '國家程式碼',
                '周報', '周末', '制作', '標題里', '這里', '那里', '哪里', '之后', '然后', '以后', '最后']
_TERMS = sorted(TW_TERMS, key=len, reverse=True)


_TERMS_RE = re.compile('|'.join(map(re.escape, _TERMS)))


def tw_terms(text: str) -> str:
    """大陸用語換成台灣用語（同一個位置長的詞先對到，「源代碼」不會變成「源程式碼」）"""
    return _TERMS_RE.sub(lambda m: TW_TERMS[m.group(0)], text)


def to_tw(text: str) -> str:
    """台灣正體＋台灣用語：含簡體字的段落用 OpenCC 轉；大陸用語全部換成台灣說法"""
    if not text:
        return text
    if any(c in SIMPLIFIED for c in text):
        text = S2TWP.convert(text)
        for a, b in TW_FIX.items():
            text = text.replace(a, b)
    return tw_terms(text)


def has_cjk(text: str) -> bool:
    return any('\u4e00' <= c <= '\u9fff' for c in text)


def fetch(name: str) -> tarfile.TarFile:
    src = SOURCES[name]
    path = CACHE / f"{src['repo'].replace('/', '__')}-{src['sha']}.tar.gz"
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        url = f"https://codeload.github.com/{src['repo']}/tar.gz/{src['sha']}"
        print(f'下載 {url}', file=sys.stderr)
        with urllib.request.urlopen(url, timeout=120) as r:
            path.write_bytes(r.read())
    return tarfile.open(path, 'r:gz')


def read_files(tar: tarfile.TarFile) -> dict[str, str]:
    """tar 裡的文字檔（不解壓到磁碟）：路徑去掉最上層資料夾"""
    files = {}
    for m in tar.getmembers():
        if not m.isfile() or not m.name.endswith(('.json', '.md', 'LICENSE')):
            continue
        rel = m.name.split('/', 1)[1] if '/' in m.name else m.name
        files[rel] = tar.extractfile(m).read().decode('utf-8')
    return files


def lobe_entries(files: dict[str, str]) -> list[dict]:
    """lobe 的繁中版：沒翻的名字和介紹換成 lobe-zh.json 補翻的；含簡體的轉台灣正體"""
    fix = json.loads(LOBE_ZH_FILE.read_text()) if LOBE_ZH_FILE.exists() else {}
    out = []
    for path in sorted(p for p in files if re.fullmatch(r'src/[^/]+\.json', p)):
        d = json.loads(files[path])
        ident = d['identifier']
        loc = {lang: json.loads(files[f'locales/{ident}/{f}']) for lang, f in (('zh', 'index.zh-TW.json'), ('en', 'index.json'))}
        meta = d['meta']
        zh_name, zh_desc = loc['zh']['meta']['title'], loc['zh']['meta'].get('description', '')
        f = fix.get(f'lobe:{ident}', {})
        if f.get('n') and not has_cjk(zh_name):
            zh_name = f['n']
        if f.get('d') and not has_cjk(zh_desc):
            zh_desc = f['d']
        out.append({
            'id': f'lobe:{ident}',
            'c': CATEGORY['lobe'][meta['category']],
            'e': meta.get('avatar', ''),
            'n': [to_tw(zh_name), loc['en']['meta']['title']],
            'd': [to_tw(zh_desc), loc['en']['meta'].get('description', '')],
            # 英文版的標籤也可能混著簡體中文
            't': sorted({to_tw(x) for x in loc['zh']['meta'].get('tags', []) + loc['en']['meta'].get('tags', [])}),
            'a': d.get('author', ''),
            'u': d.get('homepage', ''),
            'prompt': {'zh': to_tw(loc['zh']['config']['systemRole']), 'en': loc['en']['config']['systemRole']},
        })
    return out


def front_matter(text: str) -> tuple[dict, str]:
    m = re.match(r'---\n(.*?)\n---\n?', text, re.S)
    if not m:
        return {}, text
    meta = {}
    for k, v in re.findall(r'^(\w+):\s*(.*)$', m.group(1), re.M):
        meta[k] = v.strip().strip('"')
    return meta, text[m.end():].lstrip()


def agency_entries(files: dict[str, str], zh: dict) -> list[dict]:
    divisions = json.loads(files['divisions.json'])['divisions']
    out = []
    for path in sorted(files):
        div = path.split('/', 1)[0]
        if div not in divisions or not path.endswith('.md'):
            continue
        meta, body = front_matter(files[path])
        if not meta.get('name') or not meta.get('description'):
            continue
        ident = f'agency:{div}/{Path(path).stem}'
        t = zh.get(ident, {})
        out.append({
            'id': ident,
            'c': CATEGORY['agency'][div],
            'e': meta.get('emoji', ''),
            'n': [to_tw(t.get('n', '')), meta['name']],
            'd': [to_tw(t.get('d', '')), meta['description']],
            'v': [to_tw(t.get('v', '')), meta.get('vibe', '')],
            't': [divisions[div]['label']],
            'a': meta.get('author', '') or 'msitarzewski/agency-agents',
            'u': f"https://github.com/{SOURCES['agency']['repo']}/blob/{SOURCES['agency']['sha']}/{path}",
            'prompt': {'en': body},
        })
    return out


def translate(entries: list[dict], url: str, model: str) -> None:
    """agency 的名字、介紹、個性一句話翻成繁中（台灣用語），已經翻過的跳過；每批存一次"""
    zh = json.loads(ZH_FILE.read_text()) if ZH_FILE.exists() else {}
    todo = [e for e in entries if e['id'] not in zh]
    schema = {
        'type': 'object',
        'properties': {'items': {'type': 'array', 'items': {
            'type': 'object',
            'properties': {'id': {'type': 'string'}, 'n': {'type': 'string'}, 'd': {'type': 'string'}, 'v': {'type': 'string'}},
            'required': ['id', 'n', 'd', 'v'],
        }}},
        'required': ['items'],
    }
    def one(batch: list[dict]) -> list[dict]:
        src = [{'id': e['id'], 'name': e['n'][1], 'description': e['d'][1], 'vibe': e['v'][1]} for e in batch]
        prompt = (
            '把下面每個 AI 角色的 name、description、vibe 翻成繁體中文（台灣用語，例如「軟體」不是「软件」、「資料」不是「数据」、「品質」不是「质量」）。\n'
            '- n：職稱或角色名，簡短（2–8 個字），像「歷史學家」「資安架構師」\n'
            '- d：description 的意思完整翻出來，通順，不要加原文沒有的內容\n'
            '- v：vibe 那句個性話，保留語氣\n'
            '- 專有名詞（產品、平台名）保留原文，例如 Roblox、Unity、Salesforce\n'
            '- id 照抄\n\n' + json.dumps(src, ensure_ascii=False, indent=1)
        )
        body = json.dumps({'model': model, 'stream': False, 'format': schema, 'options': {'temperature': 0.2},
                           'messages': [{'role': 'user', 'content': prompt}]}).encode()
        req = urllib.request.Request(f'{url}/api/chat', data=body, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=900) as r:
            return json.loads(json.loads(r.read())['message']['content'])['items']

    # 主機有開並行（例如 OLLAMA_NUM_PARALLEL=4）：同時送 4 批；每批回來就存一次
    batches = [todo[i:i + 8] for i in range(0, len(todo), 8)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(one, b): b for b in batches}
        for fut in as_completed(futures):
            want = {e['id'] for e in futures[fut]}
            try:
                items = fut.result()
            except Exception as e:  # 這批失敗：下次再跑會補
                print(f'這批失敗：{e}', file=sys.stderr)
                continue
            for it in items:
                if it['id'] in want and it['n'].strip() and it['d'].strip():
                    zh[it['id']] = {'n': it['n'].strip(), 'd': it['d'].strip(), 'v': it['v'].strip()}
            ZH_FILE.parent.mkdir(parents=True, exist_ok=True)
            ZH_FILE.write_text(json.dumps(dict(sorted(zh.items())), ensure_ascii=False, indent=1) + '\n')
            print(f'翻好 {len(zh)}/{len(entries)}', file=sys.stderr)


def translate_lobe(entries: list[dict], url: str, model: str) -> None:
    """lobe 繁中版沒翻到（沒有中文字）的名字和介紹：照英文版翻成繁中（台灣用語）；人名、品牌、產品名保留原文"""
    fix = json.loads(LOBE_ZH_FILE.read_text()) if LOBE_ZH_FILE.exists() else {}
    todo = [e for e in entries if (not has_cjk(e['n'][0]) or not has_cjk(e['d'][0])) and e['id'] not in fix]
    schema = {'type': 'object', 'properties': {'items': {'type': 'array', 'items': {
        'type': 'object', 'properties': {'id': {'type': 'string'}, 'n': {'type': 'string'}, 'd': {'type': 'string'}}, 'required': ['id', 'n', 'd']}}}, 'required': ['items']}

    def one(batch: list[dict]) -> list[dict]:
        src = [{'id': e['id'], 'name': e['n'][1], 'description': e['d'][1]} for e in batch]
        prompt = (
            '把下面每個 AI 角色的 name、description 翻成繁體中文（台灣用語，例如「軟體」「資料」「程式」「專案」「使用者」，不要用簡體字和大陸用語）。\n'
            '- n：角色名，簡短，一定要有中文：描述性的名字直接翻成中文（Code Companion 是「程式碼夥伴」、Prompt Architect 是「提示詞架構師」）；'
            '人名、角色名或品牌（Alfred、Chad、BIDOSx2、GitHub Copilot）保留原文，後面用括號加 2–6 個字的中文說明他是誰，例如「Alfred（貼身管家）」\n'
            '- d：description 的意思完整翻出來，通順，不要加原文沒有的內容\n'
            '- 程式語言、產品名、縮寫保留原文（Python、React、AWS、SEO、PPT）\n'
            '- id 照抄\n\n' + json.dumps(src, ensure_ascii=False, indent=1)
        )
        body = json.dumps({'model': model, 'stream': False, 'format': schema, 'think': False, 'options': {'temperature': 0.2},
                           'messages': [{'role': 'user', 'content': prompt}]}).encode()
        req = urllib.request.Request(f'{url}/api/chat', data=body, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=900) as r:
            return json.loads(json.loads(r.read())['message']['content'])['items']

    batches = [todo[i:i + 8] for i in range(0, len(todo), 8)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(one, b): b for b in batches}
        for fut in as_completed(futures):
            want = {e['id'] for e in futures[fut]}
            try:
                items = fut.result()
            except Exception as e:  # 這批失敗：下次再跑會補
                print(f'這批失敗：{e}', file=sys.stderr)
                continue
            for it in items:
                if it['id'] in want and it['n'].strip() and it['d'].strip():
                    fix[it['id']] = {'n': to_tw(it['n'].strip()), 'd': to_tw(it['d'].strip())}
            LOBE_ZH_FILE.parent.mkdir(parents=True, exist_ok=True)
            LOBE_ZH_FILE.write_text(json.dumps(dict(sorted(fix.items())), ensure_ascii=False, indent=1) + '\n')
            print(f'補翻好 {len(fix)} 個', file=sys.stderr)


def check_traditional(entries: list[dict]) -> None:
    """
    中文欄位（名字、介紹、個性、標籤、角色原文）：不能有簡體字、不能有改壞或台灣不用的寫法，
    而且再轉一次也不會變（替換不能疊在一起，像「算法」把「演算法」改成「演演算法」）
    """
    bad = []
    for e in entries:
        texts = [e['n'][0], e['d'][0], *(e.get('v') or ['', ''])[:1], *e['t'], e['prompt'].get('zh', '')]
        found = sorted({c for x in texts for c in x if c in SIMPLIFIED})
        if found:
            bad.append(f"{e['id']}：簡體字 {''.join(found)}")
        words = sorted({p for x in texts for p in BAD_PATTERNS if p in x})
        if words:
            bad.append(f"{e['id']}：{'、'.join(words)}")
        if any(to_tw(x) != x for x in texts):
            bad.append(f"{e['id']}：再轉一次會變")
    if bad:
        sys.exit(f'還有 {len(bad)} 個問題：\n' + '\n'.join(bad[:20]))


def build(entries: list[dict], licenses: list[dict], draft: bool = False) -> None:
    check_traditional(entries)
    SIMPLIFIED_FILE.write_text(''.join(sorted(SIMPLIFIED)) + '\n')
    missing = [e['id'] for e in entries if not e['n'][0] or not e['d'][0]]
    if missing and draft:
        # 草稿：還沒翻的先用英文（開發時先跑測試用，不要 commit）
        for e in entries:
            for k in ('n', 'd', 'v'):
                if k in e and not e[k][0]:
                    e[k][0] = e[k][1]
    elif missing:
        sys.exit(f'還有 {len(missing)} 個沒有繁中名字或介紹（先跑 --translate）：{missing[:5]}')
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob('prompts-*.txt'):
        old.unlink()
    shards: list[dict] = [{}]
    size = 0
    index = []
    for e in entries:
        prompt = e.pop('prompt')
        n = len(json.dumps(prompt, ensure_ascii=False).encode())
        if size and size + n > SHARD_BYTES:
            shards.append({})
            size = 0
        shards[-1][e['id']] = prompt
        size += n
        e['s'] = len(shards) - 1
        if e['id'] in REVIEW:
            e['r'] = 1
        if 'v' in e and not any(e['v']):
            del e['v']
        index.append(e)
    for i, shard in enumerate(shards):
        (OUT_DIR / f'prompts-{i:02d}.txt').write_text(json.dumps(shard, ensure_ascii=False, separators=(',', ':')))
    OUT_INDEX.parent.mkdir(parents=True, exist_ok=True)
    OUT_INDEX.write_text(json.dumps({'shards': len(shards), 'licenses': licenses, 'entries': index}, ensure_ascii=False, separators=(',', ':')))
    # 分片檔要靜態 require，產生對照表
    lines = ['// 由 scripts/build_catalog.py 產生，不要手改', '/* eslint-disable */', 'export const PROMPT_SHARDS: number[] = [']
    lines += [f"  require('../../assets/agents/prompts-{i:02d}.txt')," for i in range(len(shards))]
    lines += ['];', '']
    (OUT_INDEX.parent / 'shards.ts').write_text('\n'.join(lines))
    total = sum(p.stat().st_size for p in OUT_DIR.glob('prompts-*.txt'))
    print(f'{len(index)} 個 Agent、{len(shards)} 個分片（{total / 1e6:.1f} MB）、索引 {OUT_INDEX.stat().st_size / 1e3:.0f} KB', file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--translate', metavar='OLLAMA_URL')
    ap.add_argument('--model', default='gemma4:31b')
    ap.add_argument('--draft', action='store_true', help='還沒翻的先用英文（不要 commit）')
    ap.add_argument('--translate-lobe', metavar='OLLAMA_URL')
    args = ap.parse_args()
    lobe_files = read_files(fetch('lobe'))
    agency_files = read_files(fetch('agency'))
    zh = json.loads(ZH_FILE.read_text()) if ZH_FILE.exists() else {}
    agency = agency_entries(agency_files, zh)
    if args.translate:
        translate(agency, args.translate.rstrip('/'), args.model)
        return
    if args.translate_lobe:
        translate_lobe(lobe_entries(lobe_files), args.translate_lobe.rstrip('/'), args.model)
        return
    licenses = [
        {'name': SOURCES[k]['repo'], 'url': f"https://github.com/{SOURCES[k]['repo']}", 'sha': SOURCES[k]['sha'], 'text': files['LICENSE']}
        for k, files in (('lobe', lobe_files), ('agency', agency_files))
    ]
    build(lobe_entries(lobe_files) + agency, licenses, args.draft)


if __name__ == '__main__':
    main()
