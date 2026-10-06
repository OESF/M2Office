/**
 * @file 会社ごとの拡張機能の見え方をまとめる。公式の配布元と、その会社が取り込んだファイルを合わせる。
 *
 * 会社で使えるのは、公式の業務エージェントと、**導入済み・有効・再同意が不要**な拡張機能の業務エージェント（仕様書 第12.10.4節）。
 * ツールは、内蔵のツールと**会社の接続**（コネクタ。MCP）のツールである（第12.11.0節、ADR-0037）。
 * 拡張機能に同梱した接続は、導入したときに会社の接続として登録する。
 * ファイルから取り込んだ拡張機能（自社専用）は、取り込んだ会社にだけ見える（第12.10.3節）。
 *
 * @see 仕様書 第12.10節 持ち運べる拡張機能
 */

import { RISK_ORDER, type AgentDefinition, type RiskLevel } from '@m2office/shared';
import type { InstalledExtension, Repository, TenantConnection } from '../repository/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { McpClient } from '../connectors/mcp.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { connectorToolName, connectorTools, type ConnectionAuthProvider, type ConnectorDeclaration } from './connectors.js';
import { loadExtensionFiles, type ExtensionFiles, type ExtensionPackage } from './loader.js';
import { CARDS_PACKAGE } from '../cards/agents.js';
import { INVENTORY_PACKAGE } from '../inventory/agents.js';
import { HR_PACKAGE } from '../hr/package.js';
import { SIGNAGE_PACKAGE } from '../signage/package.js';
import { WEB_COLUMNS_PACKAGE } from '../columns/agents.js';
import { INQUIRIES_PACKAGE } from '../inquiries/agents.js';
import { COMPETITORS_PACKAGE } from '../competitors/agents.js';
import { ANNOUNCEMENTS_PACKAGE } from '../announcements/agents.js';
import { WEB_REVIEW_PACKAGE } from '../web-review/agents.js';
import { CONTRACTS_PACKAGE } from '../contracts/agents.js';

/**
 * 内蔵の拡張（第12.13節）と、入り切りを持つ会社の設定の区分。導入の手順は無く、この区分の `enabled` だけで決まる。
 *
 * @remarks 名刺管理は既定で入、在庫管理と人事・給与と店頭サイネージとコラムの作成と問い合わせの記録と競合の分析とお知らせの作成と Webの分析と契約の管理は既定で切り（第27.2節・第29.2節・第30.2節・第31.2節・第32.18.1節・第33.2節・第34.2節・第35.2節・第36.2節）
 */
export const BUILTIN_EXTENSIONS: { pkg: ExtensionPackage; section: BuiltinSection }[] = [
  { pkg: CARDS_PACKAGE, section: 'cards' },
  { pkg: INVENTORY_PACKAGE, section: 'inventory' },
  { pkg: HR_PACKAGE, section: 'hr' },
  { pkg: SIGNAGE_PACKAGE, section: 'signage' },
  { pkg: WEB_COLUMNS_PACKAGE, section: 'webColumns' },
  { pkg: INQUIRIES_PACKAGE, section: 'inquiries' },
  { pkg: COMPETITORS_PACKAGE, section: 'competitors' },
  { pkg: ANNOUNCEMENTS_PACKAGE, section: 'announcements' },
  { pkg: WEB_REVIEW_PACKAGE, section: 'webReview' },
  { pkg: CONTRACTS_PACKAGE, section: 'contracts' },
];

/** 内蔵の拡張の入り切りを持つ会社の設定の区分。 */
export type BuiltinSection = 'cards' | 'inventory' | 'hr' | 'signage' | 'webColumns' | 'inquiries' | 'competitors' | 'announcements' | 'webReview' | 'contracts';

/** 内蔵の拡張なら、入り切りを持つ会社の設定の区分を返す。 */
export function builtinSection(extensionId: string): BuiltinSection | null {
  return BUILTIN_EXTENSIONS.find((b) => b.pkg.manifest.id === extensionId)?.section ?? null;
}

