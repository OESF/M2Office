/**
 * @file 拡張機能の API（管理者向け）。一覧、ファイルからの取り込み、同意して導入、スイッチ、接続の確認、削除。
 *
 * 導入の前に必要な権限を構成要素ごとに平易な言葉で示し、管理者の同意を得て、同意した権限を記録する（不変則 I-8）。
 * スイッチの切り替えに同意のやり直しは要らない。ただし権限が増えた版では再同意を求める。
 * ファイルから取り込んだ拡張機能（自社専用）は、取り込んだ会社にだけ見える。
 *
 * @see 仕様書 第12.10節 持ち運べる拡張機能
 * @see 仕様書 第12.11節 コネクタ（L2）の実装
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  CARDS_EXTENSION_ID, HR_EXTENSION_ID, INVENTORY_EXTENSION_ID, INVENTORY_FEATURES, type HrSettings, type InventorySettings, type RiskLevel,
} from '@m2office/shared';
import {
  bundledConnection, builtinSection, consentSnapshot, encodeFiles, unpackExtension, EXTENSION_FILE_MAX_BYTES,
  ensureHrCompartment, type ExtensionEntry, type ExtensionPackage, type TenantExtensions,
} from '@m2office/core';
import type { AppDeps } from '../context.js';
import { tenantOrigin } from '../tenant-origin.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';
import { parseScope, saveScope } from './access.js';

/** 危険度を利用者向けの言葉にする。 */
const RISK_WORDS: Record<RiskLevel, string> = {
  read: '読むだけ（書き込みも送信もしない）',
  draft: '下書きや資料を作る（送信はしない）',
  'write-internal': '社内に書き込む（ToDo の登録など）',
  'external-send': '社外や他の人へ送る（必ず承認のあと）',
  financial: 'お金に関わる処理をする（必ず承認のあと）',
};

/** 認証の方式を利用者向けの言葉にする。 */
const AUTH_WORDS: Record<string, string> = {
  none: '認証なし（公開されている情報だけを扱います）',
  oauth: '利用者ごとの認可',
  api_key: '管理者が登録する鍵',
};

