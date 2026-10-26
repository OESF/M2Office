/**
 * @file 販売の書類の PDF を作る（仕様書 第42.3節・第42.4節）。見積書と同じ会社の体裁（型・ロゴ・差出人・印影）を使う。
 *
 * 型は会社が見積書で選んだもの（罫線の表・シンプル）を 4 つの書類にも使う（書類ごとに選ばせない）。
 * 表題と前文の既定は書類ごとに持つ。下書きは薄く「下書き」と入れ、番号は「発行時に付けます」とする（第42.3.1節）。
 */

import { SALES_DOC_KIND_LABELS, type SalesDocKind, type TenantSettings } from '@m2office/shared';
import { renderPdf, renderRuledQuote, type InvoiceRow, type InvoiceStyleInput } from '../files/pdf-render.js';
import { itemAmount, yenMark, yenText } from './calc.js';
import type { StoredDoc } from './store.js';

/** 書類ごとの表題・前文・番号の呼び方（第42.3節）。 */
export const DOC_WORDS: Record<SalesDocKind, { title: string; greeting: string; number: string; date: string; due: string; headline: string }> = {
  purchase_order: { title: '御注文書', greeting: '下記の通り、注文いたします。', number: '注文番号', date: '注文日', due: '納期', headline: '合計金額' },
  delivery: { title: '納品書', greeting: '下記の通り、納品いたします。', number: '納品番号', date: '納品日', due: '', headline: '合計金額' },
  invoice: { title: '御請求書', greeting: '下記の通り、ご請求申し上げます。', number: '請求番号', date: '請求日', due: 'お支払期限', headline: 'ご請求金額' },
  receipt: { title: '領収書', greeting: '', number: '領収番号', date: '日付', due: '', headline: '金額' },
};

/** 宛名に敬称を付ける（個人の名前らしければ「様」、それ以外は「御中」。付いていればそのまま）。 */
export function addressee(name: string, person: string, honorific = ''): string {
  if (!name && !person) return '';
  if (/(御中|様|殿)$/.test(name)) return name;
  if (person) return `${name ? `${name} ` : ''}${person.replace(/\s*(様|殿)$/, '')} 様`;
  return `${name} ${honorific || '御中'}`;
}

