/**
 * @file 管理者のセットアップウィザード（仕様書 第6.10.3節、ADR-0130）。
 *
 * 新しい会社の管理者がログインしたとき、ウィザードを終えるまで、ワークスペースと管理者ページの代わりに全画面で出す。
 * 段ごとに、その場で入力させる（別の画面へ移さない）。済みの判定はチェックリストと同じもの（`/v1/onboarding/wizard`）を使う。
 * 支払いの方法はお金に関わるので、管理者が自分で選ぶ（ADR-0028）。カードの登録と Google の接続で外へ移っても、`/setup` に戻る。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { inviteEffect, type BillingView, type ContractTerm, type TenantSettings } from '@m2office/shared';
import { api, describeError, type ChecklistItem, type ConnectionSettings, type ExtensionView, type Me, type MyGoogle } from './api.js';
import { copyText } from './clipboard.js';

/** 段の名前（チェックリストの項目の ID と同じ。拡張機能と終わりの段は、ウィザードだけの段）。 */
type StepId = 'company' | 'ai' | 'google' | 'agents' | 'extensions' | 'knowledge' | 'users' | 'notify' | 'finish';

const STEP_LABEL: Record<StepId, string> = {
  company: '会社情報', ai: 'Gemini の鍵', google: 'Google Workspace', agents: '使う業務', extensions: '拡張機能',
  knowledge: '規程', users: '同僚の招待', notify: '従業員へ知らせる', finish: '使い始める',
};

/** 「中断」を押したタブでは出さない（次のログイン＝新しいタブで、また出す）。 */
const LATER_KEY = 'm2office.setup-later';

/** このタブで「中断」を押したか。 */
export function setupLater(): boolean {
  try { return sessionStorage.getItem(LATER_KEY) === '1'; } catch { return false; }
}

/** ヘルプの記事を新しいタブで開く URL（ウィザードはヘルプの URL では出さない）。 */
const helpUrl = (id: string) => `/admin/help/${encodeURIComponent(id)}`;

/** 段の下に置く、ヘルプへの 1 行のリンク。 */
function HelpLink({ id, children }: { id: string; children: string }) {
  return <a className="small" href={helpUrl(id)} target="_blank" rel="noopener">{children}</a>;
}

/**
 * セットアップウィザード。
 *
 * @param onLater 「中断」を押したとき（呼ぶ側が、いつもの画面に戻す）
 * @param onLogout 「ログアウト」を押したとき。全画面で出るので、別のアカウントで入り直すための出口をここに置く
 */
