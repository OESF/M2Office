/**
 * @file 業務システムへの接続口を、設定（`mock` / `google`）に応じて組み立てる。
 *
 * @see ADR-0003 外部接続の手前に接続口を設ける
 * @see ADR-0022 Google の接続口は Gmail とカレンダーから
 */

import type { Repository } from '../repository/types.js';
import type { SecretBox } from '../secrets/box.js';
import type { ConnectorPrincipal, DataSource, WorkspaceConnector } from './types.js';
import { MockWorkspaceConnector } from './mock.js';
import { GoogleWorkspaceConnector } from './google/index.js';

/**
 * 会社ごとに、見本と本物のどちらかへ振り分ける接続口（ADR-0022。**開発だけ**）。
 *
 * @remarks
 * 通しの確認（`npm run smoke`）の会社は決まった見本のデータを前提にしている。
 * 実在の会社を本物につなぎながら、その会社を見本のまま保つために使う。
 * どの操作も、呼び出しの `tenantId` で振り分ける。会社をまたいで混ざることはない（不変則 I-2）。
 */
export class TenantRoutingConnector implements WorkspaceConnector {
  constructor(
    private readonly mockTenants: ReadonlySet<string>,
    private readonly mock: WorkspaceConnector,
    private readonly real: WorkspaceConnector,
  ) {}

  sourceFor(tenantId: string): DataSource {
    return this.mockTenants.has(tenantId) ? 'mock' : this.real.sourceFor(tenantId);
  }

  private pick(tenantId: string): WorkspaceConnector {
    return this.mockTenants.has(tenantId) ? this.mock : this.real;
  }

  // 各サービスの各操作を、第 1 引数（誰の権限か）の会社で振り分ける
  mail = this.route('mail');
  calendar = this.route('calendar');
  tasks = this.route('tasks');
  chat = this.route('chat');
  slides = this.route('slides');
  drive = this.route('drive');
  docs = this.route('docs');
  sheets = this.route('sheets');
  directory = this.route('directory');
  meet = this.route('meet');
  forms = this.route('forms');

  private route<K extends Exclude<keyof WorkspaceConnector, 'sourceFor'>>(service: K): WorkspaceConnector[K] {
    return new Proxy({}, {
      get: (_t, op: string) => (p: { tenantId: string }, ...rest: unknown[]) => {
        const target = this.pick(p.tenantId)[service] as unknown as Record<string, (...a: unknown[]) => unknown>;
        return target[op]!(p, ...rest);
      },
    }) as WorkspaceConnector[K];
  }
}

/** 接続口を組み立てるのに要るもの。`google` のときだけ使う。 */
export interface ConnectorDeps {
  repo: Repository;
  box: SecretBox;
  /** 見本の接続口を使う会社のテナント ID（`CONNECTOR_MOCK_TENANTS`。開発だけ）。 */
  mockTenants?: string[];
  /** `NODE_ENV=production` か。見本の会社を指定していたら起動を拒否する。 */
  production?: boolean;
  /**
   * Google の側で許可が外されたと分かったとき（トークンの取り直しの失敗）に呼ぶ後始末（仕様書 第6.5.2.1節 経路 2・3）。
   *
   * @remarks 後始末の役（`GoogleRevocation`）は接続口より後に組み立てるため、呼ぶ側で後から結び付けられる形で渡す
   */
  onRevoked?: (p: ConnectorPrincipal, refreshTokenEnc: string) => Promise<void>;
}

/**
 * 設定に応じて接続口を組み立てる。
 *
 * @param mode `mock` または `google`
 * @param deps `google` のときに要るもの
 * @returns 接続口
 * @throws {Error} 値が不正なとき。`google` に要るものが無いとき。本番で見本の会社を指定したとき
 *
 * @remarks
 * `google` のとき、まだ本物にしていないサービスは「準備中」と断る（ADR-0022）。
 * 黙って見本に切り替えない（ADR-0003）。
 */
export function buildConnector(mode: string, deps?: ConnectorDeps): WorkspaceConnector {
  switch (mode) {
    case 'mock':
      return new MockWorkspaceConnector();
    case 'google': {
      if (!deps) throw new Error('CONNECTOR_MODE=google には、データベースと暗号の箱が要ります');
      const real = new GoogleWorkspaceConnector(deps.repo, deps.box, undefined, undefined, deps.onRevoked);
      const mockTenants = (deps.mockTenants ?? []).map((t) => t.trim()).filter(Boolean);
      if (mockTenants.length === 0) return real;
      if (deps.production) {
        throw new Error('CONNECTOR_MOCK_TENANTS は開発だけの設定です。本番（NODE_ENV=production）では使えません');
      }
      return new TenantRoutingConnector(new Set(mockTenants), new MockWorkspaceConnector(), real);
    }
    default:
      throw new Error(`CONNECTOR_MODE の値が不正です: ${mode}（mock か google）`);
  }
}

export type * from './types.js';
export { ConnectorUnavailableError } from './types.js';
export { MockWorkspaceConnector, ymd, jst, addDays } from './mock.js';
export { GoogleWorkspaceConnector } from './google/index.js';
export { GOOGLE_API_ENDPOINTS, GoogleTokenSource, type GoogleApiEndpoints } from './google/http.js';
