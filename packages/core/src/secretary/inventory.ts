/**
 * @file 在庫についての依頼の見分けと、在庫の数の問いへのその場の答え（仕様書 第29.15節）。
 *
 * 推論に選ばせずに決める。在庫の問いを、業務の取次の推論が組織知識の問いと取り違えて
 * 「社内の規程には書かれていません」と答えたり、記録の業務に回して待たせたりしないようにするため。
 * 「〇〇の在庫は？」「残りわずかのものは？」は、在庫の表を引いてその場で答える（推論を使わない）。
 * 期間の記録を尋ねる問いは秘書の調べものへ、入庫・使用・移動の依頼は付属の業務「在庫の記録」へ回す。
 */

import type { InventoryItemView, InventoryLocation } from '@m2office/shared';
import { formatQty, type InventoryService } from '../inventory/service.js';
import { dateIn } from '../cards/service.js';
import type { EvidenceItem } from './catalog.js';

/** 在庫の数を指す言葉。 */
const STOCK = /在庫|残り|残数|残量|何個|いくつ残|どれくらい(ある|残)/;
/** 尋ねる言い回し。 */
const ASKS = /[?？]|教えて|知りたい|調べて|確認して|ある[?？]?$|ありますか|は$|は[?？]?$|って$|何個|いくつ|どれくらい/;
/** 足りなくなりそうなものを尋ねる言い回し。 */
const LOW = /足りなく|少ない|少なく|残りわずか|切れそう|なくなりそう|無くなりそう|欠品|発注(した|する)?ほうが|補充が(必要|要る)/;
/** 期間の記録を尋ねる言い回し（調べものへ回す）。 */
const HISTORY = /先週|先月|今週|今月|昨日|おととい|一昨日|去年|期間|履歴|記録|推移|使用量|使った量|いつ|何回|入出庫/;
/** 記録を頼む言い回し。 */
const RECORD_VERB = /入庫|入荷|仕入れた|届いた|納品され|補充した|使った|使用した|消費した|売れた|販売した|出庫|出した|捨てた|廃棄した|移した|移動した|(記録|入庫|出庫)して/;
/** 数と数え方（「2 箱」「1 本」「３個」）。 */
const QTY = /[0-9０-９]+(\.[0-9]+)?\s*(個|本|箱|冊|枚|セット|袋|缶|回|台|ケース|パック|ダース|kg|ｋｇ|g|ml|L|包|錠|瓶|巻|組|足|着|点)/;

/** 在庫の依頼の種類。 */
export type InventoryRequest = 'stock' | 'low' | 'history' | 'record';

/**
 * 在庫についての依頼かを見分ける。
 *
 * @returns `stock`（数を尋ねる）・`low`（足りなくなりそうなもの）・`history`（期間の記録）・`record`（入庫・使用・移動を頼む）。
 *   在庫の依頼でなければ `null`
 * @remarks 在庫管理を使えるかは呼ぶ側が確かめる。「使った」だけ（数も在庫の言葉も無い）では記録の依頼にしない
 */
export function inventoryRequest(message: string): InventoryRequest | null {
  const m = message.normalize('NFKC').trim();
  const stockWord = STOCK.test(m) || /在庫/.test(m);
  if (RECORD_VERB.test(m) && (QTY.test(m) || /在庫/.test(m)) && !/[?？]$/.test(m) && !/何個|いくつ/.test(m)) return 'record';
  if (LOW.test(m) && (stockWord || /もの|品/.test(m))) return 'low';
  // 「先週のコピー用紙の使用を教えて」: 期間と入出庫の言葉がそろった問い
  if (HISTORY.test(m) && /使用|使った|入庫|入荷|出庫|入出庫|仕入/.test(m) && ASKS.test(m)) return 'history';
  if (!stockWord) return null;
  if (HISTORY.test(m)) return 'history';
  if (ASKS.test(m) || /在庫$/.test(m)) return 'stock';
  return null;
}