export function SetupWizard({ me, onLater, onLogout }: { me: Me; onLater: () => void; onLogout: () => void }) {
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [step, setStep] = useState<StepId | null>(null);
  const [error, setError] = useState<string | null>(null);
  // この画面で招待したか（「従業員へ知らせる」の段を出すかに使う）
  const [invited, setInvited] = useState(false);
  // 「拡張機能」の段を一度保存したか（チェックリストには無い、ウィザードだけの段）
  const [extDone, setExtDone] = useState(false);
  // Google から戻ったときの結果（`?google=`）。最初に読んで URL から消す
  const googleResult = useRef<string | null>(null);

  const load = useCallback(async (): Promise<{ items: ChecklistItem[]; extensionsReviewed: boolean } | null> => {
    try {
      const r = await api.onboarding.wizard();
      setItems(r.items);
      setExtDone(r.extensionsReviewed);
      return r;
    } catch (e) {
      setError(describeError(e, '読み込めませんでした'));
      return null;
    }
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    googleResult.current = q.get('google');
    history.replaceState(null, '', '/setup');
    void load().then((got) => {
      if (!got) return;
      if (googleResult.current) { setStep('google'); return; }
      // 開いたときは、まだ済んでいない最初の段から（会社情報はスキップできないので、空なら必ずそこから）
      const order = stepsOf(got.items, false);
      // 拡張機能の段はチェックリストに無いので、済みは別の値で見る
      const done = (s: StepId) => (s === 'extensions' ? got.extensionsReviewed : got.items.find((i) => i.id === s)?.done);
      setStep(order.find((s) => s !== 'finish' && !done(s)) ?? 'finish');
    });
  }, [load]);

  if (!items || !step) return <div className="wizard"><p className={error ? 'error' : 'muted'}>{error ?? '読み込み中…'}</p></div>;
  const steps = stepsOf(items, invited);
  const index = Math.max(0, steps.indexOf(step));
  const doneOf = (s: StepId) => (s === 'extensions' ? extDone : items.find((i) => i.id === s)?.done ?? false);
  const go = (to: number) => { setError(null); setStep(steps[Math.min(Math.max(0, to), steps.length - 1)]!); window.scrollTo(0, 0); };
  const next = () => go(index + 1);
  const later = () => {
    try { sessionStorage.setItem(LATER_KEY, '1'); } catch { /* 覚えられなくても、閉じることはできる */ }
    history.replaceState(null, '', '/');
    onLater();
  };
  const refresh = async () => { await load(); };

  return (
    <div className="wizard">
      <div className="wizard-card card">
        <header className="wizard-head">
          <div className="wizard-title">
            <h1>はじめに行う設定</h1>
            <button type="button" className="btn ghost small" onClick={onLogout}>ログアウト</button>
          </div>
          <ol className="wizard-steps" aria-label="段の並び">
            {steps.map((s, i) => (
              <li key={s} className={`${i === index ? 'current' : ''}${s !== 'finish' && doneOf(s) ? ' done' : ''}`}>
                <button type="button" onClick={() => go(i)} aria-current={i === index ? 'step' : undefined}>
                  <span className="wizard-step-no">{s !== 'finish' && doneOf(s) ? '✓' : i + 1}</span>
                  <span className="wizard-step-label">{STEP_LABEL[s]}</span>
                </button>
              </li>
            ))}
          </ol>
        </header>

        <section className="wizard-body">
          <h2>{STEP_LABEL[step]}</h2>
          {step === 'company' && <CompanyStep me={me} onSaved={async () => { await refresh(); next(); }} />}
          {step === 'ai' && <AiStep done={doneOf('ai')} onChanged={refresh} />}
          {step === 'google' && <GoogleStep result={googleResult.current} onChanged={refresh} />}
          {step === 'agents' && <AgentsStep onSaved={async () => { await refresh(); next(); }} />}
          {step === 'extensions' && <ExtensionsStep reviewed={extDone} onSaved={async () => { await refresh(); next(); }} />}
          {step === 'knowledge' && <KnowledgeStep done={doneOf('knowledge')} onChanged={refresh} />}
          {step === 'users' && <UsersStep me={me} onInvited={async () => { setInvited(true); await refresh(); }} />}
          {step === 'notify' && <NotifyStep done={doneOf('notify')} onChanged={refresh} />}
          {step === 'finish' && <FinishStep items={items} />}
          {error && <p className="error">{error}</p>}
        </section>

        <footer className="wizard-foot">
          <button type="button" className="btn ghost" disabled={index === 0} onClick={() => go(index - 1)}>戻る</button>
          <button type="button" className="btn ghost" onClick={later}>中断</button>
          <span className="wizard-foot-gap" />
          {/* 会社情報・使う業務・拡張機能は、段の中の保存で進む */}
          {step !== 'company' && step !== 'agents' && step !== 'extensions' && step !== 'finish' && (
            <button type="button" className={doneOf(step) || (step === 'users' && invited) ? 'btn' : 'btn ghost'} onClick={next}>
              {doneOf(step) || (step === 'users' && invited) ? '次へ' : step === 'users' ? 'しばらく 1 人で使う' : 'スキップ'}
            </button>
          )}
          {(step === 'agents' || step === 'extensions') && <button type="button" className="btn ghost" onClick={next}>スキップ</button>}
          {step === 'finish' && (
            <button type="button" className="btn" onClick={() => void api.onboarding.wizardDone()
              .then(() => { location.href = '/'; })
              .catch((e) => setError(describeError(e, '記録できませんでした')))}>使い始める</button>
          )}
        </footer>
      </div>
    </div>
  );
}

/** 段の並び。Gemini の鍵はチェックリストに出る会社だけ。従業員へ知らせるのは、招待したときだけ。 */
function stepsOf(items: ChecklistItem[], invited: boolean): StepId[] {
  const has = (id: string) => items.some((i) => i.id === id);
  const usersDone = items.find((i) => i.id === 'users')?.done ?? false;
  return [
    'company',
    ...(has('ai') ? ['ai' as const] : []),
    'google', 'agents', 'extensions', 'knowledge', 'users',
    ...(invited || usersDone ? ['notify' as const] : []),
    'finish',
  ];
}

