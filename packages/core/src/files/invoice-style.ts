/**
 * @file 会社の帳票の体裁を、会社情報と設定から組み立てる（仕様書 第15.2.2節、Q-57）。
 *
 * 自社の書き方（文章の規則）とは分けて持つ。ここで扱うのは、帳票を描くための値だけである。
 */

import type { ToolContext } from '../tools/registry.js';
import type { InvoiceStyleInput } from './pdf-render.js';

/**
 * 会社の帳票の体裁を読む。
 *
 * @param ctx ツールの文脈（会社の設定とファイルの置き場を使う）
 * @returns 帳票に渡す体裁。設定が無い項目は含めない
 *
 * @remarks
 * 差出人は会社情報から組み立てる。帳票ごとに書かせない（第15.2.2節）。
 * ロゴが読めない場合は、ロゴ無しで帳票を出す（帳票が出せないほうが困るため）。
 */
export async function loadInvoiceStyle(ctx: ToolContext): Promise<InvoiceStyleInput> {
  const settings = await ctx.repo.getTenantSettings(ctx.tenantId);
  const { company, invoice } = settings;
  const from = [
    company.legalName,
    company.address,
    company.phone ? `電話 ${company.phone}` : '',
    company.invoiceRegistrationNumber ? `登録番号 ${company.invoiceRegistrationNumber}` : '',
  ].filter(Boolean);

  let logo: InvoiceStyleInput['logo'] = null;
  if (invoice.logoFileId) {
    try {
      // ロゴは会社のものであり、依頼した本人のファイルではない。置き場から直接読む
      const meta = await ctx.repo.getFile(ctx.tenantId, invoice.logoFileId);
      if (meta && (meta.kind === 'png' || meta.kind === 'jpeg')) {
        const bytes = await ctx.files.get(ctx.tenantId, invoice.logoFileId);
        if (bytes) logo = { bytes, kind: meta.kind };
      }
    } catch {
      // 読めなければロゴ無しで出す
    }
  }

  return {
    logo,
    from,
    ...(invoice.bankAccount ? { bankAccount: invoice.bankAccount } : {}),
    ...(invoice.notes ? { notes: invoice.notes } : {}),
    sealBox: invoice.sealBox,
  };
}
