/**
 * @file 表の列を選ぶ（2026-10-19 に三浦さんが、M2Office の中の表をすべて、見せる列を選べるようにするよう求めた）。
 *
 * 画面の土台に 1 つだけ置き、見出しのある表（`table.table`）を見つけて、表にマウスを重ねたときに右上へ「列」のボタンを出す。
 * 押すと見出しの一覧が出て、見せる列を選べる。選んだ列は、その端末で表ごとに覚える（見出しの並びで見分ける）。
 * 表の部品には手を入れない: 隠す列は、表に付けた印（`data-tcols`）と、まとめて作った見た目の決まりで隠す。ボタンと一覧は表の外（文書の末尾）に出す。
 * 暦やシフトの升目のように、列を消すと意味が崩れる表（{@link FIXED_CLASSES}）と、見出しが 3 つに満たない表には出さない。見出しの無い列（操作のボタンの列など）はいつも出す。
 *
 * **はじめは隠す列**: 表を作る側が見出しに `data-col-default="hidden"` を付けた列は、はじめは隠し、一覧で選ぶと出る
 * （いまは表に無い項目（販売価格など）を選んで出せるようにするため）。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** 列を選ばせない表（升目・会話の中の表）。 */
const FIXED_CLASSES = ['shift-grid', 'hr-calendar', 'rsv-week', 'myhr-days', 'md-table'];
/** 覚えておく置き場の名前の頭。 */
const KEY_PREFIX = 'm2o.tablecols.';
/** 隠す列の見た目の決まりを入れる要素の ID。 */
const STYLE_ID = 'm2o-table-columns';

/** 表の見出しの名前（左から）。 */
function headersOf(t: HTMLTableElement): string[] {
  const row = t.tHead?.rows[t.tHead.rows.length - 1];
  return row ? Array.from(row.cells, (c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()) : [];
}

/** 列を選べる表か。 */
function choosable(t: HTMLTableElement): boolean {
  if (FIXED_CLASSES.some((c) => t.classList.contains(c)) || t.dataset['columns'] === 'fixed') return false;
  const row = t.tHead?.rows[t.tHead.rows.length - 1];
  // 見出しを横につないだ表（colspan）は列の数え方が崩れるため出さない
  if (!row || Array.from(row.cells).some((c) => c.colSpan > 1)) return false;
  return headersOf(t).filter(Boolean).length >= 3;
}

/** 覚えておく名前（見出しの並びで表を見分ける）。 */
const keyOf = (headers: string[]) => `${KEY_PREFIX}${headers.join('|')}`;

/** 表を作る側が「はじめは隠す」とした列の名前。 */
function defaultHiddenOf(t: HTMLTableElement): string[] {
  const row = t.tHead?.rows[t.tHead.rows.length - 1];
  return row ? Array.from(row.cells).filter((c) => (c as HTMLElement).dataset['colDefault'] === 'hidden').map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()) : [];
}

/** 覚えている選び方（`h` は隠した列、`s` ははじめは隠す列のうち出した列）。読めなければ何も選んでいない。 */
function choiceOf(headers: string[]): { h: string[]; s: string[] } {
  try {
    const v = JSON.parse(localStorage.getItem(keyOf(headers)) ?? '[]') as unknown;
    const pick = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && headers.includes(x)) : []);
    // 前の形（隠した列の配列）も読む
    if (Array.isArray(v)) return { h: pick(v), s: [] };
    const o = (v ?? {}) as { h?: unknown; s?: unknown };
    return { h: pick(o.h), s: pick(o.s) };
  } catch {
    return { h: [], s: [] };
  }
}

/** いま隠す列（はじめは隠す列のうち出していないものと、隠した列）。 */
function hiddenOf(headers: string[], defaults: string[]): string[] {
  const c = choiceOf(headers);
  return headers.filter((h) => h && (c.h.includes(h) || (defaults.includes(h) && !c.s.includes(h))));
}

/** 隠す列を覚える（はじめの状態と同じなら消す）。 */
function saveHidden(headers: string[], defaults: string[], hidden: string[]): void {
  const h = hidden.filter((x) => !defaults.includes(x));
  const s = defaults.filter((x) => !hidden.includes(x));
  try {
    if (h.length || s.length) localStorage.setItem(keyOf(headers), JSON.stringify({ h, s }));
    else localStorage.removeItem(keyOf(headers));
  } catch {
    // 覚えられなくても、いま開いている画面では効く
  }
}

let seq = 0;
/** 表ごとの印（隠す列の決まりを当てるため）。 */
function idOf(t: HTMLTableElement): string {
  if (!t.dataset['tcols']) t.dataset['tcols'] = `t${++seq}`;
  return t.dataset['tcols'];
}