export function extensionsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));

  /** 拡張機能の中身と、必要な権限を構成要素ごとに説明する（第12.10.5節）。 */
  function describe(pkg: ExtensionPackage, view: TenantExtensions | null) {
    const { tools, max_risk_level } = pkg.manifest.permissions;
    const connectorTools = pkg.connectors.flatMap((c) => c.tools.map((t) => ({ connector: c, tool: t })));
    return {
      id: pkg.manifest.id,
      name: pkg.manifest.name,
      version: pkg.manifest.version,
      description: pkg.manifest.description ?? '',
      publisher: pkg.manifest.publisher,
      icon: pkg.icon,
      readme: pkg.readme,
      counts: { agents: pkg.agents.length, connectors: pkg.connectors.length, tools: connectorTools.length },
      agents: pkg.agents.map((a) => ({ id: a.id, name: a.name, summary: a.help?.summary ?? a.description })),
      connectors: pkg.connectors.map((c) => ({
        id: c.id, name: c.name, description: c.description ?? '', url: c.url,
        auth: c.auth.type, authText: AUTH_WORDS[c.auth.type] ?? c.auth.type,
        tools: c.tools.map((t) => ({
          name: `${c.id}.${t.name}`, description: t.description, risk: t.risk, riskText: RISK_WORDS[t.risk],
          // 管理者が個別に止めたか（第6.6.3.1節）。止めていなければ有効である
          enabled: !view?.disabledTools.has(`${c.id}.${t.name}`),
        })),
      })),
      permissions: {
        maxRisk: max_risk_level,
        maxRiskText: RISK_WORDS[max_risk_level],
        tools: tools.map((t) => {
          const tool = view?.registry.get(t) ?? deps.registry.get(t);
          const fromConnector = connectorTools.find(({ connector, tool: ct }) => `${connector.id}.${ct.name}` === t);
          return {
            name: t,
            does: tool?.helpText ?? (fromConnector ? `${fromConnector.tool.description}（外部のサービス「${fromConnector.connector.name}」を使います）` : '（不明なツール）'),
            risk: tool?.risk ?? fromConnector?.tool.risk ?? null,
          };
        }),
      },
    };
  }

  /** 会社から見た状態（区分・導入・有効・再同意）。 */
  function stateOf(e: ExtensionEntry) {
    return {
      origin: e.origin,
      originText: e.origin === 'official' ? '公式' : e.origin === 'builtin' ? '公式・内蔵' : '自社専用',
      installed: e.installed ? { version: e.installed.version, installedAt: e.installed.installedAt } : null,
      enabled: e.installed?.enabled ?? false,
      needsReconsent: e.needsReconsent,
      active: e.active,
    };
  }

  const find = (view: TenantExtensions, id: string) => view.entries.find((e) => e.pkg.manifest.id === id);

  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    const [view, settings] = await Promise.all([deps.tenantView(tenant.id), deps.repo.getTenantSettings(tenant.id)]);
    return c.json({
      items: view.entries.map((e) => ({
        ...describe(e.pkg, view), ...stateOf(e),
        // 利用できる人（第16.7節）。設定が無ければ全員
        scope: settings.access.scopes[e.pkg.manifest.id] ?? 'all',
        // 内蔵の拡張の会社の設定（名刺管理: 取り込んだ名刺の既定の範囲。第27.7節）
        ...(e.pkg.manifest.id === CARDS_EXTENSION_ID ? { cards: { defaultScope: settings.cards.defaultScope } } : {}),
        // 在庫管理: 機能の入り切りと既定の目安（第29.4.1節）
        ...(e.pkg.manifest.id === INVENTORY_EXTENSION_ID ? { inventory: settings.inventory } : {}),
        // 人事・給与: 事業所・保険・締めと支払・手続きを行う人（第30.8.1節）
        ...(e.pkg.manifest.id === HR_EXTENSION_ID ? { hr: settings.hr } : {}),
      })),
    });
  });

  /**
   * 名刺管理の、取り込んだ名刺の既定の範囲を変える（第27.7節「会社は自分だけを既定にできる」）。すぐに反映する。
   */
  app.put(`/${CARDS_EXTENSION_ID}/settings`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ defaultScope?: unknown }>().catch(() => ({ defaultScope: undefined }));
    if (body.defaultScope !== 'company' && body.defaultScope !== 'personal') return c.json({ error: 'defaultScope は company か personal です' }, 400);
    const current = (await deps.repo.getTenantSettings(tenant.id)).cards;
    await deps.repo.saveTenantSettings(tenant.id, 'cards', { ...current, defaultScope: body.defaultScope }, user.id);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'settings.update',
      targetType: 'settings', targetId: 'cards', detail: { defaultScope: body.defaultScope }, occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true, defaultScope: body.defaultScope });
  });

  /**
   * 在庫管理の、機能の入り切りと既定の目安を変える（第29.4節・第29.4.1節）。すぐに反映し、監査ログに残す。
   *
   * @remarks 送られた項目だけを変える。切った機能の記録は消さない
   */
  app.put(`/${INVENTORY_EXTENSION_ID}/settings`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const current = (await deps.repo.getTenantSettings(tenant.id)).inventory;
    const next: InventorySettings = { ...current, features: { ...current.features } };
    const f = body['features'];
    if (f && typeof f === 'object') {
      for (const { id } of INVENTORY_FEATURES) {
        const v = (f as Record<string, unknown>)[id];
        if (typeof v === 'boolean') next.features[id] = v;
      }
    }
    const count = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined);
    if (count(body['lowDefault'], 1_000_000) !== undefined) next.lowDefault = count(body['lowDefault'], 1_000_000)!;
    if (count(body['leadDaysDefault'], 365) !== undefined) next.leadDaysDefault = Math.round(count(body['leadDaysDefault'], 365)!);
    if (body['countEveryDays'] === null) next.countEveryDays = null;
    else if (count(body['countEveryDays'], 366)) next.countEveryDays = Math.round(count(body['countEveryDays'], 366)!);
    await deps.repo.saveTenantSettings(tenant.id, 'inventory', next, user.id);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'settings.update',
      targetType: 'settings', targetId: 'inventory',
      detail: { features: next.features, lowDefault: next.lowDefault, leadDaysDefault: next.leadDaysDefault, countEveryDays: next.countEveryDays },
      occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true, inventory: next });
  });

  /**
   * 人事・給与の会社の設定を変える（第30.8.1節のうち段 1 の項目）。すぐに反映し、監査ログに残す。
   *
   * @remarks 送られた項目だけを変える。変えた日から効き、作った手続きの期限は変えない
   */
  app.put(`/${HR_EXTENSION_ID}/settings`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const cur = (await deps.repo.getTenantSettings(tenant.id)).hr;
    const next: HrSettings = { ...cur, office: { ...cur.office }, health: { ...cur.health }, pay: { ...cur.pay } };
    const obj = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : null);
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
    const day = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 31 ? v : undefined);
    const office = obj(b['office']);
    if (office) {
      if (text(office['name'], 200) !== undefined) next.office.name = text(office['name'], 200)!;
      if (text(office['address'], 300) !== undefined) next.office.address = text(office['address'], 300)!;
      if (office['form'] === 'corporation' || office['form'] === 'sole') next.office.form = office['form'];
    }
    const health = obj(b['health']);
    if (health) {
      if (['kyokai', 'kumiai', 'kokuho-kumiai', 'none'].includes(String(health['kind']))) next.health.kind = health['kind'] as HrSettings['health']['kind'];
      if (text(health['prefecture'], 10) !== undefined) next.health.prefecture = text(health['prefecture'], 10)!;
    }
    if (['mandatory', 'voluntary', 'none'].includes(String(b['socialApply']))) next.socialApply = b['socialApply'] as HrSettings['socialApply'];
    const pay = obj(b['pay']);
    if (pay) {
      if (day(pay['closingDay'])) next.pay.closingDay = day(pay['closingDay'])!;
      if (day(pay['payDay'])) next.pay.payDay = day(pay['payDay'])!;
      if (pay['payMonth'] === 'same' || pay['payMonth'] === 'next') next.pay.payMonth = pay['payMonth'];
    }
    if (b['procedures'] === 'self' || b['procedures'] === 'sharoushi') next.procedures = b['procedures'];
    await deps.repo.saveTenantSettings(tenant.id, 'hr', next, user.id);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'settings.update',
      targetType: 'settings', targetId: 'hr', detail: { fields: Object.keys(b) }, occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true, hr: next });
  });

  /** 在庫管理の予約の受け口（第29.13.1節）。URL の鍵は返さない（作ったときに一度だけ返す）。 */
  app.get(`/${INVENTORY_EXTENSION_ID}/booking-sources`, async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ sources: await deps.inventory.bookings.sources(tenant.id) });
  });

  /** 予約の受け口を作る。URL（鍵を含む）は、この応答で一度だけ返す。 */
  app.post(`/${INVENTORY_EXTENSION_ID}/booking-sources`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({ name: undefined }));
    const res = await deps.inventory.bookings.createSource(tenant.id, user.id, typeof body.name === 'string' ? body.name : '');
    if ('error' in res) return c.json({ error: res.error }, 400);
    const url = `${tenantOrigin(c.req.header('origin'), c.req.header('host'))}/v1/hooks/inventory/${res.key}`;
    return c.json({ source: res.source, url }, 201);
  });

  /** 予約の受け口を止める・動かす。 */
  app.put(`/${INVENTORY_EXTENSION_ID}/booking-sources/:id/status`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ status?: unknown }>().catch(() => ({ status: undefined }));
    if (body.status !== 'active' && body.status !== 'stopped') return c.json({ error: 'status は active か stopped です' }, 400);
    await deps.inventory.bookings.setSourceStatus(tenant.id, user.id, c.req.param('id'), body.status);
    return c.json({ ok: true });
  });

  /** 予約の受け口の型（項目の対応）を直す。`null` なら、次の通知から AI が推測し直す。 */
  app.put(`/${INVENTORY_EXTENSION_ID}/booking-sources/:id/mapping`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ mapping?: unknown }>().catch(() => ({ mapping: undefined }));
    const m = body.mapping as Record<string, unknown> | null | undefined;
    if (m === undefined) return c.json({ error: 'mapping を入れてください（推測し直すなら null）' }, 400);
    const s = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
    const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 10) : []);
    const mapping = m === null ? null : {
      id: s(m['id']), startsAt: s(m['startsAt']), ...(s(m['startTime']) ? { startTime: s(m['startTime']) } : {}), menu: s(m['menu']), status: s(m['status']),
      cancelledValues: list(m['cancelledValues']), visitedValues: list(m['visitedValues']),
    };
    if (mapping && (!mapping.id || !mapping.startsAt)) return c.json({ error: '予約番号と日時の項目は必ず入れてください' }, 400);
    await deps.inventory.bookings.setSourceMapping(tenant.id, user.id, c.req.param('id'), mapping);
    return c.json({ ok: true });
  });

  /**
   * ファイル（`.m2ext`）から取り込む（第12.10.2節）。本文は ZIP のバイト列。
   *
   * @remarks
   * 取り込むだけで、導入（権限への同意）は別に行う。検証を通らなければ、問題の一覧を返して保存しない。
   * 同じ ID の自社専用の拡張機能があれば置き換える。権限が増えていれば、使う前に再同意が要る。
   */
  app.post('/import', async (c) => {
    const { tenant, user } = c.get('ctx');
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > EXTENSION_FILE_MAX_BYTES) return c.json({ error: 'ファイルが大きすぎます（5 MB まで）' }, 413);
    const data = new Uint8Array(await c.req.arrayBuffer());
    if (data.length === 0) return c.json({ error: 'ファイルが空です' }, 400);

    const unpacked = await unpackExtension(data);
    if (unpacked.problems.length > 0) {
      return c.json({ error: '取り込めませんでした', problems: unpacked.problems }, 400);
    }
    const { pkg, problems, notices = [], keep } = await deps.hub.validateImport(tenant.id, unpacked.files);
    if (!pkg || problems.length > 0) {
      return c.json({ error: '検証を通りませんでした', problems: [...problems, ...notices] }, 400);
    }
    const now = new Date().toISOString();
    // スキルの形式なら、除いたファイル（プログラムなど）を保存しない（第12.12.4節）
    await deps.repo.savePrivateExtension({
      tenantId: tenant.id, extensionId: pkg.manifest.id, version: pkg.manifest.version,
      files: encodeFiles(keep ?? unpacked.files), sizeBytes: data.length, importedBy: user.id, importedAt: now,
    });
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'extension.import',
      targetType: 'extension', targetId: pkg.manifest.id,
      detail: { version: pkg.manifest.version, sizeBytes: data.length }, occurredAt: now,
    });
    const view = await deps.tenantView(tenant.id);
    const entry = find(view, pkg.manifest.id);
    return c.json({ ok: true, notices, item: entry ? { ...describe(entry.pkg, view), ...stateOf(entry) } : null });
  });

  /**
   * 同意して導入する。導入すると有効（スイッチが入った状態）になる。
   *
   * @remarks 本文に `consent: true` が無ければ導入しない。同意した権限（コネクタの接続先と危険度を含む）を記録する。
   */
  app.post('/:id/install', async (c) => {
    const { tenant, user } = c.get('ctx');
    const entry = find(await deps.tenantView(tenant.id), c.req.param('id'));
    if (!entry) return c.json({ error: '拡張機能が見つかりません' }, 404);
    // 内蔵の拡張は導入の手順を持たない。入り切りだけで使う（第12.13節）
    if (entry.origin === 'builtin') return c.json({ error: '内蔵の拡張は導入済みです。スイッチで入り切りしてください' }, 409);
    const body = await c.req.json<{ consent?: boolean; scope?: unknown }>().catch(() => ({ consent: false, scope: undefined }));
    if (body.consent !== true) {
      return c.json({ error: '必要な権限を確認し、同意してから導入してください' }, 400);
    }
    // 利用できる人（第16.7節）。省略時は全員
    const parsed = body.scope === undefined ? null : await parseScope(deps, tenant.id, body.scope);
    if (parsed && 'error' in parsed) return c.json({ error: parsed.error }, 400);
    const { pkg } = entry;
    const now = new Date().toISOString();
    const consented = consentSnapshot(pkg);
    await deps.repo.installExtension({
      tenantId: tenant.id, extensionId: pkg.manifest.id, version: pkg.manifest.version,
      consentedPermissions: consented, installedBy: user.id, installedAt: now, enabled: true,
    });
    // 同梱の接続を会社の接続として登録する。あれば使い回し、接続先が違えば置き換えずに知らせる（仕様書 第12.11.0節）
    const connections = await deps.repo.listConnections(tenant.id);
    const notices: string[] = [];
    for (const decl of pkg.connectors) {
      const have = connections.find((x) => x.id === decl.id);
      if (!have) await deps.repo.saveConnection(bundledConnection(tenant.id, decl, pkg.manifest.id, user.id));
      else if (have.url !== decl.url) notices.push(`会社の接続「${decl.id}」は別の接続先（${have.url}）で登録済みのため、そのまま使います`);
    }
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'extension.install',
      targetType: 'extension', targetId: pkg.manifest.id,
      detail: { version: pkg.manifest.version, origin: entry.origin, permissions: consented }, occurredAt: now,
    });
    if (parsed) await saveScope(deps, tenant.id, user.id, pkg.manifest.id, parsed.scope);
    return c.json({ ok: true, notices });
  });

  /**
   * 有効・無効を切り替える（スイッチ。第12.10.4節）。すぐに反映し、監査ログに残す。
   *
   * @remarks 権限が増えた版を有効にするときは、先に再同意（導入）を求める。
   */
  app.put('/:id/enabled', async (c) => {
    const { tenant, user } = c.get('ctx');
    const id = c.req.param('id');
    const body = await c.req.json<{ enabled?: unknown }>().catch(() => ({ enabled: undefined }));
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled に true か false を指定してください' }, 400);
    const entry = find(await deps.tenantView(tenant.id), id);
    if (!entry?.installed) return c.json({ error: '導入されていません' }, 404);
    // 内蔵の拡張は会社の設定で入り切りする。切ってもデータは消さない（第12.13節）
    const section = entry.origin === 'builtin' ? builtinSection(id) : null;
    if (section) {
      const settings = await deps.repo.getTenantSettings(tenant.id);
      if (section === 'cards') await deps.repo.saveTenantSettings(tenant.id, 'cards', { ...settings.cards, enabled: body.enabled }, user.id);
      else if (section === 'inventory') await deps.repo.saveTenantSettings(tenant.id, 'inventory', { ...settings.inventory, enabled: body.enabled }, user.id);
      else await deps.repo.saveTenantSettings(tenant.id, 'hr', { ...settings.hr, enabled: body.enabled }, user.id);
      // 人事・給与を入れたら、人事区画を用意し、入れた管理者を区画に入れる（仕様書 第30.2節）
      if (section === 'hr' && body.enabled) {
        const prepared = await ensureHrCompartment(deps.repo, tenant.id, user.id);
        if (prepared.created || prepared.added) {
          await deps.repo.appendAudit({
            id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id,
            action: prepared.created ? 'compartment.create' : 'compartment.enter',
            targetType: 'compartment', targetId: 'hr', detail: { by: 'hr.enable', member: user.id }, occurredAt: new Date().toISOString(),
          });
        }
      }
      await deps.repo.appendAudit({
        id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id,
        action: body.enabled ? 'extension.enable' : 'extension.disable',
        targetType: 'extension', targetId: id, detail: { builtin: true }, occurredAt: new Date().toISOString(),
      });
      return c.json({ ok: true, enabled: body.enabled });
    }
    if (body.enabled && entry.needsReconsent) {
      return c.json({ error: '新しい版で必要な権限が増えています。内容を確認して、もう一度同意してください' }, 409);
    }
    await deps.repo.setExtensionEnabled(tenant.id, id, body.enabled);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id,
      action: body.enabled ? 'extension.enable' : 'extension.disable',
      targetType: 'extension', targetId: id, detail: {}, occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true, enabled: body.enabled });
  });

  /**
   * 削除する。業務エージェントは使えなくなるが、実行の記録は残る。
   *
   * @remarks 自社専用の拡張機能は、取り込んだファイルも消す。使うには取り込み直す。
   */
  app.delete('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const id = c.req.param('id');
    if (builtinSection(id)) return c.json({ error: '内蔵の拡張は削除できません。スイッチで切ってください（データは消えません）' }, 409);
    const uninstalled = await deps.repo.uninstallExtension(tenant.id, id);
    const removed = await deps.repo.deletePrivateExtension(tenant.id, id);
    if (!uninstalled && !removed) return c.json({ error: '導入されていません' }, 404);
    // 利用範囲の設定も消す（第16.7.9節）
    if ((await deps.repo.getTenantSettings(tenant.id)).access.scopes[id]) await saveScope(deps, tenant.id, user.id, id, null);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'extension.uninstall',
      targetType: 'extension', targetId: id, detail: { removedPackage: removed }, occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true });
  });

  return app;
}