/** 会社から見た拡張機能 1 つ分。 */
export interface ExtensionEntry {
  pkg: ExtensionPackage;
  /** 公式の配布元か、その会社がファイルから取り込んだもの（自社専用）か、中核に組み込んだ内蔵の拡張（第12.13節）か。 */
  origin: 'official' | 'private' | 'builtin';
  /** 導入の記録。未導入なら `null`。 */
  installed: InstalledExtension | null;
  /** 導入したときより権限が増えている。スイッチを入れる前に再同意が要る（第12.6節）。 */
  needsReconsent: boolean;
  /** その会社で使える（導入済み・有効・再同意が不要）。 */
  active: boolean;
}

/** 会社から見た拡張機能の全体。 */
export interface TenantExtensions {
  entries: ExtensionEntry[];
  /** その会社で使える業務エージェント（公式と、使える拡張機能）。 */
  agents: AgentDefinition[];
  /** 名前を引くための、知っているすべての業務エージェント（使えないものを含む）。 */
  allAgents: AgentDefinition[];
  /** その会社で使えるツール（内蔵と、使える拡張機能のコネクタのツール）。 */
  registry: ToolRegistry;
  /** ID と版で業務エージェントを引く。使えるかどうかは {@link isAvailable} で確かめる。 */
  resolve(agentId: string, version: number): AgentDefinition | undefined;
  isAvailable(agentId: string): boolean;
  /** 業務エージェントがどの拡張機能のものか。公式なら `null`。 */
  entryOf(agentId: string): ExtensionEntry | null;
  /** 管理者が個別に止めたコネクタのツール（`<コネクタの ID>.<ツールの名前>`。第6.6.3.1節）。 */
  disabledTools: Set<string>;
  /** 会社の接続（第12.11.0節）。 */
  connections: TenantConnection[];
  /**
   * その業務が使うツールのうち、この会社に無いもの（会社の接続が登録されていないツール。第12.11.0節）。
   *
   * @remarks 1 つでもあれば、その業務は使えない（「接続が要ります」）
   */
  missingToolsOf(def: AgentDefinition): string[];
}

/**
 * 秘書の調べもの（第10.11.4節）の ID。会社の接続の**読むだけのツール**を足して使わせる（第12.11.0節）。
 */
const CONNECTION_READER_IDS = new Set(['secretary-lookup']);

/**
 * その業務エージェントが、止められたツールを使うか（仕様書 第6.6.3.1節）。
 *
 * @remarks
 * 業務の定義はツールを名前で指しており、1 つ欠けると最後まで進めない。
 * そのため、1 つでも止まっていれば、その業務は使えないものとして扱う。
 */
export function blockedByDisabledTool(def: AgentDefinition, disabled: ReadonlySet<string>): boolean {
  return def.tools.some((name) => disabled.has(name));
}

/** 導入の同意で記録する権限（仕様書 第12.10.5節、第12.11.2節）。 */
export interface ConsentSnapshot {
  tools: string[];
  max_risk_level: RiskLevel;
  connectors: { id: string; url: string; auth: string; tools: { name: string; risk: RiskLevel }[] }[];
}

export interface ExtensionHubDeps {
  repo: Repository;
  /** 内蔵のツールの登録簿。 */
  registry: ToolRegistry;
  /** 公式の業務エージェント。 */
  official: AgentDefinition[];
  /** 公式の配布元から読み込んだ拡張機能。 */
  packages: ExtensionPackage[];
  /** コネクタの MCP サーバへの接続口。省略するとコネクタのツールは「接続されていません」を返す。 */
  mcp?: McpClient;
  /**
   * 認証の要る接続の認可を用意する口（仕様書 第12.11.6.4節）。無ければ、認証の要る接続のツールは「準備がありません」を返す
   */
  connectionAuth?: ConnectionAuthProvider;
  logger?: Logger;
}

