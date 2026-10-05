/**
 * @file 秘書から店頭サイネージを使う（仕様書 第31.11.1節・第31.11.2節）。割り込みを出す・消す、画面の状態、割り込みの素材の音、呼び出しの言い回し、画面を切断する、
 * 渡された画像を流れに足す、時間帯を作る・消す、画像と割り込みの秒数・店の色・ジングルを変える。
 *
 * **秘書の欄で本人が話した回（音声を含む）にだけ使う。** 決まった言い方で見分けてその場で行い、業務の実行・定時実行・ブリーフ・
 * 会話から学ぶ処理・メールや文書を読んだ結果からは呼ばれない（秘書の返事の処理だけが呼ぶ。第31.14節）。推論に選ばせない。
 * 割り込みを出す処理はスタッフのページと同じもの（{@link SignageInterrupts.create}）を通す。
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANNOUNCEMENT_BAND_COLORS, SIGNAGE_JINGLES, SIGNAGE_LIMITS, SIGNAGE_WEEKDAYS, signageBandLabel, type SignageSettings,
} from '@m2office/shared';
import type { SignageService } from '../signage/service.js';
import type { SignageInterrupts } from '../signage/interrupts.js';
import { thumbnailMime, thumbnailPng } from '../signage/thumbnail.js';

/** 秘書がサイネージを使うのに要るもの。 */
export interface SignageSecretaryDeps {
  service: SignageService;
  interrupts: SignageInterrupts;
  /** サイネージを使っていて、利用範囲に入っているか。 */
  access(tenantId: string, userId: string): Promise<unknown>;
  /** 秘書に渡されたファイル（本人のものだけ。無ければ `null`）。流れに足す画像に使う（第31.11.2節） */
  file?(tenantId: string, userId: string, fileId: string): Promise<{ name: string; bytes: Uint8Array } | null>;
}

/** 秘書への依頼。 */
export type SignageRequest =
  | { kind: 'status' }
  | { kind: 'clear'; all: boolean; screens: string[] }
  | { kind: 'show'; text?: string; number?: string; place?: string; assetHint?: string; screens: string[]; seconds?: number; chime?: boolean }
  | { kind: 'asset-jingle'; assetHint: string; jingle: string }
  | { kind: 'template'; template: string }
  | { kind: 'remove'; screen: string }
  | { kind: 'add-file'; screens: string[]; bandStart?: string }
  | { kind: 'band-add'; screens: string[]; start: string; end: string; days: number }
  | { kind: 'band-remove'; screens: string[]; start: string }
  | { kind: 'settings'; patch: Partial<Pick<SignageSettings, 'imageSeconds' | 'interruptSeconds' | 'color' | 'jingle' | 'chime'>> };

/** 「17時」「17:30」「5時半」を `HH:MM` に（読めなければ `null`）。 */
function timeOf(t: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2})|時(?:(\d{1,2})分|(半))?)$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : m[3] ? Number(m[3]) : m[4] ? 30 : 0;
  return h < 24 && min < 60 ? `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` : null;
}

const TIME = '(\\d{1,2}(?::\\d{2}|時(?:\\d{1,2}分|半)?))';

/** 曜日の言い方をビットに（言われなければ毎日）。 */
function daysOf(m: string): number {
  if (/平日/.test(m)) return 31;
  if (/(土日|週末)/.test(m)) return 96;
  if (/毎日/.test(m)) return 127;
  const hit = /([月火水木金土日](?:曜日?)?(?:[・、,と][月火水木金土日](?:曜日?)?)*)(?:曜日?)?(?:の|だけ|に|は)/.exec(m.replace(/(時間帯|月曜?から|日から)/g, ''));
  if (!hit) return 127;
  const bits = SIGNAGE_WEEKDAYS.filter((d) => hit[1]!.includes(d.label)).reduce((a, d) => a | d.bit, 0);
  return bits || 127;
}

/** 「入口の画面」「入口に」から画面の名前を取り出す（流れ・時間帯の頼み）。 */
function flowScreens(raw: string): string[] {
  const m = raw.normalize('NFKC').replace(/\s+/g, '');
  const hit = /^(?:サイネージの)?([^「『、。のに]+?)の画面/.exec(m) ?? /^([^「『、。のに\d]+?)(?:の流れ|[にの]\d)/.exec(m);
  if (!hit) return [];
  return hit[1]!.split(/[と・]/).map((x) => x.trim()).filter((x) => x && !/^(この画像|この写真|画像|写真|サイネージ|画面|全部|すべて|平日|土日|週末|毎日|今日|明日|[月火水木金土日](?:曜日?)?)$/.test(x));
}

/** 色の名前か `#RRGGBB`（読めなければ `null`）。 */
function colorOf(word: string): string | null {
  const w = word.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(w)) return w;
  const named = ANNOUNCEMENT_BAND_COLORS.find((c) => c.label === word.trim() || (word.trim() === '紺' && c.id === 'navy') || (word.trim() === 'グレー' && c.id === 'gray') || (word.trim() === 'オレンジ' && c.id === 'orange'));
  return named ? named.color : null;
}