/** 段 1: 会社情報。正式な会社名は申し込みのときの名前を先に入れておく（人に一から打たせない）。 */
function CompanyStep({ me, onSaved }: { me: Me; onSaved: () => Promise<void> }) {
  const [company, setCompany] = useState<TenantSettings['company'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.admin.settings()
      .then((s) => setCompany({ ...s.company, legalName: s.company.legalName || me.tenant.name }))
      .catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, [me.tenant.name]);
  if (!company) return <p className={error ? 'error' : 'muted'}>{error ?? '読み込み中…'}</p>;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.admin.saveSettings('company', { ...company, legalName: company.legalName.trim(), shortName: company.shortName.trim() });
      await onSaved();
    } catch (e) {
      setError(describeError(e, '保存できませんでした'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="field">
        <label htmlFor="wizard-legal">正式な会社名</label>
        <input id="wizard-legal" value={company.legalName} maxLength={200} onChange={(e) => setCompany({ ...company, legalName: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="wizard-short">略称</label>
        <input id="wizard-short" value={company.shortName} maxLength={60} onChange={(e) => setCompany({ ...company, shortName: e.target.value })} />
      </div>
      <button className="btn" disabled={busy || !company.legalName.trim()}>{busy ? '保存しています…' : '保存して次へ'}</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

/** 段 2: Gemini の鍵。入れたら、その場でつながるかを確かめる。 */
function AiStep({ done, onChanged }: { done: boolean; onChanged: () => Promise<void> }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    setBusy(true);
    setResult(null);
    try {
      await api.admin.saveGemini({ mode: 'byok', apiKey: key.trim() });
      const t = await api.admin.testGemini('text');
      setResult(t.ok ? { ok: true, text: 'つながりました' } : { ok: false, text: `つながりませんでした: ${t.error ?? '理由が分かりません'}` });
      setKey('');
      await onChanged();
    } catch (e) {
      setResult({ ok: false, text: describeError(e, '保存できませんでした') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {done && !result && <p className="ok-msg small">会社の鍵が入っています</p>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <input className="wizard-grow" type="password" autoComplete="off" aria-label="Gemini の API キー" placeholder="Gemini の API キー"
          value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn" disabled={busy || !key.trim()}>{busy ? '確かめています…' : done ? '入れ直す' : '入れる'}</button>
      </form>
      {result && <p className={result.ok ? 'ok-msg small' : 'error'}>{result.text}</p>}
      {!done && <p className="muted small">鍵を入れるまで、AI は動きません。</p>}
      <HelpLink id="admin-gemini-key">鍵の取り方</HelpLink>
    </>
  );
}

/** 段 3: Google Workspace。会社の OAuth クライアントが無ければ登録し、あれば自分の Google を接続する。 */
function GoogleStep({ result, onChanged }: { result: string | null; onChanged: () => Promise<void> }) {
  const [conn, setConn] = useState<ConnectionSettings['google'] | null>(null);
  const [mine, setMine] = useState<MyGoogle | null>(null);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    result === 'ok' ? { ok: true, text: 'Google と接続しました' }
      : result === 'cancelled' ? { ok: false, text: '接続を取りやめました' }
      : result ? { ok: false, text: 'Google と接続できませんでした。もう一度お試しください' } : null,
  );
  const load = useCallback(() => Promise.all([api.admin.connections(), api.myGoogle()])
    .then(([c, m]) => { setConn(c.google); setMine(m); setClientId((v) => v || c.google.clientId); })
    .catch((e) => setMessage({ ok: false, text: describeError(e, '読み込めませんでした') })), []);
  useEffect(() => { void load(); }, [load]);
  if (!conn || !mine) return <p className="muted">読み込み中…</p>;

  if (conn.workspaceSource === 'mock') return <p className="muted">いまは準備中のため、見本のデータで動いています。</p>;
  const clientReady = !!conn.clientId && conn.secretRegistered;
  const saveClient = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.admin.saveGoogleClient({ clientId: clientId.trim(), clientSecret: secret.trim() || undefined });
      setMessage({ ok: r.verdict === 'ok', text: r.message });
      setSecret('');
      await load();
      await onChanged();
    } catch (e) {
      setMessage({ ok: false, text: describeError(e, '保存できませんでした') });
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    setBusy(true);
    try {
      location.href = (await api.connectGoogle({ back: '/setup' })).url;
    } catch (e) {
      setMessage({ ok: false, text: describeError(e, '接続を始められませんでした') });
      setBusy(false);
    }
  };
  return (
    <>
      {!clientReady && (
        <form onSubmit={(e) => { e.preventDefault(); void saveClient(); }}>
          <div className="field">
            <label>戻り先の URL（Google Cloud の OAuth クライアントに登録します）</label>
            <div className="row">
              <code className="wizard-grow wizard-code">{conn.redirectUri}</code>
              <button type="button" className="btn ghost small" onClick={() => void copyText(conn.redirectUri)}>コピー</button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="wizard-client-id">クライアント ID</label>
            <input id="wizard-client-id" value={clientId} autoComplete="off" onChange={(e) => setClientId(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="wizard-client-secret">クライアント シークレット</label>
            <input id="wizard-client-secret" type="password" value={secret} autoComplete="off" onChange={(e) => setSecret(e.target.value)} />
          </div>
          <button className="btn" disabled={busy || !clientId.trim() || (!conn.secretRegistered && !secret.trim())}>{busy ? '確かめています…' : '登録する'}</button>
        </form>
      )}
      {clientReady && (mine.connected
        ? <p className="ok-msg small">{mine.googleEmail ?? 'Google'} で接続しています</p>
        : <button type="button" className="btn" disabled={busy} onClick={() => void connect()}>Google と接続する</button>)}
      {message && <p className={message.ok ? 'ok-msg small' : 'error'}>{message.text}</p>}
      <HelpLink id="admin-google-setup">Google 側の設定の手順</HelpLink>
    </>
  );
}

/** 段 4: 使う業務。すべて選んだ状態から外す。保存すると「業務と承認」を一度保存したことになる。 */
function AgentsStep({ onSaved }: { onSaved: () => Promise<void> }) {
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof api.admin.settings>> | null>(null);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.admin.settings().then((s) => { setSettings(s); setDisabled(new Set(s.agents.disabled)); })
      .catch((e) => setError(describeError(e, '読み込めませんでした')));
  }, []);
  if (!settings) return <p className={error ? 'error' : 'muted'}>{error ?? '読み込み中…'}</p>;
  const toggle = (id: string, on: boolean) => setDisabled((d) => { const n = new Set(d); if (on) n.delete(id); else n.add(id); return n; });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.admin.saveSettings('agents', { ...settings.agents, disabled: [...disabled] });
      await onSaved();
    } catch (e) {
      setError(describeError(e, '保存できませんでした'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ul className="wizard-agents">
        {settings.catalog.map((a) => (
          <li key={a.id}>
            <label className="wizard-agent">
              <input type="checkbox" checked={!disabled.has(a.id)} onChange={(e) => toggle(a.id, e.target.checked)} />
              <span><strong>{a.name}</strong><span className="muted small">{a.description}</span></span>
            </label>
          </li>
        ))}
      </ul>
      <button type="button" className="btn" disabled={busy} onClick={() => void save()}>{busy ? '保存しています…' : '保存して次へ'}</button>
      {error && <p className="error">{error}</p>}
    </>
  );
}

/**
 * 段 4.1: 拡張機能。内蔵の拡張を並べ、使うものに印を付ける（仕様書 第6.10.3節。第 0.537.0 版）。
 * まだ一度も保存していなければ、すべて選ばない状態から始める（三浦さんが決めた）。保存すると、印の無いものは切る（データは消えない）。
 * 配布元の拡張機能は権限への同意が要るので、ここに出さない（管理者ページの「拡張機能」で入れる）。
 */
function ExtensionsStep({ reviewed, onSaved }: { reviewed: boolean; onSaved: () => Promise<void> }) {
  const [list, setList] = useState<ExtensionView[] | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.admin.extensions().then((r) => {
      const builtin = r.items.filter((x) => x.origin === 'builtin' && x.installed);
      setList(builtin);
      setOn(new Set(reviewed ? builtin.filter((x) => x.enabled).map((x) => x.id) : []));
    }).catch((e) => setError(describeError(e, '読み込めませんでした')));
    // 開いたときの状態だけを使う（保存の後に印を出し直さない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!list) return <p className={error ? 'error' : 'muted'}>{error ?? '読み込み中…'}</p>;
  const toggle = (id: string, v: boolean) => setOn((d) => { const n = new Set(d); if (v) n.add(id); else n.delete(id); return n; });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const x of list) {
        const want = on.has(x.id);
        if (want !== x.enabled) await api.admin.setExtensionEnabled(x.id, want);
      }
      await api.onboarding.wizardExtensions();
      await onSaved();
    } catch (e) {
      setError(describeError(e, '保存できませんでした'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ul className="wizard-agents">
        {list.map((x) => (
          <li key={x.id}>
            <label className="wizard-agent">
              <input type="checkbox" checked={on.has(x.id)} onChange={(e) => toggle(x.id, e.target.checked)} />
              <span><strong>{x.name}</strong><span className="muted small">{x.description}</span></span>
            </label>
          </li>
        ))}
      </ul>
      <button type="button" className="btn" disabled={busy} onClick={() => void save()}>{busy ? '保存しています…' : '保存して次へ'}</button>
      <HelpLink id="admin-extensions">拡張機能について</HelpLink>
      {error && <p className="error">{error}</p>}
    </>
  );
}

/** 段 5: 規程。PDF か Word を渡すと、文字を取り出して社内規程として登録する。 */
function KnowledgeStep({ done, onChanged }: { done: boolean; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ name: string; ok: boolean; text: string }[]>([]);
  const add = async (files: FileList) => {
    setBusy(true);
    const got: { name: string; ok: boolean; text: string }[] = [];
    for (const file of Array.from(files)) {
      try {
        const up = await api.uploadFile(file);
        const r = await api.admin.knowledgeFromFile(up.id);
        got.push({ name: file.name, ok: true, text: `「${r.title}」を登録しました（${r.sections} の節）` });
      } catch (e) {
        got.push({ name: file.name, ok: false, text: describeError(e, `${file.name} を登録できませんでした`) });
      }
    }
    setResults((r) => [...r, ...got]);
    await onChanged();
    setBusy(false);
  };
  return (
    <>
      {done && results.length === 0 && <p className="ok-msg small">規程が登録されています</p>}
      <label className={`btn${busy ? ' disabled' : ''}`}>
        {busy ? '登録しています…' : '就業規則などのファイルを選ぶ'}
        <input type="file" hidden multiple accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          disabled={busy} onChange={(e) => { if (e.target.files?.length) void add(e.target.files); e.target.value = ''; }} />
      </label>
      {results.map((r, i) => <p key={`${r.name}-${i}`} className={r.ok ? 'ok-msg small' : 'error'}>{r.text}</p>)}
      <HelpLink id="admin-knowledge">規程の登録のしかた</HelpLink>
    </>
  );
}

/**
 * 段 6: 同僚の招待。スターターは、先に契約の形と支払いの方法を選ぶ（第23.4.5節「有料への移り方と招待」）。
 * 料金が増える招待は、管理者ページと同じく金額を示して確かめる。
 */
function UsersStep({ me, onInvited }: { me: Me; onInvited: () => Promise<void> }) {
  const [billing, setBilling] = useState<BillingView | null>(null);
  const [billable, setBillable] = useState<boolean | null>(null);
  const [term, setTerm] = useState<ContractTerm>('monthly');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [invitedList, setInvitedList] = useState<string[]>([]);
  const load = useCallback(() => {
    // 請求の無い会社（ローカルの形・請求しない）は、支払いの方法を聞かない
    if ((me.billingCategory ?? 'none') === 'none') { setBillable(false); return Promise.resolve(); }
    return api.admin.billing()
      .then((v) => { setBilling(v); setBillable(true); setName((n) => n || v.billingName || me.tenant.name); })
      .catch((e) => { setBillable(false); setMessage({ ok: false, text: describeError(e, '料金を読み込めませんでした') }); });
  }, [me.billingCategory, me.tenant.name]);
  useEffect(() => { void load(); }, [load]);
  if (billable === null) return <p className="muted">読み込み中…</p>;

  const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try { await f(); } catch (e) { setMessage({ ok: false, text: describeError(e, 'できませんでした') }); } finally { setBusy(false); }
  };
  const invite = () => run(async () => {
    const view = billable ? await api.admin.billing() : null;
    if (view) {
      const effect = inviteEffect(view);
      if (effect.kind === 'payment_required') { setBilling(view); return; }
      if (effect.kind === 'class_limit') { setMessage({ ok: false, text: `人数の上限（${effect.limit} 人）に達しています。上のクラスは「ご利用料金」のお問い合わせ先へご連絡ください` }); return; }
      const total = (n: number) => `${yen(n)}（税込）`;
      if (effect.kind === 'monthly' && !confirm(`今月の料金は有料の ${effect.paidSeats} 人分で ${total(effect.totalJpy)}になります。招待しますか。`)) return;
      if (effect.kind === 'annual_start' && !confirm(`この方が使い始めた日から 12 か月の年間契約が始まります。${total(effect.totalJpy)}を請求します。招待しますか。`)) return;
      if (effect.kind === 'annual_add' && !confirm(`席が増え、残り ${effect.months} か月分の ${total(effect.totalJpy)}を翌月 1 日に請求します。招待しますか。`)) return;
    }
    await api.admin.inviteUser(email.trim(), displayName.trim(), ['member']);
    setInvitedList((l) => [...l, email.trim()]);
    setEmail('');
    setDisplayName('');
    setMessage({ ok: true, text: '招待しました。最初にログインしたときから使い始めます' });
    await onInvited();
    await load();
  });

  // スターターは、招待の前に契約の形と支払いの方法を選ぶ（お金に関わるので、管理者が自分で選ぶ。ADR-0028）
  if (billable && billing && billing.category === 'starter') {
    return (
      <>
        <p>2 人目からは料金がかかります。最初の 1 人は無料のままです。</p>
        <div className="row">
          <label className="check"><input type="radio" name="wizard-term" checked={term === 'monthly'} onChange={() => setTerm('monthly')} /> 月間契約（1 人 1 か月 {yen(billing.monthlyPriceJpy)}・税別）</label>
          <label className="check"><input type="radio" name="wizard-term" checked={term === 'annual'} onChange={() => setTerm('annual')} /> 年間契約（1 人 1 か月 {yen(billing.annualPriceJpy)}・税別。12 か月分を一括）</label>
        </div>
        <div className="field">
          <label htmlFor="wizard-billing-name">請求書の宛名</label>
          <input id="wizard-billing-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="row">
          {billing.cardReady && (
            <button type="button" className="btn" disabled={busy || !name.trim()}
              onClick={() => void run(async () => { location.href = (await api.admin.billingCard(name, term, 'setup')).url; })}>カードで払う</button>
          )}
          {billing.transferReady && (
            <button type="button" className="btn ghost" disabled={busy || !name.trim()}
              onClick={() => void run(async () => { await api.admin.billingTransfer(name, term); await load(); })}>銀行振込で払う</button>
          )}
        </div>
        {!billing.cardReady && !billing.transferReady && <p className="muted small">いまは支払いの方法を準備中です。</p>}
        {message && <p className={message.ok ? 'ok-msg small' : 'error'}>{message.text}</p>}
        <HelpLink id="admin-billing">料金と支払いの方法</HelpLink>
      </>
    );
  }

  return (
    <>
      <form onSubmit={(e) => { e.preventDefault(); void invite(); }}>
        <div className="grid2">
          <div className="field">
            <label htmlFor="wizard-email">メールアドレス</label>
            <input id="wizard-email" type="email" value={email} placeholder={`例: name@${me.tenant.workspaceDomain ?? 'example.jp'}`} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="wizard-display">表示名</label>
            <input id="wizard-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
        </div>
        <button className="btn" disabled={busy || !email.trim()}>{busy ? '招待しています…' : '招待する'}</button>
      </form>
      {invitedList.length > 0 && <p className="muted small">招待した人: {invitedList.join('、')}</p>}
      {message && <p className={message.ok ? 'ok-msg small' : 'error'}>{message.text}</p>}
      <HelpLink id="admin-users">招待と権限</HelpLink>
    </>
  );
}

/** 段 7: 従業員へ、管理者に見える範囲を知らせる。知らせる文の例はよくある質問にある。 */
function NotifyStep({ done, onChanged }: { done: boolean; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <p>管理者には、従業員の業務の使われ方が見えます。使い始める前に、見える範囲を従業員に伝えてください。</p>
      <HelpLink id="faq-privacy">伝える文の例（誰に何が見られますか）</HelpLink>
      <div className="row">
        {done ? <p className="ok-msg small">知らせたことを記録しました</p> : (
          <button type="button" className="btn" disabled={busy} onClick={() => {
            setBusy(true);
            void api.onboarding.notified().then(onChanged).catch((e) => setError(describeError(e, '記録できませんでした'))).finally(() => setBusy(false));
          }}>知らせた</button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}

/** 終わり。残っている項目は、管理者ページの「はじめに行う設定」に残ることだけを示す。 */
function FinishStep({ items }: { items: ChecklistItem[] }) {
  const left = items.filter((i) => !i.done);
  return (
    <>
      <p>分からないことは、秘書に聞いてください。</p>
      {left.length > 0 && (
        <p className="muted small">残っている設定（{left.map((i) => i.label).join('・')}）は、管理者ページの「はじめに行う設定」から続けられます。</p>
      )}
    </>
  );
}
