/**
 * @file 契約の管理の処理（仕様書 第38章）。台帳に入れる（契約書から・契約書チェックの実行から・手で）・直す・削除・契約書を開く・
 * 置き場（会社の Google ドライブのフォルダ）をつなぐ・期限の見張り（ワーカーの {@link ContractService.tick}）。
 *
 * 人に確かめを求めない（ADR-0028）。読めなかった項目は「不明」の印を付け、推測で埋めない。
 * 解約するかは人が決める。解約の申し出の文は秘書が下書きまでを作る（送るのは承認の後。ここでは送らない）。
 * **金額は扱わない**（お金は税理士と会計パッケージで行う方針）。
 */

import { randomUUID } from 'node:crypto';
import {
  CONTRACTS_EXTENSION_ID, CONTRACT_END_DAYS_BEFORE, CONTRACT_FOLDER_NAME, CONTRACT_KIND_LABELS, CONTRACT_NOTICE_DAYS_BEFORE, canUseAgent,
  type Contract, type ContractKind, type ContractSettings, type ContractStatus, type ContractUnknownField,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { LlmProvider } from '../llm/provider.js';
import type { FileStore } from '../files/store.js';
import type { DriveConnector } from '../connectors/types.js';
import { fileToText, type OcrFn } from '../files/to-text.js';
import { loadFile, saveFile } from '../files/service.js';
import { dateIn } from '../cards/service.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { addDays, addMonths, kindOf, noticeDaysOf, noticeDeadline, readContract } from './extract.js';
import { nextDue, type ContractPatch, type ContractQuery, type ContractStore, type StoredContract } from './store.js';

/** 操作する人。 */
export interface ContractViewer {
  tenantId: string;
  userId: string;
}

/** 処理に要るもの。 */
export interface ContractServiceDeps {
  store: ContractStore;
  repo: Repository;
  files: FileStore;
  /** 会社の Google ドライブ（`drive.file` の範囲） */
  drive: DriveConnector;
  llmFor(tenantId: string): Promise<LlmProvider | null>;
  /** 画像と文字の無い PDF を読み取る口（無ければ読み取らない） */
  ocrFor?(tenantId: string): Promise<OcrFn | undefined>;
  /** 契約書チェックの実行の、契約書のファイルの ID（依頼した本人の実行だけ）。見つからなければ `null` */
  reviewFile?(tenantId: string, userId: string, runId: string): Promise<string | null>;
  /** 本人がいちばん新しく行った契約書チェックの実行の ID */
  latestReview?(tenantId: string, userId: string): Promise<string | null>;
  /**
   * 契約書チェックを起こす（更新の前に見直す。第38.18節）。本人が契約書チェックを使えなければ `null`。
   *
   * @returns 実行の ID
   */
  reviewStarter?(tenantId: string, userId: string, fileId: string): Promise<string | null>;
  logger?: Logger;
}

/** 仕組みが行うとき（ワーカー）の操作する人。 */
const SYSTEM = 'system';

/** 契約書チェック（公式の拡張機能。第28章）の業務の ID。この業務の実行から台帳に入れられる（第38.5節 ①）。 */
export const CONTRACT_REVIEW_AGENT_ID = 'jp.m2office.legal.contract-review:contract-review';

/** 入れた結果。 */
export interface ContractImported {
  contract: Contract;
  /** 同じ契約の新しい版としてつないだか */
  linkedTo: string | null;
  /** 契約書を置けなかった理由（置き場が無いなど）。置けたら `null` */
  fileNote: string | null;
}

/**
 * 会社が契約の管理を使っていて、利用者が利用範囲の中なら、会社の設定を返す。
 *
 * @returns 使えなければ `null`
 */
export function contractsAccess(repo: Repository) {
  return async (tenantId: string, userId: string): Promise<ContractSettings | null> => {
    const settings = await repo.getTenantSettings(tenantId);
    if (!settings.contracts.enabled) return null;
    const groups = await repo.listUserGroupIds(tenantId, userId);
    if (!canUseAgent(settings.access, CONTRACTS_EXTENSION_ID, userId, groups)) return null;
    return settings.contracts;
  };
}

const jstToday = (now: Date) => dateIn('Asia/Tokyo', now);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = Object.keys(CONTRACT_KIND_LABELS) as ContractKind[];

/** 契約書のファイルの名前（「相手_種類_締結日.pdf」）。ドライブに置くときに使う。 */
export function contractFileName(c: Pick<Contract, 'party' | 'kind' | 'signedOn'>, ext: string): string {
  const safe = (v: string) => v.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 40);
  return `${safe(c.party) || '相手不明'}_${CONTRACT_KIND_LABELS[c.kind].replace(/[（）()]/g, '')}_${c.signedOn ?? '日付不明'}.${ext}`;
}

