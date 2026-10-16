/**
 * @file 証拠保全の ZIP を組み立てる（仕様書 第16.10.5節、ADR-0098）。ワーカーが待っている保全を 1 つずつ取って作る。
 *
 * 範囲のシステムログ・監査ログ・不正の兆し・その時点のログイン中の端末・日ごとの改ざんの確かめの値を、1 つの ZIP にする。
 * ローカルの形の機械の保全（`machine`）では、標準出力のファイルと入口のアクセスログ（接続元の IP を含む）も入れる。
 * ファイルごとの SHA-256 を `manifest.json` に、ZIP 全体の SHA-256 を `evidence_packages` に残す（写した後に変わっていないことを示す）。
 * 業務の入力・成果物・会話・ファイルの中身は入れない（システムログと監査ログがもともと中身を持たない）。
 */

import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import type { Repository } from '../repository/types.js';
import type { SecurityStore } from '../security/store.js';
import { silentLogger, type Logger } from './logger.js';
import type { EvidencePackage, PostgresSystemLogStore } from './store.js';

/** 1 回に読むシステムログの行数。 */
const PAGE = 20_000;
/** 1 回に読む監査ログの件数。 */
const AUDIT_PAGE = 5_000;
/** 機械のログのファイルとして入れる名前（入れ替えた世代と圧縮したものも）。 */
const MACHINE_LOG = /\.log(\.\d+)?(\.(gz|bz2))?$/;

/** 組み立てに要るもの。 */
export interface EvidenceBuilderDeps {
  store: Pick<PostgresSystemLogStore, 'claimEvidence' | 'evidenceLogs' | 'putEvidence' | 'failEvidence' | 'digests'>;
  repo: Pick<Repository, 'listTenantIds' | 'searchAudit' | 'listUsers' | 'createNotification'>;
  security: Pick<SecurityStore, 'recentSignals' | 'liveSessions'>;
  /** ローカルの形の機械のログの置き場（`<データの置き場>/logs`）。無ければ機械のファイルは入れない。 */
  machineLogDir?: string | null;
  logger?: Logger;
  now?: () => Date;
}

/** `manifest.json` に書く、入れたファイル 1 つ。 */
export interface EvidenceFile {
  path: string;
  size: number;
  sha256: string;
  /** 行・件の数（数えられるものだけ）。 */
  count?: number;
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

/**
 * 証拠保全の組み立て役。
 *
 * @remarks テナント境界: 会社の保全は、その会社の分だけを入れる。全体の保全（クラウドの形の運営）だけが全社を入れる
 */
export class EvidenceBuilder {
  private readonly log: Logger;