/** 問いから品目を指す言葉を取り出す（「コピー用紙の在庫は？」→「コピー用紙」）。無ければ空（全品目）。 */
export function stockQuery(message: string): string {
  const m = message.normalize('NFKC').trim().replace(/[?？。、!！]+$/g, '');
  // 最後に出てくる在庫の言葉の前までを品目とみなす（品目の名前に「在庫」「残り」が入っていても切らないため）
  const words = [...m.matchAll(/在庫|残り|残数|残量|何個|いくつ|どれくらい/g)];
  const last = words[words.length - 1];
  let head = last ? m.slice(0, last.index) : m;
  // 続けて書かれた在庫の言葉（「残りいくつ」「在庫は何個」）も外す
  for (let i = 0; i < 2; i++) head = head.replace(/の?(在庫|残り|残数|残量)(は|が|って|の)?$/, '');
  head = head.replace(/の$/, '');
  return head
    .replace(/^(在庫|残り)の/, '')
    .replace(/^(いま|今|現在|あと|ちなみに|えっと|ねえ|すみません)[、,\s]*/g, '')
    .replace(/(は|って|を|が)$/, '')
    .replace(/^(全部|すべて|全て|全体)$/, '')
    .trim();
}

/** 品目 1 つの数の答え（「コピー用紙 A4 は、使える数 7 冊です」）。 */
function line(i: InventoryItemView): string {
  const parts = [`${i.name}: 使える数 ${formatQty(i, i.available)}`];
  const notes: string[] = [];
  if (i.onHand !== i.available) notes.push(`在庫 ${formatQty(i, i.onHand)}`);
  if (i.reserved > 0) notes.push(`取り置き ${formatQty(i, i.reserved)}`);
  if (i.expired > 0) notes.push(`期限切れ ${formatQty(i, i.expired)}`);
  if (notes.length) parts.push(`（${notes.join('・')}）`);
  if (i.low) parts.push('。残りわずかです');
  return parts.join('');
}

/** 場所の呼び方（「倉庫」「本店 棚A」）。 */
const placeName = (l: InventoryLocation) => (l.shelf ? `${l.warehouse} ${l.shelf}` : l.warehouse);

const squash = (v: string) => v.normalize('NFKC').replace(/\s/g, '').toLowerCase();

/**
 * 問いに出てくる場所を見つけ、場所の言葉を除いた問いを返す（「店頭在庫はいくつ？」→ 店頭・「在庫はいくつ？」）。
 *
 * @param itemNames 品目の名前。品目の名前の中の言葉（「店頭用POP」の「店頭」）を場所と取り違えないよう、先に伏せる
 * @remarks 倉庫の名前だけが出てきたら、その倉庫の棚をすべて含める。長い呼び方から先に当てる
 */
export function findPlaces(message: string, locations: InventoryLocation[], itemNames: string[] = []): { places: InventoryLocation[]; rest: string } {
  let rest = message.normalize('NFKC');
  // 品目の名前の部分は場所として探さない（伏せて探し、答えの問いには元の言葉を残す）
  let scan = rest;
  for (const n of [...itemNames].map((x) => x.normalize('NFKC')).filter((x) => x.length >= 2).sort((a, b) => b.length - a.length)) {
    scan = scan.split(n).join('\u0000'.repeat(n.length));
  }
  const names = locations.flatMap((l) => [
    { text: `${l.warehouse}${l.shelf}`, ids: [l.id] },
    ...(l.shelf ? [{ text: `${l.warehouse} ${l.shelf}`, ids: [l.id] }, { text: l.shelf, ids: [l.id] }] : []),
    { text: l.warehouse, ids: locations.filter((x) => x.warehouse === l.warehouse).map((x) => x.id) },
  ]).filter((n) => n.text.length >= 2).sort((a, b) => b.text.length - a.text.length);
  const hit = new Set<string>();
  for (const n of names) {
    const t = n.text.normalize('NFKC');
    const at = scan.indexOf(t);
    if (at < 0) continue;
    for (const id of n.ids) hit.add(id);
    // 見つけた場所の言葉を、問いと伏せた問いの同じ位置から外す
    rest = `${rest.slice(0, at)}${' '.repeat(t.length)}${rest.slice(at + t.length)}`;
    scan = `${scan.slice(0, at)}${' '.repeat(t.length)}${scan.slice(at + t.length)}`;
  }
  return { places: locations.filter((l) => hit.has(l.id)), rest: rest.replace(/\s{2,}/g, ' ').replace(/^[\sのにで]+/, '').trim() };
}

