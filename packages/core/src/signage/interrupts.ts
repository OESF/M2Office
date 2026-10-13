/**
 * @file サイネージの割り込み（仕様書 第31.7節・第31.8節の段 2）。文の整え方・呼び出しの言い回し・画面ごとの並び・よく出す案内・外部のアプリからの呼び出し・会社のジングルの音。
 *
 * スタッフのページ・管理の画面・秘書・外部のアプリは、どれも {@link SignageInterrupts.create} を通す（第31.12.1節。抜け道にしない）。
 * 割り込みの文は推論に渡さない（第31.13節）。1 件ずつは監査ログに入れない。
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  SIGNAGE_JINGLES, SIGNAGE_LIMITS, type AuditEvent, type SignageInterruptInput, type SignageInterruptView, type SignageOrigin,
  type SignagePhrase, type SignagePlayInterrupt, type SignageSettings, type SignageSound,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { SignageService } from './service.js';

/** 割り込みの処理に要るもの。 */
export interface SignageInterruptsDeps {
  service: SignageService;
  repo: Repository;
  now?: () => Date;
}

/** 作れなかったときの理由（外部のアプリへの答えの番号と対応する）。 */
export interface InterruptError { error: string; status: 400 | 403 | 404 | 422 | 429 | 503 }

const FULLWIDTH_ALNUM = /[Ａ-Ｚａ-ｚ０-９]/g;
/** 作ってから出し始めるまでに許す時間（第31.7.2節）。 */
const EXPIRE_MS = 2 * 60_000;

/**
 * 割り込みの文を整える（第31.7.1節）。全角の英数字を半角に、改行とタブを空白に、続いた空白を 1 つにし、見えない文字を除く。
 *
 * @returns 整えた文（空なら空の文字列）
 */