  constructor(private readonly deps: EvidenceBuilderDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /**
   * 待っている保全を 1 つ作る。
   *
   * @returns 作った（作れなかった）保全の ID。待っているものが無ければ `null`
   */
  async tick(): Promise<string | null> {
    const p = await this.deps.store.claimEvidence();
    if (!p) return null;
    try {
      const { zip, manifest } = await this.build(p);
      const digest = sha(zip);
      await this.deps.store.putEvidence(p.id, zip, digest, manifest);
      this.log.info('証拠を保全しました', { evidenceId: p.id, scope: p.scope, tenantId: p.tenantId, size: zip.length });
      await this.notify(p, `証拠を保全しました（${(zip.length / 1024 / 1024).toFixed(1)} MB）`, true);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      await this.deps.store.failEvidence(p.id, why).catch(() => undefined);
      this.log.error('証拠を保全できませんでした', { evidenceId: p.id, err });
      await this.notify(p, '証拠を保全できませんでした。もう一度押してください', false);
    }
    return p.id;
  }

  /** ZIP を組み立てる。 */
  async build(p: EvidencePackage): Promise<{ zip: Uint8Array; manifest: Record<string, unknown> }> {
    const zip = new JSZip();
    const files: EvidenceFile[] = [];
    const add = (path: string, body: Uint8Array | string, count?: number) => {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      zip.file(path, bytes);
      files.push({ path, size: bytes.byteLength, sha256: sha(bytes), ...(count !== undefined ? { count } : {}) });
    };
    const all = p.scope === 'all';
    const tenants = all ? await this.deps.repo.listTenantIds() : p.tenantId ? [p.tenantId] : [];

    // システムログ（会社の保全は、その会社の分と、機械の保全なら会社に属さない分も）
    const lines: unknown[] = [];
    for (const tenantId of all ? [null] : p.scope === 'machine' ? [p.tenantId, null] : [p.tenantId]) {
      let after: { at: string; id: string } | null = null;
      for (;;) {
        const page = await this.deps.store.evidenceLogs({ tenantId, all, from: p.rangeFrom, to: p.rangeTo, after, limit: PAGE });
        lines.push(...page);
        if (page.length < PAGE) break;
        after = { at: page[page.length - 1]!.at, id: page[page.length - 1]!.id };
      }
    }
    add('system-logs.jsonl', jsonl(lines), lines.length);

    // 会社ごとの監査ログ・不正の兆し・その時点のログイン中の端末
    const now = (this.deps.now ?? (() => new Date()))();
    for (const tenantId of tenants) {
      const audit: unknown[] = [];
      for (let offset = 0; ; offset += AUDIT_PAGE) {
        const page = await this.deps.repo.searchAudit(tenantId, { from: p.rangeFrom, to: p.rangeTo, limit: AUDIT_PAGE, offset });
        audit.push(...page);
        if (page.length < AUDIT_PAGE) break;
      }
      add(`audit/${tenantId}.jsonl`, jsonl(audit), audit.length);
      const signals = (await this.deps.security.recentSignals(tenantId, p.rangeFrom, 100_000)).filter((s) => s.createdAt < p.rangeTo);
      add(`security-signals/${tenantId}.jsonl`, jsonl(signals), signals.length);
      const sessions = await this.deps.security.liveSessions(tenantId, now.toISOString());
      add(`sessions/${tenantId}.json`, JSON.stringify({ at: now.toISOString(), sessions }, null, 2), sessions.length);
    }

    // 日ごとの改ざんの確かめの値
    const digests = await this.deps.store.digests(p.rangeFrom.slice(0, 10), p.rangeTo.slice(0, 10), false);
    add('system-log-digests.json', JSON.stringify(digests, null, 2), digests.length);

    // ローカルの形の機械のログのファイル（入口のアクセスログを含む）
    if (p.scope === 'machine' && this.deps.machineLogDir) {
      for (const name of (await readdir(this.deps.machineLogDir).catch(() => [] as string[])).sort()) {
        if (!MACHINE_LOG.test(name)) continue;
        const path = join(this.deps.machineLogDir, name);
        const st = await stat(path).catch(() => null);
        if (!st?.isFile() || st.size > 1024 * 1024 * 1024) continue;
        add(`machine-logs/${name}`, new Uint8Array(await readFile(path)));
      }
    }

    const manifest = {
      id: p.id, scope: p.scope, tenantId: p.tenantId, reason: p.reason, createdKind: p.createdKind, createdBy: p.createdBy,
      range: { from: p.rangeFrom, to: p.rangeTo }, generatedAt: now.toISOString(), files,
      note: 'ファイルごとの sha256 を、取り出したファイルの SHA-256 と比べると、写した後に変わっていないことを確かめられます。ZIP 全体の SHA-256 は M2Office の保全の一覧にあります。',
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return { zip: bytes, manifest };
  }

  /** 会社の保全なら、その会社の管理者全員に「セキュリティ」で知らせる（全体の保全は運営の画面に出す）。 */
  private async notify(p: EvidencePackage, title: string, ok: boolean): Promise<void> {
    if (!p.tenantId) return;
    const admins = (await this.deps.repo.listUsers(p.tenantId).catch(() => [])).filter((u) => u.status === 'active' && u.roles.includes('admin'));
    const by = p.createdKind === 'system' ? '不正の兆しの見張りが自動で' : p.createdKind === 'operator' ? '運営が' : '管理者が';
    const body = ok
      ? `${by}、${p.rangeFrom.slice(0, 10)} から ${p.rangeTo.slice(0, 10)} までのログと記録を保全しました。理由: ${p.reason}。保全したものは 1 年は消せません。`
      : `${by}頼んだ保全を作れませんでした。理由: ${p.reason}`;
    for (const a of admins) {
      await this.deps.repo.createNotification({ id: randomUUID(), tenantId: p.tenantId, userId: a.id, kind: 'security', title, body, runId: null, readAt: null, createdAt: new Date().toISOString() }).catch(() => undefined);
    }
  }
}
