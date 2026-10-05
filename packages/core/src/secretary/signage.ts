/**
 * @file 秘書から店頭サイネージを使う（仕様書 第31.11.1節）。割り込みを出す・消す、画面の状態、割り込みの素材の音、呼び出しの言い回し、画面を外す。
 *
 * **秘書の欄で本人が話した回（音声を含む）にだけ使う。** 決まった言い方で見分けてその場で行い、業務の実行・定時実行・ブリーフ・
 * 会話から学ぶ処理・メールや文書を読んだ結果からは呼ばれない（秘書の返事の処理だけが呼ぶ。第31.14節）。推論に選ばせない。
 * 割り込みを出す処理はスタッフのページと同じもの（{@link SignageInterrupts.create}）を通す。
 */

import { SIGNAGE_JINGLES } from '@m2office/shared';
import type { SignageService } from '../signage/service.js';
import type { SignageInterrupts } from '../signage/interrupts.js';

/** 秘書がサイネージを使うのに要るもの。 */
export interface SignageSecretaryDeps {
  service: SignageService;
  interrupts: SignageInterrupts;
  /** サイネージを使っていて、利用範囲に入っているか。 */
  access(tenantId: string, userId: string): Promise<unknown>;
}

/** 秘書への依頼。 */
export type SignageRequest =
  | { kind: 'status' }
  | { kind: 'clear'; all: boolean; screens: string[] }
  | { kind: 'show'; text?: string; number?: string; place?: string; assetHint?: string; screens: string[]; seconds?: number; chime?: boolean }
  | { kind: 'asset-jingle'; assetHint: string; jingle: string }
  | { kind: 'template'; template: string }
  | { kind: 'remove'; screen: string };

const QUOTED = /[「『"](.+?)[」』"]/;

/** 「待合だけに」「入口と待合に」「入口の画面に」から画面の名前を取り出す（かぎかっこの中は見ない）。 */
export function screensIn(message: string): string[] {
  const m = message.replace(/[「『][^」』]*[」』]/g, '「」').replace(/\s+/g, '');
  const hit = /^(?:サイネージの)?([^「『、。]+?)(?:の画面)?(?:だけ|のみ)(?:に|へ)/.exec(m)
    ?? /^(?:サイネージの)?([^「『、。]+?)の画面(?:だけ)?(?:に|へ)/.exec(m)
    ?? /^(?:サイネージの)?([^「『、。]+?)(?:に|へ)(?:「」|だけ)/.exec(m)
    ?? /を(?:サイネージの)?([^「『、。を]+?)(?:の画面)?(?:だけ)?(?:に|へ)(?:だけ)?(?:出|表示|流)/.exec(m);
  if (!hit) return [];
  return hit[1]!.split(/[と・,、]/).map((x) => x.trim()).filter((x) => x && !/^(画面|サイネージ|全部|すべて|全画面|みんな)$/.test(x) && !/\d+番/.test(x));
}

/**
 * サイネージへの依頼を見分ける。
 *
 * @returns サイネージへの依頼でなければ `null`（ふつうの会話に回す）
 */
