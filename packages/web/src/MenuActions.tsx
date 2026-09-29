/**
 * @file 左のメニューの縦の三点のボタンで出す操作の一覧の中身（仕様書 第6.1.1節「項目の操作」「カテゴリーの見出し」）。
 *
 * 業務の項目では、ピン止め・カテゴリーに入れる・入れない・作るを並べる。カテゴリーの見出しでは、名前を変える・消すを並べる。
 * 名前を入れる欄は一覧の中に開き、別の画面や確認を挟まない（ADR-0028）。
 */

import { useState } from 'react';
import type { MenuCategory } from '@m2office/shared';
import { RowMenuInput, RowMenuItem, RowMenuSeparator } from './nav.js';

/**
 * 業務の項目の操作の一覧。
 *
 * @param categoryId いま入っているカテゴリー（入っていなければ `null`）
 * @param onCreate カテゴリーを作ってこの業務を入れる。だめなら理由を返す
 */
export function ItemMenuActions({ pinned, categories, categoryId, onPin, onAssign, onCreate, close }: {
  pinned: boolean;
  categories: MenuCategory[];
  categoryId: string | null;
  onPin: () => void;
  onAssign: (categoryId: string | null) => void;
  onCreate: (name: string) => string | null;
  close: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const act = (fn: () => void) => { fn(); close(); };
  return (
    <>
      <RowMenuItem icon="pin" onSelect={() => act(onPin)}>{pinned ? 'ピン止めを外す' : 'ピン止めする'}</RowMenuItem>
      <RowMenuSeparator />
      {categories.map((c) => (
        <RowMenuItem key={c.id} checked={categoryId === c.id} onSelect={() => act(() => onAssign(c.id))}>{c.name}</RowMenuItem>
      ))}
      <RowMenuItem checked={categoryId === null} onSelect={() => act(() => onAssign(null))}>カテゴリーに入れない</RowMenuItem>
      <RowMenuSeparator />
      {creating
        ? (
          <RowMenuInput
            placeholder="カテゴリーの名前"
            onSubmit={(name) => {
              const error = onCreate(name);
              if (!error) close();
              return error;
            }}
            onCancel={() => setCreating(false)}
          />
        )
        : <RowMenuItem icon="folder" onSelect={() => setCreating(true)}>カテゴリーを作る</RowMenuItem>}
    </>
  );
}

/**
 * カテゴリーの見出しの操作の一覧。
 *
 * @param onRename 名前を変える。だめなら理由を返す
 * @param onRemove 消す（中の業務は「カテゴリーに入れない」に戻る）
 */
export function CategoryMenuActions({ category, onRename, onRemove, close }: {
  category: MenuCategory;
  onRename: (name: string) => string | null;
  onRemove: () => void;
  close: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  if (renaming) {
    return (
      <RowMenuInput
        initial={category.name} placeholder="カテゴリーの名前"
        onSubmit={(name) => {
          const error = onRename(name);
          if (!error) close();
          return error;
        }}
        onCancel={() => setRenaming(false)}
      />
    );
  }
  return (
    <>
      <RowMenuItem onSelect={() => setRenaming(true)}>名前を変える</RowMenuItem>
      <RowMenuItem onSelect={() => { onRemove(); close(); }}>カテゴリーを消す</RowMenuItem>
    </>
  );
}
