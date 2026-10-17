/**
 * @file 管理者ページ「接続」の「データの渡し先」（仕様書 第16.11.3節 G-3、第16.5節「委託先を公開」）。
 *
 * M2Office がどこにどのデータを渡すかを、会社がいま使っているものから先に並べる。使っていないものは薄く出す（使えば渡すもの）。
 * 説明文は常に出さない（原則 u11）。分からなければ秘書に聞けばよい。
 */
import { useEffect, useState } from 'react';
import { DATA_RECIPIENT_CONTRACT_LABEL, type DataRecipient } from '@m2office/shared';
import { api, describeError } from './api.js';
import { PageTitle } from './help.js';

/** データの渡し先の一覧。 */
export function DataRecipients() {
  const [items, setItems] = useState<DataRecipient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.admin.dataRecipients().then((r) => setItems(r.items), (e) => setError(describeError(e)));
  }, []);
  const sorted = items ? [...items.filter((x) => x.active), ...items.filter((x) => !x.active)] : [];
  return (
    <>
      <PageTitle trail={['接続', 'データの渡し先']} help={{ article: 'admin-data-recipients', text: 'M2Office が業務のためにデータを渡す先です。薄い行は、その機能を使えば渡す先です。' }} />
      {error && <p className="error">{error}</p>}
      {!items && !error && <p className="muted">読み込み中…</p>}
      {items && (
        <div className="card">
          <table className="table">
            <thead>
              <tr><th>渡し先</th><th>使い道</th><th>渡すもの</th><th>場所</th><th>契約</th></tr>
            </thead>
            <tbody>
              {sorted.map((x) => (
                <tr key={x.id} className={x.active ? undefined : 'muted'}>
                  <td>{x.name}{!x.active && <><br /><span className="badge">使っていない</span></>}</td>
                  <td>{x.purpose}</td>
                  <td>{x.data}</td>
                  <td>{x.location}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{DATA_RECIPIENT_CONTRACT_LABEL[x.contract]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
