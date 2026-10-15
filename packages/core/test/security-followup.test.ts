/**
 * @file 2026-10-12 の点検で検討が要るとしたもののうち、決めて直した 3 つの単体テスト（仕様書 第16.9節。第 0.366.0 版）。
 *
 * - 人事・給与の帳簿をまとめた書き出しが、件数を監査ログに残す（不正の兆しの見張りが数える。第16.8.2節）
 * - 本人の明細の PDF は、画面と同じく同意があり確定した明細だけ（第30.10.3節）
 * - 利用者と従業員の自動の結び付けは在籍中の人だけ（第30 章 段 2）
 *
 * 権限区画の承認と閲覧は `core.test.ts`・`run-access.test.ts` で確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditEvent, HrEmployee } from '@m2office/shared';
import { AttendanceService, HrBooksExport, PayrollService, type BooksExportDeps, type PayrollServiceDeps, type AttendanceServiceDeps } from '../src/index.js';

const employee = (over: Partial<HrEmployee>): HrEmployee => ({
  id: 'e1', code: '001', name: '社員', kana: '', birthDate: null, gender: '', address: '', phone: '', email: 'staff@example.test',
  hiredOn: null, leftOn: null, leaveReason: '', employment: 'regular', category: 'employee', department: '', title: '',
  userId: null, status: 'active', note: '', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
} as HrEmployee);

test('帳簿をまとめた書き出しは、表の行の合計を件数として監査ログに残す（第16.8.2節）', async () => {
  const audits: AuditEvent[] = [];
  const sheet = (n: number) => ({ columns: ['a'], rows: Array.from({ length: n }, (_, i) => [String(i)]) });
  const deps = {
    service: { rosterRows: async () => sheet(3), deps: { store: { listEmployees: async () => [] } } },
    payroll: { deps: { store: { listRuns: async () => [] } } },
    attendance: { deps: { store: { firstPunchDates: async () => new Map() } }, leaveRegister: async () => sheet(2) },
    yea: {}, social: { list: async () => [] }, labor: { bookSheet: async () => null },
    repo: {
      getTenantSettings: async () => ({ hr: { office: { name: '会社' }, pay: { closingDay: 31 } } }),
      findTenantById: async () => ({ name: '会社' }),
      appendAudit: async (e: AuditEvent) => { audits.push(e); },
    },
  } as unknown as BooksExportDeps;
  const r = await new HrBooksExport(deps).build('t', 'u1');
  assert.equal(r.summary.rows, 5);
  const ev = audits.find((e) => e.action === 'hr.books.export');
  assert.equal(ev?.detail?.['rows'], 5, '見張りが読む rows を残す');
});

test('本人の明細の PDF は、同意があり確定した本人の明細だけを出す（第30.10.3節）', async () => {
  let consentAt: string | null = null;
  const confirmed = [{ id: 'slip-ok' }];
  class Probe extends PayrollService {
    async slipPdf() { return { bytes: new Uint8Array([1]), filename: 'payslip.pdf' }; }
  }
  const svc = new Probe({
    store: { getProfile: async () => ({ payslipConsentAt: consentAt }), listConfirmedSlips: async () => confirmed },
  } as unknown as PayrollServiceDeps);
  const me = employee({});
  assert.equal(await svc.mySlipPdf('t', 'u1', me, 'slip-ok'), null, '同意が無ければ出さない');
  consentAt = '2026-10-01T00:00:00.000Z';
  assert.equal(await svc.mySlipPdf('t', 'u1', me, 'slip-draft'), null, '確定していない明細は出さない');
  assert.ok(await svc.mySlipPdf('t', 'u1', me, 'slip-ok'));
});

test('利用者と従業員の自動の結び付けは、在籍中の人だけ', async () => {
  const updated: HrEmployee[] = [];
  const make = (list: HrEmployee[]) => new AttendanceService({
    store: {},
    hrStore: {
      findEmployeeByUser: async () => null,
      listEmployees: async () => list,
      updateEmployee: async (_t: string, e: HrEmployee) => { updated.push(e); },
    },
    repo: {
      getTenantSettings: async () => ({ hr: { enabled: true } }),
      findUserById: async () => ({ id: 'u1', email: 'Staff@example.test' }),
      appendAudit: async () => undefined,
    },
  } as unknown as AttendanceServiceDeps);
  assert.equal(await make([employee({ status: 'left', leftOn: '2026-03-31' })]).selfEmployee('t', 'u1'), null, '退職した人の台帳には結び付けない');
  assert.equal(updated.length, 0);
  const linked = await make([employee({})]).selfEmployee('t', 'u1');
  assert.equal(linked?.userId, 'u1');
});
