/**
 * @file 資料のつながりの画面（グラフ。仕様書 第44.17.2節、ADR-0127）。force-graph（canvas 2D）で、点どうしが引き合い・離れ合って並ぶ形に描く。
 *
 * 資料を色の付いた丸に、タグを「# 名前」の淡い札にする（取引先・案件・種類などを区別せず、同じ形と色。資料より目立たせない。第44.17.3節）。点を押すと、その点とつながる点だけを明るくし、横に題名・要約・「開く」「詳しく」を出す。
 * 引っ張る・拡大・縮小ができる（指でもつまんで拡大できる）。言葉に当たった資料は輪で光らせる。
 * 色は画面の色の決まり（CSS の変数 `--graph-*`）から取り、暗い表示に切り替えたら描き直す。
 * このファイルは、グラフの画面を開いたときだけ読み込む（ほかの画面を重くしない）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph from 'force-graph';
import type { LibraryGraph, LibraryGraphLink, LibraryGraphNode } from '@m2office/shared';

/** 描く点（force-graph が位置を足す）。 */
type GNode = LibraryGraphNode & { x?: number; y?: number };
/** 描く線（force-graph が端を点に置き換える）。 */
type GLink = Omit<LibraryGraphLink, 'source' | 'target'> & { source: string | GNode; target: string | GNode };

/** 画面の色（CSS の変数から読む）。 */
interface Colors { types: string[]; tag: string; tagBg: string; link: string; hubLink: string; dim: string; accent: string; ink: string; panel: string }

function readColors(): Colors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    types: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--graph-${i}`)),
    tag: v('--graph-tag'), tagBg: v('--graph-tag-bg'), link: v('--graph-link'), hubLink: v('--graph-hub-link'), dim: v('--graph-dim'), accent: v('--accent'), ink: v('--ink'), panel: v('--panel'),
  };
}

const idOf = (end: string | GNode) => (typeof end === 'string' ? end : end.id);
const isHub = (n: Pick<GNode, 'kind'>) => n.kind !== 'item';
const radiusOf = (n: GNode) => Math.min(14, 4 + Math.sqrt(n.degree) * 1.5);

/** 資料の点の形を描く（丸）。 */
function shapeOf(ctx: CanvasRenderingContext2D, n: GNode, r: number) {
  ctx.beginPath();
  ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
}

/** タグの札の文字（長い名前は縮める）。 */
const chipText = (n: GNode) => `# ${n.label.length > 16 ? `${n.label.slice(0, 16)}…` : n.label}`;

/**
 * タグの札の大きさを決め、角の丸い四角の道を作る。画面の上で同じ大きさに見えるよう、拡大の倍率で割る。
 * 多くの資料に付いたタグほど、文字を少し大きくする。
 *
 * @returns 札の幅と高さ（グラフの座標）
 */
function chipPath(ctx: CanvasRenderingContext2D, n: GNode, scale: number): { w: number; h: number; font: number } {
  const font = (10 + Math.min(3, Math.sqrt(n.degree) * 0.6)) / scale;
  ctx.font = `600 ${font}px sans-serif`;
  const w = ctx.measureText(chipText(n)).width + (10 / scale);
  const h = font * 1.7;
  const x = (n.x ?? 0) - w / 2, y = (n.y ?? 0) - h / 2, r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  return { w, h, font };
}

/**
 * 資料のつながりを描く。
 *
 * @param props.graph 描く点と線（API の `/v1/library/graph` か `/v1/library/:id/graph`）
 * @param props.onOpen 資料の 1 件の画面を開く
 * @param props.compact 1 件の画面の小さなグラフ（ローカルグラフ）。点を押すと、その資料を開く
 * @param props.focusId はじめから選んでおく資料
 * @param props.onOpenFile 「開く」で実際の資料を開いたとき（確かめた記録。第44.16.1節）。無ければ何もしない
 */
