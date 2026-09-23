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
import type { RiskLevel } from '@m2office/shared';
import {
  consentSnapshot, encodeFiles, unpackExtension, EXTENSION_FILE_MAX_BYTES,
  type ExtensionEntry, type ExtensionPackage, type TenantExtensions,
} from '@m2office/core';
import type { AppDeps } from '../context.js';
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
      originText: e.origin === 'official' ? '公式' : '自社専用',
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
      })),
    });
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
    const { pkg, problems } = await deps.hub.validateImport(tenant.id, unpacked.files);
    if (!pkg || problems.length > 0) {
      return c.json({ error: '検証を通りませんでした', problems }, 400);
    }
    const now = new Date().toISOString();
    await deps.repo.savePrivateExtension({
      tenantId: tenant.id, extensionId: pkg.manifest.id, version: pkg.manifest.version,
      files: encodeFiles(unpacked.files), sizeBytes: data.length, importedBy: user.id, importedAt: now,
    });
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'extension.import',
      targetType: 'extension', targetId: pkg.manifest.id,
      detail: { version: pkg.manifest.version, sizeBytes: data.length }, occurredAt: now,
    });
    const view = await deps.tenantView(tenant.id);
    const entry = find(view, pkg.manifest.id);
    return c.json({ ok: true, item: entry ? { ...describe(entry.pkg, view), ...stateOf(entry) } : null });
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
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'extension.install',
      targetType: 'extension', targetId: pkg.manifest.id,
      detail: { version: pkg.manifest.version, origin: entry.origin, permissions: consented }, occurredAt: now,
    });
    if (parsed) await saveScope(deps, tenant.id, user.id, pkg.manifest.id, parsed.scope);
    return c.json({ ok: true });
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

  /** コネクタの接続を確かめる（第12.11.3節）。宣言したツールを MCP サーバが提供しているかを返す。 */
  app.post('/:id/connectors/:connectorId/check', async (c) => {
    const { tenant } = c.get('ctx');
    const entry = find(await deps.tenantView(tenant.id), c.req.param('id'));
    const connector = entry?.pkg.connectors.find((x) => x.id === c.req.param('connectorId'));
    if (!connector) return c.json({ error: 'コネクタが見つかりません' }, 404);
    return c.json(await deps.hub.checkConnector(connector));
  });

  /**
   * ツールを止めると使えなくなる業務（仕様書 第6.6.3.1節）。
   *
   * @remarks 止める前に、数だけでなく名前を示して確かめてもらう。
   */
  app.get('/:id/connectors/:connectorId/tools/:tool/impact', async (c) => {
    const { tenant } = c.get('ctx');
    const view = await deps.tenantView(tenant.id);
    const entry = find(view, c.req.param('id'));
    const connector = entry?.pkg.connectors.find((x) => x.id === c.req.param('connectorId'));
    const tool = connector?.tools.find((t) => t.name === c.req.param('tool'));
    if (!connector || !tool) return c.json({ error: 'ツールが見つかりません' }, 404);

    const name = `${connector.id}.${tool.name}`;
    // いま使える業務のうち、このツールを使うもの。止めると消える
    const blocked = view.agents.filter((a) => a.tools.includes(name));
    const schedules = (await deps.repo.listSchedules(tenant.id, null))
      .filter((s) => s.enabled && blocked.some((a) => a.id === s.agentId));
    return c.json({
      tool: name,
      agents: blocked.map((a) => ({ id: a.id, name: a.name })),
      schedules: schedules.length,
    });
  });

  /**
   * コネクタのツールを 1 つ、有効または無効にする（仕様書 第6.6.3.1節）。
   *
   * @remarks
   * 止めたツールを使う業務は、メニュー・秘書・定時実行・API から消える。
   * 動いている実行は止めない。同意のある範囲で始まっており、途中で止めると成果物が中途半端に残る。
   */
  app.put('/:id/connectors/:connectorId/tools/:tool/enabled', async (c) => {
    const { tenant, user } = c.get('ctx');
    const entry = find(await deps.tenantView(tenant.id), c.req.param('id'));
    const connector = entry?.pkg.connectors.find((x) => x.id === c.req.param('connectorId'));
    const tool = connector?.tools.find((t) => t.name === c.req.param('tool'));
    if (!connector || !tool) return c.json({ error: 'ツールが見つかりません' }, 404);
    const body = await c.req.json<{ enabled?: boolean }>();
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled を指定してください' }, 400);

    await deps.repo.setConnectorToolEnabled(tenant.id, connector.id, tool.name, body.enabled, user.id);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id,
      action: 'extension.tool.toggle', targetType: 'extension', targetId: c.req.param('id'),
      detail: { connectorId: connector.id, tool: tool.name, enabled: body.enabled },
      occurredAt: new Date().toISOString(),
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
