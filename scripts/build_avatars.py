#!/usr/bin/env python3
"""圖鑑 788 個角色的像素頭像。

三步：
  python3 scripts/build_avatars.py describe --ollama http://<電腦位址>:11434
      每個角色寫一句英文外觀描述（給生圖用），存 scripts/catalog/avatar-subjects.json；已經寫過的跳過
  python3 scripts/build_avatars.py generate --style A --comfy http://<電腦位址>:8188
      用本機或區網的 ComfyUI（Z-Image Turbo）每個角色生一張 512×512，存在 ~/.cache/local-chat-catalog/avatars/<風格>/；已經生過的跳過
  python3 scripts/build_avatars.py pack --style A
      縮成 48×48 的像素格、放大兩倍成 96×96，每個角色一個檔 assets/agents/avatars/N.png，對照表 src/agents/avatars.ts

風格（使用者挑）：A 16 位元 RPG、B 8 位元大顆粒、C 細緻陰影（Stardew）
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / 'src' / 'agents' / 'catalog.json'
SUBJECTS = ROOT / 'scripts' / 'catalog' / 'avatar-subjects.json'
CACHE = Path.home() / '.cache' / 'local-chat-catalog' / 'avatars'
OUT_DIR = ROOT / 'assets' / 'agents' / 'avatars'
AVATAR_MAP = ROOT / 'src' / 'agents' / 'avatars.ts'
GRID = 48
TILE = 96

STYLES = {
    'A': '16-bit SNES-era RPG character portrait, pixel art, {subject}, head and shoulders, front-facing, centered, limited 32-color palette, crisp hard pixel edges, no anti-aliasing, flat soft {bg} solid background, game dialogue portrait style',
    'B': '8-bit retro pixel art avatar, very low resolution 32x32 look with large chunky pixels, {subject}, head and shoulders, front-facing, centered, only 8 colors, NES style, flat soft {bg} solid background, no gradients',
    'C': 'pixel art character portrait in the style of Stardew Valley dialogue portraits, detailed pixel shading with dithering, {subject}, head and shoulders, front-facing, centered, warm color palette, crisp pixels, no anti-aliasing, flat soft {bg} solid background',
}
BACKGROUNDS = ['teal', 'lavender', 'peach', 'mint green', 'sky blue', 'pale yellow', 'pink', 'light grey']


def entries() -> list[dict]:
    return json.loads(INDEX.read_text())['entries']


def h(s: str) -> int:
    return int(hashlib.sha1(s.encode()).hexdigest()[:8], 16)


def safe(ident: str) -> str:
    return ident.replace(':', '__').replace('/', '__')


def describe(url: str, model: str) -> None:
    """一句英文外觀描述：職業特徵、性別年紀多樣；奇幻、動物角色就照角色畫"""
    subjects = json.loads(SUBJECTS.read_text()) if SUBJECTS.exists() else {}
    todo = [e for e in entries() if e['id'] not in subjects]
    schema = {'type': 'object', 'properties': {'items': {'type': 'array', 'items': {'type': 'object', 'properties': {'id': {'type': 'string'}, 'subject': {'type': 'string'}}, 'required': ['id', 'subject']}}}, 'required': ['items']}

    def one(batch: list[dict]) -> list[dict]:
        src = [{'id': e['id'], 'name': e['n'][1], 'about': e['d'][1][:200]} for e in batch]
        prompt = (
            'For each AI character below, write ONE short English description of how their pixel-art portrait should look '
            '(the subject only, 8-20 words): who they are visually, clothing or props that show their role. '
            'Vary gender, age and ethnicity across characters. If the character is a creature, deity, fantasy or game character, '
            'draw them as that. No text, no logos, no brand names. Example: "a middle-aged woman chef with a white toque and a wooden spoon".\n'
            'Keep id unchanged.\n\n' + json.dumps(src, ensure_ascii=False, indent=1)
        )
        body = json.dumps({'model': model, 'stream': False, 'format': schema, 'think': False, 'options': {'temperature': 0.7},
                           'messages': [{'role': 'user', 'content': prompt}]}).encode()
        req = urllib.request.Request(f'{url}/api/chat', data=body, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=900) as r:
            return json.loads(json.loads(r.read())['message']['content'])['items']

    batches = [todo[i:i + 10] for i in range(0, len(todo), 10)]
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
                if it['id'] in want and it['subject'].strip():
                    subjects[it['id']] = it['subject'].strip().rstrip('.')
            SUBJECTS.parent.mkdir(parents=True, exist_ok=True)
            SUBJECTS.write_text(json.dumps(dict(sorted(subjects.items())), ensure_ascii=False, indent=1) + '\n')
            print(f'描述好 {len(subjects)}/{len(entries())}', file=sys.stderr)


def workflow(text: str, seed: int) -> dict:
    return {
        '1': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'z_image_turbo_bf16.safetensors', 'weight_dtype': 'default'}},
        '2': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'qwen_3_4b_fp8_mixed.safetensors', 'type': 'lumina2'}},
        '3': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'ae.safetensors'}},
        '4': {'class_type': 'ModelSamplingAuraFlow', 'inputs': {'model': ['1', 0], 'shift': 3}},
        '5': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['2', 0], 'text': text}},
        '6': {'class_type': 'ConditioningZeroOut', 'inputs': {'conditioning': ['5', 0]}},
        '7': {'class_type': 'EmptySD3LatentImage', 'inputs': {'width': 512, 'height': 512, 'batch_size': 1}},
        '8': {'class_type': 'KSampler', 'inputs': {'model': ['4', 0], 'positive': ['5', 0], 'negative': ['6', 0], 'latent_image': ['7', 0],
                                                    'seed': seed, 'steps': 9, 'cfg': 1.0, 'sampler_name': 'res_multistep', 'scheduler': 'simple', 'denoise': 1.0}},
        '9': {'class_type': 'VAEDecode', 'inputs': {'samples': ['8', 0], 'vae': ['3', 0]}},
        '10': {'class_type': 'SaveImage', 'inputs': {'images': ['9', 0], 'filename_prefix': 'localchat_avatar'}},
    }


def generate(style: str, server: str) -> None:
    subjects = json.loads(SUBJECTS.read_text())
    out = CACHE / style
    out.mkdir(parents=True, exist_ok=True)
    todo = [e for e in entries() if not (out / f"{safe(e['id'])}.png").exists()]
    missing = [e['id'] for e in todo if e['id'] not in subjects]
    if missing:
        sys.exit(f'還有 {len(missing)} 個沒有外觀描述（先跑 describe）：{missing[:3]}')

    def call(path: str, data: dict | None = None) -> bytes:
        req = urllib.request.Request(server + path, data=json.dumps(data).encode() if data else None, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()

    def one(e: dict) -> None:
        text = STYLES[style].format(subject=subjects[e['id']], bg=BACKGROUNDS[h(e['id']) % len(BACKGROUNDS)])
        pid = json.loads(call('/prompt', {'prompt': workflow(text, h(e['id']))}))['prompt_id']
        while True:
            hist = json.loads(call(f'/history/{pid}'))
            if pid in hist:
                st = hist[pid]['status']
                if st.get('status_str') == 'error':
                    raise RuntimeError(json.dumps(st)[:500])
                img = hist[pid]['outputs']['10']['images'][0]
                break
            time.sleep(0.5)
        q = urllib.parse.urlencode({'filename': img['filename'], 'subfolder': img['subfolder'], 'type': img['type']})
        (out / f"{safe(e['id'])}.png").write_bytes(call(f'/view?{q}'))

    t0 = time.time()
    # ComfyUI 一次畫一張：同時送 2 個，排隊不空轉
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(one, e): e for e in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                fut.result()
            except Exception as err:  # 這張失敗：下次再跑會補
                print(f"失敗 {futures[fut]['id']}：{err}", file=sys.stderr)
            if i % 20 == 0 or i == len(todo):
                print(f'生好 {i}/{len(todo)}（{time.time() - t0:.0f} 秒）', file=sys.stderr)


def pack(style: str) -> None:
    """每個角色一個小檔（48×48 的像素格放大兩倍成 96×96：32pt 的頭像在 3 倍螢幕剛好不模糊）；
    畫面用到才載入（拼成一張大圖的話，手機解開要好幾十 MB）"""
    from PIL import Image

    src = CACHE / style
    ids = [e['id'] for e in entries() if (src / f"{safe(e['id'])}.png").exists()]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob('*.png'):
        old.unlink()
    for i, ident in enumerate(ids):
        im = Image.open(src / f'{safe(ident)}.png').convert('RGB')
        # 先取平均縮成像素格、減成 32 色（邊緣才俐落），再放大兩倍
        small = im.resize((GRID, GRID), Image.BOX).quantize(colors=32, method=Image.Quantize.MEDIANCUT)
        small.resize((TILE, TILE), Image.NEAREST).save(OUT_DIR / f'{i}.png', optimize=True)
    lines = ['// 由 scripts/build_avatars.py 產生，不要手改', '/* eslint-disable */', f'/** 圖鑑角色的像素頭像（風格 {style}） */', 'export const AVATARS: Record<string, number> = {']
    lines += [f"  {json.dumps(ident)}: require('../../assets/agents/avatars/{i}.png')," for i, ident in enumerate(ids)]
    lines += ['};', '']
    AVATAR_MAP.write_text('\n'.join(lines))
    total = sum(p.stat().st_size for p in OUT_DIR.glob('*.png'))
    print(f'{len(ids)} 個頭像、共 {total / 1e6:.1f} MB', file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    d = sub.add_parser('describe')
    d.add_argument('--ollama', default=os.environ.get('OLLAMA_URL', 'http://localhost:11434'))
    d.add_argument('--model', default='gemma4:31b')
    g = sub.add_parser('generate')
    g.add_argument('--style', choices=list(STYLES), required=True)
    g.add_argument('--comfy', default=os.environ.get('COMFY_URL', 'http://localhost:8188'))
    s = sub.add_parser('pack')
    s.add_argument('--style', choices=list(STYLES), required=True)
    a = ap.parse_args()
    if a.cmd == 'describe':
        describe(a.ollama.rstrip('/'), a.model)
    elif a.cmd == 'generate':
        generate(a.style, a.comfy.rstrip('/'))
    else:
        pack(a.style)


if __name__ == '__main__':
    main()