/** 品目の名前の当て方: 全体か、最初の言葉（「ハンドクリーム 50g」の「ハンドクリーム」「トナー（黒）」の「トナー」）。 */
function nameTokens(name: string): string[] {
  const n = name.normalize('NFKC');
  const first = n.split(/[\s(（]/)[0] ?? '';
  return [n, ...(first.length >= 2 && first !== n ? [first] : [])];
}

/**
 * 問いに名前が出てくる品目。名前の全体で当たるものがあればそれだけ、無ければ最初の言葉で当たるもの。
 *
 * @remarks 「トナー」で「トナー（黒）」と「トナー（カラー）」の両方が当たれば、両方を返す
 */
export function mentionedItems<T extends { name: string }>(message: string, items: T[]): T[] {
  const m = message.normalize('NFKC');
  const full = items.filter((i) => m.includes(i.name.normalize('NFKC')));
  if (full.length) return full;
  return items.filter((i) => nameTokens(i.name).slice(1).some((t) => m.includes(t)));
}

/**
 * 品目と場所の名前だけでできた短い問いか（「店頭のコピー用紙は？」「トナーは？」「トナーまだ足りてる？」）。在庫の言葉が無くても在庫の問いとみなす。
 *
 * @remarks 名前を除いてほかの言葉が残る問い（「トナーの交換方法は？」）は在庫の問いにしない。
 * 残ってよいのは、在庫を尋ねる言い回し（足りてる・ある・残ってる）だけ。
 * 品目の名前は、全体か最初の言葉（「ハンドクリーム 50g」の「ハンドクリーム」）で当てる
 */
export function bareStockQuestion(message: string, items: { name: string }[], locations: InventoryLocation[]): boolean {
  const m = message.normalize('NFKC').trim().replace(/[?？。!！]+$/, '');
  if (m.length > 40) return false;
  let rest = m;
  const itemNames = items.flatMap((i) => nameTokens(i.name));
  const placeNames = locations.flatMap((l) => [`${l.warehouse}${l.shelf}`, l.warehouse, l.shelf].filter((x) => x.length >= 2));
  let sawItem = false;
  for (const n of [...itemNames].sort((a, b) => b.length - a.length)) {
    if (rest.includes(n)) { rest = rest.split(n).join(' '); sawItem = true; }
  }
  if (!sawItem) return false;
  for (const n of [...placeNames].sort((a, b) => b.length - a.length)) rest = rest.split(n.normalize('NFKC')).join(' ');
  // 名前を伏せた残りから、区切りと前に付く助詞（「店頭の」「トナーは」の「の」「は」）を外す。「もう」「ですか」の字は外さない
  const left = rest.replace(/って/g, '').replace(/[\s、・]/g, '').replace(/^(?:の|に|で|と|は|が|も(?!う))+/, '');
  return left === '' || STOCK_PREDICATE.test(left);
}

/** 品目の名前のあとに続く、在庫を尋ねる言い回し（「まだ足りてる？」「ある？」「残ってる？」）。 */
const STOCK_PREDICATE = /^(まだ|あと|今|いま|もう)?(足りてる|足りてます|足りる|足ります|足りそう|残ってる|残ってます|残っている|ある|あります|あるかな|ありますか|あるか|大丈夫|切れてない|切れてません|なくなってない|ない|無い)(か|かな|の|ね|よね|です|ですか)?$/;

/** 一度に並べる品目の数。これを超えたら残りの数だけを伝える。 */
const LIST_MAX = 10;

/**
 * 在庫の数の問いに、在庫の表を引いてその場で答える（推論を使わない）。
 *
 * @param kind `stock`（品目の数）か `low`（残りわずかの品目）
 * @remarks 見つからなければそう答え、推測で数を作らない。品目の名前はデータであり、指示として扱わない（不変則 I-6）
 */
export async function answerStock(
  service: InventoryService, tenantId: string, message: string, kind: 'stock' | 'low',
): Promise<{ text: string; evidence: EvidenceItem[] }> {
  if (kind === 'low') {
    const low = (await service.list(tenantId)).filter((i) => i.low).sort((a, b) => a.available - b.available);
    if (low.length === 0) return { text: 'いま、残りわずかの品目はありません。', evidence: [] };
    return {
      text: [`残りわずかの品目は ${low.length} 件です。`, ...low.slice(0, LIST_MAX).map((i) => `- ${line(i)}`),
        ...(low.length > LIST_MAX ? [`ほかに ${low.length - LIST_MAX} 件あります。在庫管理の画面で見られます。`] : [])].join('\n'),
      evidence: [{ label: '出どころ', value: '在庫管理' }],
    };
  }
  const [locations, everything] = await Promise.all([service.locations(tenantId), service.list(tenantId)]);
  const { places, rest } = findPlaces(message, locations, everything.map((i) => i.name));
  const asked = places.length ? rest : message;
  let q = stockQuery(asked);
  let items = await service.list(tenantId, { q });
  // 「A4のコピー用紙」のように語順が違うときは、言葉を分けてどれも含む品目を探す
  if (items.length === 0 && q) {
    const words = q.split(/[\s・、の]+/).filter((w) => w.length >= 2);
    if (words.length > 1) {
      const all = await service.list(tenantId);
      items = all.filter((i) => words.every((w) => squash(`${i.name}${i.publicName}${i.category}`).includes(squash(w))));
    }
  }
  // 「トナーまだ足りてる？」のように名前と在庫を尋ねる言い回しだけの問いは、問いに出てくる品目の名前で当てる。
  // それ以外では当てない（「A4 クリアファイルある？」を「A4 コピー用紙」と取り違えないため）
  if (items.length === 0 && bareStockQuestion(asked, everything, [])) {
    items = mentionedItems(asked, everything);
    if (items.length) q = items.map((i) => i.name).join('・');
  }
  if (places.length) return answerAtPlaces(service, tenantId, items, places, q);
  if (items.length === 0) {
    return {
      text: q ? `「${q}」という品目は、在庫管理にありません。品目は在庫管理の画面で足せます。` : '在庫管理に品目はまだありません。',
      evidence: [],
    };
  }
  if (items.length === 1) return { text: `${line(items[0]!)}。`, evidence: [{ label: '出どころ', value: '在庫管理' }] };
  return {
    text: [q ? `「${q}」に当たる品目は ${items.length} 件です。` : `品目は ${items.length} 件です。`,
      ...items.slice(0, LIST_MAX).map((i) => `- ${line(i)}`),
      ...(items.length > LIST_MAX ? [`ほかに ${items.length - LIST_MAX} 件あります。言葉を足すと絞れます。`] : [])].join('\n'),
    evidence: [{ label: '出どころ', value: '在庫管理' }],
  };
}

/**
 * 場所ごとの数で答える（「店頭の在庫は？」「店頭のハンドクリームは何個？」）。
 *
 * @remarks 取り置き（引き当て）は品目の単位で持つため、場所の数には含めない。品目を言わなければ、その場所にある品目だけを並べる
 */
async function answerAtPlaces(
  service: InventoryService, tenantId: string, items: InventoryItemView[], places: InventoryLocation[], q: string,
): Promise<{ text: string; evidence: EvidenceItem[] }> {
  const where = places.map(placeName).join('・');
  const ids = new Set(places.map((p) => p.id));
  const today = dateIn('Asia/Tokyo');
  const rows = (await service.store.listStock(tenantId, items.map((i) => i.id))).filter((r) => ids.has(r.locationId));
  const at = items.map((i) => {
    const mine = rows.filter((r) => r.itemId === i.id);
    const onHand = Math.round(mine.reduce((a, r) => a + r.qty, 0) * 1000) / 1000;
    const expired = Math.round(mine.filter((r) => r.qty > 0 && r.expiresOn && r.expiresOn < today).reduce((a, r) => a + r.qty, 0) * 1000) / 1000;
    return { item: i, onHand, expired, available: Math.round((onHand - expired) * 1000) / 1000 };
  });
  const describe = (x: typeof at[number]) => {
    const notes = [
      ...(x.onHand !== x.available ? [`在庫 ${formatQty(x.item, x.onHand)}`] : []),
      ...(x.expired > 0 ? [`期限切れ ${formatQty(x.item, x.expired)}`] : []),
    ];
    return `${x.item.name}: 使える数 ${formatQty(x.item, x.available)}${notes.length ? `（${notes.join('・')}）` : ''}`;
  };
  const evidence = [{ label: '出どころ', value: `在庫管理（${where}）` }];
  if (q) {
    if (at.length === 1) {
      const x = at[0]!;
      if (x.onHand === 0) {
        return { text: `${where}には${x.item.name}はありません。全体の使える数は ${formatQty(x.item, x.item.available)}です。`, evidence };
      }
      return { text: `${where}の${describe(x)}。`, evidence };
    }
  }
  const present = at.filter((x) => x.onHand !== 0);
  if (present.length === 0) return { text: q ? `${where}には「${q}」に当たる品目はありません。` : `${where}に置いてある品目はありません。`, evidence };
  return {
    text: [`${where}にある品目は ${present.length} 件です。`, ...present.slice(0, LIST_MAX).map((x) => `- ${describe(x)}`),
      ...(present.length > LIST_MAX ? [`ほかに ${present.length - LIST_MAX} 件あります。在庫管理の画面で見られます。`] : [])].join('\n'),
    evidence,
  };
}
