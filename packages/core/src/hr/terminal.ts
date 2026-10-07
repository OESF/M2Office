/**
 * @file 共有の端末での打刻（仕様書 第30.6.3節、ADR-0085）。受付などに置いたタブレットかパソコンに、打刻の画面だけを出す。
 *
 * 端末の登録は店頭サイネージと同じ（端末に出た 6 桁の番号を、人事区画の人が登録する。第31.5.1節）。端末は鍵で名乗る（ハッシュだけを持つ）。
 * 打刻は、端末に出した QR を**本人が自分のスマホで読み、本人のログインで打つ**。QR は 30 秒ごとに変わり、その端末で打ったことが記録に残る。
 * スマホを持たない人のために、会社が許せば「名前を選んで 4 桁の番号を入れる」で打てる。番号を 5 回間違えたら、その人の打刻を 15 分止め、担当者に知らせる。
 *
 * @remarks テナント境界: 置き場は会社ごとに絞る（不変則 I-2）。端末の鍵で読めるのは、その会社の打刻の画面に要るものだけ
 */

import { createHash, createHmac, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import type { AttPunchKind, AuditEvent, HrEmployee } from '@m2office/shared';
import type { Repository } from '../repository/types.js';

/** 登録した端末。 */
export interface HrTerminal {
  id: string;
  name: string;
  lastSeenAt: string | null;
  registeredAt: string;
}

/** QR が変わる間隔（ミリ秒）。 */
export const TERMINAL_QR_MS = 30_000;
/** 番号を間違えられる回数と、止める時間（ミリ秒）。 */
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MS = 15 * 60_000;
/** 1 社の端末の上限。 */
export const TERMINAL_MAX = 10;

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const SECRET_FORMAT = /^[A-Za-z0-9_-]{32,64}$/;

/** 端末の置き場。 */
export interface TerminalStore {
  createPairing(tenantId: string, p: { id: string; code: string; secretHash: string; expiresAt: string }): Promise<void>;
  trimPairings(tenantId: string, keep: number): Promise<void>;
  findPairingByCode(tenantId: string, code: string, now: Date): Promise<{ id: string } | null>;
  findPairingBySecret(tenantId: string, secretHash: string): Promise<{ id: string; expiresAt: string; terminalId: string | null } | null>;
  setPairingTerminal(tenantId: string, id: string, terminalId: string): Promise<void>;
  deletePairing(tenantId: string, id: string): Promise<void>;
  createTerminal(tenantId: string, t: { id: string; name: string }, by: string): Promise<void>;
  setTerminalKey(tenantId: string, id: string, keyHash: string): Promise<void>;
  listTerminals(tenantId: string): Promise<HrTerminal[]>;
  terminalByKey(tenantId: string, keyHash: string): Promise<HrTerminal | null>;
  getTerminal(tenantId: string, id: string): Promise<HrTerminal | null>;
  removeTerminal(tenantId: string, id: string, by: string): Promise<boolean>;
  getPin(tenantId: string, employeeId: string): Promise<{ pinHash: string; failures: number; lockedUntil: string | null } | null>;
  savePin(tenantId: string, employeeId: string, pinHash: string): Promise<void>;
  setPinFailures(tenantId: string, employeeId: string, failures: number, lockedUntil: string | null): Promise<void>;
  listPinEmployees(tenantId: string): Promise<string[]>;
  close?(): Promise<void>;
}

/** PostgreSQL の端末の置き場。問い合わせごとに会社を設定し、行単位の制限で絞る（移行 110）。 */
export class PostgresTerminalStore implements TerminalStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 2 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const rows = (await client.query<T>(text, params as never[])).rows;
      await client.query('commit');
      return rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private static readonly COLS = `id, name, to_json(last_seen_at) #>> '{}' as "lastSeenAt", to_json(registered_at) #>> '{}' as "registeredAt"`;

  async createPairing(tenantId: string, p: { id: string; code: string; secretHash: string; expiresAt: string }): Promise<void> {
    await this.q(tenantId, `insert into hr_terminal_pairings (id, tenant_id, code, secret_hash, expires_at) values ($1,$2,$3,$4,$5)`,
      [p.id, tenantId, p.code, p.secretHash, p.expiresAt]);
  }

  async trimPairings(tenantId: string, keep: number): Promise<void> {
    await this.q(tenantId, `delete from hr_terminal_pairings where tenant_id = $1 and (expires_at < now() - interval '1 hour' or id not in (
      select id from hr_terminal_pairings where tenant_id = $1 order by created_at desc limit $2))`, [tenantId, keep]);
  }

  async findPairingByCode(tenantId: string, code: string, now: Date): Promise<{ id: string } | null> {
    const rows = await this.q<{ id: string }>(tenantId,
      `select id from hr_terminal_pairings where tenant_id = $1 and code = $2 and expires_at > $3 and terminal_id is null limit 1`, [tenantId, code, now.toISOString()]);
    return rows[0] ?? null;
  }

  async findPairingBySecret(tenantId: string, secretHash: string): Promise<{ id: string; expiresAt: string; terminalId: string | null } | null> {
    const rows = await this.q<{ id: string; expiresAt: string; terminalId: string | null }>(tenantId,
      `select id, to_json(expires_at) #>> '{}' as "expiresAt", terminal_id as "terminalId" from hr_terminal_pairings where tenant_id = $1 and secret_hash = $2`, [tenantId, secretHash]);
    return rows[0] ?? null;
  }

  async setPairingTerminal(tenantId: string, id: string, terminalId: string): Promise<void> {
    await this.q(tenantId, `update hr_terminal_pairings set terminal_id = $3 where tenant_id = $1 and id = $2`, [tenantId, id, terminalId]);
  }

  async deletePairing(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, `delete from hr_terminal_pairings where tenant_id = $1 and id = $2`, [tenantId, id]);
  }

  async createTerminal(tenantId: string, t: { id: string; name: string }, by: string): Promise<void> {
    await this.q(tenantId, `insert into hr_terminals (id, tenant_id, name, registered_by) values ($1,$2,$3,$4)`, [t.id, tenantId, t.name, by]);
  }

  async setTerminalKey(tenantId: string, id: string, keyHash: string): Promise<void> {
    await this.q(tenantId, `update hr_terminals set key_hash = $3 where tenant_id = $1 and id = $2 and status = 'active'`, [tenantId, id, keyHash]);
  }

  async listTerminals(tenantId: string): Promise<HrTerminal[]> {
    return this.q<HrTerminal>(tenantId, `select ${PostgresTerminalStore.COLS} from hr_terminals where tenant_id = $1 and status = 'active' order by registered_at`, [tenantId]);
  }

  async terminalByKey(tenantId: string, keyHash: string): Promise<HrTerminal | null> {
    const rows = await this.q<HrTerminal>(tenantId,
      `update hr_terminals set last_seen_at = now() where tenant_id = $1 and key_hash = $2 and status = 'active' returning ${PostgresTerminalStore.COLS}`, [tenantId, keyHash]);
    return rows[0] ?? null;
  }

  async getTerminal(tenantId: string, id: string): Promise<HrTerminal | null> {
    const rows = await this.q<HrTerminal>(tenantId, `select ${PostgresTerminalStore.COLS} from hr_terminals where tenant_id = $1 and id = $2 and status = 'active'`, [tenantId, id]);
    return rows[0] ?? null;
  }

  async removeTerminal(tenantId: string, id: string, by: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `update hr_terminals set status = 'removed', key_hash = null, removed_by = $3, removed_at = now() where tenant_id = $1 and id = $2 and status = 'active' returning id`, [tenantId, id, by]);
    return rows.length > 0;
  }

  async getPin(tenantId: string, employeeId: string): Promise<{ pinHash: string; failures: number; lockedUntil: string | null } | null> {
    const rows = await this.q<{ pinHash: string; failures: number; lockedUntil: string | null }>(tenantId,
      `select pin_hash as "pinHash", failures, to_json(locked_until) #>> '{}' as "lockedUntil" from hr_punch_pins where tenant_id = $1 and employee_id = $2`, [tenantId, employeeId]);
    return rows[0] ?? null;
  }

  async savePin(tenantId: string, employeeId: string, pinHash: string): Promise<void> {
    await this.q(tenantId, `insert into hr_punch_pins (tenant_id, employee_id, pin_hash) values ($1,$2,$3)
      on conflict (tenant_id, employee_id) do update set pin_hash = excluded.pin_hash, failures = 0, locked_until = null, updated_at = now()`, [tenantId, employeeId, pinHash]);
  }

  async setPinFailures(tenantId: string, employeeId: string, failures: number, lockedUntil: string | null): Promise<void> {
    await this.q(tenantId, `update hr_punch_pins set failures = $3, locked_until = $4 where tenant_id = $1 and employee_id = $2`, [tenantId, employeeId, failures, lockedUntil]);
  }

  async listPinEmployees(tenantId: string): Promise<string[]> {
    return (await this.q<{ id: string }>(tenantId, `select employee_id as id from hr_punch_pins where tenant_id = $1`, [tenantId])).map((r) => r.id);
  }
}

