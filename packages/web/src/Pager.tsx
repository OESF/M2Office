/**
 * @file 一覧のページ送り（仕様書 第6.8節 原則 u14「増え続ける一覧は、件数で切らずにページで送る」）。
 *
 * 一覧を件数で切ると、古いものが見えず、開けず、削除できなくなる（2026-11-17 に 25 か所で見つかった）。
 * どの画面も同じ形で送れるよう、ページ送りの部品（{@link Pager}）と、ページを読む仕組み（{@link usePaged}）をここに置く。
 * API は `offset` で受けて、そのページの `items` とすべての数 `total` を返す。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** 1 ページの件数の既定（API の既定と同じ）。 */
export const PAGE_SIZE = 50;

/**
 * ページ送り。「‹ 前ページ」「51〜100 件め / 230 件」「次ページ ›」を並べる。1 ページに収まるときは何も出さない。
 *
 * @param page いまのページ（0 から）
 * @param total すべての数
 * @param onPage ページを変える
 */
export function Pager({ page, total, pageSize = PAGE_SIZE, onPage }: {
  page: number; total: number; pageSize?: number; onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="row pager">
      <button className="btn ghost small" disabled={page === 0} onClick={() => onPage(page - 1)}>‹ 前ページ</button>
      <span className="muted small">{page * pageSize + 1}〜{Math.min(total, (page + 1) * pageSize)} 件め / {total} 件</span>
      <button className="btn ghost small" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>次ページ ›</button>
    </div>
  );
}

/**
 * ページを読む。いまのページの一覧・すべての数・ページを変える関数・読み直す関数を返す。
 *
 * @remarks
 * `key` が変わったら（検索の言葉・絞り込みを変えたら）最初のページへ戻す。削除して件数が減り、いまのページが無くなったら、最後のページへ戻す。
 * 読めなかったときは `error` に理由を入れ、前の一覧は残す。
 *
 * @param load `offset` のページを読む
 * @param key 絞り込みの条件（変わったら最初のページから読み直す）
 */
export function usePaged<T>(load: (offset: number) => Promise<{ items: T[]; total: number }>, key = '', pageSize = PAGE_SIZE) {
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<T[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  // 遅れて届いた古い答えで、新しい答えを上書きしない
  const seq = useRef(0);
  const read = useCallback((p: number) => {
    const n = ++seq.current;
    return loadRef.current(p * pageSize).then((r) => {
      if (n !== seq.current) return;
      setItems(r.items);
      setTotal(r.total);
      setError(null);
      // 消して件数が減り、いまのページが無くなったら、最後のページへ戻す
      const last = Math.max(0, Math.ceil(r.total / pageSize) - 1);
      if (p > last) setPage(last);
    }).catch((e: unknown) => { if (n === seq.current) setError(e); });
  }, [pageSize]);
  useEffect(() => { setPage(0); }, [key]);
  useEffect(() => { void read(page); }, [page, key, read]);
  const reload = useCallback(() => read(page), [read, page]);
  return { items, total, page, setPage, reload, error, pageSize };
}
