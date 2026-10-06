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
  CARDS_EXTENSION_ID, HR_EXTENSION_ID, INVENTORY_EXTENSION_ID, INVENTORY_FEATURES, SIGNAGE_EXTENSION_ID, SIGNAGE_JINGLES, WEB_COLUMNS_EXTENSION_ID, INQUIRIES_EXTENSION_ID, COMPETITORS_EXTENSION_ID, ANNOUNCEMENTS_EXTENSION_ID, WEB_REVIEW_EXTENSION_ID, CONTRACTS_EXTENSION_ID, SUBSIDIES_EXTENSION_ID, MEMBERS_EXTENSION_ID, WEB_REVIEW_SCOPES, COLUMN_INDUSTRIES, type WebColumnSettings, type HrSettings, type InventorySettings, type RiskLevel, type SignageSettings,
} from '@m2office/shared';
import {
  bundledConnection, builtinSection, consentSnapshot, encodeFiles, unpackExtension, EXTENSION_FILE_MAX_BYTES,
  ensureHrCompartment, detectKind, MAX_FILE_BYTES, LAW_BOOK, itemRule, createPkce, buildGoogleAuthUrl, revokeGoogleToken, MAILBOX_SCOPES, type ExtensionEntry, type ExtensionPackage, type TenantExtensions,
} from '@m2office/core';
import type { AppDeps } from '../context.js';
import { tenantOrigin } from '../tenant-origin.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';
import { parseScope, saveScope } from './access.js';
import { googleClient, returnTo } from './connections.js';

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
    const [view, settings, optOuts, columnAiUsage] = await Promise.all([
      deps.tenantView(tenant.id), deps.repo.getTenantSettings(tenant.id), deps.cards.bulk.store.countOptOuts(tenant.id),
      deps.columns.service.aiUsage(tenant.id),
    ]);
    return c.json({
      items: view.entries.map((e) => ({
        ...describe(e.pkg, view), ...stateOf(e),
        // 利用できる人（第16.7節）。設定が無ければ全員
        scope: settings.access.scopes[e.pkg.manifest.id] ?? 'all',
        // 内蔵の拡張の会社の設定（名刺管理: 取り込んだ名刺の既定の範囲。第27.7節）
        // メールの署名からの更新の入り切り（第27.6.1節）
        // 配信を停止したアドレスの数（まとめてのメール。第27.9.1節）。アドレスそのものは返さない
        ...(e.pkg.manifest.id === CARDS_EXTENSION_ID ? {
          cards: { defaultScope: settings.cards.defaultScope, mailSignature: settings.cards.mailSignature, bulkMailAdminApproval: settings.cards.bulkMailAdminApproval, optOuts },
        } : {}),
        // 在庫管理: 機能の入り切りと既定の目安（第29.4.1節）
        ...(e.pkg.manifest.id === INVENTORY_EXTENSION_ID ? { inventory: settings.inventory } : {}),
        // 人事・給与: 事業所・保険・締めと支払・手続きを行う人（第30.8.1節）
        ...(e.pkg.manifest.id === HR_EXTENSION_ID ? { hr: settings.hr } : {}),
        // 店頭サイネージ: 画像の秒数・店の色（第31.4節）
        ...(e.pkg.manifest.id === SIGNAGE_EXTENSION_ID ? { signage: settings.signage } : {}),
        // Web のコラム: 分野・読み手・業種・監修者・AI の表示・WordPress の入れ先（第32.18.1節）。パスワードは返さない
        ...(e.pkg.manifest.id === WEB_COLUMNS_EXTENSION_ID ? { webColumns: settings.webColumns, columnAiUsage } : {}),
        // 問い合わせの記録: 窓口のアカウント（第33.18節）。アドレスだけを返す
        ...(e.pkg.manifest.id === INQUIRIES_EXTENSION_ID ? { inquiries: settings.inquiries } : {}),
        // 競合の分析: 地図の鍵を預けたか（第36.18節）。鍵そのものは返さない
        ...(e.pkg.manifest.id === COMPETITORS_EXTENSION_ID ? { competitors: settings.competitors } : {}),
        // お知らせの作成: Web を公開まで行うか・カテゴリー・流す画面（第35.4節）
        ...(e.pkg.manifest.id === ANNOUNCEMENTS_EXTENSION_ID ? { announcements: settings.announcements } : {}),
        // Webの分析: 担当の許可・選んだプロパティとサイト（第34.18節。トークンは返さない）
        ...(e.pkg.manifest.id === WEB_REVIEW_EXTENSION_ID ? { webReview: settings.webReview } : {}),
        // 契約の管理: 契約書の置き場（第38.7節）
        ...(e.pkg.manifest.id === CONTRACTS_EXTENSION_ID ? { contracts: settings.contracts } : {}),
        // 補助金・助成金の案内: 会社の関心と業種（第39.3節）
        // 会員とポイント: 来店のポイント・購入の率・有効期限・LINE の会員証（第40.4節）
        ...(e.pkg.manifest.id === MEMBERS_EXTENSION_ID ? { members: settings.members } : {}),
        ...(e.pkg.manifest.id === SUBSIDIES_EXTENSION_ID ? { subsidies: { interest: settings.subsidies.interest, industry: settings.subsidies.industry, profile: settings.subsidies.profile } } : {}),
      })),
    });
  });

  /**
   * 名刺管理の会社の設定を変える。取り込んだ名刺の既定の範囲（第27.7節「会社は自分だけを既定にできる」）と、
   * メールの署名からの更新の入り切り（第27.6.1節）。渡した項目だけを変え、すぐに反映する。
   */
  app.put(`/${CARDS_EXTENSION_ID}/settings`, async (c) => {
    const { tenant, user } = c.get('ctx');
    type Body = { defaultScope?: unknown; mailSignature?: unknown; bulkMailAdminApproval?: unknown };
    const body = await c.req.json<Body>().catch(() => ({} as Body));
    if (body.defaultScope !== undefined && body.defaultScope !== 'company' && body.defaultScope !== 'personal') return c.json({ error: 'defaultScope は company か personal です' }, 400);
    if (body.mailSignature !== undefined && typeof body.mailSignature !== 'boolean') return c.json({ error: 'mailSignature は true か false です' }, 400);
    if (body.bulkMailAdminApproval !== undefined && typeof body.bulkMailAdminApproval !== 'boolean') return c.json({ error: 'bulkMailAdminApproval は true か false です' }, 400);
    if (body.defaultScope === undefined && body.mailSignature === undefined && body.bulkMailAdminApproval === undefined) return c.json({ error: '変える項目がありません' }, 400);
    const current = (await deps.repo.getTenantSettings(tenant.id)).cards;
    const next = {
      ...current,
      ...(body.defaultScope !== undefined ? { defaultScope: body.defaultScope as 'company' | 'personal' } : {}),
      ...(body.mailSignature !== undefined ? { mailSignature: body.mailSignature as boolean } : {}),
      // まとめてのメールで、本人の承認のあとに管理者の承認を加えるか（第27.9.1節）
      ...(body.bulkMailAdminApproval !== undefined ? { bulkMailAdminApproval: body.bulkMailAdminApproval as boolean } : {}),
    };
    await deps.repo.saveTenantSettings(tenant.id, 'cards', next, user.id);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'settings.update',
      targetType: 'settings', targetId: 'cards',
      detail: {
        ...(body.defaultScope !== undefined ? { defaultScope: next.defaultScope } : {}),
        ...(body.mailSignature !== undefined ? { mailSignature: next.mailSignature } : {}),
        ...(body.bulkMailAdminApproval !== undefined ? { bulkMailAdminApproval: next.bulkMailAdminApproval } : {}),
      },
      occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true, defaultScope: next.defaultScope, mailSignature: next.mailSignature, bulkMailAdminApproval: next.bulkMailAdminApproval });
  });

  /** 配信を停止したアドレスの一覧（新しい順。`q` でアドレスの一部を探す。第27.9.1節「停止を外す」）。 */
  app.get(`/${CARDS_EXTENSION_ID}/opt-outs`, async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ items: await deps.cards.bulk.optOuts(tenant.id, (c.req.query('q') ?? '').slice(0, 200)) });
  });

  /** 配信の停止を外す（本人から「また送ってほしい」と求められたとき）。外したことは監査ログに残す。 */
  app.post(`/${CARDS_EXTENSION_ID}/opt-outs/remove`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({} as { email?: unknown }));
    if (typeof body.email !== 'string' || !body.email.includes('@')) return c.json({ error: 'メールアドレスを渡してください' }, 400);
    const removed = await deps.cards.bulk.removeOptOut(tenant.id, user.id, body.email);
    return removed ? c.json({ ok: true }) : c.json({ error: 'このアドレスは停止されていません' }, 404);
  });

  /**
   * 在庫管理の、機能の入り切りと既定の目安を変える（第29.4節・第29.4.1節）。すぐに反映し、監査ログに残す。
   *
   * @remarks 送られた項目だけを変える。切った機能の記録は消さない
   */
  /**
   * 店頭サイネージの会社の設定を変える（送った項目だけ。第31.4節）。すぐ画面に届く。
   * 画像の秒数 3〜120・店の色 `#RRGGBB` か `null`・割り込みの秒数 5〜60・ジングルの入り切りと既定の音・呼び出しの言い回し（`{番号}` を含む 60 字まで）・
   * 在庫の入荷と品切れの案内の入り切り（`stockNotices`。第31.6.7節）。
   */
  app.put(`/${SIGNAGE_EXTENSION_ID}/settings`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const current = (await deps.repo.getTenantSettings(tenant.id)).signage;
    const next: SignageSettings = { ...current };
    const changed: string[] = [];
    if (body['imageSeconds'] !== undefined) {
      const n = body['imageSeconds'];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 3 || n > 120) return c.json({ error: '画像を出す秒数は 3〜120 秒にしてください' }, 400);
      next.imageSeconds = n;
      changed.push('imageSeconds');
    }
    if (body['color'] !== undefined) {
      const v = body['color'];
      if (v !== null && (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v))) return c.json({ error: '店の色は #RRGGBB の形にしてください' }, 400);
      next.color = v === null ? null : (v as string).toLowerCase();
      changed.push('color');
    }
    if (body['interruptSeconds'] !== undefined) {
      const n = body['interruptSeconds'];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 5 || n > 60) return c.json({ error: '割り込みを出す秒数は 5〜60 秒にしてください' }, 400);
      next.interruptSeconds = n;
      changed.push('interruptSeconds');
    }
    if (body['stockNotices'] !== undefined) {
      if (typeof body['stockNotices'] !== 'boolean') return c.json({ error: '在庫の案内の入り切りは真偽で送ってください' }, 400);
      next.stockNotices = body['stockNotices'];
      changed.push('stockNotices');
    }
    if (body['chime'] !== undefined) {
      if (typeof body['chime'] !== 'boolean') return c.json({ error: 'ジングルの入り切りは真偽で送ってください' }, 400);
      next.chime = body['chime'];
      changed.push('chime');
    }
    if (body['jingle'] !== undefined) {
      const j = String(body['jingle'] ?? '');
      const sounds = await deps.signage.service.deps.store.listSounds(tenant.id);
      if (!SIGNAGE_JINGLES.some((x) => x.id === j) && !sounds.some((s) => s.id === j)) return c.json({ error: '知らない音です' }, 400);
      next.jingle = j;
      changed.push('jingle');
    }
    for (const k of ['callTemplate', 'callTemplateNoPlace'] as const) {
      if (body[k] === undefined) continue;
      const t = String(body[k] ?? '').trim();
      if (!t.includes('{番号}') || [...t].length > 60) return c.json({ error: '呼び出しの言い回しは {番号} を含む 60 字までにしてください' }, 400);
      if (k === 'callTemplate' && !t.includes('{場所}')) return c.json({ error: '番号と場所の言い回しには {場所} も入れてください' }, 400);
      next[k] = t;
      changed.push(k);
    }
    await deps.repo.saveTenantSettings(tenant.id, 'signage', next, user.id);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'settings.update',
      targetType: 'settings', targetId: 'signage', detail: { fields: changed }, occurredAt: new Date().toISOString(),
    });
    deps.signage.service.settingsChanged(tenant.id);
    return c.json({ ok: true, signage: next });
  });

  /** 番号で店頭サイネージの画面を登録する（管理者だけ。第31.5.1節）。名前と向きは尋ねずに決める。 */
  app.post(`/${SIGNAGE_EXTENSION_ID}/pairings/claim`, async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.repo.getTenantSettings(tenant.id)).signage.enabled) return c.json({ error: '店頭サイネージを入れていません' }, 404);
    const b = await c.req.json<{ code?: unknown }>().catch(() => ({} as { code?: unknown }));
    const r = await deps.signage.service.claim(tenant.id, user.id, b.code);
    return 'error' in r ? c.json({ error: r.error, ...(r.screens ? { screens: r.screens } : {}) }, r.status as 404) : c.json(r, 201);
  });

  /** 店頭サイネージの呼び出しの受け口の一覧（今日の受け付けた数と断った数つき。第31.8.2節）。 */
  app.get(`/${SIGNAGE_EXTENSION_ID}/sources`, async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ sources: await deps.signage.service.deps.store.listSources(tenant.id) });
  });

  /** 呼び出しの受け口を作る（`name`）。URL は作ったときに 1 度だけ返す。 */
  app.post(`/${SIGNAGE_EXTENSION_ID}/sources`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ name?: unknown }>().catch(() => ({} as { name?: unknown }));
    const r = await deps.signage.interrupts.createSource(tenant.id, user.id, b.name);
    if ('error' in r) return c.json(r, 400);
    return c.json({ source: r.source, url: `${tenantOrigin(c.req.header('origin'), c.req.header('host'))}/v1/hooks/signage/${r.key}`, key: r.key }, 201);
  });

  /** 受け口を止める・動かす（`status`: active・stopped）。 */
  app.put(`/${SIGNAGE_EXTENSION_ID}/sources/:id/status`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ status?: unknown }>().catch(() => ({} as { status?: unknown }));
    if (b.status !== 'active' && b.status !== 'stopped') return c.json({ error: 'status は active か stopped です' }, 400);
    return (await deps.signage.interrupts.setSourceStatus(tenant.id, user.id, c.req.param('id'), b.status)) ? c.json({ ok: true }) : c.json({ error: '受け口が見つかりません' }, 404);
  });

  /** 受け口の項目の対応を忘れ、次の呼び出しから推測し直す。 */
  app.post(`/${SIGNAGE_EXTENSION_ID}/sources/:id/reset-mapping`, async (c) => {
    const { tenant, user } = c.get('ctx');
    return (await deps.signage.interrupts.resetMapping(tenant.id, user.id, c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: '受け口が見つかりません' }, 404);
  });

  /** 会社のジングルの音の一覧。 */
  app.get(`/${SIGNAGE_EXTENSION_ID}/sounds`, async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ sounds: await deps.signage.service.deps.store.listSounds(tenant.id) });
  });

  /** 会社のジングルの音を入れる（本文は MP3・WAV そのもの。名前は `x-sound-name`、画面で調べた長さは `x-duration-ms`）。 */
  app.post(`/${SIGNAGE_EXTENSION_ID}/sounds`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const data = new Uint8Array(await c.req.arrayBuffer());
    let name = '';
    try { name = decodeURIComponent(c.req.header('x-sound-name') ?? ''); } catch { name = ''; }
    const r = await deps.signage.interrupts.addSound(tenant.id, user.id, name, data, c.req.header('x-duration-ms'));
    if ('error' in r) return c.json(r, 400);
    deps.signage.service.settingsChanged(tenant.id);
    return c.json(r, 201);
  });

  /** 会社のジングルの音を消す（既定の音に選んでいれば「ピンポーン」に戻す）。 */
  app.delete(`/${SIGNAGE_EXTENSION_ID}/sounds/:id`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const settings = (await deps.repo.getTenantSettings(tenant.id)).signage;
    const r = await deps.signage.interrupts.deleteSound(tenant.id, user.id, c.req.param('id'), settings);
    if (!r) return c.json({ error: '音が見つかりません' }, 404);
    deps.signage.service.settingsChanged(tenant.id);
    return c.json({ ok: true, ...r });
  });

  /** 店頭サイネージの画面を外す（管理者だけ。確認を挟まない。第31.5.1節）。鍵はその場で効かなくなる。 */
  app.delete(`/${SIGNAGE_EXTENSION_ID}/screens/:id`, async (c) => {
    const { tenant, user } = c.get('ctx');
    return (await deps.signage.service.removeScreen(tenant.id, user.id, c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: '画面が見つかりません' }, 404);
  });

  /**
   * Web のコラムの会社の設定を変える（第32.18.1節）。分野・読み手・業種・監修者・AI が書いたことの表示。
   * 渡した項目だけを変え、すぐに反映する。WordPress の入れ先は下の口で、つながるかを確かめてから預ける。
   */
  app.put(`/${WEB_COLUMNS_EXTENSION_ID}/settings`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const current = (await deps.repo.getTenantSettings(tenant.id)).webColumns;
    const next: WebColumnSettings = { ...current };
    if (Array.isArray(body['topics'])) {
      next.topics = [...new Set(body['topics'].filter((t): t is string => typeof t === 'string').map((t) => t.trim().slice(0, 60)).filter(Boolean))].slice(0, 30);
    }
    if (typeof body['audience'] === 'string') next.audience = body['audience'].trim().slice(0, 200);
    if (body['industry'] !== undefined) {
      if (typeof body['industry'] !== 'string' || !COLUMN_INDUSTRIES.some((i) => i.code === body['industry'])) return c.json({ error: '業種が正しくありません' }, 400);
      next.industry = body['industry'];
    }
    if (body['supervisor'] === null) next.supervisor = null;
    else if (body['supervisor'] && typeof body['supervisor'] === 'object') {
      const sv = body['supervisor'] as Record<string, unknown>;
      const name = typeof sv['name'] === 'string' ? sv['name'].trim().slice(0, 60) : '';
      const title = typeof sv['title'] === 'string' ? sv['title'].trim().slice(0, 60) : '';
      next.supervisor = name ? { name, title } : null;
    }
    if (body['aiNotice'] !== undefined) {
      if (typeof body['aiNotice'] !== 'boolean') return c.json({ error: 'aiNotice は true か false です' }, 400);
      next.aiNotice = body['aiNotice'];
    }
    // カバー画像の背景を生成 AI で描くか（第32.7.1節。既定は切り）
    if (body['aiIllustration'] !== undefined) {
      if (typeof body['aiIllustration'] !== 'boolean') return c.json({ error: 'aiIllustration は true か false です' }, 400);
      next.aiIllustration = body['aiIllustration'];
    }
    // 予定表（月の本数と曜日。第32.18.4節）。null で予定を作らない
    if (body['plan'] !== undefined) {
      const p = body['plan'] as Record<string, unknown> | null;
      if (p === null) next.plan = null;
      else if (p && [1, 2, 4].includes(Number(p['perMonth'])) && Number.isInteger(Number(p['weekday'])) && Number(p['weekday']) >= 0 && Number(p['weekday']) <= 6) {
        next.plan = { perMonth: Number(p['perMonth']) as 1 | 2 | 4, weekday: Number(p['weekday']) };
      } else return c.json({ error: '予定表は、本数（1・2・4）と曜日（0〜6）です' }, 400);
    }
    await deps.repo.saveTenantSettings(tenant.id, 'webColumns', next, user.id);
    // 業種・分野・読み手・監修者が変わったら、当てる表現の決まりを AI が選び直す（第32.18.3節。秘書で直した後は選び直さない）
    const clues = (w: WebColumnSettings) => JSON.stringify([w.industry, w.topics, w.audience, w.supervisor?.title ?? '']);
    const saved = clues(next) !== clues(current) ? await deps.columns.service.refreshRules(tenant.id, user.id) : next;
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'settings.update',
      targetType: 'settings', targetId: 'webColumns',
      detail: { topics: next.topics.length, industry: next.industry, supervisor: !!next.supervisor, aiNotice: next.aiNotice, aiIllustration: next.aiIllustration },
      occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true, webColumns: saved });
  });

  /**
   * WordPress の入れ先とアプリケーションパスワードを預ける（第32.18.1節）。つながるかを確かめてから、暗号化して預ける。
   *
   * @returns 預けた入れ先（パスワードは返さない）。つながらなければ 400
   */
  app.put(`/${WEB_COLUMNS_EXTENSION_ID}/wordpress`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    const res = await deps.columns.service.saveWordPress({ tenantId: tenant.id, userId: user.id }, {
      siteUrl: s(body['siteUrl']), username: s(body['username']), password: s(body['password']),
    });
    return 'error' in res ? c.json({ error: res.error }, 400) : c.json({ ok: true, wordpress: res.wordpress });
  });

  /**
   * 問い合わせの窓口のアカウントをつなぐ（第33.18節）。Google の認可の画面の URL を返す（アカウントを選ばせる）。
   * 開発の見本の会社では、認可を経ずに見本の箱（`info@` 会社のドメイン）をつなぐ。
   *
   * @returns `{ url }` か、見本なら `{ connected: true }`。会社の Google のクライアントが無ければ 409
   */
  app.post(`/${INQUIRIES_EXTENSION_ID}/mailbox/connect`, async (c) => {
    const { tenant, user } = c.get('ctx');
    if (deps.connector.sourceFor(tenant.id) === 'mock') {
      const err = await deps.inquiries.service.connectMailbox({ tenantId: tenant.id, userId: user.id }, { email: `info@${user.email.split('@')[1] ?? 'example.jp'}`, refreshToken: null });
      return err ? c.json({ error: err }, 400) : c.json({ connected: true });
    }
    const client = await googleClient(deps, tenant.id);
    if (!client) return c.json({ error: '会社の Google 接続の設定がありません。「接続」の「Google Workspace」で登録してください' }, 409);
    const { verifier, challenge } = createPkce();
    // 戻り先は管理者ページの拡張機能（問い合わせの記録の設定）
    const back = returnTo(c).replace(/\/(\?|$)/, '/admin/extensions$1');
    const state = deps.oauth.states.issue({ tenantId: tenant.id, userId: user.id, codeVerifier: verifier, returnTo: back, purpose: 'inquiry-mailbox' });
    const url = buildGoogleAuthUrl({ clientId: client.clientId, redirectUri: deps.oauth.redirectUri, scopes: MAILBOX_SCOPES, state, codeChallenge: challenge, selectAccount: true });
    return c.json({ url });
  });

  /**
   * LINE 公式アカウントをつなぐ（第33.19節）。チャネルのシークレットとアクセストークンを確かめて預け、受け口の URL を返す（1 度だけ）。
   * ローカルの形では使えない（社外から届く受け口が要るため。Q-176）。開発の見本の会社では、鍵を確かめず外に送らない口にする。
   *
   * @returns 受け口の URL（LINE の管理画面の Webhook に入れる）
   */
  app.put(`/${INQUIRIES_EXTENSION_ID}/line`, async (c) => {
    const { tenant, user } = c.get('ctx');
    if (deps.onsiteTenant) return c.json({ error: '社内の機械だけで動かす形（ローカルの形）では、LINE を使えません。社外から届く受け口が要るためです' }, 409);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    const res = await deps.inquiries.service.connectLine({ tenantId: tenant.id, userId: user.id }, {
      secret: s(body['secret']), token: s(body['token']), mock: deps.connector.sourceFor(tenant.id) === 'mock',
    });
    if ('error' in res) return c.json({ error: res.error }, 400);
    return c.json({ ok: true, webhookUrl: `${tenantOrigin(c.req.header('origin'), c.req.header('host'))}/v1/hooks/line/${res.key}` });
  });

  /**
   * 競合の分析の地図の鍵を預ける（第36.18節）。Google Cloud コンソールで作った API キーで、Places API を使えるかを確かめてから預ける。
   * 開発の見本の会社では確かめない。
   */
  app.put(`/${COMPETITORS_EXTENSION_ID}/map-key`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ key?: unknown }>().catch(() => ({} as { key?: unknown }));
    const problem = await deps.competitors.service.setMapKey({ tenantId: tenant.id, userId: user.id }, typeof body.key === 'string' ? body.key.slice(0, 200) : '',
      deps.connector.sourceFor(tenant.id) === 'mock');
    if (problem) return c.json({ error: problem }, 400);
    return c.json({ ok: true });
  });

  /** 競合の分析の設定（自動で覚える数 `autoMax`・定期の見回りの間隔 `watch`・結果を届ける人 `notifyUsers`。第 0.239.0 版・第36.19節・第36.22節）。 */
  app.put(`/${COMPETITORS_EXTENSION_ID}/settings`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ autoMax?: unknown; watch?: unknown; notifyUsers?: unknown }>().catch(() => ({} as { autoMax?: unknown; watch?: unknown; notifyUsers?: unknown }));
    const problem = await deps.competitors.service.setSettings({ tenantId: tenant.id, userId: user.id }, {
      ...(body.autoMax !== undefined ? { autoMax: Number(body.autoMax) } : {}),
      ...(body.watch !== undefined ? { watch: String(body.watch) } : {}),
      // 見回りの結果を、管理者のほかに届ける人（第36.22節）
      ...(body.notifyUsers !== undefined ? { notifyUsers: body.notifyUsers } : {}),
    });
    if (problem) return c.json({ error: problem }, 400);
    return c.json({ ok: true });
  });

  /** お知らせの作成: 流す画面の選び先（店頭サイネージの画面）と、いま選んでいる画面（`null` ならすべて）。 */
  app.get(`/${ANNOUNCEMENTS_EXTENSION_ID}/screens`, async (c) => c.json(await deps.announcements.service.screenChoices(c.get('ctx').tenant.id)));

  /** お知らせの作成の設定（第35.4節）: Web を公開まで行うか（`webPublish`）・WordPress のカテゴリー（`webCategory`）・流す画面（`screens`。`null` ならすべて）。 */
  app.put(`/${ANNOUNCEMENTS_EXTENSION_ID}/settings`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const settings = await deps.repo.getTenantSettings(tenant.id);
    const next = { ...settings.announcements };
    if (body['webPublish'] !== undefined) {
      if (body['webPublish'] !== 'publish' && body['webPublish'] !== 'draft') return c.json({ error: 'Web の出し方は 公開 か 下書き です' }, 400);
      next.webPublish = body['webPublish'];
    }
    if (body['webCategory'] !== undefined) next.webCategory = String(body['webCategory']).trim().slice(0, 40);
    if (body['screens'] !== undefined) {
      if (body['screens'] === null) next.screens = null;
      else if (Array.isArray(body['screens'])) next.screens = (body['screens'] as unknown[]).map(String).slice(0, 50);
      else return c.json({ error: '流す画面の形が違います' }, 400);
    }
    await deps.repo.saveTenantSettings(tenant.id, 'announcements', next, user.id);
    return c.json({ ok: true, settings: next });
  });

  /** 競合の分析の地図の鍵を外す。 */
  app.delete(`/${COMPETITORS_EXTENSION_ID}/map-key`, async (c) => {
    const { tenant, user } = c.get('ctx');
    await deps.competitors.service.removeMapKey({ tenantId: tenant.id, userId: user.id });
    return c.json({ ok: true });
  });

  /** LINE 公式アカウントを外す。受け口も止める（問い合わせは消さない）。 */
  app.delete(`/${INQUIRIES_EXTENSION_ID}/line`, async (c) => {
    const { tenant, user } = c.get('ctx');
    await deps.inquiries.service.disconnectLine({ tenantId: tenant.id, userId: user.id });
    return c.json({ ok: true });
  });

  /** 問い合わせの窓口のアカウントを外す。Google の許可も取り消す（問い合わせは消さない）。 */
  app.delete(`/${INQUIRIES_EXTENSION_ID}/mailbox`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const { refreshToken } = await deps.inquiries.service.disconnectMailbox({ tenantId: tenant.id, userId: user.id });
    if (refreshToken) await revokeGoogleToken(refreshToken).catch(() => false);
    return c.json({ ok: true });
  });

  /**
   * Webの分析の担当の許可をつなぐ（第34.18節）。Google の認可の画面の URL を返す（アカウントを選ばせ、読み取りの 2 つだけを求める。
   * 前に許した権限は引き継がない）。開発の見本の会社では、認可を経ずに見本の口をつなぐ。
   *
   * @returns `{ url }` か、見本なら `{ connected: true, status }`。会社の Google のクライアントが無ければ 409
   */
  app.post(`/${WEB_REVIEW_EXTENSION_ID}/connect`, async (c) => {
    const { tenant, user } = c.get('ctx');
    if (deps.connector.sourceFor(tenant.id) === 'mock') {
      const status = await deps.webReview.service.connect({ tenantId: tenant.id, userId: user.id }, { email: user.email, refreshToken: null });
      return c.json({ connected: true, status });
    }
    const client = await googleClient(deps, tenant.id);
    if (!client) return c.json({ error: '会社の Google 接続の設定がありません。「接続」の「Google Workspace」で登録してください' }, 409);
    const { verifier, challenge } = createPkce();
    const back = returnTo(c).replace(/\/(\?|$)/, '/admin/extensions$1');
    const state = deps.oauth.states.issue({ tenantId: tenant.id, userId: user.id, codeVerifier: verifier, returnTo: back, purpose: 'web-review' });
    const url = buildGoogleAuthUrl({ clientId: client.clientId, redirectUri: deps.oauth.redirectUri, scopes: WEB_REVIEW_SCOPES, state, codeChallenge: challenge, selectAccount: true, onlyTheseScopes: true });
    return c.json({ url });
  });

  /** Webの分析の担当の許可を外す。Google の許可も取り消す（月の便りは消さない）。 */
  app.delete(`/${WEB_REVIEW_EXTENSION_ID}/connection`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const { refreshToken } = await deps.webReview.service.disconnect({ tenantId: tenant.id, userId: user.id });
    if (refreshToken) await revokeGoogleToken(refreshToken).catch(() => false);
    return c.json({ ok: true });
  });

  /** Webの分析: 担当が見られるプロパティとサイトと、いまの状態（設定の画面で選ぶ）。 */
  app.get(`/${WEB_REVIEW_EXTENSION_ID}/candidates`, async (c) => {
    const { tenant } = c.get('ctx');
    const [candidates, status] = await Promise.all([deps.webReview.service.candidates(tenant.id), deps.webReview.service.status(tenant.id)]);
    return c.json({ candidates: 'error' in candidates ? null : candidates, error: 'error' in candidates ? candidates.error : null, status });
  });

  /** Webの分析: 制作会社の宛先（`email`・`name`。`null` で外す。第34.21節）。 */
  app.put(`/${WEB_REVIEW_EXTENSION_ID}/agency`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const agency = body['email'] === null || body['email'] === '' ? null : { email: String(body['email'] ?? ''), name: String(body['name'] ?? '') };
    const err = await deps.webReview.service.setAgency({ tenantId: tenant.id, userId: user.id }, agency);
    return err ? c.json({ error: err }, 400) : c.json({ ok: true });
  });

  /** Webの分析: プロパティとサイトを選ぶ（`propertyId`・`siteUrl`。`null` で選ばない）。 */
  app.put(`/${WEB_REVIEW_EXTENSION_ID}/selection`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const pick = (v: unknown) => (v === undefined ? undefined : v === null ? null : String(v));
    const err = await deps.webReview.service.select({ tenantId: tenant.id, userId: user.id }, { propertyId: pick(body['propertyId']), siteUrl: pick(body['siteUrl']) });
    if (err) return c.json({ error: err }, 400);
    return c.json({ ok: true, status: await deps.webReview.service.status(tenant.id) });
  });

  /** コラムの貼るだけのページを入れる（鍵の URL を作る。第32.18.4節）。 */
  app.post(`/${WEB_COLUMNS_EXTENSION_ID}/page`, async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!deps.columns.planner) return c.json({ error: '貼るだけのページは使えません' }, 409);
    const { key } = await deps.columns.planner.enablePage({ tenantId: tenant.id, userId: user.id });
    const page = `${tenantOrigin(c.req.header('origin'), c.req.header('host'))}/v1/public/columns/${key}`;
    return c.json({ ok: true, urls: { page, data: `${page}.json`, rss: `${page}.rss` } });
  });

  /** コラムの貼るだけのページを止める（鍵を捨てる。すぐ 404 になる）。 */
  app.delete(`/${WEB_COLUMNS_EXTENSION_ID}/page`, async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!deps.columns.planner) return c.json({ error: '貼るだけのページは使えません' }, 409);
    await deps.columns.planner.disablePage({ tenantId: tenant.id, userId: user.id });
    return c.json({ ok: true });
  });

  /** WordPress の入れ先と鍵を外す（コラムは消さない）。 */
  app.delete(`/${WEB_COLUMNS_EXTENSION_ID}/wordpress`, async (c) => {
    const { tenant, user } = c.get('ctx');
    await deps.columns.service.removeWordPress({ tenantId: tenant.id, userId: user.id });
    return c.json({ ok: true });
  });

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
  /**
   * 就業規則・賃金規程（PDF・Word・文字・写真）から会社の設定の案を作る（第30.8.2節）。保存はしない（管理者が選んで設定に入れる）。
   * ファイルは残さない。JSON で `knowledgeId` を送ると、知識に登録した社内規程から作る（第11.11.2節。第 0.193.0 版）。
   */
  app.post(`/${HR_EXTENSION_ID}/proposal`, async (c) => {
    const { tenant, user } = c.get('ctx');
    if ((c.req.header('content-type') ?? '').startsWith('application/json')) {
      const b = await c.req.json<{ knowledgeId?: unknown }>().catch(() => ({} as { knowledgeId?: unknown }));
      const rule = (await deps.repo.listKnowledge(tenant.id)).find((k) => k.id === b.knowledgeId && k.category === 'rule');
      if (!rule) return c.json({ error: '社内規程が見つかりません' }, 404);
      const r = await deps.hr.service.proposeFromText(tenant.id, user.id, rule.body);
      return 'error' in r ? c.json(r, 422) : c.json({ fields: r.fields });
    }
    const form = await c.req.parseBody();
    const f = form['file'];
    if (!(f instanceof File)) return c.json({ error: '就業規則か賃金規程のファイルを選んでください' }, 400);
    if (f.size > MAX_FILE_BYTES) return c.json({ error: 'ファイルが大きすぎます（10 MB まで）' }, 413);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const detected = detectKind(f.name || 'rules.pdf', bytes);
    const kind = detected === 'pdf' || detected === 'docx' || detected === 'png' || detected === 'jpeg' || detected === 'webp' ? detected
      : /\.(txt|md)$/i.test(f.name) ? 'txt' : null;
    if (!kind) return c.json({ error: 'PDF・Word・文字のファイルか、写真を選んでください' }, 400);
    const r = await deps.hr.service.proposeSettings(tenant.id, user.id, bytes, kind);
    return 'error' in r ? c.json(r, 422) : c.json({ fields: r.fields });
  });

  /**
   * 社内規程の登録・改定で見つかった、人事・給与の今の設定と食い違う項目（第11.11.2節・第30.8.2節）。
   * 残した答えを、いまの設定と並べ直して返す（直した項目は出さない）。食い違いが無くなった版は返さない。
   */
  app.get(`/${HR_EXTENSION_ID}/rule-checks`, async (c) => {
    const { tenant } = c.get('ctx');
    const checks = [];
    for (const v of await deps.repo.listRuleHrChecks(tenant.id)) {
      const raw = (v.hrCheck as { raw?: unknown } | null)?.raw;
      if (typeof raw !== 'string') continue;
      const fields = await deps.hr.service.ruleDiffs(tenant.id, raw);
      if (fields.length) checks.push({ itemId: v.itemId, version: v.version, title: v.title, effectiveFrom: v.effectiveFrom, fields });
    }
    return c.json({ checks });
  });

  /** 規程の改定で見つかった食い違いを見終えた（直さないと決めたときにも使う）。 */
  app.post(`/${HR_EXTENSION_ID}/rule-checks/:itemId/:version/dismiss`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const ok = await deps.repo.dismissRuleHrCheck(tenant.id, c.req.param('itemId'), Number(c.req.param('version')), new Date().toISOString());
    if (!ok) return c.json({ error: '見つかりません' }, 404);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'hr.rule_check.dismiss',
      targetType: 'knowledge', targetId: c.req.param('itemId'), detail: { version: Number(c.req.param('version')) }, occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true });
  });

  /** 労災保険率表の事業の種類（いまの表。会社の設定で選ぶ。第30.13.1節）。 */
  const industries = () => [...LAW_BOOK.workersComp].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]?.rows ?? [];
  app.get(`/${HR_EXTENSION_ID}/labor-industries`, (c) => c.json({ industries: industries() }));

  /**
   * 手当の扱い（第30.10.1節）。雇用条件に入っている手当の名前と会社の設定の手当を並べ、それぞれの扱い（設定があればそれ、無ければ名前から決めたもの）を返す。
   * 人に手当の一覧を作らせない（ADR-0028）。名前だけを返し、額や人は返さない。
   */
  app.get(`/${HR_EXTENSION_ID}/allowances`, async (c) => {
    const { tenant } = c.get('ctx');
    const store = deps.hr.service.deps.store;
    const rules = (await deps.repo.getTenantSettings(tenant.id)).hr.payroll.items;
    const names = new Set(rules.map((r) => r.name));
    for (const e of await store.listEmployees(tenant.id)) for (const t of await store.listTerms(tenant.id, e.id)) for (const a of t.allowances) names.add(a.name);
    const items = [...names].sort((a, b) => a.localeCompare(b, 'ja')).map((name) => ({ ...itemRule(name, rules), set: rules.some((r) => r.name === name) }));
    return c.json({ items });
  });

  app.put(`/${HR_EXTENSION_ID}/settings`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const cur = (await deps.repo.getTenantSettings(tenant.id)).hr;
    const next: HrSettings = { ...cur, office: { ...cur.office }, health: { ...cur.health }, pay: { ...cur.pay }, work: { ...cur.work }, agreement: { ...cur.agreement }, leave: { ...cur.leave }, payroll: { ...cur.payroll }, transfer: { ...cur.transfer }, duties: { ...cur.duties }, notice: { ...cur.notice }, insurance: { ...cur.insurance }, labor: { ...cur.labor } };
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
    // 労働日と休日（第30.6.1節）。曜日は 0=日曜〜6=土曜
    const work = obj(b['work']);
    const wd = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6 ? v : undefined);
    if (work) {
      if (Array.isArray(work['weekdays'])) next.work = { ...next.work, weekdays: [...new Set(work['weekdays'].map(wd).filter((x): x is number => x !== undefined))].sort() };
      if (wd(work['legalHoliday']) !== undefined) next.work = { ...next.work, legalHoliday: wd(work['legalHoliday'])! };
      if (wd(work['weekStart']) !== undefined) next.work = { ...next.work, weekStart: wd(work['weekStart'])! };
      if (typeof work['nationalHolidays'] === 'boolean') next.work = { ...next.work, nationalHolidays: work['nationalHolidays'] };
    }
    // 36 協定（第30.6.1節）
    const ag = obj(b['agreement']);
    const hours = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? Math.round(v) : undefined);
    if (ag) {
      next.agreement = {
        enabled: typeof ag['enabled'] === 'boolean' ? ag['enabled'] : next.agreement.enabled,
        monthly: hours(ag['monthly'], 100) ?? next.agreement.monthly,
        yearly: hours(ag['yearly'], 720) ?? next.agreement.yearly,
        special: typeof ag['special'] === 'boolean' ? ag['special'] : next.agreement.special,
        startMonth: hours(ag['startMonth'], 12) ?? next.agreement.startMonth,
      };
    }
    // 休暇（第30.7.1節）
    const lv = obj(b['leave']);
    if (lv && typeof lv['halfDay'] === 'boolean') next.leave = { ...next.leave, halfDay: lv['halfDay'] };
    // 給与の計算（第30.10.1節）。割増率は法定の下限を下回らせない
    const py = obj(b['payroll']);
    if (py) {
      const p = { ...next.payroll, premiums: { ...next.payroll.premiums }, kumiai: { ...next.payroll.kumiai } };
      if (py['collect'] === 'next' || py['collect'] === 'current') p.collect = py['collect'];
      const pm = obj(py['premiums']);
      const floor = { overtime: 25, over60: 50, night: 25, holiday: 35 } as const;
      if (pm) {
        for (const k of Object.keys(floor) as (keyof typeof floor)[]) {
          const v = pm[k];
          if (v === undefined) continue;
          if (typeof v !== 'number' || !Number.isFinite(v) || v < floor[k] || v > 200) return c.json({ error: `割増率は法定の下限（${floor[k]}%）以上で入れてください` }, 400);
          p.premiums[k] = v;
        }
      }
      if (py['avgMonthlyHours'] === null) p.avgMonthlyHours = null;
      else if (typeof py['avgMonthlyHours'] === 'number' && py['avgMonthlyHours'] > 0 && py['avgMonthlyHours'] <= 250) p.avgMonthlyHours = py['avgMonthlyHours'];
      if (typeof py['deductAbsence'] === 'boolean') p.deductAbsence = py['deductAbsence'];
      const km = obj(py['kumiai']);
      const pct = (v: unknown) => (v === null ? null : typeof v === 'number' && v >= 0 && v < 30 ? v : undefined);
      if (km) {
        if (pct(km['health']) !== undefined) p.kumiai.health = pct(km['health'])!;
        if (pct(km['care']) !== undefined) p.kumiai.care = pct(km['care'])!;
      }
      if (Array.isArray(py['items'])) {
        p.items = py['items'].slice(0, 50).map((x) => x as Record<string, unknown>)
          .filter((x) => typeof x['name'] === 'string' && x['name'].trim())
          .map((x) => ({ name: String(x['name']).trim().slice(0, 50), premiumBase: x['premiumBase'] !== false, taxable: x['taxable'] !== false }));
      }
      next.payroll = p;
    }
    // 振込データの振込元（第30.10.3節）。番号は桁を確かめ、名前はそのまま持つ（作るときに半角のカナに直す）
    const tr = obj(b['transfer']);
    if (tr) {
      const t = { ...next.transfer };
      const digits = (k: 'clientCode' | 'bankCode' | 'branchCode' | 'accountNumber', re: RegExp, label: string): string | null => {
        const v = tr[k];
        if (v === undefined) return null;
        const s = String(v).normalize('NFKC').trim();
        if (s && !re.test(s)) return label;
        t[k] = s;
        return null;
      };
      const bad = digits('clientCode', /^\d{10}$/, '委託者コードは 10 桁の数字です') ?? digits('bankCode', /^\d{4}$/, '銀行コードは 4 桁の数字です')
        ?? digits('branchCode', /^\d{3}$/, '支店コードは 3 桁の数字です') ?? digits('accountNumber', /^\d{1,7}$/, '口座番号は 7 桁までの数字です');
      if (bad) return c.json({ error: bad }, 400);
      for (const k of ['clientName', 'bankName', 'branchName'] as const) if (text(tr[k], 40) !== undefined) t[k] = text(tr[k], 40)!;
      if (tr['format'] === 'sogo' || tr['format'] === 'kyuyo') t.format = tr['format'];
      if (tr['accountType'] === '普通' || tr['accountType'] === '当座') t.accountType = tr['accountType'];
      next.transfer = t;
    }
    // 労務カレンダーに使う決まり（第30.19.1節）と、労働条件通知書の会社の定め（第30.5.3節）
    const du = obj(b['duties']);
    if (du) {
      const d = { ...next.duties };
      if (typeof du['withholdingSpecial'] === 'boolean') d.withholdingSpecial = du['withholdingSpecial'];
      if (typeof du['residentSpecial'] === 'boolean') d.residentSpecial = du['residentSpecial'];
      if (du['healthCheckMonth'] === null) d.healthCheckMonth = null;
      else if (Number.isInteger(du['healthCheckMonth']) && Number(du['healthCheckMonth']) >= 1 && Number(du['healthCheckMonth']) <= 12) d.healthCheckMonth = Number(du['healthCheckMonth']);
      next.duties = d;
    }
    const no = obj(b['notice']);
    if (no) {
      const n = { ...next.notice };
      for (const k of ['raise', 'bonus', 'severance', 'retirement', 'consultation', 'other'] as const) if (text(no[k], 1000) !== undefined) n[k] = text(no[k], 1000)!;
      next.notice = n;
    }
    // 社会保険の届出と加入の判定（第30.12.1節）
    const ins = obj(b['insurance']);
    if (ins) {
      const i = { ...next.insurance };
      if (text(ins['officeSymbol'], 20) !== undefined) i.officeSymbol = text(ins['officeSymbol'], 20)!;
      if (text(ins['officeNumber'], 10) !== undefined) i.officeNumber = text(ins['officeNumber'], 10)!;
      if (ins['specificOffice'] === 'auto' || ins['specificOffice'] === 'yes' || ins['specificOffice'] === 'no') i.specificOffice = ins['specificOffice'];
      if (ins['fullTimeWeeklyHours'] !== undefined) {
        const h = ins['fullTimeWeeklyHours'];
        if (typeof h !== 'number' || !Number.isFinite(h) || h < 10 || h > 60) return c.json({ error: '通常の労働者の週の所定労働時間は 10〜60 時間で入れてください' }, 400);
        i.fullTimeWeeklyHours = Math.round(h * 100) / 100;
      }
      next.insurance = i;
    }
    // 労働保険の事業の種類と労働保険番号（第30.13.1節）
    const lb = obj(b['labor']);
    if (lb) {
      const l = { ...next.labor };
      if (lb['business'] === 'general' || lb['business'] === 'agriculture' || lb['business'] === 'construction') l.business = lb['business'];
      if (lb['industry'] !== undefined) {
        if (!industries().some((r) => r.code === lb['industry'])) return c.json({ error: '労災保険の事業の種類が労災保険率表にありません' }, 400);
        l.industry = String(lb['industry']);
      }
      if (text(lb['number'], 20) !== undefined) l.number = text(lb['number'], 20)!;
      next.labor = l;
    }
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

  /** 会員とポイントの、来店のポイント・購入の率・有効期限・LINE の会員証を直す（管理者だけ。第40.4節）。 */
  app.put(`/${MEMBERS_EXTENSION_ID}/settings`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const problem = await deps.members.service.saveSettings({ tenantId: tenant.id, userId: user.id }, body);
    return problem ? c.json({ error: problem }, problem.includes('管理者だけ') ? 403 : 400) : c.json({ ok: true });
  });

  /** 補助金・助成金の案内の、会社の関心と業種を直す（管理者だけ。第39.12節）。 */
  app.put(`/${SUBSIDIES_EXTENSION_ID}/settings`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ interest?: unknown; industry?: unknown }>().catch(() => ({} as { interest?: unknown; industry?: unknown }));
    const problem = await deps.subsidies.service.saveSettings({ tenantId: tenant.id, userId: user.id }, body);
    return problem ? c.json({ error: problem }, 403) : c.json({ ok: true });
  });

  /** 契約の管理の、契約書の置き場をつなぐ・つなぎ直す（会社の Google ドライブにフォルダを作る。管理者だけ。第38.7節）。 */
  app.put(`/${CONTRACTS_EXTENSION_ID}/storage`, async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await deps.contracts.service.connectStorage({ tenantId: tenant.id, userId: user.id });
    if ('error' in r) return c.json({ error: r.error }, 400);
    return c.json({ ok: true, folderName: r.folderName });
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
      else if (section === 'webColumns') await deps.repo.saveTenantSettings(tenant.id, 'webColumns', { ...settings.webColumns, enabled: body.enabled }, user.id);
      else if (section === 'inquiries') await deps.repo.saveTenantSettings(tenant.id, 'inquiries', { ...settings.inquiries, enabled: body.enabled }, user.id);
      else if (section === 'competitors') await deps.repo.saveTenantSettings(tenant.id, 'competitors', { ...settings.competitors, enabled: body.enabled }, user.id);
      else if (section === 'announcements') await deps.repo.saveTenantSettings(tenant.id, 'announcements', { ...settings.announcements, enabled: body.enabled }, user.id);
      else if (section === 'webReview') await deps.repo.saveTenantSettings(tenant.id, 'webReview', { ...settings.webReview, enabled: body.enabled }, user.id);
      else if (section === 'contracts') {
        await deps.repo.saveTenantSettings(tenant.id, 'contracts', { ...settings.contracts, enabled: body.enabled }, user.id);
        // 入れたら、入れた管理者のドライブに契約書の置き場を作る（まだ無ければ。作れなくても入れる。第38.7節）
        if (body.enabled && !settings.contracts.storage) await deps.contracts.service.connectStorage({ tenantId: tenant.id, userId: user.id }).catch(() => null);
      }
      else if (section === 'reservations') await deps.repo.saveTenantSettings(tenant.id, 'reservations', { ...settings.reservations, enabled: body.enabled }, user.id);
      else if (section === 'members') await deps.repo.saveTenantSettings(tenant.id, 'members', { ...settings.members, enabled: body.enabled }, user.id);
      else if (section === 'subsidies') {
        await deps.repo.saveTenantSettings(tenant.id, 'subsidies', { ...settings.subsidies, enabled: body.enabled }, user.id);
        // 初めて入れたときは、利用範囲を管理者だけにする（第39.2節。管理者は「利用できる人」で広げられる）
        if (body.enabled && !settings.access.scopes[SUBSIDIES_EXTENSION_ID]) {
          const admins = (await deps.repo.listUsers(tenant.id)).filter((u) => u.status === 'active' && u.roles.includes('admin')).map((u) => u.id);
          await deps.repo.saveTenantSettings(tenant.id, 'access', { ...settings.access, scopes: { ...settings.access.scopes, [SUBSIDIES_EXTENSION_ID]: { users: admins, groups: [] } } }, user.id);
        }
      }
      else if (section === 'signage') {
        await deps.repo.saveTenantSettings(tenant.id, 'signage', { ...settings.signage, enabled: body.enabled }, user.id);
        // 切ったら、画面は無地にする（登録・素材・流れは消さない。第31.2節）
        deps.signage.service.settingsChanged(tenant.id);
      } else await deps.repo.saveTenantSettings(tenant.id, 'hr', { ...settings.hr, enabled: body.enabled }, user.id);
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