export class ExtensionHub {
  private readonly log: Logger;

  constructor(private readonly deps: ExtensionHubDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /** 公式の配布元の拡張機能。 */
  officialPackages(): ExtensionPackage[] {
    return this.deps.packages;
  }

  /** 公式の業務エージェントと、公式の配布元の拡張機能の業務エージェント（見本の応答を引くなどに使う）。 */
  officialAgents(): AgentDefinition[] {
    return [...this.deps.official, ...this.deps.packages.flatMap((p) => p.agents)];
  }

  /**
   * 会社から見た拡張機能の全体を組み立てる。
   *
   * @remarks
   * テナント境界: 自社専用の拡張機能と導入の記録は、その会社の分だけを読む（不変則 I-2）。
   * 取り込んだファイルは読み込むたびに検証し直す。通らなくなったものは使わない。
   */
  async forTenant(tenantId: string): Promise<TenantExtensions> {
    const { repo, registry, official, mcp, connectionAuth } = this.deps;
    const [installed, privates, disabledRows, settings] = await Promise.all([
      repo.listInstalledExtensions(tenantId), repo.listPrivateExtensions(tenantId),
      repo.listDisabledConnectorTools(tenantId), repo.getTenantSettings(tenantId),
    ]);
    const disabledTools = new Set(disabledRows.map((d) => connectorToolName(d.connectorId, d.toolName)));
    const packages: { pkg: ExtensionPackage; origin: 'official' | 'private' }[] =
      this.deps.packages.map((pkg) => ({ pkg, origin: 'official' }));
    const takenAgents = new Set(this.officialAgents().map((a) => a.id));
    for (const rec of privates) {
      if (this.deps.packages.some((p) => p.manifest.id === rec.extensionId)) continue;
      // 接続の ID は拡張機能どうしで重なってよい（同じ会社の接続を使う。第12.11.0節）
      const { pkg, problems } = loadExtensionFiles(decodeFiles(rec.files), registry, { takenAgents });
      if (!pkg || problems.length > 0) {
        this.log.warn('取り込んだ拡張機能が検証を通りません', { tenantId, extensionId: rec.extensionId, problems });
        continue;
      }
      for (const a of pkg.agents) takenAgents.add(a.id);
      packages.push({ pkg, origin: 'private' });
    }

    const entries: ExtensionEntry[] = packages.map(({ pkg, origin }) => {
      const rec = installed.find((i) => i.extensionId === pkg.manifest.id) ?? null;
      const needsReconsent = rec !== null && !covers(rec.consentedPermissions, consentSnapshot(pkg));
      return { pkg, origin, installed: rec, needsReconsent, active: rec !== null && rec.enabled && !needsReconsent };
    });
    // 内蔵の拡張（名刺管理・在庫管理・人事・給与・店頭サイネージ。第12.13節）。導入の手順は無く、会社の設定の入り切りだけで決まる
    for (const { pkg, section } of BUILTIN_EXTENSIONS) {
      const enabled = settings[section].enabled;
      entries.push({
        pkg, origin: 'builtin', needsReconsent: false, active: enabled,
        installed: {
          tenantId, extensionId: pkg.manifest.id, version: pkg.manifest.version,
          consentedPermissions: { tools: pkg.manifest.permissions.tools, max_risk_level: pkg.manifest.permissions.max_risk_level },
          installedBy: 'system', installedAt: '', enabled,
        },
      });
    }
    const active = entries.filter((e) => e.active);
    // 導入済みの拡張機能が同梱する接続で、まだ会社に無いものを登録する（第 0.132.0 版より前に導入した会社のため）
    let connections = await repo.listConnections(tenantId);
    const missing = active.flatMap((e) => e.pkg.connectors.map((c) => ({ c, e }))).filter(({ c }) => !connections.some((x) => x.id === c.id));
    if (missing.length > 0) {
      for (const { c, e } of missing) await repo.saveConnection(bundledConnection(tenantId, c, e.pkg.manifest.id, e.installed?.installedBy ?? 'system'));
      connections = await repo.listConnections(tenantId);
    }
    // 止めたツールは、その会社のツールの一覧から外す。業務からも接続の確認からも見えない
    const tenantRegistry = registry.extend(
      connections.flatMap((c) => connectorTools(c, mcp, connectionAuth)).filter((t) => !disabledTools.has(t.name)),
    );
    const missingToolsOf = (def: AgentDefinition) => def.tools.filter((name) => !tenantRegistry.get(name));
    // 秘書の調べものは、会社の接続の読むだけのツールを使える（第12.11.0節）
    const readTools = connections.flatMap((c) => connectorTools(c)).filter((t) => t.risk === 'read' && tenantRegistry.get(t.name)).map((t) => t.name);
    // 名刺管理を使う会社では、秘書の調べものが名刺を探せる（第27.9節）。利用範囲はツールを呼ぶときに確かめる
    if (settings.cards.enabled) readTools.push('contacts.search', 'contacts.get', 'contacts.changes');
    // 在庫管理を使う会社では、秘書の調べものが在庫と入出庫の記録を探せる（第29.15節）
    if (settings.inventory.enabled) readTools.push('inventory.search', 'inventory.history');
    const withReaders = (a: AgentDefinition) => (CONNECTION_READER_IDS.has(a.id) && readTools.length > 0
      ? { ...a, tools: [...new Set([...a.tools, ...readTools])] } : a);
    const allAgents = [...official, ...entries.flatMap((e) => e.pkg.agents)].map(withReaders);
    // 止めたツール・会社に無い接続のツールを使う業務は、メニュー・秘書・定時実行・API から消す（第6.6.3.1節・第12.11.0節）
    const activeIds = new Set([...official.map((a) => a.id), ...active.flatMap((e) => e.pkg.agents.map((a) => a.id))]);
    const agents = allAgents.filter((a) => activeIds.has(a.id) && !blockedByDisabledTool(a, disabledTools) && missingToolsOf(a).length === 0);
    const entryOf = (agentId: string) => {
      if (!agentId.includes(':')) return null;
      const extId = agentId.slice(0, agentId.indexOf(':'));
      return entries.find((e) => e.pkg.manifest.id === extId) ?? null;
    };
    return {
      entries, agents, allAgents, registry: tenantRegistry, disabledTools, connections, missingToolsOf,
      resolve: (agentId, version) => allAgents.find((a) => a.id === agentId && a.version === version),
      isAvailable: (agentId) => agents.some((a) => a.id === agentId),
      entryOf,
    };
  }

  /**
   * コネクタの接続を確かめる（仕様書 第12.11.3節「接続の確認」）。
   *
   * @returns 宣言したツールごとに、MCP サーバが提供しているか。接続できなければ理由
   */
  async checkConnector(c: ConnectorDeclaration, headers?: Record<string, string>): Promise<
    { ok: true; tools: { name: string; provided: boolean }[] } | { ok: false; error: string }
  > {
    if (!this.deps.mcp) return { ok: false, error: 'コネクタへの接続口が用意されていません' };
    const res = await this.deps.mcp.listTools(c.url, headers);
    if (!res.ok) return res;
    return { ok: true, tools: c.tools.map((t) => ({ name: t.name, provided: res.tools.some((x) => x.name === t.name) })) };
  }

  /**
   * MCP サーバにツールの一覧を問い合わせる（会社の接続を登録するとき。仕様書 第12.11.0節）。
   *
   * @returns ツールの一覧（名前・説明・読むだけの目印）。接続できなければ理由
   */
  async listMcpTools(url: string, headers?: Record<string, string>): ReturnType<McpClient['listTools']> {
    if (!this.deps.mcp) return { ok: false, error: 'コネクタへの接続口が用意されていません' };
    return this.deps.mcp.listTools(url, headers);
  }

  /** 内蔵のツールの名前の頭の部分（`gmail` など）。会社の接続の ID に使えない。 */
  builtinPrefixes(): Set<string> {
    return new Set(this.deps.registry.names().map((n) => n.split('.')[0]!));
  }

  /**
   * 取り込もうとするファイルを検証する（仕様書 第12.10.2節）。
   *
   * @remarks
   * 公式の拡張機能と同じ ID は取り込めない。同じ ID の自社専用の拡張機能があれば、それを置き換える前提で検証する。
   */
  async validateImport(tenantId: string, files: ExtensionFiles): Promise<ReturnType<typeof loadExtensionFiles>> {
    const { repo, registry } = this.deps;
    const first = loadExtensionFiles(files, registry, {});
    const extId = first.pkg?.manifest.id;
    if (!first.pkg || !extId) return first;
    if (this.deps.packages.some((p) => p.manifest.id === extId)) {
      return { pkg: first.pkg, problems: [`公式の拡張機能と同じ ID（${extId}）です。ID を変えてください`] };
    }
    const others = (await repo.listPrivateExtensions(tenantId)).filter((r) => r.extensionId !== extId);
    const takenAgents = new Set(this.officialAgents().map((a) => a.id));
    for (const rec of others) {
      const { pkg } = loadExtensionFiles(decodeFiles(rec.files), registry, {});
      for (const a of pkg?.agents ?? []) takenAgents.add(a.id);
    }
    return loadExtensionFiles(files, registry, { takenAgents });
  }
}

/**
 * 拡張機能に同梱した接続を、会社の接続の形にする（第12.11.0節）。危険度は同梱の宣言の推奨のまま。
 *
 * @param extensionId 同梱していた拡張機能（登録の由来に残す）
 */
export function bundledConnection(tenantId: string, c: ConnectorDeclaration, extensionId: string, by: string): TenantConnection {
  const now = new Date().toISOString();
  return {
    tenantId, id: c.id, name: c.name, description: c.description ?? '', transport: c.transport, url: c.url, auth: c.auth,
    tools: c.tools.map((t) => ({ ...t })), origin: `extension:${extensionId}`, createdBy: by, createdAt: now, updatedAt: now,
  };
}

/** 拡張機能が求める権限を、同意の記録の形にする。 */
export function consentSnapshot(pkg: ExtensionPackage): ConsentSnapshot {
  return {
    tools: [...pkg.manifest.permissions.tools],
    max_risk_level: pkg.manifest.permissions.max_risk_level,
    connectors: pkg.connectors.map((c) => ({
      id: c.id, url: c.url, auth: c.auth.type, tools: c.tools.map((t) => ({ name: t.name, risk: t.risk })),
    })),
  };
}

/** 同意した権限が、求める権限をすべて含むか。含まなければ再同意が要る。 */
function covers(consented: InstalledExtension['consentedPermissions'], wanted: ConsentSnapshot): boolean {
  const had = consented as Partial<ConsentSnapshot>;
  if (!wanted.tools.every((t) => had.tools?.includes(t))) return false;
  if (RISK_ORDER[wanted.max_risk_level] > (RISK_ORDER[had.max_risk_level as RiskLevel] ?? -1)) return false;
  return wanted.connectors.every((w) => {
    const c = had.connectors?.find((x) => x.id === w.id);
    return !!c && c.url === w.url && c.auth === w.auth &&
      w.tools.every((t) => c.tools.some((x) => x.name === t.name && RISK_ORDER[x.risk] >= RISK_ORDER[t.risk]));
  });
}

/** 保存の形（パス→Base64）から、ファイルの集まりに戻す。 */
export function decodeFiles(files: Record<string, string>): ExtensionFiles {
  return new Map(Object.entries(files).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))]));
}

/** ファイルの集まりを、保存の形（パス→Base64）にする。 */
export function encodeFiles(files: ExtensionFiles): Record<string, string> {
  return Object.fromEntries([...files.entries()].map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
}
