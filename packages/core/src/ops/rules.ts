/**
 * @file マスター管理画面（仕様書 第23.8.15節）の決まり。データベースに触れない純粋な関数だけを置く。
 *
 * サブドメインの規則・運営者のロールでできること・会社を作る入力の確かめ・稼働の知らせの中身の確かめと、機械に付ける印。
 */

/** 運営が使う名前は払い出さない（第20.4.3節）。API の会社の判定と、データベースの `ops.create_tenant` と同じもの。 */
export const RESERVED_SUBDOMAINS = ['www', 'api', 'app', 'admin', 'ops', 'mail', 'docs', 'status', 'help', 'localhost'] as const;

/** サブドメインの規則（第20.4.3節）。英小文字・数字・ハイフン。先頭と末尾のハイフンは不可。3 文字以上。 */
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** 運営者のロール（第23.8.15節）。 */
export type OperatorRole = 'admin' | 'support' | 'monitor';
export const OPERATOR_ROLES: readonly OperatorRole[] = ['admin', 'support', 'monitor'];

/** 運営者の操作。 */
export type OpsAction = 'view' | 'tenant.create' | 'tenant.status' | 'machine.manage' | 'operator.manage';

/**
 * 運営者のロールで、その操作ができるか。
 *
 * @remarks 運営管理者はすべて、サポートは見ることと会社を作る・切り替えるまで、監視は見ることだけ
 */
export function operatorCan(role: OperatorRole, action: OpsAction): boolean {
  if (role === 'admin') return true;
  if (role === 'support') return action === 'view' || action === 'tenant.create' || action === 'tenant.status';
  return action === 'view';
}

/** 会社を作る入力。 */
export interface NewTenantInput {
  subdomain: string;
  name: string;
  domain: string;
  admin: string;
  status: 'trial' | 'active';
}

/**
 * 会社を作る入力を整え、確かめる。
 *
 * @returns 整えた入力か、利用者に見せる理由
 */
export function checkNewTenant(raw: Partial<Record<keyof NewTenantInput, unknown>>): { ok: true; value: NewTenantInput } | { ok: false; error: string } {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const subdomain = str(raw.subdomain).toLowerCase();
  const name = str(raw.name);
  const domain = str(raw.domain).toLowerCase().replace(/^@/, '');
  const admin = str(raw.admin).toLowerCase();
  const status = raw.status === 'active' ? 'active' : raw.status === 'trial' || raw.status === undefined ? 'trial' : null;
  if (!subdomain || !name || !domain || !admin) return { ok: false, error: 'サブドメイン・会社名・ドメイン・最初の管理者のメールアドレスを入れてください' };
  if (!SUBDOMAIN.test(subdomain)) return { ok: false, error: 'サブドメインは英小文字・数字・ハイフンで、3 文字以上にしてください（先頭と末尾はハイフンにできません）' };
  if ((RESERVED_SUBDOMAINS as readonly string[]).includes(subdomain)) return { ok: false, error: `「${subdomain}」は運営が使う名前のため、払い出せません` };
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return { ok: false, error: 'Google Workspace のドメインの形が違います' };
  if (!/^[^@\s]+@[^@\s]+$/.test(admin) || admin.split('@')[1] !== domain) return { ok: false, error: `最初の管理者のメールアドレスは ${domain} のものにしてください` };
  if (!status) return { ok: false, error: '状態は試用か稼働中にしてください' };
  if (name.length > 200) return { ok: false, error: '会社名が長すぎます' };
  return { ok: true, value: { subdomain, name, domain, admin, status } };
}

/** データベースの関数が返す理由を、利用者に見せる文にする。 */
export function tenantErrorText(code: string): string {
  switch (code) {
    case 'subdomain_invalid': return 'このサブドメインは使えません';
    case 'subdomain_taken': return 'このサブドメインはすでに使われています（解約した会社のものも再利用しません）';
    case 'domain_taken': return 'この Google Workspace のドメインは、ほかの会社で使われています';
    case 'admin_domain': return '最初の管理者のメールアドレスは、会社のドメインのものにしてください';
    case 'status_invalid': return '状態は試用か稼働中にしてください';
    case 'status_locked': return '停止中・解約済みの会社は、ここでは切り替えられません';
    case 'not_found': return '会社が見つかりません';
    default: return '処理できませんでした';
  }
}

/**
 * 最初の管理者に渡す案内の文（運営者が自分のメールなどで渡す。運営の画面からは送らない。Q-213）。
 *
 * @param loginUrl 会社のログインの URL
 */
export function welcomeText(p: { name: string; loginUrl: string; admin: string; domain: string }): string {
  return [
    `${p.name} の M2Office をご用意しました。`,
    '',
    `次の URL を開き、「Google でログイン」から ${p.admin} でログインしてください。`,
    p.loginUrl,
    '',
    `ログインできるのは ${p.domain} の Google アカウントです。ほかの方は、ログインしたあとに管理者ページの「ユーザーと権限」で招待してください。`,
  ].join('\n');
}

