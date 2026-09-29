#!/usr/bin/env python3
"""把片中实际用到的字符子集化成 woff2，并以 base64 内嵌进 index.html（/*FONTS:BEGIN*/ 与 /*FONTS:END*/ 之间）。

字符来源：index.html 里 /*TEXT:BEGIN*/ … /*TEXT:END*/ 之间的文字 + 可打印 ASCII。
改了屏幕文字之后重新运行：python3 scripts/fonts.py（需要 pip install fonttools brotli）
"""
import base64
import pathlib
import re
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / '.cache' / 'fonts'
GF = 'https://raw.githubusercontent.com/google/fonts/main/ofl'
SOURCES = {
    'NotoSerifSC[wght].ttf': f'{GF}/notoserifsc/NotoSerifSC%5Bwght%5D.ttf',
    'IBMPlexMono-Regular.ttf': f'{GF}/ibmplexmono/IBMPlexMono-Regular.ttf',
    'OFL-NotoSerifSC.txt': f'{GF}/notoserifsc/OFL.txt',
    'OFL-IBMPlexMono.txt': f'{GF}/ibmplexmono/OFL.txt',
}


def fetch(name):
    CACHE.mkdir(parents=True, exist_ok=True)
    p = CACHE / name
    if not p.exists():
        print(f'download {name}')
        urllib.request.urlretrieve(SOURCES[name], p)
    return p


def build(font, chars, out):
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.hinting = False
    opts.desubroutinize = True
    opts.layout_features = ['kern', 'liga', 'palt', 'vpal']
    sub = subset.Subsetter(opts)
    sub.populate(text=''.join(sorted(chars)))
    sub.subset(font)
    font.flavor = 'woff2'
    font.save(out)
    return out.read_bytes()


def main():
    html_path = ROOT / 'index.html'
    html = html_path.read_text(encoding='utf-8')
    block = re.search(r'/\*TEXT:BEGIN\*/(.*?)/\*TEXT:END\*/', html, re.S).group(1)
    block = re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), block)
    chars = set(block) | {chr(c) for c in range(0x20, 0x7F)} | {'’', '·'}
    chars -= {'\n', '\r', '\t'}

    out = ROOT / 'fonts'
    out.mkdir(exist_ok=True)
    data = {}
    for weight in (400, 600):
        vf = TTFont(fetch('NotoSerifSC[wght].ttf'))
        inst = instancer.instantiateVariableFont(vf, {'wght': weight})
        data[f'serif{weight}'] = build(inst, chars, out / f'NotoSerifSC-{weight}.subset.woff2')
    data['mono400'] = build(TTFont(fetch('IBMPlexMono-Regular.ttf')), chars, out / 'IBMPlexMono-400.subset.woff2')
    for lic in ('OFL-NotoSerifSC.txt', 'OFL-IBMPlexMono.txt'):
        (out / lic).write_bytes(fetch(lic).read_bytes())

    js = 'const FONT_DATA = {\n' + ''.join(f"  {k}: '{base64.b64encode(v).decode()}',\n" for k, v in data.items()) + '};\n'
    html = re.sub(r'/\*FONTS:BEGIN\*/.*?/\*FONTS:END\*/', lambda m: '/*FONTS:BEGIN*/\n' + js + '/*FONTS:END*/', html, flags=re.S)
    html_path.write_text(html, encoding='utf-8')
    cjk = sorted(c for c in chars if ord(c) > 0x2E80)
    print(f"subset {len(chars)} chars ({len(cjk)} CJK: {''.join(cjk)})")
    for k, v in data.items():
        print(f'  {k}: {len(v) / 1024:.1f} KB')


if __name__ == '__main__':
    main()
