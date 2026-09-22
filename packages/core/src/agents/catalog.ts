/**
 * @file 業務エージェントの目録。公式の業務エージェントと、読み込んだ拡張機能の業務エージェントをまとめて引く。
 *
 * 会社ごとに使える業務エージェントは「公式」と「その会社が導入した拡張機能」である。
 *
 * @see 仕様書 第12.9.3節 会社への導入
 */

import type { AgentDefinition } from '@m2office/shared';
import type { ExtensionPackage } from '../extensions/loader.js';
import { OFFICIAL_AGENTS } from './index.js';

export class AgentCatalog {
  private readonly byExtension = new Map<string, ExtensionPackage>();

  constructor(
    private readonly official: AgentDefinition[] = OFFICIAL_AGENTS,
    extensions: ExtensionPackage[] = [],
  ) {
    for (const pkg of extensions) this.byExtension.set(pkg.manifest.id, pkg);
  }

  /** 読み込んだ拡張機能の一覧。 */
  extensions(): ExtensionPackage[] {
    return [...this.byExtension.values()];
  }

  /** すべての業務エージェント（どの会社でも使えるとは限らない）。 */
  all(): AgentDefinition[] {
    return [...this.official, ...this.extensions().flatMap((p) => p.agents)];
  }

  /**
   * ID と版で業務エージェントを引く。
   *
   * @remarks 会社で使えるかどうかは確かめない。確かめるには {@link forTenant} を使う。
   */
  resolve(agentId: string, version: number): AgentDefinition | undefined {
    return this.all().find((a) => a.id === agentId && a.version === version);
  }

  /** 業務エージェントがどの拡張機能のものか。公式なら `null`。 */
  extensionOf(agentId: string): ExtensionPackage | null {
    const extId = agentId.includes(':') ? agentId.slice(0, agentId.indexOf(':')) : null;
    return extId ? this.byExtension.get(extId) ?? null : null;
  }

  /**
   * その会社で使える業務エージェント（公式と、導入した拡張機能）。
   *
   * @param installed その会社が導入した拡張機能の ID
   */
  forTenant(installed: readonly string[]): AgentDefinition[] {
    const set = new Set(installed);
    return [
      ...this.official,
      ...this.extensions().filter((p) => set.has(p.manifest.id)).flatMap((p) => p.agents),
    ];
  }

  /** その会社で使えるか。公式は常に使える。 */
  availableFor(agentId: string, installed: readonly string[]): boolean {
    const ext = this.extensionOf(agentId);
    return ext === null ? this.official.some((a) => a.id === agentId) : installed.includes(ext.manifest.id);
  }
}
