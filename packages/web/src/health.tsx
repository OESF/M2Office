/**
 * @file 接続先の状態の一覧（仕様書 第6.7.6節）。ダッシュボードの「接続先」と、管理者ページの「接続」の健全性（第6.6.2節）が使う。
 */

import type { ConnectionHealth } from './api.js';

/** 接続先の状態の言葉（仕様書 第6.7.6節）。 */
const HEALTH_LABEL: Record<ConnectionHealth['state'], string> = { ok: '正常', slow: '遅延', fail: '失敗', off: '未接続' };

/** 接続先の区分の見出し。 */
const HEALTH_GROUP: Record<ConnectionHealth['group'], string> = { ai: 'AI', google: 'Google', mcp: '会社の接続' };

/**
 * 接続先（仕様書 第6.7.6節）。AI・Google の各サービス・会社の接続を、直近 15 分の状態で並べる。
 *
 * @remarks 呼び出しが続いている接続は、線が流れる表示にする。数は回数・平均の時間・失敗の数だけ（中身は持っていない）
 */
export function HealthList({ items }: { items: ConnectionHealth[] }) {
  if (items.length === 0) return null;
  const groups = (['ai', 'google', 'mcp'] as const).map((g) => ({ g, list: items.filter((x) => x.group === g) })).filter((x) => x.list.length > 0);
  return (
    <section className="card">
      <h3>接続先 <span className="muted small">（直近 15 分）</span></h3>
      <div className="health-groups">
        {groups.map(({ g, list }) => (
          <div key={g} className="health-group">
            <div className="muted small">{HEALTH_GROUP[g]}</div>
            <ul className="health-list">
              {list.map((x) => (
                <li key={x.target} className={`health-item is-${x.state}`} title={healthTitle(x)}>
                  <span className={`health-line${x.active && x.state !== 'off' ? ' active' : ''}`} aria-hidden="true" />
                  <span className="health-name">{x.name}</span>
                  <span className="health-state">{HEALTH_LABEL[x.state]}</span>
                  <span className="muted small health-note">{healthNote(x)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 状態に添える短い言葉。 */
function healthNote(x: ConnectionHealth): string {
  if (x.state === 'off') return '';
  if (x.calls === 0) return '直近の呼び出しなし';
  const avg = x.avgMs === null ? '' : x.avgMs < 1000 ? `${x.avgMs} ms` : `${(x.avgMs / 1000).toFixed(1)} 秒`;
  return [`${x.calls} 回`, avg, x.fails > 0 ? `失敗 ${x.fails}${x.lastError ? `（${x.lastError}）` : ''}` : ''].filter(Boolean).join('・');
}

/** マウスを重ねたときの説明（読み上げにも使う）。 */
function healthTitle(x: ConnectionHealth): string {
  const note = healthNote(x);
  return `${x.name}: ${HEALTH_LABEL[x.state]}${note ? `（${note}）` : ''}${x.active && x.state !== 'off' ? '・呼び出し中' : ''}`;
}