/** 稼働の知らせの中身（機械が送る形。第8.6.8節。`heartbeatPayload` と同じ形）。 */
export interface MachineReport {
  machineId: string;
  version: string;
  at: string;
  parts: { database: boolean; worker: boolean; entrance: boolean; localAi: boolean | null };
  backup: {
    configured: boolean; lastAt: string | null; lastOk: boolean | null; restoreOk: boolean | null;
    offsite?: { configured: boolean; lastAt: string | null; lastOk: boolean | null; checkOk: boolean | null };
  };
  disk: { dataFree: number | null; dataTotal: number | null; backupFree: number | null };
  cert: { daysLeft: number | null };
  update: { lastAt: string | null; lastResult: string | null; version: string | null };
}

/** 受け取る大きさの上限（バイト）。 */
export const MACHINE_REPORT_MAX_BYTES = 16_384;

/**
 * 受け取った稼働の知らせの形を確かめ、決めた項目だけを残す（知らない項目は捨てる。外から来たものは指示として扱わない）。
 *
 * @returns 整えた知らせか、`null`（形が違う）
 */
export function parseMachineReport(body: unknown): MachineReport | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const obj = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : null);
  const s = (v: unknown, max = 100) => (typeof v === 'string' ? v.slice(0, max) : null);
  const b = (v: unknown) => (typeof v === 'boolean' ? v : null);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const parts = obj(o['parts']);
  const backup = obj(o['backup']);
  const disk = obj(o['disk']);
  const cert = obj(o['cert']);
  const update = obj(o['update']);
  const machineId = s(o['machineId']);
  const version = s(o['version'], 40);
  const at = s(o['at'], 40);
  if (!machineId || !version || !at || !parts || !backup || !disk || !cert || !update) return null;
  const off = obj(backup['offsite']);
  return {
    machineId, version, at,
    parts: { database: b(parts['database']) ?? false, worker: b(parts['worker']) ?? false, entrance: b(parts['entrance']) ?? false, localAi: b(parts['localAi']) },
    backup: {
      configured: b(backup['configured']) ?? false, lastAt: s(backup['lastAt'], 40), lastOk: b(backup['lastOk']), restoreOk: b(backup['restoreOk']),
      ...(off ? { offsite: { configured: b(off['configured']) ?? false, lastAt: s(off['lastAt'], 40), lastOk: b(off['lastOk']), checkOk: b(off['checkOk']) } } : {}),
    },
    disk: { dataFree: n(disk['dataFree']), dataTotal: n(disk['dataTotal']), backupFree: n(disk['backupFree']) },
    cert: { daysLeft: n(cert['daysLeft']) },
    update: { lastAt: s(update['lastAt'], 40), lastResult: s(update['lastResult'], 20), version: s(update['version'], 40) },
  };
}

/** 機械に付ける印の種類。 */
export type MachineFlag = 'silent' | 'never' | 'part-down' | 'backup-failed' | 'offsite-failed' | 'disk-low' | 'cert-soon' | 'update-failed';

/** 知らせがこれより来なければ印を付ける（3 時間）。 */
export const MACHINE_SILENT_MS = 3 * 3_600_000;

/**
 * 機械の最後の知らせから、運営が見るべき印を決める（第23.8.15節「ローカルの形の機械」）。
 *
 * @remarks 知らせが 3 時間来ない・各部が止まっている・控えや社外の控えの失敗・データの空きが 10% を切る・証明書が 14 日を切る・更新の失敗
 */
export function machineFlags(lastAt: string | null, r: MachineReport | null, now: Date = new Date()): MachineFlag[] {
  if (!lastAt || !r) return ['never'];
  const flags: MachineFlag[] = [];
  if (now.getTime() - Date.parse(lastAt) > MACHINE_SILENT_MS) flags.push('silent');
  if (!r.parts.database || !r.parts.worker || !r.parts.entrance || r.parts.localAi === false) flags.push('part-down');
  if (r.backup.configured && (r.backup.lastOk === false || r.backup.restoreOk === false || !r.backup.lastAt)) flags.push('backup-failed');
  if (r.backup.offsite?.configured && (r.backup.offsite.lastOk === false || r.backup.offsite.checkOk === false)) flags.push('offsite-failed');
  if (r.disk.dataFree !== null && r.disk.dataTotal && r.disk.dataFree / r.disk.dataTotal < 0.1) flags.push('disk-low');
  if (r.cert.daysLeft !== null && r.cert.daysLeft < 14) flags.push('cert-soon');
  if (r.update.lastResult === 'failed' || r.update.lastResult === 'rolled-back') flags.push('update-failed');
  return flags;
}