export function signageRequest(message: string): SignageRequest | null {
  const raw = message.normalize('NFKC').trim();
  const m = raw.replace(/\s+/g, '');
  if (/(方法|やり方|どうやって|とは|仕組み|できる\?|できますか)/.test(m)) return null;
  if (/サイネージ.*(つなが|状態|動いて|映って)|(画面|サイネージ).*(つながって|オンライン)/.test(m)) return { kind: 'status' };
  const seconds = Number(/(\d{1,2})秒/.exec(m)?.[1]) || undefined;
  const chime = /音(なし|無し|を?鳴らさず|を?出さず)/.test(m) ? false : undefined;
  // 割り込みを消す（「呼び出しを消して」「全部消して」）
  if (/(呼び出し|割り込み|案内|サイネージ|画面の表示).*(消して|止めて|取り消して|下げて)|^(全部|すべて)消して/.test(m)) {
    return { kind: 'clear', all: /(全部|すべて|全て)/.test(m), screens: screensIn(raw) };
  }
  // 呼び出しの言い回し（管理者）
  const tpl = /言い回しを[「『](.+?)[」』]に/.exec(raw);
  if (tpl) {
    let n = 0;
    const template = tpl[1]!.replace(/[〇○◯]+|\{番号\}|\{場所\}/g, (x) => (x.startsWith('{') ? x : ++n === 1 ? '{番号}' : '{場所}'));
    return { kind: 'template', template };
  }
  // 画面を切断する（管理者）
  const rm = /^(.+?)の画面を(?:外して|切断して)/.exec(m);
  if (rm) return { kind: 'remove', screen: rm[1]! };
  // 割り込みの素材の音（「焼き上がりの案内はベルにして」）
  const jg = /^(.+?)(?:の案内)?は(.+?)(?:の音)?にして/.exec(m);
  if (jg) {
    const j = SIGNAGE_JINGLES.find((x) => x.label === jg[2] || x.id === jg[2]);
    if (j) return { kind: 'asset-jingle', assetHint: jg[1]!, jingle: j.id };
  }
  const screens = screensIn(raw);
  // 番号で呼ぶ（「12番の方を呼んで」「12番、レントゲン室」）
  const short = /^(\d{1,4})番[、,](.+?)(?:へ|に)?(?:呼んで|呼び出して)?$/.exec(m);
  if (short && !QUOTED.test(raw)) return { kind: 'show', number: short[1]!, place: short[2]!, screens: [], seconds, chime };
  const call = /(\d{1,4})番(?:の(?:方|患者様|お客様))?(?:を|さんを)?[、,]?(?:(.+?)(?:に|へ))?(?:呼んで|呼び出して|お呼びして|案内して)?$/.exec(m);
  if (call && (/(呼んで|呼び出して|お呼び|案内して)/.test(m) || /^\d{1,4}番[、,]/.test(m))) {
    const placeRaw = call[2] ?? (/^\d{1,4}番[、,](.+?)$/.exec(m)?.[1] ?? '');
    const place = placeRaw.replace(/(に|へ)(呼んで|呼び出して)?$/, '').replace(/(呼んで|呼び出して|お呼びして|案内して)$/, '');
    return { kind: 'show', number: call[1]!, ...(place ? { place } : {}), screens, seconds, chime };
  }
  // かぎかっこの文をそのまま出す（秘書が言い換えない）
  const quoted = QUOTED.exec(raw);
  if (quoted && /(出して|表示して|流して|映して)/.test(m)) return { kind: 'show', text: quoted[1]!, screens, seconds, chime };
  // 「〜って出して」は、その文を出す
  const said = /^(.+?)って(?:サイネージに|画面に)?(?:出して|表示して)/.exec(raw.replace(/^(?:サイネージ|画面)に/, ''));
  if (said) return { kind: 'show', text: said[1]!.trim(), screens, seconds, chime };
  // 「焼き上がりの案内を出して」は、割り込みの素材の名前で選ぶ（合うものが無ければ、ふつうの会話に回す）
  const hint = /^(?:サイネージに)?(.+?)(?:の案内)?を(?:サイネージに)?(?:出して|表示して)/.exec(m);
  if (hint) return { kind: 'show', assetHint: hint[1]!, screens, seconds, chime };
  return null;
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/**
 * サイネージへの依頼に答える（その場で行う）。
 *
 * @param admin 本人が管理者か（言い回しを変える・画面を外すのは管理者だけ）
 * @returns 答えの文。サイネージへの依頼でなかったとき（合う割り込みの素材が無いなど）は `null`
 * @remarks 危険度: write-internal（会社の店頭の画面に出す・消す。社外への送信に当たらない。ADR-0051）
 */
export async function answerSignage(deps: SignageSecretaryDeps, tenantId: string, userId: string, admin: boolean, req: SignageRequest): Promise<string | null> {
  const { service, interrupts } = deps;
  const screens = await service.deps.store.listScreens(tenantId);
  const byName = (names: string[]) => screens.filter((s) => names.some((n) => norm(n) === norm(s.name)));
  if (req.kind === 'status') {
    const o = await service.overview(tenantId);
    if (!o.screens.length) return '登録した画面はまだありません。';
    const ago = (iso: string | null) => (iso ? `${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))} 分前` : '通信なし');
    return o.screens.map((s) => `${s.name}: ${s.online ? '接続中' : `未接続（最後の通信 ${ago(s.lastSeenAt)}）`}${s.lastReport?.audio === false ? '・音が出せません' : ''}`).join('\n');
  }
  if (req.kind === 'clear') {
    const target = req.screens.length ? byName(req.screens) : null;
    if (req.screens.length && !target?.length) return `「${req.screens.join('・')}」という画面がありません（画面: ${screens.map((s) => s.name).join('・')}）。`;
    if (req.all || target) {
      const n = await interrupts.clearAll(tenantId, userId, target?.map((s) => s.id));
      return n ? `${target ? target.map((s) => s.name).join('と') + 'の' : ''}割り込みを消しました。` : '出している割り込みはありません。';
    }
    // いま出しているもの（最新）を消す
    const latest = (await interrupts.recent(tenantId)).find((i) => i.targets.some((t) => t.state === 'showing' || t.state === 'waiting'));
    if (!latest) return '出している割り込みはありません。';
    await interrupts.clear(tenantId, userId, latest.id);
    return '割り込みを消しました。';
  }
  if (req.kind === 'template') {
    if (!admin) return '呼び出しの言い回しは管理者が変えられます。管理者に頼んでください。';
    if (!req.template.includes('{番号}')) return '言い回しには番号の場所（〇）を入れてください。';
    const settings = await service.settings(tenantId);
    const key = req.template.includes('{場所}') ? 'callTemplate' : 'callTemplateNoPlace';
    await service.deps.repo.saveTenantSettings(tenantId, 'signage', { ...settings, [key]: req.template }, userId);
    service.settingsChanged(tenantId);
    return `呼び出しの言い回しを「${req.template.replace('{番号}', '〇').replace('{場所}', '〇〇')}」にしました。`;
  }
  if (req.kind === 'remove') {
    if (!admin) return '画面を外せるのは管理者です。管理者に頼んでください。';
    const s = byName([req.screen])[0];
    if (!s) return `「${req.screen}」という画面がありません（画面: ${screens.map((x) => x.name).join('・') || 'なし'}）。`;
    await service.removeScreen(tenantId, userId, s.id);
    return `「${s.name}」の画面を切断しました。30 日のうちに同じ端末で登録し直せば、名前と流れのまま戻ります。`;
  }
  const assets = (await service.deps.store.listAssets(tenantId)).filter((a) => a.isInterrupt);
  const findAsset = (hint: string) => {
    const h = norm(hint);
    return assets.find((a) => norm(a.name) === h) ?? assets.find((a) => norm(a.name).includes(h) || h.includes(norm(a.name)));
  };
  if (req.kind === 'asset-jingle') {
    const a = findAsset(req.assetHint);
    if (!a) return null;
    await service.setInterruptAsset(tenantId, userId, a.id, { jingle: req.jingle });
    return `「${a.name}」の音を${SIGNAGE_JINGLES.find((j) => j.id === req.jingle)?.label ?? req.jingle}にしました。`;
  }
  // 出す
  const target = req.screens.length ? byName(req.screens) : null;
  if (req.screens.length && !target?.length) {
    // 名前の合う画面が無ければ出さない（違う画面に出さないため）
    return `「${req.screens.join('・')}」という画面がありません（画面: ${screens.map((s) => s.name).join('・') || 'なし'}）。出していません。`;
  }
  let assetId: string | undefined;
  let label = '';
  if (req.assetHint) {
    const a = findAsset(req.assetHint);
    if (!a) return null;
    assetId = a.id;
    label = a.name;
  }
  const r = await interrupts.create(tenantId, userId, {
    ...(assetId ? { assetId } : {}), ...(req.text ? { text: req.text } : {}), ...(req.number ? { number: req.number } : {}), ...(req.place ? { place: req.place } : {}),
    ...(target ? { screens: target.map((s) => s.id) } : {}), ...(req.seconds ? { seconds: req.seconds } : {}), ...(req.chime !== undefined ? { chime: req.chime } : {}),
  }, 'secretary');
  if ('error' in r) return `出せませんでした（${r.error}）。`;
  const names = (ids: string[]) => ids.map((id) => screens.find((s) => s.id === id)?.name).filter(Boolean).join('と');
  if (!r.screens.length) return `同じ案内を${names(r.merged)}に出しています。`;
  const shown = assetId ? `「${label}」` : `『${(await interrupts.recent(tenantId)).find((i) => i.id === r.id)?.text ?? ''}』`;
  return `${names(r.screens)}に${shown}を出しました。`;
}