/**
 * 画像を渡したときの、流れに足す依頼を見分ける（第31.11.2節）。
 *
 * @returns 流れに足す依頼でなければ `null`（ほかの業務への取次に回す）
 */
export function signageFileRequest(message: string): Extract<SignageRequest, { kind: 'add-file' }> | null {
  const m = message.normalize('NFKC').replace(/\s+/g, '');
  if (!/(サイネージ|流れ|画面)/.test(m) || !/(足して|入れて|追加|流して|加えて)/.test(m)) return null;
  const band = new RegExp(`${TIME}(?:から|〜|~)(?:の)?(?:時間帯|流れ)`).exec(m);
  const start = band ? timeOf(band[1]!) : null;
  return { kind: 'add-file', screens: flowScreens(message), ...(start ? { bandStart: start } : {}) };
}

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
  // 時間帯を作る・消す（第31.11.2節）
  if (/時間帯/.test(m)) {
    const range = new RegExp(`${TIME}(?:から|〜|~|-)${TIME}`).exec(m);
    if (range && /(作って|足して|追加|作成|設けて)/.test(m)) {
      const start = timeOf(range[1]!);
      const end = timeOf(range[2]!);
      if (start && end) return { kind: 'band-add', screens: flowScreens(raw), start, end, days: daysOf(m) };
    }
    const one = new RegExp(`${TIME}(?:から|〜|~)?(?:の)?時間帯`).exec(m);
    if (one && /(消して|削除|なくして|やめて)/.test(m)) {
      const start = timeOf(one[1]!);
      if (start) return { kind: 'band-remove', screens: flowScreens(raw), start };
    }
  }
  // 画像なしで「流れに足して」は、画像を渡すよう答える
  if (/(画像|写真).*(流れ|サイネージ)|(流れ|サイネージ).*(画像|写真)/.test(m) && /(足して|入れて|追加|加えて)/.test(m)) return { kind: 'add-file', screens: flowScreens(raw) };
  // 会社の設定（管理者。第31.11.2節）
  const imgSec = /(?:サイネージの)?(?:画像|素材)の?(?:表示の?)?秒数を(\d{1,3})秒/.exec(m);
  if (imgSec) return { kind: 'settings', patch: { imageSeconds: Number(imgSec[1]) } };
  const intSec = /割り込み(?:の秒数)?(?:は|を)(\d{1,2})秒に/.exec(m);
  if (intSec) return { kind: 'settings', patch: { interruptSeconds: Number(intSec[1]) } };
  const color = /店の色を(.+?)に(?:して|変えて)/.exec(m);
  if (color) {
    const c = colorOf(color[1]!);
    if (c) return { kind: 'settings', patch: { color: c } };
  }
  const sound = /(?:サイネージ|呼び出し|割り込み)の(?:音|ジングル)を(.+?)に(?:して|変えて)/.exec(m);
  if (sound) {
    const j = SIGNAGE_JINGLES.find((x) => x.label === sound[1] || x.id === sound[1]);
    if (j) return { kind: 'settings', patch: { jingle: j.id, chime: true } };
  }
  if (/(?:サイネージ|呼び出し|割り込み)の(?:音|ジングル)を?(?:鳴らさないで|止めて|消して|なしにして|切って)/.test(m)) return { kind: 'settings', patch: { chime: false } };
  if (/(?:サイネージ|呼び出し|割り込み)の(?:音|ジングル)を?(?:鳴らして|戻して|入れて)/.test(m)) return { kind: 'settings', patch: { chime: true } };
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
 * @remarks 危険度: write-internal（会社のサイネージの画面に出す・消す。社外への送信に当たらない。ADR-0051）
 */