/** 日付を「2026年10月26日」にする。 */
const jp = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日` : '');

/** 書類の番号の欄（下書きは番号が無い。訂正版は版を添える）。 */
export function numberText(d: Pick<StoredDoc, 'number' | 'version' | 'status'>): string {
  if (!d.number) return '（発行時に付けます）';
  return d.version > 1 ? `${d.number}（訂正版 ${d.version}）` : d.number;
}

/**
 * 書類の PDF を作る。
 *
 * @param style 会社の帳票の体裁（ロゴ・差出人・印影・振込先）
 * @param settings 会社の設定（型と端数）
 */
export async function renderSalesDoc(d: StoredDoc, style: InvoiceStyleInput, settings: Pick<TenantSettings, 'invoice'>): Promise<Uint8Array> {
  const w = DOC_WORDS[d.kind];
  const qs = settings.invoice.quote;
  const to = addressee(d.party.name, d.party.person);
  const fields = [
    { label: w.number, value: numberText(d) },
    { label: w.date, value: jp(d.issuedOn) },
    ...(d.subject && d.kind !== 'receipt' ? [{ label: '件名', value: d.subject }] : []),
    ...(w.due && d.dueOn ? [{ label: w.due, value: jp(d.dueOn) }] : []),
    ...(d.kind === 'purchase_order' && d.terms ? [{ label: 'お支払い条件', value: d.terms }] : []),
  ];
  const reduced = d.items.some((i) => i.taxRate === 8);
  // 振込先は請求書だけに載せる（納品書・領収書・注文書には載せない。第42.4.2節）
  const notes = [
    ...(d.kind === 'invoice' && style.bankAccount ? [`お振込先: ${style.bankAccount}`] : []),
    ...(d.kind !== 'purchase_order' && d.terms ? [`条件: ${d.terms}`] : []),
    ...(d.notes ? [d.notes] : []),
    ...(reduced ? ['※は軽減税率（8%）の対象です'] : []),
    // 領収書は税率ごとの内訳を添える（適格簡易請求書の記載。第42.4.4節）
    ...(d.kind === 'receipt' ? d.taxLines.map((x) => `（内訳）${x.rate}% 対象 ${yenText(x.base)}・消費税 ${yenText(x.tax)}`) : []),
    ...(d.kind === 'invoice' && style.notes ? [style.notes] : []),
  ].slice(0, 10);
  const stamp = d.status === 'draft' ? '下書き' : d.status === 'cancelled' ? '取り消し' : undefined;
  const headline = { label: w.headline, value: `${yenMark(d.total)}-` };
  const greeting = d.kind === 'receipt' ? `但し ${d.subject || '品代'} として、上記正に領収いたしました。` : w.greeting;
  const sealStyle = { logo: style.logo ?? null, from: style.from ?? [], sealBox: style.sealBox ?? false, seal: style.seal ?? null };
  const totals = [
    { label: '小計', value: yenMark(d.subtotal) },
    ...d.taxLines.map((x) => ({ label: d.taxLines.length > 1 ? `消費税（${x.rate}%）` : '消費税', value: yenMark(x.tax) })),
    { label: '合計', value: yenMark(d.total) },
  ];
  if (qs.template === 'simple') {
    return renderPdf({
      title: w.title, style: sealStyle, ...(to ? { to } : {}), from: style.from ?? [],
      fields: [...fields, { label: headline.label, value: headline.value }],
      rows: d.items.map((i): InvoiceRow => ({
        name: `${i.group ? `【${i.group}】` : ''}${i.name}${i.taxRate === 8 ? '（※）' : ''}（${i.quantity} ${i.unit}）`,
        quantity: i.quantity, unitPrice: i.unitPrice ?? 0, amount: itemAmount(i),
      })),
      totals, notes: greeting ? [greeting, ...notes] : notes, ...(stamp ? { stamp } : {}),
    });
  }
  return renderRuledQuote({
    title: w.title, ...(to ? { to } : {}), fields, ...(greeting ? { greeting } : {}), headline,
    rows: d.items.map((i) => ({
      ...(i.group ? { group: i.group } : {}), name: `${i.name}${i.code ? `（${i.code}）` : ''}${i.taxRate === 8 ? '（※）' : ''}`,
      quantity: i.quantity, unit: i.unit, unitPrice: i.unitPrice, discount: i.discount ?? 0, amount: itemAmount(i),
    })),
    totals, notes, style: sealStyle, ...(stamp ? { stamp } : {}),
  });
}

/** 書類の中身を Markdown にする（成果物。承認の画面に出す。第9.3.3節）。 */
export function docMarkdown(d: StoredDoc): string {
  const w = DOC_WORDS[d.kind];
  return [
    `# ${w.title} ${numberText(d)}${d.status === 'draft' ? '（下書き）' : ''}`,
    '',
    `- 宛先: ${addressee(d.party.name, d.party.person) || '（未記入）'}`,
    `- ${w.date}: ${jp(d.issuedOn)}`,
    ...(d.subject ? [`- 件名: ${d.subject}`] : []),
    ...(w.due && d.dueOn ? [`- ${w.due}: ${jp(d.dueOn)}`] : []),
    '',
    '| 品目 | 数量 | 単価 | 金額 |',
    '|---|---|---|---|',
    ...d.items.map((i) => `| ${i.group ? `【${i.group}】` : ''}${i.name}${i.taxRate === 8 ? '（※軽減税率）' : ''} | ${i.quantity} ${i.unit} | ${i.unitPrice === null ? '（未記入）' : yenText(i.unitPrice)} | ${yenText(itemAmount(i))} |`),
    '',
    `- 小計: ${yenText(d.subtotal)}`,
    ...d.taxLines.map((x) => `- 消費税（${x.rate}%）: ${yenText(x.tax)}`),
    `- **${w.headline}: ${yenText(d.total)}**`,
    ...(d.notes ? ['', d.notes] : []),
  ].join('\n');
}

/** 書類の名前（ファイルの名前と成果物の題名）。 */
export function docTitle(d: Pick<StoredDoc, 'kind' | 'number' | 'party' | 'status' | 'version'>): string {
  return `${SALES_DOC_KIND_LABELS[d.kind]} ${d.number ? numberText(d) : '下書き'}${d.party.name ? `（${d.party.name}）` : ''}`;
}

/** PDF のファイルの名前。 */
export function docFileName(d: Pick<StoredDoc, 'kind' | 'number' | 'party' | 'version'>): string {
  const safe = (v: string) => v.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 40);
  return `${DOC_WORDS[d.kind].title}_${d.number ? `${d.number}${d.version > 1 ? `-${d.version}` : ''}` : '下書き'}${d.party.name ? `_${safe(d.party.name)}` : ''}.pdf`;
}