export function normalizeText(s: string): string {
  return s.replace(FULLWIDTH_ALNUM, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 言い回しに番号と場所を差し込む。 */
export function fillTemplate(template: string, number: string, place: string): string {
  return template.replace(/\{番号\}/g, number).replace(/\{場所\}/g, place);
}

/** 文の先頭の「数字（4 桁まで）番」の番号（大きく出す。第31.7.1節）。 */
export function leadingNumber(text: string): string | null {
  return /^(\d{1,4})番/.exec(text)?.[1] ?? null;
}

/** よく出す案内の形（先頭の番号を空ける。第31.9.3節）。 */
export function phraseTemplate(text: string): { template: string; hasNumber: boolean } {
  const m = /^\d{1,4}番/.exec(text);
  return m ? { template: `{番号}番${text.slice(m[0].length)}`, hasNumber: true } : { template: text, hasNumber: false };
}

/** 名前を比べる形（全角と半角・大文字と小文字を区別しない）。 */
const same = (a: string) => a.normalize('NFKC').toLowerCase().trim();

/**
 * サイネージの割り込み。
 *
 * @remarks テナント境界: 置き場が会社ごとに絞る（不変則 I-2）。使えるか（入り切りと利用範囲）の確かめは呼ぶ側（API・秘書）が行う
 */
export class SignageInterrupts {
  /** 外部のアプリごとの 1 分の呼び出しの回数（第13.4.3節）。 */
  private readonly hits = new Map<string, number[]>();

  constructor(readonly deps: SignageInterruptsDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private get store() {
    return this.deps.service.deps.store;
  }

  private emit(tenantId: string, screenId: string, kind: 'interrupt' | 'clear' | 'volume') {
    this.deps.service.changes.emit(`${tenantId}:${screenId}`, kind);
  }

  private async audit(tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    const ev: AuditEvent = { id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'signage', targetId, detail, occurredAt: this.now().toISOString() };
    await this.deps.repo.appendAudit(ev);
  }

  /** 鳴らす音が使えるか（M2Office の音か、会社の音の ID）。 */
  private async knownJingle(tenantId: string, id: string | null | undefined): Promise<boolean> {
    if (!id) return false;
    if (SIGNAGE_JINGLES.some((j) => j.id === id)) return true;
    return (await this.store.listSounds(tenantId)).some((s) => s.id === id);
  }

  /**
   * 割り込みを出す（第31.7.2節）。出す先の画面ごとに並べ、同じ中身が待っているか出している画面には足さない。
   *
   * @param userId 出した人（外部のアプリは `app:<ID>`）
   * @remarks 危険度: 低（会社のサイネージの画面に出す。社外への送信に当たらない。ADR-0051）。1 件ずつは監査ログに入れない（第31.12.1節）
   * @returns 足した画面・まとめた画面。作れなければ理由と答えの番号
   */
  async create(tenantId: string, userId: string | null, input: SignageInterruptInput, origin: SignageOrigin): Promise<{ id: string; screens: string[]; merged: string[] } | InterruptError> {
    const settings = (await this.deps.repo.getTenantSettings(tenantId)).signage;
    const now = this.now();
    await this.settle(tenantId);
    const all = await this.store.listScreens(tenantId);
    const targets = input.screens ? all.filter((s) => input.screens!.includes(s.id)) : all;
    if (!targets.length) return { error: all.length ? '表示する画面が見つかりません' : '登録した画面がありません', status: 422 };

    let kind: 'text' | 'asset' = 'text';
    let text: string | null = null;
    let number: string | null = null;
    let assetId: string | null = null;
    let assetJingle: string | null = null;
    if (input.assetId) {
      const a = await this.store.getAsset(tenantId, input.assetId);
      if (!a || !a.isInterrupt || a.kind === 'video') return { error: '割り込みの素材が見つかりません', status: 422 };
      kind = 'asset';
      assetId = a.id;
      assetJingle = a.jingle;
    } else {
      const num = input.number !== undefined ? normalizeText(String(input.number)).slice(0, 8) : '';
      const place = input.place !== undefined ? normalizeText(String(input.place)).slice(0, 30) : '';
      const raw = input.text !== undefined && String(input.text).trim()
        ? String(input.text)
        : num ? fillTemplate(place ? settings.callTemplate : settings.callTemplateNoPlace, num, place) : '';
      text = normalizeText(raw);
      if (!text) return { error: '表示するメッセージがありません', status: 422 };
      if ([...text].length > SIGNAGE_LIMITS.textChars) return { error: `メッセージは ${SIGNAGE_LIMITS.textChars} 字までにしてください`, status: 422 };
      number = num || leadingNumber(text);
    }
    const base = Math.round(Math.min(SIGNAGE_LIMITS.maxInterruptSeconds, Math.max(SIGNAGE_LIMITS.minInterruptSeconds, Number(input.seconds) || settings.interruptSeconds)));
    const chime = input.chime ?? settings.chime;
    const wanted = input.jingle ?? assetJingle ?? settings.jingle;
    const jingle = (await this.knownJingle(tenantId, wanted)) ? wanted : 'pinpon';

    const add: { screenId: string; seconds: number }[] = [];
    const merged: string[] = [];
    let full = 0;
    for (const s of targets) {
      const active = await this.store.activeTargets(tenantId, s.id);
      // 同じ中身が待っているか出していれば足さない（スタッフが二度押したとき）
      if (active.some((t) => (kind === 'asset' ? t.assetId === assetId && t.kind === 'asset' : t.kind === 'text' && t.text === text))) { merged.push(s.id); continue; }
      const waiting = active.filter((t) => t.state === 'waiting').length;
      if (waiting >= SIGNAGE_LIMITS.queue) { full++; continue; }
      // 待ちが 3 件を超えている間は 8 秒に縮めて早く回す
      add.push({ screenId: s.id, seconds: waiting > 3 ? Math.min(base, 8) : base });
    }
    if (!add.length && full) return { error: '待っている割り込みがいっぱいです', status: 429 };
    const id = randomUUID();
    if (add.length) {
      await this.store.createInterrupt(tenantId, {
        id, kind, text, number, assetId, seconds: base, chime, jingle, origin, createdBy: userId, sourceId: null, requestId: null,
      }, add);
      for (const t of add) this.emit(tenantId, t.screenId, 'interrupt');
      if (text) await this.countPhrase(tenantId, text, now);
    }
    return { id, screens: add.map((t) => t.screenId), merged };
  }

  /** よく出す案内の回数を足す（番号を空けた形のハッシュで数える。第31.9.3節）。 */
  private async countPhrase(tenantId: string, text: string, now: Date): Promise<void> {
    const { template, hasNumber } = phraseTemplate(text);
    const salt = createHash('sha256').update(`m2o-signage-phrase:${tenantId}`).digest('hex');
    const hash = createHash('sha256').update(salt + template).digest('hex');
    const day = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
    const since = new Date(now.getTime() + 9 * 3_600_000 - 13 * 86_400_000).toISOString().slice(0, 10);
    await this.store.bumpPhrase(tenantId, { hash, template, hasNumber, day, since });
  }

  /** 古い割り込みを片付け、変わった画面に知らせる。 */
  async settle(tenantId: string): Promise<void> {
    for (const s of await this.store.settleTargets(tenantId, this.now())) this.emit(tenantId, s, 'clear');
  }

  /** 画面が出す割り込み（待っているものと出しているもの。受け取った順）。経過はサーバーが数える。 */
  async pending(tenantId: string, screenId: string): Promise<SignagePlayInterrupt[]> {
    await this.settle(tenantId);
    const now = this.now().getTime();
    return (await this.store.activeTargets(tenantId, screenId))
      .filter((t) => t.state === 'showing' || now - Date.parse(t.createdAt) <= EXPIRE_MS)
      .map((t) => ({
        id: t.interruptId, kind: t.kind, text: t.text, number: t.number, assetId: t.assetId, seconds: t.seconds,
        jingle: t.chime ? t.jingle : null, state: t.state, ageMs: now - Date.parse(t.createdAt),
      }));
  }

  /** 画面が出し始めた。 */
  async started(tenantId: string, screenId: string, interruptId: string): Promise<boolean> {
    return this.store.startTarget(tenantId, interruptId, screenId);
  }

  /** 画面が出し終えた（秒数が過ぎた）。 */
  async ended(tenantId: string, screenId: string, interruptId: string): Promise<boolean> {
    return this.store.endTarget(tenantId, interruptId, screenId, 'done', null);
  }

  /**
   * 割り込みを消す（その割り込みを出しているすべての画面から。待っているものも外す）。
   *
   * @remarks 危険度: 低。消した人は出す先の行に残す（監査ログには入れない。第31.12.1節）
   */
  async clear(tenantId: string, userId: string, interruptId: string): Promise<number> {
    const done = await this.store.clearTargets(tenantId, { interruptId }, userId);
    for (const s of new Set(done.map((d) => d.screenId))) this.emit(tenantId, s, 'clear');
    return done.length;
  }

  /** 画面（無ければすべての画面）の、出しているものと待っているものをまとめて消す。 */
  async clearAll(tenantId: string, userId: string, screenIds?: string[]): Promise<number> {
    const done = await this.store.clearTargets(tenantId, screenIds ? { screenIds } : {}, userId);
    for (const s of new Set(done.map((d) => d.screenId))) this.emit(tenantId, s, 'clear');
    return done.length;
  }

  /** 最近 24 時間の割り込み（出す先の状態つき）。 */
  async recent(tenantId: string): Promise<SignageInterruptView[]> {
    await this.settle(tenantId);
    return this.store.listInterrupts(tenantId, new Date(this.now().getTime() - 24 * 3_600_000));
  }

  /** よく出す案内（最近 14 日の回数の多い順）と、割り込みの素材の回数。 */
  async phrases(tenantId: string): Promise<{ phrases: SignagePhrase[]; assets: { assetId: string; count: number }[] }> {
    const now = this.now();
    const since = new Date(now.getTime() + 9 * 3_600_000 - 13 * 86_400_000).toISOString().slice(0, 10);
    const use = await this.store.assetUse(tenantId, new Date(now.getTime() - 14 * 86_400_000));
    return { phrases: (await this.store.listPhrases(tenantId, since)).slice(0, 8), assets: [...use].map(([assetId, count]) => ({ assetId, count })).sort((a, b) => b.count - a.count) };
  }

  /** 見回り（ワーカーから）。古い割り込みを片付け、文を 24 時間で消し、行を 90 日で消す。 */
  async sweep(tenantId: string): Promise<{ texts: number; rows: number }> {
    await this.settle(tenantId);
    await this.store.purgePhrases(tenantId, this.now());
    return this.store.purgeInterrupts(tenantId, this.now());
  }

  /** 外部のアプリごとの呼び出しの回数を数える（1 分に 30 回まで）。超えたら `false`。 */
  private allowHit(key: string): boolean {
    const now = this.now().getTime();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= 30) return false;
    this.hits.set(key, [...list, now]);
    return true;
  }

  /**
   * 外部のアプリから呼び出しを出す（機能 `signage.interrupt`。第13.4.3節）。項目は決まった形だけを読む（推測はしない）。
   * 中身はデータとして扱い、指示として読まない（不変則 I-6）。
   *
   * @param appId 出したアプリ（出どころと、消せるものの確かめに使う）
   * @param payload 本文（`text`・`number`・`place`・`image`・`screens`・`seconds`・`chime`）
   * @param allowed 承認した画面（`null` ならすべての画面）
   * @returns 出した割り込みの ID と、出した画面・同じ案内を出していた画面の名前。断るときは理由と番号
   * @remarks 危険度: 社内に書き込む（店頭の画面に、文字か登録した割り込みの素材を出す。画像・HTML・URL は受け取らない）
   */
  async fromApp(tenantId: string, appId: string, payload: Record<string, unknown>, allowed: string[] | null): Promise<{ id: string; screens: string[]; merged: string[] } | InterruptError> {
    // 回数は 1 分 30 回（アプリの上限 1 分 120 回とは別。画面の待ちを埋めないため）
    if (!this.allowHit(`app:${appId}`)) return { error: '呼び出しは 1 分に 30 回までです', status: 429 };
    const str = (v: unknown, max: number) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');
    const input: SignageInterruptInput = {};
    const text = str(payload['text'], 400);
    const number = str(payload['number'], 8);
    const place = str(payload['place'], 30);
    const image = str(payload['image'] ?? payload['asset'], 60);
    if (text) input.text = text;
    else if (number) { input.number = number; if (place) input.place = place; }
    else if (image) {
      // 割り込みの素材は名前で選ぶだけ（URL や画像を受け取らない。第31.8.1節）
      const asset = (await this.store.listAssets(tenantId)).find((a) => a.isInterrupt && same(a.name) === same(image));
      if (!asset) return { error: '割り込みの素材が見つかりません', status: 422 };
      input.assetId = asset.id;
    } else return { error: '表示するメッセージ（text）か、番号（number）か、割り込みの素材の名前（image）を送ってください', status: 422 };
    const all = await this.store.listScreens(tenantId);
    const permitted = allowed ? all.filter((s) => allowed.includes(s.id)) : all;
    const raw = payload['screens'];
    if (raw !== undefined && raw !== null && raw !== '') {
      const names = (Array.isArray(raw) ? raw.map(String) : String(raw).split(/[,、，]/)).map((x) => x.trim()).filter(Boolean);
      const known = all.filter((s) => names.some((n) => same(n) === same(s.name)));
      // 知らない名前だけなら出さない（勝手にすべての画面にしない）。承認した画面の外だけなら断る
      if (!known.length) return { error: '画面が見つかりません', status: 422 };
      const inside = known.filter((s) => permitted.some((p) => p.id === s.id));
      if (!inside.length) return { error: '承認した画面の外です', status: 403 };
      input.screens = inside.map((s) => s.id);
    } else {
      if (!permitted.length) return { error: '出せる画面がありません', status: 422 };
      input.screens = permitted.map((s) => s.id);
    }
    const seconds = Number(payload['seconds']);
    if (Number.isFinite(seconds) && seconds > 0) input.seconds = seconds;
    const chime = payload['chime'];
    if (chime !== undefined && chime !== null && chime !== '') input.chime = !['0', 'false', 'off', 'no'].includes(String(chime).toLowerCase());
    const r = await this.create(tenantId, `app:${appId}`, input, 'app');
    if ('error' in r) return r;
    const nameOf = (id: string) => all.find((s) => s.id === id)?.name ?? '';
    return { id: r.id, screens: r.screens.map(nameOf), merged: r.merged.map(nameOf) };
  }

  // ---- 会社のジングルの音（第31.7.3節） ----

  /**
   * 会社の音を入れる（管理者だけ）。MP3・WAV を中身の先頭で確かめ、300 KB・5 秒・10 個まで。
   *
   * @param durationMs 画面で調べた長さ
   */
  async addSound(tenantId: string, userId: string, name: unknown, data: Uint8Array, durationMs: unknown): Promise<{ sound: SignageSound } | { error: string }> {
    const n = String(name ?? '').trim().slice(0, 20) || '音';
    const mime = soundMime(data);
    if (!mime) return { error: '音は MP3 か WAV にしてください' };
    if (data.length > SIGNAGE_LIMITS.soundBytes) return { error: '音が大きすぎます（300 KB まで）' };
    const ms = Math.round(Number(durationMs));
    if (!(ms > 0 && ms <= SIGNAGE_LIMITS.soundMs)) return { error: '音は 5 秒までにしてください' };
    const list = await this.store.listSounds(tenantId);
    if (list.length >= SIGNAGE_LIMITS.sounds) return { error: `会社の音は ${SIGNAGE_LIMITS.sounds} 個までです` };
    if (list.some((s) => s.name === n)) return { error: '同じ名前の音があります' };
    const id = randomUUID();
    const sha256 = createHash('sha256').update(data).digest('hex');
    await this.store.addSound(tenantId, { id, name: n, mime, data, sha256, durationMs: ms }, userId);
    await this.audit(tenantId, userId, 'signage.sound.add', id, { name: n, bytes: data.length, sha256 });
    return { sound: (await this.store.listSounds(tenantId)).find((s) => s.id === id)! };
  }

  /** 会社の音を消す（管理者だけ）。既定の音に選んでいれば「ピンポーン」に戻す。 */
  async deleteSound(tenantId: string, userId: string, id: string, settings: SignageSettings): Promise<{ resetDefault: boolean } | null> {
    const s = await this.store.deleteSound(tenantId, id);
    if (!s) return null;
    await this.audit(tenantId, userId, 'signage.sound.remove', id, { name: s.name, bytes: s.bytes });
    let resetDefault = false;
    if (settings.jingle === id) {
      await this.deps.repo.saveTenantSettings(tenantId, 'signage', { ...settings, jingle: 'pinpon' }, userId);
      resetDefault = true;
    }
    return { resetDefault };
  }
}

/** 音の形式を中身の先頭で決める（MP3・WAV）。 */
export function soundMime(b: Uint8Array): 'audio/mpeg' | 'audio/wav' | null {
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return 'audio/wav';
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg';
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}
