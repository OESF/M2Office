/**
 * @file グループと利用範囲の画面部品。グループの管理と、業務・拡張機能ごとの「利用できる人」の編集。
 *
 * 利用範囲は「全員」か「指定したグループと人」のどちらか。指定のときは、グループのいずれかに所属する人と、
 * 個別に選んだ人が使える（「開発部門プラス誰か」）。
 *
 * @see 仕様書 第16.7節 グループと利用範囲
 * @see 仕様書 第16.3節 権限区画
 */

import { useEffect, useState } from 'react';
import { api, describeError, type AccessOptions, type CompartmentView, type GroupView, type ScopeValue } from './api.js';

/** 利用範囲の画面の選択肢（グループ・利用者・現在の範囲）を読む。 */
export function useAccessOptions() {
  const [options, setOptions] = useState<AccessOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => api.admin.access().then(setOptions).catch((e) => setError(describeError(e, '読み込めませんでした')));
  useEffect(() => { void reload(); }, []);
  return { options, error, reload };
}

/** 範囲を短く言い表す（例: 「開発・マーケティング、ほか 2 人」）。第16.7.7節。 */
export function scopeSummary(scope: ScopeValue | undefined, options: Pick<AccessOptions, 'groups' | 'users'>): string {
  if (!scope || scope === 'all') return '全員';
  const groups = scope.groups.map((g) => options.groups.find((x) => x.id === g)?.name ?? '（削除されたグループ）');
  const users = scope.users.map((u) => options.users.find((x) => x.id === u)?.displayName ?? '（利用者）');
  if (groups.length === 0 && users.length === 0) return '誰も使えません';
  const head = groups.join('・');
  if (!head) return users.length <= 2 ? users.join('・') : `${users.slice(0, 2).join('・')}、ほか ${users.length - 2} 人`;
  return users.length === 0 ? head : users.length <= 2 ? `${head}、${users.join('・')}` : `${head}、ほか ${users.length} 人`;
}

/**
 * 利用範囲の編集。全員／指定を選び、指定ならグループと人を選ぶ。
 *
 * @param allowAll `false` なら「全員」を出さない（権限区画は全員を持たない。第16.3.2節）
 */
export function ScopeEditor({ value, onChange, options, allowAll = true }: {
  value: ScopeValue; onChange: (v: ScopeValue) => void; options: Pick<AccessOptions, 'groups' | 'users'>;
  allowAll?: boolean;
}) {
  const picked = value === 'all' ? { groups: [], users: [] } : value;
  const toggle = (kind: 'groups' | 'users', id: string) => {
    const list = picked[kind].includes(id) ? picked[kind].filter((x) => x !== id) : [...picked[kind], id];
    onChange({ ...picked, [kind]: list });
  };
  return (
    <div className="scope-editor">
      {allowAll && (
        <>
          <label className="check">
            <input type="radio" checked={value === 'all'} onChange={() => onChange('all')} /> 全員
          </label>
          <label className="check">
            <input type="radio" checked={value !== 'all'} onChange={() => onChange(picked)} /> 指定したグループと人だけ
          </label>
        </>
      )}
      {value !== 'all' && (
        <div className="scope-pick">
          <div>
            <div className="small muted">グループ（所属する人が使えます）</div>
            {options.groups.length === 0 && <p className="small muted">グループがありません。「ユーザーと権限」で作れます。</p>}
            {options.groups.map((g) => (
              <label key={g.id} className="check">
                <input type="checkbox" checked={picked.groups.includes(g.id)} onChange={() => toggle('groups', g.id)} />
                {g.name}<span className="muted small">（{g.memberCount} 人）</span>
              </label>
            ))}
          </div>
          <div>
            <div className="small muted">個別に加える人</div>
            {options.users.map((u) => (
              <label key={u.id} className="check">
                <input type="checkbox" checked={picked.users.includes(u.id)} onChange={() => toggle('users', u.id)} />
                {u.displayName}
              </label>
            ))}
          </div>
          {allowAll && picked.groups.length === 0 && picked.users.length === 0 && (
            <p className="warn-msg small">グループか人を 1 つ以上選んでください。</p>
          )}
        </div>
      )}
    </div>
  );
}