/**
 * 契約の管理の操作。
 *
 * @remarks 呼ぶ前に、利用者が使えるかを {@link contractsAccess} で確かめること
 */
export class ContractService {
  private readonly log: Logger;

  constructor(readonly deps: ContractServiceDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  private async audit(who: ContractViewer, action: string, id: string, detail: Record<string, unknown>): Promise<void> {
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId: who.tenantId, actorType: who.userId === SYSTEM ? 'system' : 'user', actorId: who.userId === SYSTEM ? 'contract-watch' : who.userId,
      action, targetType: 'contract', targetId: id, detail, occurredAt: new Date().toISOString(),
    });
  }

  private async names(tenantId: string): Promise<Map<string, string>> {
    return new Map((await this.deps.repo.listUsers(tenantId)).map((u) => [u.id, u.displayName || u.email]));
  }

  private view(c: StoredContract, names: Map<string, string>): Contract {
    const { notified: _n, ...rest } = c;
    return { ...rest, ownerName: names.get(c.ownerId) ?? '' };
  }

  /** 一覧（期限の近い順）。 */
  async list(who: ContractViewer, q: ContractQuery = {}): Promise<Contract[]> {
    const names = await this.names(who.tenantId);
    return (await this.deps.store.list(who.tenantId, q)).map((c) => this.view(c, names));
  }

  /** 1 件。見つからなければ `null`。 */
  async get(who: ContractViewer, id: string): Promise<Contract | null> {
    const c = await this.deps.store.get(who.tenantId, id);
    return c ? this.view(c, await this.names(who.tenantId)) : null;
  }

  // ---- 入れる ------------------------------------------------------------------------------

  /**
   * 契約書のファイルから台帳に入れる（第38.5節 ②）。AI が項目を取り出し、契約書を会社のドライブに置く。確かめを求めない。
   *
   * @param fileId M2Office に上げたファイル（**入れる本人のファイルだけ**）
   * @param reviewRunId 契約書チェックの実行から入れたときは、その実行
   */
  async importFile(who: ContractViewer, fileId: string, reviewRunId: string | null = null): Promise<ContractImported | { error: string }> {
    const ocr = this.deps.ocrFor ? await this.deps.ocrFor(who.tenantId).catch(() => undefined) : undefined;
    const read = await fileToText(this.deps.repo, this.deps.files, who.tenantId, fileId, who.userId, ocr);
    if (!read.ok) return { error: read.note ?? '契約書を読めませんでした' };
    if (read.text.trim().length < 40) return { error: '契約書から文字をほとんど読めませんでした（写真なら、明るく正面から撮り直してください）' };
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const company = settings.company.legalName || settings.company.shortName || '';
    const llm = await this.deps.llmFor(who.tenantId).catch(() => null);
    const r = await readContract(llm, read.text, company, jstToday(new Date()));
    const same = await this.deps.store.findSame(who.tenantId, r.party, r.kind, r.signedOn);
    // 変更契約・覚書は、同じ相手・種類の有効な契約の新しい版としてつなぐ
    const amendment = /(変更|覚書)/.test(r.title) ? (await this.deps.store.list(who.tenantId, { status: 'active', search: r.party })).find((c) => c.party === r.party && c.id !== same?.id) ?? null : null;
    if (same) return { error: `同じ契約（${same.party}・${CONTRACT_KIND_LABELS[same.kind]}・${same.signedOn ?? ''}）がもう台帳にあります` };
    const id = await this.deps.store.create(who.tenantId, {
      party: r.party, kind: r.kind, title: r.title, signedOn: r.signedOn, startOn: r.startOn, endOn: r.endOn, autoRenew: r.autoRenew,
      renewMonths: r.renewMonths, noticeRule: r.noticeRule, noticeDays: r.noticeDays, noticeDeadline: noticeDeadline(r.endOn, r.noticeDays),
      status: r.endOn && r.endOn < jstToday(new Date()) && !r.autoRenew ? 'ended' : 'active', ownerId: who.userId, driveFileId: null, driveFileName: '',
      reviewRunId, previousId: amendment?.id ?? null, note: '', unknown: r.unknown, createdBy: who.userId,
    });
    const fileNote = await this.placeFile(who, id, fileId);
    await this.audit(who, 'contract.create', id, { kind: r.kind, from: reviewRunId ? 'review' : 'file', unknown: r.unknown.length, placed: !fileNote });
    // 期限を過ぎて自動更新された契約は、いまの期間まで進める
    await this.rollForward(who.tenantId, id, new Date());
    return { contract: (await this.get(who, id))!, linkedTo: amendment?.id ?? null, fileNote };
  }

  /**
   * 契約書チェックの実行から入れる（第38.5節 ①）。依頼した本人の実行だけ。
   *
   * @param runId 無ければ本人がいちばん新しく行った契約書チェック
   */
  async importReview(who: ContractViewer, runId: string | null): Promise<ContractImported | { error: string }> {
    const id = runId ?? (this.deps.latestReview ? await this.deps.latestReview(who.tenantId, who.userId) : null);
    if (!id) return { error: '契約書チェックの実行が見つかりません。結んだ契約書を渡してください' };
    const fileId = this.deps.reviewFile ? await this.deps.reviewFile(who.tenantId, who.userId, id) : null;
    if (!fileId) return { error: 'その契約書チェックの契約書が見つかりません（チェックを頼んだ本人だけが台帳に入れられます）' };
    return this.importFile(who, fileId, id);
  }

  /**
   * 手で入れる（第38.5節 ③。紙だけの古い契約など）。
   *
   * @returns 入れた 1 件か、直せない理由
   */
  async create(who: ContractViewer, input: Record<string, unknown>): Promise<{ contract: Contract } | { error: string }> {
    const v = this.validate(input);
    if ('error' in v) return v;
    if (!v.party) return { error: '相手を入れてください' };
    const p = v as Required<Pick<ContractPatch, 'party'>> & ContractPatch;
    const kind = p.kind ?? kindOf(p.title ?? '');
    const id = await this.deps.store.create(who.tenantId, {
      party: p.party, kind, title: p.title ?? '', signedOn: p.signedOn ?? null, startOn: p.startOn ?? null, endOn: p.endOn ?? null,
      autoRenew: p.autoRenew ?? false, renewMonths: p.renewMonths ?? null, noticeRule: p.noticeRule ?? '', noticeDays: p.noticeDays ?? null,
      noticeDeadline: noticeDeadline(p.endOn ?? null, p.autoRenew ? p.noticeDays ?? null : null), status: 'active', ownerId: who.userId,
      driveFileId: null, driveFileName: '', reviewRunId: null, previousId: null, note: p.note ?? '', unknown: [], createdBy: who.userId,
    });
    await this.audit(who, 'contract.create', id, { kind, from: 'manual' });
    await this.rollForward(who.tenantId, id, new Date());
    return { contract: (await this.get(who, id))! };
  }

  /** 入力を確かめて、直す項目にする。 */
  private validate(input: Record<string, unknown>): ContractPatch | { error: string } {
    const out: ContractPatch = {};
    const text = (k: string, max: number) => (typeof input[k] === 'string' ? (input[k] as string).trim().slice(0, max) : undefined);
    const date = (k: string): string | null | undefined | false => {
      const v = input[k];
      if (v === undefined) return undefined;
      if (v === null || v === '') return null;
      return typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v)) ? v : false;
    };
    const party = text('party', 100);
    if (party !== undefined) out.party = party;
    const title = text('title', 120);
    if (title !== undefined) out.title = title;
    const note = text('note', 1000);
    if (note !== undefined) out.note = note;
    const rule = text('noticeRule', 300);
    if (rule !== undefined) out.noticeRule = rule;
    if (input['kind'] !== undefined) {
      if (!KINDS.includes(input['kind'] as ContractKind)) return { error: '契約の種類が違います' };
      out.kind = input['kind'] as ContractKind;
    }
    for (const [k, key] of [['signedOn', 'signedOn'], ['startOn', 'startOn'], ['endOn', 'endOn']] as const) {
      const d = date(k);
      if (d === false) return { error: '日付は YYYY-MM-DD の形で入れてください' };
      if (d !== undefined) out[key] = d;
    }
    if (input['autoRenew'] !== undefined) out.autoRenew = input['autoRenew'] === true;
    for (const [k, max] of [['renewMonths', 120], ['noticeDays', 730]] as const) {
      const v = input[k];
      if (v === undefined) continue;
      if (v === null || v === '') { out[k] = null; continue; }
      const n = Number(v);
      if (!Number.isInteger(n) || n < (k === 'renewMonths' ? 1 : 0) || n > max) return { error: k === 'renewMonths' ? '更新の期間は 1〜120 か月です' : '申し出の日数は 0〜730 日です' };
      out[k] = n;
    }
    if (input['status'] !== undefined) {
      if (!['active', 'cancel_requested', 'ended'].includes(String(input['status']))) return { error: '状態が違います' };
      out.status = input['status'] as ContractStatus;
    }
    if (typeof input['ownerId'] === 'string' && input['ownerId']) out.ownerId = input['ownerId'];
    return out;
  }

  /**
   * 直す（第38.9節）。日付や決まりを直したら期限を計算し直し、直した項目の「不明」の印を外す。
   *
   * @returns 直せなければ理由
   */
  async update(who: ContractViewer, id: string, input: Record<string, unknown>): Promise<string | null> {
    const cur = await this.deps.store.get(who.tenantId, id);
    if (!cur) return '契約が見つかりません';
    const v = this.validate(input);
    if ('error' in v) return v.error;
    if (v.ownerId) {
      const u = await this.deps.repo.findUserById(who.tenantId, v.ownerId);
      if (!u || u.status !== 'active') return '担当にできない人です';
    }
    // 申し出の決まりの文だけを直したら、日数を読み直す
    if (v.noticeRule !== undefined && v.noticeDays === undefined) v.noticeDays = noticeDaysOf(v.noticeRule) ?? cur.noticeDays;
    const next = { ...cur, ...v };
    if (next.startOn && next.endOn && next.endOn < next.startOn) return '終わりが始めより前です';
    const deadline = noticeDeadline(next.endOn, next.autoRenew ? next.noticeDays : null);
    const fixed: ContractUnknownField[] = [];
    for (const [k, f] of [['party', 'party'], ['kind', 'kind'], ['signedOn', 'signedOn'], ['startOn', 'startOn'], ['endOn', 'endOn'], ['autoRenew', 'autoRenew']] as const) {
      if (v[k] !== undefined) fixed.push(f);
    }
    if (deadline) fixed.push('noticeDeadline');
    const dateChanged = deadline !== cur.noticeDeadline || next.endOn !== cur.endOn;
    await this.deps.store.update(who.tenantId, id, {
      ...v, noticeDeadline: deadline, unknown: cur.unknown.filter((u) => !fixed.includes(u)), ...(dateChanged ? { notified: [] } : {}),
    }, who.userId);
    await this.audit(who, v.status ? 'contract.status' : 'contract.update', id, { fields: Object.keys(v), ...(v.status ? { status: v.status } : {}) });
    return null;
  }

  /** 削除（入れた人と管理者だけ。ドライブの契約書は残す）。 */
  async remove(who: ContractViewer, id: string): Promise<string | null> {
    const cur = await this.deps.store.get(who.tenantId, id);
    if (!cur) return '契約が見つかりません';
    const user = await this.deps.repo.findUserById(who.tenantId, who.userId);
    if (cur.createdBy !== who.userId && !user?.roles.includes('admin')) return '削除できるのは、入れた人と管理者だけです';
    await this.deps.store.delete(who.tenantId, id);
    await this.audit(who, 'contract.delete', id, { kind: cur.kind });
    return null;
  }

  // ---- 置き場（会社の Google ドライブ） ------------------------------------------------------

  /**
   * 契約書の置き場をつなぐ・つなぎ直す（第38.7節。管理者だけ）。M2Office が、その管理者のドライブにフォルダを作る。
   *
   * @returns つないだ置き場か、つなげない理由
   */
  async connectStorage(who: ContractViewer): Promise<{ folderName: string } | { error: string }> {
    const user = await this.deps.repo.findUserById(who.tenantId, who.userId);
    if (!user?.roles.includes('admin')) return { error: '置き場をつなげるのは管理者だけです' };
    let folder;
    try {
      folder = await this.deps.drive.createFolder({ tenantId: who.tenantId, userId: who.userId }, { name: CONTRACT_FOLDER_NAME, parentId: null });
    } catch (err) {
      this.log.warn('契約書の置き場を作れませんでした', { tenantId: who.tenantId, error: err instanceof Error ? err.message : String(err) });
      return { error: 'Google ドライブにフォルダを作れませんでした。Google をつないでいるか確かめてください' };
    }
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const storage = { folderId: folder.id, folderName: folder.name, connectedBy: who.userId, connectedAt: new Date().toISOString() };
    await this.deps.repo.saveTenantSettings(who.tenantId, 'contracts', { ...settings.contracts, storage }, who.userId);
    await this.audit(who, 'contract.storage', 'storage', { reconnected: !!settings.contracts.storage });
    // 前の置き場の契約書は、新しい置き場にはまだ無い（つなぎ直したときは、開けなくなった契約書を入れ直してもらう）
    return { folderName: folder.name };
  }

  /** 契約書を会社のドライブに置く。置けなければ理由を返す（台帳には入れる）。 */
  private async placeFile(who: ContractViewer, contractId: string, fileId: string): Promise<string | null> {
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const storage = settings.contracts.storage;
    if (!storage) return '契約書の置き場をつないでいないため、契約書はドライブに置いていません（管理者が拡張機能の設定でつなぎます）';
    const f = await loadFile(this.deps.repo, this.deps.files, who.tenantId, fileId, { id: who.userId, roles: [] });
    if (!f) return '契約書のファイルが見つかりません';
    const c = await this.deps.store.get(who.tenantId, contractId);
    if (!c) return '契約が見つかりません';
    const ext = (/\.([a-z0-9]+)$/i.exec(f.meta.name)?.[1] ?? f.meta.kind).toLowerCase();
    const name = contractFileName(c, ext);
    try {
      const placed = await this.deps.drive.upload({ tenantId: who.tenantId, userId: storage.connectedBy }, { name, mimeType: f.meta.mime, bytes: f.bytes, parentId: storage.folderId });
      await this.deps.store.update(who.tenantId, contractId, { driveFileId: placed.id, driveFileName: placed.name }, who.userId);
      return null;
    } catch (err) {
      this.log.warn('契約書をドライブに置けませんでした', { tenantId: who.tenantId, error: err instanceof Error ? err.message : String(err) });
      return '契約書をドライブに置けませんでした（置き場をつないだ管理者の Google の許可が無くなったか、フォルダが消されました。管理者が置き場をつなぎ直してください）';
    }
  }

  /**
   * 契約書を開く（第38.7節）。置き場をつないだ管理者の許可で、ドライブから読んで返す。利用範囲の人なら、ドライブの共有の設定が無くても開ける。
   *
   * @returns ファイルか、開けない理由
   */
  async openFile(who: ContractViewer, id: string): Promise<{ name: string; mimeType: string; bytes: Uint8Array } | { error: string }> {
    const c = await this.deps.store.get(who.tenantId, id);
    if (!c) return { error: '契約が見つかりません' };
    if (!c.driveFileId) return { error: 'この契約の契約書はドライブに置いていません' };
    const storage = (await this.deps.repo.getTenantSettings(who.tenantId)).contracts.storage;
    if (!storage) return { error: '契約書の置き場がつながっていません（管理者が拡張機能の設定でつなぎます）' };
    const got = await this.deps.drive.download({ tenantId: who.tenantId, userId: storage.connectedBy }, c.driveFileId).catch(() => null);
    if (!got) return { error: '契約書が見つかりません（ドライブで消されたか、置き場から動かされました）' };
    if ('tooLarge' in got) return { error: '契約書が大きすぎて開けません（25 MB まで）。ドライブで開いてください' };
    await this.audit(who, 'contract.open', id, {});
    return { name: c.driveFileName || got.file.name, mimeType: got.mimeType, bytes: got.bytes };
  }

  // ---- 段 2（第38.18節） ---------------------------------------------------------------------

  /**
   * 名刺管理の会社と同じ相手の契約（名刺の詳細に並べる）。株式会社などの言葉と空白を除いて、どちらかがもう一方を含めば同じとみなす。
   *
   * @param company 名刺の会社名（2 字に満たなければ何も返さない）
   */
  async byCompany(who: ContractViewer, company: string): Promise<Contract[]> {
    const norm = (s: string) => s.normalize('NFKC').replace(/株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|医療法人|\(株\)|\(有\)|㈱|㈲|\s/g, '').toLowerCase();
    const key = norm(company);
    if (key.length < 2) return [];
    const names = await this.names(who.tenantId);
    return (await this.deps.store.list(who.tenantId, { status: 'all' }))
      .filter((c) => { const p = norm(c.party); return p.length >= 2 && (p.includes(key) || key.includes(p)); })
      .map((c) => this.view(c, names));
  }

  /**
   * 契約書チェックで見直す（更新の前に。第38.18節）。ドライブの契約書を、頼んだ本人のファイルとして M2Office に写し、契約書チェックを起こす。
   *
   * @returns 実行の ID か、始められない理由
   */
  async startReview(who: ContractViewer, id: string): Promise<{ runId: string } | { error: string }> {
    if (!this.deps.reviewStarter) return { error: '契約書チェックは使えません' };
    const f = await this.openFile(who, id);
    if ('error' in f) return f;
    const ext = (/\.([a-z0-9]+)$/i.exec(f.name)?.[1] ?? '').toLowerCase();
    const kind = f.mimeType === 'application/pdf' || ext === 'pdf' ? 'pdf'
      : ext === 'docx' || f.mimeType.includes('wordprocessingml') ? 'docx'
        : f.mimeType === 'image/png' || ext === 'png' ? 'png'
          : f.mimeType === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : null;
    if (!kind) return { error: 'この形式の契約書は、契約書チェックで読めません（PDF・Word・写真）' };
    const saved = await saveFile(this.deps.repo, this.deps.files, { tenantId: who.tenantId, ownerUserId: who.userId, name: f.name, kind, bytes: f.bytes, origin: 'upload', runId: null });
    const runId = await this.deps.reviewStarter(who.tenantId, who.userId, saved.id);
    if (!runId) return { error: '契約書チェックを使えません（拡張機能の「契約書チェック」を入れていないか、利用範囲の外です）' };
    await this.audit(who, 'contract.review', id, {});
    return { runId };
  }

  // ---- 期限の見張り ------------------------------------------------------------------------

  /**
   * 自動更新の契約を、いまの期間まで進める（終わりの日を過ぎ、解約を申し出ていなければ）。解約を申し出た・自動更新の無い契約は、終わったら「終了」にする。
   *
   * @returns 進めた回数
   */
  private async rollForward(tenantId: string, id: string, now: Date): Promise<number> {
    const today = jstToday(now);
    const c = await this.deps.store.get(tenantId, id);
    if (!c || c.status === 'ended' || !c.endOn || c.endOn >= today) return 0;
    if (c.status === 'cancel_requested' || !c.autoRenew || !c.renewMonths) {
      await this.deps.store.update(tenantId, id, { status: 'ended' }, SYSTEM);
      return 0;
    }
    let start = c.startOn;
    let end = c.endOn;
    let n = 0;
    while (end < today && n < 200) {
      start = addDays(end, 1);
      end = addDays(addMonths(start, c.renewMonths), -1);
      n += 1;
    }
    await this.deps.store.update(tenantId, id, {
      startOn: start, endOn: end, noticeDeadline: noticeDeadline(end, c.noticeDays), renewedCount: c.renewedCount + n, notified: [],
    }, SYSTEM);
    return n;
  }

  /** 1 人に知らせる。止めた人・利用範囲の外の人・「契約」の知らせを切った人には送らない。 */
  private async notify(tenantId: string, userId: string, title: string, body: string, now: Date): Promise<boolean> {
    const { repo } = this.deps;
    const user = await repo.findUserById(tenantId, userId);
    if (!user || user.status !== 'active') return false;
    const settings = await repo.getTenantSettings(tenantId);
    if (!canUseAgent(settings.access, CONTRACTS_EXTENSION_ID, userId, await repo.listUserGroupIds(tenantId, userId))) return false;
    const prefs = await repo.getUserSettings(tenantId, userId).catch(() => null);
    if (prefs?.notifications.kinds.contract === false) return false;
    await repo.createNotification({ id: randomUUID(), tenantId, userId, kind: 'contract', title, body: body.slice(0, 400), runId: null, readAt: null, createdAt: now.toISOString() });
    return true;
  }

  /** 知らせる相手（担当。担当が知らせを受けられなければ、利用範囲の管理者）。 */
  private async tell(tenantId: string, c: StoredContract, title: string, body: string, now: Date): Promise<void> {
    if (await this.notify(tenantId, c.ownerId, title, body, now)) return;
    for (const u of await this.deps.repo.listUsers(tenantId)) {
      if (u.status === 'active' && u.roles.includes('admin')) await this.notify(tenantId, u.id, title, body, now);
    }
  }

  /**
   * 見張りの 1 回分（ワーカーから。毎日見る）。自動更新の契約を進め、解約の申し出の期限（60・30・7 日前）と、
   * 自動更新の無い契約の終わり（30 日前）を知らせる。
   *
   * @returns 知らせた数と進めた数
   */
  async tick(now: Date = new Date()): Promise<{ notified: number; renewed: number }> {
    let notified = 0;
    let renewed = 0;
    const today = jstToday(now);
    const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
    for (const tenantId of await this.deps.repo.listTenantIds()) {
      try {
        const settings = await this.deps.repo.getTenantSettings(tenantId);
        if (!settings.contracts.enabled) continue;
        for (const c0 of await this.deps.store.list(tenantId, { status: 'all' })) {
          if (c0.status === 'ended') continue;
          const n = await this.rollForward(tenantId, c0.id, now);
          const c = (await this.deps.store.get(tenantId, c0.id))!;
          const label = `${c.party || '相手不明'}の${CONTRACT_KIND_LABELS[c.kind]}`;
          if (n > 0) {
            renewed += 1;
            await this.tell(tenantId, c, `${label}を自動で更新しました`, `解約の申し出が無かったので、${c.endOn ? `${md(c.endOn)} まで` : '次の期間に'}延びました。${c.noticeDeadline ? `次の解約の申し出の期限は ${c.noticeDeadline} です。` : ''}`, now);
            await this.audit({ tenantId, userId: SYSTEM }, 'contract.renewed', c.id, { times: n });
            continue;
          }
          if (c.status !== 'active') continue;
          const sent = new Set(c.notified);
          const add: string[] = [];
          if (c.autoRenew && c.noticeDeadline) {
            const left = Math.round((Date.parse(`${c.noticeDeadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
            // いちばん近い（まだ知らせていない）知らせの日だけを送る（入れたのが期限の近くでも 1 回だけ）
            const due = CONTRACT_NOTICE_DAYS_BEFORE.filter((d) => left >= 0 && left <= d && !sent.has(`notice:${d}`));
            if (due.length) {
              const rule = c.noticeRule ? `\n${c.noticeRule}` : '';
              // 更新の前に見直す提案（契約書がドライブにあれば、契約の画面から契約書チェックを始められる。第38.18節）
              const review = c.driveFileId ? '\n更新するか迷うときは、契約書の管理の画面の「契約書チェックで見直す」で、いまの契約書を見直せます。' : '';
              await this.tell(tenantId, c, `${label}: 解約の申し出の期限まであと ${left} 日（${md(c.noticeDeadline)}）`,
                `更新するなら何もしなくてかまいません。やめるなら ${c.noticeDeadline} までに相手に申し出てください（秘書に「解約の申し出の文を書いて」と頼めます）。${rule}${review}`, now);
              add.push(...due.map((d) => `notice:${d}`));
              notified += 1;
            }
          } else if (!c.autoRenew && c.endOn) {
            const left = Math.round((Date.parse(`${c.endOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
            if (left >= 0 && left <= CONTRACT_END_DAYS_BEFORE && !sent.has(`end:${CONTRACT_END_DAYS_BEFORE}`)) {
              await this.tell(tenantId, c, `${label}: 契約の終わりまであと ${left} 日（${md(c.endOn)}）`, '自動では更新されない契約です。続けるなら、相手と更新の話をしてください。', now);
              add.push(`end:${CONTRACT_END_DAYS_BEFORE}`);
              notified += 1;
            }
          }
          if (add.length) await this.deps.store.update(tenantId, c.id, { notified: [...c.notified, ...add] }, SYSTEM);
        }
      } catch (err) {
        this.log.warn('契約の期限の見張りに失敗しました', { tenantId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { notified, renewed };
  }

  /** 期限の近い順の鍵（画面と秘書の答えに使う）。 */
  static nextDue(c: Pick<Contract, 'noticeDeadline' | 'endOn' | 'status' | 'autoRenew'>): string | null {
    return nextDue(c);
  }
}
