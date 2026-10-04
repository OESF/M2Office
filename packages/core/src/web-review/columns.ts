/**
 * @file Web の振り返りとコラムの作成のつなぎ（仕様書 第34.8節・第34.19節）。WordPress で公開されたコラムの URL を知る。
 *
 * コラムの作成は、承認の後に WordPress へ下書きとして入れる（公開は WordPress の側で行う）。そのため、公開されたかと URL は、
 * 見回りのときに WordPress に問い合わせて知り、`web_columns.web_url` に残す。コラムの作成を使っていない会社では何もしない。
 */

import type { Repository } from '../repository/types.js';
import type { SecretBox } from '../secrets/box.js';
import type { ColumnStore } from '../columns/store.js';
import { getWordPressPost } from '../columns/wordpress.js';

/** Web の振り返りから見たコラム。 */
export interface WebReviewColumns {
  /** WordPress で公開されたコラム（URL がまだ分からないものは WordPress に問い合わせる） */
  published(tenantId: string): Promise<{ id: string; title: string; url: string }[]>;
  /** コラムの形（入れた版の本文の字数と、`##` の見出しの数。書き方の傾向に使う。第32.18.5節） */
  shape?(tenantId: string, columnId: string): Promise<{ chars: number; headings: number } | null>;
}

/**
 * コラムの作成の置き場と WordPress の鍵から、つなぎの口を作る。
 */
export function webReviewColumnsFrom(deps: { store: ColumnStore; repo: Repository; box: SecretBox }): WebReviewColumns {
  return {
    async published(tenantId) {
      const settings = await deps.repo.getTenantSettings(tenantId);
      if (!settings.webColumns.enabled) return [];
      const placed = await deps.store.placed(tenantId);
      const wp = settings.webColumns.wordpress;
      const cred = wp ? await deps.repo.getTenantCredential(tenantId, 'wordpress').catch(() => null) : null;
      let auth: { siteUrl: string; username: string; password: string } | null = null;
      try {
        auth = wp && cred?.secretEnc ? { siteUrl: wp.siteUrl, username: wp.username, password: deps.box.decrypt(cred.secretEnc) } : null;
      } catch {
        auth = null;
      }
      const out: { id: string; title: string; url: string }[] = [];
      for (const c of placed) {
        if (c.webUrl) { out.push({ id: c.id, title: c.title, url: c.webUrl }); continue; }
        if (!auth || !c.wpPostId) continue;
        const post = await getWordPressPost(auth, c.wpPostId);
        // 公開されたものだけ（下書き・予約の記事の URL は、まだ読まれない）
        if (post?.status === 'publish' && /^https?:\/\//.test(post.link)) {
          await deps.store.update(tenantId, c.id, { webUrl: post.link });
          out.push({ id: c.id, title: c.title, url: post.link });
        }
      }
      return out;
    },
    async shape(tenantId, columnId) {
      const c = await deps.store.get(tenantId, columnId);
      if (!c) return null;
      const v = (await deps.store.versions(tenantId, columnId)).find((x) => x.version === (c.submittedVersion ?? c.currentVersion));
      if (!v) return null;
      return { chars: v.body.replace(/\s/g, '').length, headings: v.body.split('\n').filter((l) => /^##\s/.test(l)).length };
    },
  };
}