/** 番号のハッシュ（scrypt。塩を前に付ける）。 */
export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pin, salt, 32).toString('hex')}`;
}

/** 番号が合うか。 */
export function pinMatches(pin: string, stored: string): boolean {
  const [salt, h] = stored.split(':');
  if (!salt || !h) return false;
  const got = scryptSync(pin, salt, 32);
  const want = Buffer.from(h, 'hex');
  return want.length === got.length && timingSafeEqual(got, want);
}

/** 端末の処理に要るもの。 */
export interface TerminalServiceDeps {
  store: TerminalStore;
  repo: Repository;
  /** QR の署名の鍵（会社をまたいで同じでよい。会社と端末を署名に含める）。 */
  secret: string;
  /** 担当者（人事区画の人）に知らせる。 */
  alertStaff(tenantId: string, title: string, body: string): Promise<unknown>;
  now?: () => Date;
}

/**
 * 共有の端末。
 */
export class TerminalService {
  constructor(private readonly deps: TerminalServiceDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** 登録の番号を作る（端末から。ログインなし）。 */
  async createPairing(tenantId: string, secret: unknown): Promise<{ code: string; expiresAt: string } | { error: string }> {
    if (typeof secret !== 'string' || !SECRET_FORMAT.test(secret)) return { error: '登録の合言葉が違います' };
    const now = this.now();
    await this.deps.store.trimPairings(tenantId, 4);
    let code = '';
    for (let i = 0; i < 20 && !code; i++) {
      const c = String(randomInt(0, 1_000_000)).padStart(6, '0');
      if (!(await this.deps.store.findPairingByCode(tenantId, c, now))) code = c;
    }
    if (!code) return { error: '番号を作れませんでした。もう一度お試しください' };
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    await this.deps.store.createPairing(tenantId, { id: randomUUID(), code, secretHash: hash(secret), expiresAt });
    return { code, expiresAt };
  }

  /** 登録されたか（端末から）。登録されていれば、このときに端末の鍵を作って 1 度だけ返す。 */
  async pollPairing(tenantId: string, secret: unknown): Promise<{ status: 'waiting' | 'expired' } | { status: 'registered'; key: string; terminalId: string }> {
    if (typeof secret !== 'string' || !SECRET_FORMAT.test(secret)) return { status: 'expired' };
    const p = await this.deps.store.findPairingBySecret(tenantId, hash(secret));
    if (!p) return { status: 'expired' };
    if (p.terminalId) {
      const key = randomBytes(24).toString('base64url');
      await this.deps.store.setTerminalKey(tenantId, p.terminalId, hash(key));
      await this.deps.store.deletePairing(tenantId, p.id);
      return { status: 'registered', key, terminalId: p.terminalId };
    }
    return Date.parse(p.expiresAt) < this.now().getTime() ? { status: 'expired' } : { status: 'waiting' };
  }

  /**
   * 番号で端末を登録する（人事区画の人）。
   *
   * @remarks 危険度: 低（会社の打刻の端末を増やす。社外への送信もお金の確定も無い。ADR-0028）
   */
  async claim(tenantId: string, userId: string, code: unknown, name: unknown): Promise<{ terminal: HrTerminal } | { error: string; status: number }> {
    const c = String(code ?? '').normalize('NFKC').replace(/\s/g, '');
    const p = /^\d{6}$/.test(c) ? await this.deps.store.findPairingByCode(tenantId, c, this.now()) : null;
    if (!p) return { error: '番号が見つからないか、切れています。端末に出ている番号を確かめてください', status: 404 };
    const list = await this.deps.store.listTerminals(tenantId);
    if (list.length >= TERMINAL_MAX) return { error: `端末は ${TERMINAL_MAX} 台までです。使っていない端末を外してください`, status: 409 };
    const n = String(name ?? '').trim().slice(0, 20) || `打刻の端末 ${list.length + 1}`;
    const id = randomUUID();
    await this.deps.store.createTerminal(tenantId, { id, name: n }, userId);
    await this.deps.store.setPairingTerminal(tenantId, p.id, id);
    await this.audit(tenantId, userId, 'hr.terminal.register', id, { name: n });
    return { terminal: (await this.deps.store.getTerminal(tenantId, id))! };
  }

  list(tenantId: string): Promise<HrTerminal[]> {
    return this.deps.store.listTerminals(tenantId);
  }

  /** 端末を外す（鍵はその場で効かなくなる）。 */
  async remove(tenantId: string, userId: string, id: string): Promise<boolean> {
    const ok = await this.deps.store.removeTerminal(tenantId, id, userId);
    if (ok) await this.audit(tenantId, userId, 'hr.terminal.remove', id, {});
    return ok;
  }

  /** 端末の鍵から端末を引く（端末から）。 */
  async byKey(tenantId: string, key: string | null): Promise<HrTerminal | null> {
    if (!key || !SECRET_FORMAT.test(key)) return null;
    return this.deps.store.terminalByKey(tenantId, hash(key));
  }

  private sign(tenantId: string, terminalId: string, window: number): string {
    return createHmac('sha256', this.deps.secret).update(`hr-terminal|${tenantId}|${terminalId}|${window}`).digest('base64url').slice(0, 22);
  }

  /** 端末に出す QR の中身（30 秒ごとに変わる）。 */
  qrToken(tenantId: string, terminal: HrTerminal): { token: string; expiresAt: string } {
    const now = this.now().getTime();
    const window = Math.floor(now / TERMINAL_QR_MS);
    return { token: `${terminal.id}.${window}.${this.sign(tenantId, terminal.id, window)}`, expiresAt: new Date((window + 1) * TERMINAL_QR_MS).toISOString() };
  }

  /**
   * スマホで読んだ QR を確かめる。いまと 1 つ前の区切りまで受ける（読んでから押すまでの間）。
   *
   * @returns 端末。期限切れ・ほかの会社・外した端末なら `null`
   */
  async verifyToken(tenantId: string, token: unknown): Promise<HrTerminal | null> {
    const m = /^([0-9a-f-]{36})\.(\d+)\.([A-Za-z0-9_-]{22})$/.exec(String(token ?? ''));
    if (!m) return null;
    const [, id, w, sig] = m as unknown as [string, string, string, string];
    const window = Number(w);
    const nowWindow = Math.floor(this.now().getTime() / TERMINAL_QR_MS);
    if (window !== nowWindow && window !== nowWindow - 1) return null;
    const want = Buffer.from(this.sign(tenantId, id, window));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    return this.deps.store.getTerminal(tenantId, id);
  }

  /** 名前と番号で打刻できる人（番号を決めた人だけ。名前だけを返す）。 */
  async pinPeople(tenantId: string, employees: HrEmployee[]): Promise<{ employeeId: string; name: string }[]> {
    const ids = new Set(await this.deps.store.listPinEmployees(tenantId));
    return employees.filter((e) => e.status === 'active' && ids.has(e.id)).map((e) => ({ employeeId: e.id, name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  }

  /** 本人が番号を決める（4 桁の数字）。 */
  async setPin(tenantId: string, employeeId: string, pin: unknown): Promise<{ ok: true } | { error: string }> {
    const p = String(pin ?? '').normalize('NFKC');
    if (!/^\d{4}$/.test(p)) return { error: '番号は 4 桁の数字にしてください' };
    if (/^(\d)\1{3}$/.test(p) || '0123456789'.includes(p) || '9876543210'.includes(p)) return { error: '同じ数字や続き番号は使えません' };
    await this.deps.store.savePin(tenantId, employeeId, hashPin(p));
    return { ok: true };
  }

  /**
   * 名前と番号を確かめる（端末から）。5 回間違えたら 15 分止め、担当者に知らせる。
   *
   * @returns 合えば `ok`
   */
  async checkPin(tenantId: string, employee: HrEmployee, pin: unknown): Promise<{ ok: true } | { error: string; status: number }> {
    const rec = await this.deps.store.getPin(tenantId, employee.id);
    if (!rec) return { error: '番号が決まっていません', status: 404 };
    const now = this.now().getTime();
    if (rec.lockedUntil && Date.parse(rec.lockedUntil) > now) return { error: '番号を何度も間違えたため、しばらく打刻できません。担当者に伝えてください', status: 429 };
    if (pinMatches(String(pin ?? '').normalize('NFKC'), rec.pinHash)) {
      if (rec.failures) await this.deps.store.setPinFailures(tenantId, employee.id, 0, null);
      return { ok: true };
    }
    const failures = (rec.lockedUntil && Date.parse(rec.lockedUntil) <= now ? 0 : rec.failures) + 1;
    if (failures >= PIN_MAX_FAILURES) {
      await this.deps.store.setPinFailures(tenantId, employee.id, 0, new Date(now + PIN_LOCK_MS).toISOString());
      await this.deps.alertStaff(tenantId, `勤怠: ${employee.name}さんの打刻の番号が ${PIN_MAX_FAILURES} 回間違えられました`, '共有の端末での、名前と番号の打刻を 15 分止めました。本人でなければ、番号を決め直してもらってください');
      await this.audit(tenantId, 'terminal', 'hr.terminal.pin_locked', employee.id, {});
      return { error: '番号を何度も間違えたため、しばらく打刻できません。担当者に伝えてください', status: 429 };
    }
    await this.deps.store.setPinFailures(tenantId, employee.id, failures, null);
    return { error: '番号が違います', status: 401 };
  }

  private async audit(tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    const ev: AuditEvent = { id: randomUUID(), tenantId, actorType: userId === 'terminal' ? 'system' : 'user', actorId: userId, action, targetType: 'hr', targetId, detail, occurredAt: this.now().toISOString() };
    await this.deps.repo.appendAudit(ev);
  }
}

/** 打刻の種類の呼び名（端末の画面と知らせ）。 */
export const PUNCH_LABELS: Record<AttPunchKind, string> = { in: '出勤', out: '退勤', break_start: '休憩', break_end: '休憩終わり' };
