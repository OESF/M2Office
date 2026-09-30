# -*- coding: utf-8 -*-
"""マニュアル（開発者マニュアル・人事・給与のユーザーマニュアル）を 1 冊にまとめ、PDF にする。

Markdown は章ごとに分けたまま保守し、配布と通読のときだけ 1 本にまとめる。

使い方: python3 tools/pdf/build_manual.py [マニュアルの名前] [出力の PDF]
  マニュアルの名前: developer（既定。docs/developer/）・hr-payroll（docs/manual/hr-payroll/）・inventory（docs/manual/inventory/）
  既定の出力先は各マニュアルのディレクトリの PDF（版管理の対象外）
  前との互換のため、最初の引数が .pdf で終われば開発者マニュアルの出力先とみなす

行うこと:
  1. README（はじめに）と各章を番号順につなぐ
  2. 見出しを 1 段下げる（章 = H2。build.py は H2 ごとに改ページする）
  3. 章どうしのリンクを PDF の中のリンクに、リポジトリのファイルへのリンクをパスの表記に直す
  4. build.py で印刷用 HTML にし、Google Chrome で PDF に書き出す
"""
import io, os, re, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

# マニュアルごとの置き場と表紙
MANUALS = {
    'developer': {
        'dir': os.path.join(ROOT, 'docs', 'developer'), 'pdf': 'developer-manual.pdf',
        'title': 'M2Office 開発者マニュアル', 'subtitle': '業務エージェントとコネクタの作り方',
    },
    'inventory': {
        'dir': os.path.join(ROOT, 'docs', 'manual', 'inventory'), 'pdf': 'inventory-manual.pdf',
        'title': 'M2Office 在庫管理 ユーザーマニュアル', 'subtitle': '担当者の手引きと研修の教材',
    },
    'hr-payroll': {
        'dir': os.path.join(ROOT, 'docs', 'manual', 'hr-payroll'), 'pdf': 'hr-payroll-manual.pdf',
        'title': 'M2Office 人事・給与 ユーザーマニュアル', 'subtitle': '担当者の手引きと研修の教材',
    },
}
args = sys.argv[1:]
NAME = 'developer' if not args or args[0].endswith('.pdf') else args.pop(0)
if NAME not in MANUALS:
    sys.exit(f'知らないマニュアルです: {NAME}（{"・".join(MANUALS)}）')
MANUAL = MANUALS[NAME]
DOC_DIR = MANUAL['dir']
OUT = os.path.abspath(args[0]) if args else os.path.join(DOC_DIR, MANUAL['pdf'])
CHROME = os.environ.get('CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')

chapters = sorted(f for f in os.listdir(DOC_DIR) if re.match(r'^\d{2}-.+\.md$', f))
anchor = {f: f'ch{f[:2]}' for f in chapters}
anchor['README.md'] = 'intro'


def spec_version():
    m = re.search(r'^version:\s*(\S+)', io.open(os.path.join(ROOT, 'specification.md'), encoding='utf-8').read(), re.M)
    return m.group(1) if m else ''


def convert(name, text, first_heading):
    """見出しを 1 段下げ、リンクを直す。コードブロックの中は触らない。"""
    out, in_code, done_first = [], False, False
    for line in text.split('\n'):
        if line.startswith('```'):
            in_code = not in_code
            out.append(line)
            continue
        if in_code:
            out.append(line)
            continue
        # 印刷では、チェックリストの「[ ]」を四角にする
        line = re.sub(r'^(\s*)- \[ \] ', r'\1- □ ', line)
        m = re.match(r'^(#{1,5})\s+(.*)$', line)
        if m:
            level, title = len(m.group(1)), m.group(2)
            if level == 1 and not done_first:
                done_first = True
                out.append(f'## {first_heading or title} {{#{anchor[name]}}}')
                continue
            out.append('#' * min(level + 1, 6) + ' ' + title)
            continue
        out.append(fix_links(line))
    return '\n'.join(out)


def fix_links(line):
    def repl(m):
        label, target = m.group(1), m.group(2)
        if target.startswith(('http://', 'https://', '#')):
            return m.group(0)
        path = target.split('#')[0]
        base = os.path.basename(path)
        if os.path.dirname(path) in ('', '.') and base in anchor:
            return f'[{label}](#{anchor[base]})'
        # リポジトリのファイル・ディレクトリは、PDF では開けないのでパスを添えた表記にする
        rel = os.path.relpath(os.path.normpath(os.path.join(DOC_DIR, path)), ROOT)
        return label if label.strip('`') == rel.rstrip('/') else f'{label}（`{rel}`）'
    return re.sub(r'(?<!!)\[([^\]]+)\]\(([^)\s]+)\)', repl, line)


def main():
    readme = io.open(os.path.join(DOC_DIR, 'README.md'), encoding='utf-8').read()
    parts = [convert('README.md', readme, 'はじめに')]
    for f in chapters:
        parts.append(convert(f, io.open(os.path.join(DOC_DIR, f), encoding='utf-8').read(), None))

    version = spec_version()
    front = '\n'.join([
        '---',
        f"title: {MANUAL['title']}",
        f'version: 仕様書 第 {version} 版に対応',
        f"subtitle: {MANUAL['subtitle']}",
        f'updated: {__import__("datetime").date.today().isoformat()}',
        'owner: 株式会社M2ホールディングス',
        'wrap_code: true',
        '---',
        f"# {MANUAL['title']}",  # build.py が表紙に回して本文から除く
        '',
    ])
    work = tempfile.mkdtemp(prefix='m2o-manual-')
    md_path, html_path = os.path.join(work, 'manual.md'), os.path.join(work, 'manual.html')
    io.open(md_path, 'w', encoding='utf-8').write(front + '\n\n'.join(parts) + '\n')
    subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), 'build.py'), md_path, html_path], check=True)
    subprocess.run([
        CHROME, '--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
        '--run-all-compositor-stages-before-draw', '--virtual-time-budget=25000',
        f'--print-to-pdf={OUT}', f'file://{html_path}',
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('PDF 生成:', OUT, f'({os.path.getsize(OUT):,} バイト)')


if __name__ == '__main__':
    main()