export async function answerSignage(deps: SignageSecretaryDeps, tenantId: string, userId: string, admin: boolean, req: SignageRequest, fileId?: string): Promise<string | null> {
  const { service, interrupts } = deps;
  const screens = (await service.deps.store.listScreens(tenantId)).filter((s) => s.status === 'active');
  const byName = (names: string[]) => screens.filter((s) => names.some((n) => norm(n) === norm(s.name)));
  const allNames = () => screens.map((s) => s.name).join('・') || 'なし';
  /** 流れ・時間帯の頼みの画面（名前が無く画面が 1 つならその画面。決まらなければ尋ねる文）。 */
  const oneScreen = (wanted: string[]): { id: string; name: string } | string => {
    if (wanted.length) {
      const hit = byName(wanted);
      return hit.length === 1 ? hit[0]! : `「${wanted.join('・')}」という画面がありません（画面: ${allNames()}）。`;
    }
    if (screens.length === 1) return screens[0]!;
    return screens.length ? `どの画面かを教えてください（画面: ${allNames()}）。「入口の画面の流れに足して」のように言えます。` : '登録した画面はまだありません。';
  };
  if (req.kind === 'add-file') {
    if (!fileId) return 'サイネージの流れに足す画像を、秘書の欄のクリップで渡してください（JPEG か PNG）。';
    const target = oneScreen(req.screens);
    if (typeof target === 'string') return target;
    const f = deps.file ? await deps.file(tenantId, userId, fileId).catch(() => null) : null;
    if (!f) return '渡されたファイルが見つかりませんでした。';
    if (!thumbnailMime(f.bytes)) return 'サイネージの流れに足せるのは、JPEG か PNG の画像です。動画や PowerPoint は、サイネージの画面から足してください。';
    if (f.bytes.length > SIGNAGE_LIMITS.imageBytes) return '画像が大きすぎます（5 MB まで）。サイネージの画面から足すと、縮めてから入れます。';
    const flow = await service.flow(tenantId, target.id);
    if (!flow) return `「${target.name}」の画面が見つかりません。`;
    const band = req.bandStart ? flow.bands.find((b) => b.start === req.bandStart) ?? null : null;
    if (req.bandStart && !band) return `「${target.name}」に ${req.bandStart} から始まる時間帯がありません（${flow.bands.map(signageBandLabel).join('・') || '時間帯なし'}）。`;
    const dir = await mkdtemp(join(tmpdir(), 'm2o-sec-'));
    try {
      const path = join(dir, 'image');
      await writeFile(path, f.bytes);
      const mime = thumbnailMime(f.bytes)!;
      const added = await service.addAsset(tenantId, userId, {
        path, bytes: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex'), mime, name: f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || '画像', thumbnail: thumbnailPng(f.bytes),
      });
      if ('error' in added) return `足せませんでした（${added.error}）。`;
      for (let i = 0; i < 2; i += 1) {
        const cur = await service.flow(tenantId, target.id, band?.id ?? null);
        if (!cur) break;
        const r = await service.replaceFlow(tenantId, userId, target.id, [...cur.entries, { assetId: added.asset.id, seconds: null }], cur.version, band?.id ?? null);
        if (!('error' in r)) return `「${target.name}」の${band ? `時間帯（${signageBandLabel(band)}）の` : 'いつもの'}流れの最後に「${added.asset.name}」を足しました。`;
      }
      return `素材には入れましたが、流れに足せませんでした。サイネージの画面から足してください。`;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  if (req.kind === 'band-add') {
    const target = oneScreen(req.screens);
    if (typeof target === 'string') return target;
    const r = await service.addBand(tenantId, userId, target.id, { start: req.start, end: req.end, days: req.days });
    if ('error' in r) return `時間帯を作れませんでした（${r.error}）。`;
    return `「${target.name}」に時間帯「${signageBandLabel(r.band)}」を作りました。サイネージの画面でその時間帯の流れに素材を並べるか、画像を渡して「${r.band.start} からの流れに足して」と頼んでください（空の間はいつもの流れを流します）。`;
  }
  if (req.kind === 'band-remove') {
    const target = oneScreen(req.screens);
    if (typeof target === 'string') return target;
    const flow = await service.flow(tenantId, target.id);
    const band = flow?.bands.find((b) => b.start === req.start);
    if (!band) return `「${target.name}」に ${req.start} から始まる時間帯がありません（${flow?.bands.map(signageBandLabel).join('・') || '時間帯なし'}）。`;
    await service.deleteBand(tenantId, userId, band.id);
    return `「${target.name}」の時間帯「${signageBandLabel(band)}」と、その流れを削除しました（素材は残っています）。`;
  }
  if (req.kind === 'settings') {
    if (!admin) return 'サイネージの設定は管理者が変えられます。管理者に頼んでください。';
    const p = req.patch;
    if (p.imageSeconds !== undefined && (p.imageSeconds < SIGNAGE_LIMITS.minSeconds || p.imageSeconds > SIGNAGE_LIMITS.maxSeconds)) return `画像を出す秒数は ${SIGNAGE_LIMITS.minSeconds}〜${SIGNAGE_LIMITS.maxSeconds} 秒にしてください。`;
    if (p.interruptSeconds !== undefined && (p.interruptSeconds < SIGNAGE_LIMITS.minInterruptSeconds || p.interruptSeconds > SIGNAGE_LIMITS.maxInterruptSeconds)) return `割り込みを出す秒数は ${SIGNAGE_LIMITS.minInterruptSeconds}〜${SIGNAGE_LIMITS.maxInterruptSeconds} 秒にしてください。`;
    const settings = await service.settings(tenantId);
    await service.deps.repo.saveTenantSettings(tenantId, 'signage', { ...settings, ...p }, userId);
    service.settingsChanged(tenantId);
    const said = [
      p.imageSeconds !== undefined ? `画像を出す秒数を ${p.imageSeconds} 秒` : '',
      p.interruptSeconds !== undefined ? `割り込みを出す秒数を ${p.interruptSeconds} 秒` : '',
      p.color ? `店の色を${ANNOUNCEMENT_BAND_COLORS.find((c) => c.color === p.color)?.label ?? p.color}` : '',
      p.jingle ? `呼び出しの音を${SIGNAGE_JINGLES.find((j) => j.id === p.jingle)?.label ?? p.jingle}` : '',
      p.chime === false ? '呼び出しの音を鳴らさないよう' : p.chime === true && !p.jingle ? '呼び出しの音を鳴らすよう' : '',
    ].filter(Boolean);
    return `${said.join('、')}にしました。すぐ画面に届きます。`;
  }
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