export default function LibraryGraphView({ graph, onOpen, compact = false, focusId, onOpenFile }: {
  graph: LibraryGraph;
  onOpen: (id: string) => void;
  onOpenFile?: (id: string) => void;
  compact?: boolean;
  focusId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const fg = useRef<ForceGraph<GNode, GLink> | null>(null);
  const [selected, setSelected] = useState<string | null>(focusId ?? null);
  const [colors, setColors] = useState<Colors>(() => readColors());
  const state = useRef({ selected: focusId ?? null as string | null, hovered: null as string | null });

  // 描くための材料（色の割り当て・となり合う点・言葉に当たった点）
  const view = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of graph.nodes) if (n.kind === 'item') counts.set(n.docType, (counts.get(n.docType) ?? 0) + 1);
    const typeIndex = new Map([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t], i) => [t, Math.min(i, 7)]));
    const neighbors = new Map<string, Set<string>>();
    for (const l of graph.links) {
      const a = l.source, b = l.target;
      neighbors.set(a, (neighbors.get(a) ?? new Set()).add(b));
      neighbors.set(b, (neighbors.get(b) ?? new Set()).add(a));
    }
    return { typeIndex, neighbors, matched: new Set(graph.matched), byId: new Map(graph.nodes.map((n) => [n.id, n])) };
  }, [graph]);

  // 暗い表示に切り替えたら、色を読み直す
  useEffect(() => {
    const again = () => setColors(readColors());
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', again);
    const watch = new MutationObserver(again);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { media.removeEventListener('change', again); watch.disconnect(); };
  }, []);

  // グラフを作る（1 度だけ）。大きさは囲みに合わせる
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const g = new ForceGraph<GNode, GLink>(el);
    g.width(el.clientWidth).height(el.clientHeight).nodeId('id').cooldownTicks(compact ? 120 : 200);
    let fitted = false;
    g.onEngineStop(() => { if (!fitted) { fitted = true; g.zoomToFit(400, 32); } });
    const size = new ResizeObserver(() => { g.width(el.clientWidth).height(el.clientHeight); });
    size.observe(el);
    fg.current = g;
    return () => { size.disconnect(); g._destructor(); fg.current = null; };
  }, [compact]);

  // 点と線・描き方・触り方を渡す（材料か色か選んだ点が変わったら描き直す）
  useEffect(() => {
    const g = fg.current;
    if (!g) return;
    state.current.selected = selected;
    const near = (id: string) => {
      const s = state.current.selected ?? state.current.hovered;
      return !s || s === id || !!view.neighbors.get(s)?.has(id);
    };
    const colorOf = (n: GNode) => (n.kind === 'item' ? colors.types[view.typeIndex.get(n.docType) ?? 7] ?? colors.types[0]! : colors.tag);
    g.nodeCanvasObject((n, ctx, scale) => {
      const lit = near(n.id);
      if (isHub(n)) {
        // タグは淡い札（資料の丸より目立たせない）。選んだ・言葉に当たったタグは強調の色の縁
        const { font } = chipPath(ctx, n, scale);
        ctx.fillStyle = lit ? colors.tagBg : colors.panel;
        ctx.fill();
        const strong = view.matched.has(n.id) || state.current.selected === n.id;
        ctx.lineWidth = (strong ? 2 : 1) / scale;
        ctx.strokeStyle = strong ? colors.accent : lit ? colors.tag : colors.dim;
        ctx.stroke();
        ctx.font = `600 ${font}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = lit ? colors.tag : colors.dim;
        ctx.fillText(chipText(n), n.x ?? 0, (n.y ?? 0) + font * 0.05);
        return;
      }
      const r = radiusOf(n);
      shapeOf(ctx, n, r);
      ctx.fillStyle = lit ? colorOf(n) : colors.dim;
      ctx.fill();
      if (view.matched.has(n.id) || state.current.selected === n.id) {
        ctx.lineWidth = 2.5 / scale;
        ctx.strokeStyle = colors.accent;
        ctx.stroke();
      }
      // 資料の題名は、拡大したときか、選んだ・指した点とそのとなりだけ
      const showLabel = scale >= 2.2 || ((state.current.selected || state.current.hovered) && lit);
      if (!showLabel) return;
      const font = 11 / scale;
      ctx.font = `${font}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const label = n.label.length > 24 ? `${n.label.slice(0, 24)}…` : n.label;
      ctx.lineWidth = 3 / scale;
      ctx.strokeStyle = colors.panel;
      ctx.strokeText(label, n.x ?? 0, (n.y ?? 0) + r + 2 / scale);
      ctx.fillStyle = lit ? colors.ink : colors.dim;
      ctx.fillText(label, n.x ?? 0, (n.y ?? 0) + r + 2 / scale);
    });
    g.nodePointerAreaPaint((n, color, ctx, scale) => {
      ctx.fillStyle = color;
      if (isHub(n)) chipPath(ctx, n, scale);
      else shapeOf(ctx, n, radiusOf(n) + 2);
      ctx.fill();
    });
    g.nodeLabel((n) => (n.kind === 'item' ? `${n.label}${n.date ? `（${n.date}）` : ''}` : `タグ: ${n.label}`));
    g.linkColor((l) => {
      const s = state.current.selected ?? state.current.hovered;
      if (!s) return l.hub ? colors.hubLink : colors.link;
      return idOf(l.source) === s || idOf(l.target) === s ? colors.accent : colors.dim;
    });
    // 線は背景に対して見えるよう濃くする。タグとの線は点線にせず、資料どうしの線より細く淡い実線で分ける
    g.linkWidth((l) => (l.hub ? 1 : 1.2 + l.strength * 0.6));
    g.linkLabel((l) => l.reason);
    g.onNodeHover((n) => { state.current.hovered = n?.id ?? null; if (box.current) box.current.style.cursor = n ? 'pointer' : 'grab'; });
    g.onNodeClick((n) => {
      if (compact && n.kind === 'item' && n.id !== focusId) { onOpen(n.id); return; }
      setSelected((cur) => (cur === n.id ? null : n.id));
    });
    g.onBackgroundClick(() => setSelected(null));
  }, [view, colors, selected, compact, focusId, onOpen]);

  // 材料が変わったら（絞り込み）、点と線を入れ替える
  useEffect(() => {
    const g = fg.current;
    if (!g) return;
    g.graphData({ nodes: graph.nodes.map((n) => ({ ...n })), links: graph.links.map((l) => ({ ...l })) });
  }, [graph]);

  const node = selected ? view.byId.get(selected) ?? null : null;
  const items = node && isHub(node)
    ? graph.links.filter((l) => l.hub && l.source === node.id).map((l) => view.byId.get(l.target)).filter((x): x is LibraryGraphNode => !!x)
    : [];
  return (
    <div className={['library-graph', compact ? 'compact' : '', !compact && node ? 'has-card' : ''].filter(Boolean).join(' ')}>
      <div ref={box} className="library-graph-canvas" role="img" aria-label={`資料のつながり（${graph.shown.toLocaleString('ja-JP')} 件）`} />
      {!compact && node && (
        <div className="card library-graph-card" role="region" aria-label="選んだ点">
          {node.kind === 'item' ? (
            <>
              <strong className="library-title">{node.label}</strong>
              {node.date && <span className="small muted">{[node.docType, node.date].filter(Boolean).join(' ・ ')}</span>}
              {node.summary && <p className="small library-summary">{node.summary}</p>}
              <div className="row wrap">
                {node.url && <a className="btn small" href={node.url} target="_blank" rel="noreferrer" onClick={() => onOpenFile?.(node.id)}>開く</a>}
                <button className="btn ghost small" onClick={() => onOpen(node.id)}>詳しく</button>
              </div>
            </>
          ) : (
            <>
              <strong>{node.label}</strong>
              <span className="small muted">タグ ・ {items.length.toLocaleString('ja-JP')} 件の資料</span>
              <ul className="library-mails">
                {items.slice(0, 12).map((i) => <li key={i.id}><button className="link-btn library-version-link" onClick={() => onOpen(i.id)}>{i.label}</button></li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