/** 1 つの対象の範囲を示し、「変更」で編集して保存する。 */
export function ScopeField({ target, options, onSaved }: {
  target: string; options: AccessOptions; onSaved: () => void;
}) {
  const current: ScopeValue = options.scopes[target] ?? 'all';
  const [editing, setEditing] = useState<ScopeValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!editing) {
    return (
      <span>
        {scopeSummary(current, options)}{' '}
        <button className="link small" onClick={() => { setEditing(current); setError(null); }}>変更</button>
      </span>
    );
  }
  const save = async () => {
    setBusy(true);
    try {
      await api.admin.setScope(target, editing);
      setEditing(null);
      onSaved();
    } catch (e) {
      setError(describeError(e, '保存できませんでした'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <ScopeEditor value={editing} onChange={setEditing} options={options} />
      <div className="row">
        <button className="btn small" disabled={busy} onClick={() => void save()}>保存</button>
        <button className="btn small ghost" onClick={() => setEditing(null)}>やめる</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** グループの管理（管理者ページ「ユーザーと権限」）。作成・名前の変更・所属・削除。 */
export function GroupSettings({ users, onChanged }: {
  users: { id: string; displayName: string; status: string }[]; onChanged?: () => void;
}) {
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [name, setName] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api.admin.groups().then((r) => setGroups(r.items));
  useEffect(() => { void load(); }, []);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: done });
      await load();
      onChanged?.();
    } catch (e) {
      setMsg({ ok: false, text: describeError(e, '保存できませんでした') });
    }
  };
  const toggleMember = (g: GroupView, userId: string) => {
    const ids = g.memberIds.includes(userId) ? g.memberIds.filter((x) => x !== userId) : [...g.memberIds, userId];
    void act(() => api.admin.setGroupMembers(g.id, ids), `「${g.name}」の所属を保存しました`);
  };
  const nameOf = (id: string) => users.find((u) => u.id === id)?.displayName ?? '（利用者）';

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>グループ</h3>
      <p className="small">
        管理職・マーケティング・開発など、利用者をグループにまとめます。業務ごとに「利用できる人」をグループで指定できます
        （「業務と承認」「拡張機能」の画面）。1 人が複数のグループに入れます。
      </p>
      {groups.length === 0 && <p className="muted small">まだありません。</p>}
      <table className="table">
        <tbody>
          {groups.map((g) => (
            <tr key={g.id}>
              <td>
                <strong>{g.name}</strong> <span className="muted small">{g.memberIds.length} 人</span>
                <div className="small muted">{g.memberIds.map(nameOf).join('・') || '所属する人はいません'}</div>
                {g.usedBy && (g.usedBy.compartments.length > 0 || g.usedBy.agents.length > 0) && (
                  <div className="small">
                    割り当て先:{' '}
                    {g.usedBy.compartments.map((c) => <span key={c} className="badge warn">区画「{c}」</span>)}{' '}
                    {g.usedBy.agents.map((a) => <span key={a} className="badge">{a}</span>)}
                  </div>
                )}
                {open === g.id && g.usedBy && g.usedBy.compartments.length > 0 && (
                  <p className="warn-msg small">
                    このグループは権限区画（{g.usedBy.compartments.join('、')}）に割り当てられています。
                    所属を変えると、その区画のデータを見られる人が変わります。変更は記録され、管理者全員に通知されます。
                  </p>
                )}
                {open === g.id && (
                  <div className="scope-pick">
                    {users.filter((u) => u.status === 'active').map((u) => (
                      <label key={u.id} className="check">
                        <input type="checkbox" checked={g.memberIds.includes(u.id)} onChange={() => toggleMember(g, u.id)} />
                        {u.displayName}
                      </label>
                    ))}
                  </div>
                )}
              </td>
              <td className="num">
                <button className="link small" onClick={() => setOpen(open === g.id ? null : g.id)}>
                  {open === g.id ? '閉じる' : '所属する人'}
                </button>{' '}
                <button className="link small" onClick={() => {
                  const next = prompt('新しい名前', g.name);
                  if (next && next.trim() && next !== g.name) void act(() => api.admin.updateGroup(g.id, { name: next }), '名前を変えました');
                }}>名前の変更</button>{' '}
                <button className="link small danger" onClick={() => {
                  if (!confirm(`グループ「${g.name}」を削除しますか。利用者は消えません。利用範囲からこのグループが外れます。`)) return;
                  void act(async () => {
                    const res = await api.admin.deleteGroup(g.id);
                    if (res.emptied.length > 0) {
                      throw new Error(`削除しました。ただし、次の業務は使える人がいなくなりました。範囲を設定し直してください: ${res.emptied.join('、')}`);
                    }
                  }, `「${g.name}」を削除しました`);
                }}>削除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <input value={name} placeholder="新しいグループの名前（例: 開発）" onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={!name.trim()} onClick={() => void act(async () => {
          await api.admin.createGroup(name.trim());
          setName('');
        }, `「${name.trim()}」を作りました`)}>グループを作る</button>
      </div>
      {msg && <p className={msg.ok ? 'ok-msg' : 'error'}>{msg.text}</p>}
    </div>
  );
}

/**
 * 権限区画の割当（管理者ページ「ユーザーと権限」）。区画ごとに、入れるグループと人を決める。
 *
 * @remarks 区画は「全員」を持たない。誰も割り当てなければ誰も入れない（第16.3.2節「既定は区画外」）。
 */
export function CompartmentSettings({ onChanged }: { onChanged?: () => void }) {
  const access = useAccessOptions();
  const [items, setItems] = useState<CompartmentView[]>([]);
  const [editing, setEditing] = useState<{ id: string; value: { groups: string[]; users: string[] } } | null>(null);
  const [draft, setDraft] = useState({ name: '', description: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api.admin.compartments().then((r) => setItems(r.items));
  useEffect(() => { void load(); }, []);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: done });
      await Promise.all([load(), access.reload()]);
      onChanged?.();
    } catch (e) {
      setMsg({ ok: false, text: describeError(e, '保存できませんでした') });
    }
  };
  const options = access.options;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>権限区画</h3>
      <p className="small">
        人事の給与・評価のような機微なデータを隔てる単位です。区画に入れるのは、割り当てたグループに所属する人と、個別に割り当てた人だけです。
        区画に入れる人が変わると記録され、管理者全員に通知されます。
      </p>
      {!options && <p className="muted small">読み込んでいます…</p>}
      {options && (
        <table className="table">
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>
                  <strong>{c.description ?? c.name}</strong> <span className="muted small">{c.name}</span>
                  {!c.enabled && <> <span className="badge warn">無効（誰も入れません）</span></>}
                  {editing?.id === c.id ? (
                    <>
                      <ScopeEditor
                        value={editing.value} allowAll={false} options={options}
                        onChange={(v) => setEditing({ id: c.id, value: v === 'all' ? { groups: [], users: [] } : v })}
                      />
                      <div className="row">
                        <button className="btn small" onClick={() => void act(async () => {
                          await api.admin.setCompartmentAssignment(c.id, editing.value);
                          setEditing(null);
                        }, `「${c.description ?? c.name}」の割当を保存しました`)}>保存</button>
                        <button className="btn small ghost" onClick={() => setEditing(null)}>やめる</button>
                      </div>
                    </>
                  ) : (
                    <div className="small">
                      入れる人: {c.groups.length + c.users.length === 0 ? '誰もいません' : scopeSummary(c, options)}
                    </div>
                  )}
                </td>
                <td className="num">
                  {editing?.id !== c.id && (
                    <>
                      {c.enabled && (
                        <button className="link small"
                          onClick={() => setEditing({ id: c.id, value: { groups: c.groups, users: c.users } })}>割当の変更</button>
                      )}{' '}
                      <button className="link small" title="無効にすると、その間は誰も区画に入れません（知識と業務は誰にも見えません）"
                        onClick={() => void act(
                          () => api.admin.setCompartmentEnabled(c.id, !c.enabled),
                          c.enabled
                            ? `「${c.description ?? c.name}」を無効にしました。その間は誰も入れません`
                            : `「${c.description ?? c.name}」を有効に戻しました`,
                        )}>{c.enabled ? '無効にする' : '有効に戻す'}</button>{' '}
                      <button className="link small danger" onClick={() => {
                        if (!confirm(`区画「${c.description ?? c.name}」を削除しますか。元に戻せません。`)) return;
                        void act(() => api.admin.deleteCompartment(c.id), `「${c.description ?? c.name}」を削除しました`);
                      }}>削除</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row">
        <input value={draft.name} placeholder="区画の名前（英小文字。例: legal）" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input value={draft.description} placeholder="表示名（例: 法務）" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        <button className="btn" disabled={!draft.name.trim()} onClick={() => void act(async () => {
          await api.admin.createCompartment(draft.name.trim(), draft.description.trim());
          setDraft({ name: '', description: '' });
        }, '区画を作りました')}>区画を作る</button>
      </div>
      {msg && <p className={msg.ok ? 'ok-msg' : 'error'}>{msg.text}</p>}
    </div>
  );
}
