/**
 * @file 業務「外部のアプリからの配信」のツール（仕様書 第13.4.4節）。承認の前に中身を承認の画面に出し、承認の後に送る時を待つ状態にする。
 */

import type { Tool, ToolContext } from '../tools/registry.js';
import type { DeliveryService } from './service.js';

/** ツールから配信を扱う口。 */
export interface DeliveryToolContext {
  service: DeliveryService;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * 承認された配信を送る（送るのはワーカーが 1 人に 1 通ずつ）。承認の前に、題名・差出人・人数・見本の本文を承認の画面に出す。
 *
 * @remarks 危険度 `external-send`。社外へメールを送る。いつも人に判断を求める。推論に渡すのは配信の番号と人数だけ
 */
export const deliveriesSend: Tool = {
  name: 'deliveries.send',
  risk: 'external-send',
  activityLabel: '外部のアプリからの配信を送っています',
  helpText: '外部のアプリから届いた配信の依頼を、承認の後に会社の窓口のアカウントから送ります',
  description: '承認された配信（deliveryId）を送る',
  args: { properties: { deliveryId: { type: 'string', description: '配信の ID' } }, required: ['deliveryId'] },
  planKey: (args) => `delivery:${str(args['deliveryId'])}`,
  async prepare(args, ctx) {
    const service = (ctx as ToolContext & { deliveries?: DeliveryToolContext }).deliveries?.service;
    if (!service) return { kind: 'problem', reason: '配信を扱えません' };
    const p = await service.preview(ctx.tenantId, str(args['deliveryId']));
    if ('problem' in p) return { kind: 'problem', reason: p.problem };
    return { kind: 'ready', args: { deliveryId: str(args['deliveryId']) }, audience: 'external', shown: p.shown };
  },
  async invoke(args, ctx) {
    const service = (ctx as ToolContext & { deliveries?: DeliveryToolContext }).deliveries?.service;
    if (!service) return { available: false, reason: '配信を扱えません' };
    const r = await service.approved(ctx.tenantId, ctx.userId, str(args['deliveryId']));
    if ('error' in r) return { available: false, reason: r.error };
    return { available: true, scheduled: true, note: `${r.total} 人への配信を始めます（結果は外部のアプリが取りに来ます）` };
  },
};

/** 配信のツール。 */
export const DELIVERY_TOOLS: Tool[] = [deliveriesSend];