/** すべての表の隠す列の見た目の決まりを作り直す。 */
function applyAll(): void {
  const rules: string[] = [];
  document.querySelectorAll<HTMLTableElement>('table.table').forEach((t) => {
    if (!choosable(t)) return;
    const headers = headersOf(t);
    const hidden = hiddenOf(headers, defaultHiddenOf(t));
    if (!hidden.length) return;
    const id = idOf(t);
    for (const name of hidden) {
      const n = headers.indexOf(name) + 1;
      if (n > 0) rules.push(`table.table[data-tcols="${id}"] > * > tr > :nth-child(${n}) { display: none; }`);
    }
  });
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  const css = rules.join('\n');
  if (style.textContent !== css) style.textContent = css;
}

/** 表の見えている右上（横に流せる枠の中なら、枠の右端）。 */
function cornerOf(t: HTMLTableElement): { top: number; right: number } {
  const r = t.getBoundingClientRect();
  const scroller = t.closest('.table-scroll');
  const right = scroller ? Math.min(r.right, scroller.getBoundingClientRect().right) : r.right;
  return { top: r.top, right };
}

/**
 * 表の列を選ぶ部品。画面の土台に 1 つだけ置く。
 */
export function TableColumns() {
  const [table, setTable] = useState<HTMLTableElement | null>(null);
  const [open, setOpen] = useState(false);
  const [, rerender] = useState(0);
  const menu = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);

  // 表が増えた・変わったら、覚えている隠す列を当て直す
  useEffect(() => {
    applyAll();
    let pending = false;
    const obs = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; applyAll(); });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  // 表にマウスを重ねたら、その表の右上にボタンを出す
  useEffect(() => {
    const over = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest('.tcols-ui')) { if (hideTimer.current) clearTimeout(hideTimer.current); return; }
      const t = target?.closest('table.table') as HTMLTableElement | null;
      if (t && choosable(t)) {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        setTable((cur) => (cur === t ? cur : t));
      } else if (!open) {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => setTable(null), 400);
      }
    };
    const scroll = () => { if (!open) setTable(null); else rerender((n) => n + 1); };
    document.addEventListener('mouseover', over);
    window.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('mouseover', over); window.removeEventListener('scroll', scroll, true); };
  }, [open]);

  // 一覧の外を押したら閉じる
  useEffect(() => {
    if (!open) return undefined;
    const down = (e: MouseEvent) => { if (!(e.target as Element | null)?.closest('.tcols-ui')) { setOpen(false); setTable(null); } };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setTable(null); } };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  if (!table || !table.isConnected) return null;
  const headers = headersOf(table);
  const named = headers.filter(Boolean);
  const defaults = defaultHiddenOf(table);
  const hidden = hiddenOf(headers, defaults);
  const { top, right } = cornerOf(table);
  // 一覧は下に開く。下に余白が無ければ上に開き、高さを画面に収める
  const btnTop = Math.max(4, top + 4);
  const below = window.innerHeight - btnTop - 32;
  const up = below < 240 && btnTop > below;
  const menuStyle = up ? { top: 'auto', bottom: 'calc(100% + 4px)', maxHeight: Math.max(120, btnTop - 12) } : { maxHeight: Math.max(120, below) };
  const toggle = (name: string, show: boolean) => {
    const next = show ? hidden.filter((h) => h !== name) : [...hidden, name];
    // 少なくとも 1 つの列は残す
    if (named.every((h) => next.includes(h))) return;
    saveHidden(headers, defaults, next);
    applyAll();
    rerender((n) => n + 1);
  };
  return createPortal(
    <div className="tcols-ui" style={{ position: 'fixed', top: btnTop, left: right - 4, transform: 'translateX(-100%)', zIndex: 1000 }}>
      <button type="button" className={`tcols-btn${hidden.length ? ' on' : ''}`} aria-expanded={open} aria-haspopup="true" title="表示する列を選ぶ"
        onClick={() => setOpen(!open)}>列{hidden.length ? `（${named.length - hidden.length}/${named.length}）` : ''}</button>
      {open && (
        <div className="tcols-menu" ref={menu} role="menu" style={menuStyle}>
          {named.map((h) => (
            <label key={h} className="check">
              <input type="checkbox" checked={!hidden.includes(h)} onChange={(e) => toggle(h, e.target.checked)} />
              {h}
            </label>
          ))}
          {(hidden.length !== defaults.length || hidden.some((h) => !defaults.includes(h))) && (
            <button type="button" className="link-btn small" onClick={() => { saveHidden(headers, defaults, defaults); applyAll(); rerender((n) => n + 1); }}>はじめの表示に戻す</button>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
