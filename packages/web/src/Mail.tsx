/**
 * @file メールの画面（仕様書 第9.5.1.1節、ADR-0131）。メールを M2Office の中で片付ける。
 *
 * 一覧は「返事が要る」「対応が要る」「返事待ち」の順。「目を通すだけ」と「宣伝・お知らせ」はたたむ。
 * 一覧の上に、AI が付けたカテゴリー（本人の仕事のまとまり）を並べ、押すとそのカテゴリーだけに絞る（第9.5.1.1.1節）。
 * 1 件を開くと、スレッドの本文（開いたときに Gmail から読む）と、用意した下書きを出す。
 * 「送る」→ 宛先と本文の確かめ →「送る」で、業務「メールの返事を送る」を始め、本人の承認として送る（社外への送信。境界 2）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MAIL_GROUP_LABELS, type MailItem, type MailOverview, type MailThreadDetail } from '@m2office/shared';
import { api, describeError } from './api.js';
import { BackButton } from './back-button.js';
import { Busy } from './components.js';

/** 差出人の表示名（「山田 <a@b>」→「山田」）。 */
const nameOf = (from: string) => from.split(',')[0]!.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || from;

/** 日時を短く（今日は時刻、ほかは月日）。 */
function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
}

/** 日時を、今日なら時刻だけ、ほかの日は月日と時刻で。 */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })} ${time}`;
}

/**
 * 最後にメールを取得した日時（第9.5.1.1節「一覧」。第 0.543.0 版）。見回りが止まっているのか、新しいメールが無いのかを見分けられるようにする。
 *
 * @param watch 見回りの様子。止まっているとき（`stale`）は目立たせる
 */
function LastFetch({ watch }: { watch: MailOverview['watch'] }) {
  if (!watch.checkedAt) return null;
  return (
    <p className={watch.stale ? 'error small mail-fetched' : 'muted small mail-fetched'}>
      最終の取得 {stamp(watch.checkedAt)}{watch.stale && '・見回りが止まっています'}
    </p>
  );
}

/** HTML のメールの枠の中の決まり。プログラムは動かさず、画像・見た目・字体だけを読む。 */
const MAIL_FRAME_CSP = "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https:; font-src https: data:; media-src https: data:";

/**
 * HTML のメールを、Gmail と同じ見た目で出す（仕様書 第9.5.1.1節「1 件を開いたとき」。第 0.546.0 版）。
 *
 * @remarks
 * 外から届いた HTML なので、切り離した枠（`sandbox`）の中に出す。`allow-scripts` を付けないので、メールの中のプログラムは動かない。
 * 入力欄の送信も、画面の移動もできない。リンクは新しいタブで開く（`allow-popups`）。画像やリンクの先に、M2Office の URL を渡さない（`no-referrer`）。高さは中身に合わせる（`allow-same-origin` は高さを測るためだけ。プログラムが動かないので、M2Office の画面には触れられない）。
 * メールは明るい背景で作られているので、暗い表示のときも白い紙の上に出す（Gmail と同じ）。
 */
function MailHtml({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MAIL_FRAME_CSP}"><meta name="referrer" content="no-referrer"><base target="_blank">`
    + '<style>html{color-scheme:light}body{margin:0;padding:12px;background:#fff;color:#202124;font-family:sans-serif;overflow-wrap:anywhere}img{max-width:100%}</style></head>'
    + `<body>${html}</body></html>`;
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    const fit = () => {
      const body = frame.contentDocument?.body;
      if (!body) return;
      setHeight(Math.max(body.scrollHeight, frame.contentDocument!.documentElement.scrollHeight) + 2);
      if (!observer) { observer = new ResizeObserver(() => fit()); observer.observe(body); }
    };
    frame.addEventListener('load', fit);
    return () => { frame.removeEventListener('load', fit); observer?.disconnect(); };
  }, [html]);
  return <iframe ref={ref} className="mail-html" title="メールの本文" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} style={{ height }} />;
}

/** 宛先の欄の文字を、1 人ずつに分ける。 */
const splitList = (v: string) => v.split(/[,、\n]/).map((x) => x.trim()).filter(Boolean);

/**
 * メールの画面。
 *
 * @param threadId 開いている 1 件（無ければ一覧）
 * @param onOpen 1 件を開く・一覧へ戻る（`null`）
 */
export function MailScreen({ threadId, onOpen }: { threadId: string | null; onOpen: (threadId: string | null) => void }) {
  return threadId ? <MailThread threadId={threadId} onBack={() => onOpen(null)} /> : <MailList onOpen={(id) => onOpen(id)} />;
}

/**
 * 一覧の見え方（開いているたたみと、絞っているカテゴリー）。1 件を開いて戻っても、そのままにする（仕様書 第9.5.1.1節「一覧」。第 0.549.1 版）。
 * 1 件を開くと一覧の部品は消えるので、画面の外に持つ。読み込み直したら初めに戻る。
 */
const listView: { open: Set<'read' | 'promo'>; cat: string | null } = { open: new Set(), cat: null };

/** 一覧。 */
function MailList({ onOpen }: { onOpen: (threadId: string) => void }) {
  const [data, setData] = useState<MailOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 絞っているカテゴリー（無ければすべて）
  const [cat, setCatState] = useState<string | null>(listView.cat);
  const setCat = (v: string | null) => { listView.cat = v; setCatState(v); };
  const [folds, setFolds] = useState<Set<'read' | 'promo'>>(() => new Set(listView.open));
  const toggle = (g: 'read' | 'promo', open: boolean) => {
    if (open === listView.open.has(g)) return;
    if (open) listView.open.add(g); else listView.open.delete(g);
    setFolds(new Set(listView.open));
  };
  const load = useCallback(() => api.mail.overview().then((d) => { setData(d); setError(null); })
    .catch((e) => setError(describeError(e, 'メールを読み込めませんでした'))), []);
  useEffect(() => {
    void load();
    // 見回りは 15 分ごと。画面を開いている間は 1 分ごとに読み直す（最初の 1 回の間は 5 秒ごと）
    const t = setInterval(() => void load(), data?.watch.state === 'starting' ? 5_000 : 60_000);
    return () => clearInterval(t);
  }, [load, data?.watch.state]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted"><Busy>読み込んでいます…</Busy></p>;
  const { watch } = data;
  if (watch.state === 'off') return <p className="muted">Google と接続すると使えます。<a className="link" href="/settings/google">接続する</a></p>;
  if (watch.state === 'paused') return <><p className="muted">メールを見るのを止めています。秘書に「またメールを見て」と言えば戻ります。</p><LastFetch watch={watch} /></>;
  if (watch.state === 'starting') return <p className="muted"><Busy>最近 14 日のメールを見ています…</Busy></p>;
  const active = cat && data.categories.some((c) => c.id === cat) ? cat : null;
  const only = (items: MailItem[]) => (active ? items.filter((t) => t.category?.id === active) : items);
  const view = { reply: only(data.reply), action: only(data.action), waiting: only(data.waiting), read: only(data.read), promo: active ? [] : data.promo };
  const empty = !view.reply.length && !view.action.length && !view.waiting.length;
  return (
    <div className="mail">
      <LastFetch watch={watch} />
      {data.categories.length > 0 && (
        <div className="mail-cats" role="group" aria-label="カテゴリー">
          <button type="button" className={active ? 'chip-btn' : 'chip-btn on'} onClick={() => setCat(null)}>すべて</button>
          {data.categories.map((c) => (
            <button key={c.id} type="button" className={active === c.id ? 'chip-btn on' : 'chip-btn'} onClick={() => setCat(active === c.id ? null : c.id)}>
              {c.name} <span className="mail-count">{c.count}</span>
            </button>
          ))}
        </div>
      )}
      {watch.state === 'error' && <p className="error small">メールを読めませんでした（{watch.error}）</p>}
      {data.aiLimited && <p className="error small">AI の上限に達したため、新しいメールを振り分けていません</p>}
      {empty && <p className="muted">{active ? 'このカテゴリーに、返事や対応が要るメールはありません' : '返事や対応が要るメールはありません'}</p>}
      {(['reply', 'action', 'waiting'] as const).map((g) => view[g].length > 0 && (
        <section key={g} className="mail-group">
          <h2>{MAIL_GROUP_LABELS[g]} <span className="mail-count">{view[g].length}</span></h2>
          <ul className="mail-list">{view[g].map((t) => <MailRow key={t.threadId} item={t} onOpen={onOpen} showCategory={!active} />)}</ul>
        </section>
      ))}
      {(['read', 'promo'] as const).map((g) => view[g].length > 0 && (
        <details key={g} className="mail-group" open={folds.has(g)} onToggle={(e) => toggle(g, (e.currentTarget as HTMLDetailsElement).open)}>
          <summary>{MAIL_GROUP_LABELS[g]} <span className="mail-count">{view[g].length}</span></summary>
          <ul className="mail-list">{view[g].map((t) => <MailRow key={t.threadId} item={t} onOpen={onOpen} showCategory={!active} />)}</ul>
        </details>
      ))}
    </div>
  );
}

/**
 * 一覧の 1 行。
 *
 * @param showCategory カテゴリーの名前を添える（カテゴリーで絞っているときは添えない）
 */
function MailRow({ item: t, onOpen, showCategory = true }: { item: MailItem; onOpen: (threadId: string) => void; showCategory?: boolean }) {
  const soon = t.dueDate !== null && t.dueDate <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return (
    <li>
      <button type="button" className="mail-row" onClick={() => onOpen(t.threadId)}>
        <span className="mail-from">{t.group === 'waiting' ? `→ ${nameOf(t.from)}` : nameOf(t.from)}</span>
        <span className="mail-subject">{t.subject}{showCategory && t.category && <span className="chip mail-cat">{t.category.name}</span>}</span>
        {(t.summary || t.due) && (
          <span className="mail-summary">
            {t.summary}
            {t.due && <span className={soon ? 'badge warn' : 'badge'}>{t.due}</span>}
          </span>
        )}
        <span className="mail-when muted small">
          {t.group === 'waiting' ? `${when(t.sentAt)} に送信` : when(t.lastAt)}
          {t.sending ? '・送っています' : t.draftReady ? '・下書きあり' : ''}
        </span>
      </button>
    </li>
  );
}

/** 1 件を開いた画面。 */
function MailThread({ threadId, onBack }: { threadId: string; onBack: () => void }) {
  const [d, setD] = useState<MailThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [ask, setAsk] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState(false);
  const decided = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const got = await api.mail.thread(threadId);
      setD(got);
      return got;
    } catch (e) {
      setError(describeError(e, 'メールを読み込めませんでした'));
      return null;
    }
  }, [threadId]);

  useEffect(() => {
    void load().then((got) => {
      if (!got) return;
      setDraft(got.draft);
      setTo(got.recipients.to.join(', '));
      setCc(got.recipients.cc.join(', '));
    });
  }, [load]);

  // 送っている間は読み直す。承認が出たら、本人が 2 回目の「送る」を押したので、そのまま本人の承認にする
  useEffect(() => {
    if (!d?.sending) return;
    const t = setInterval(() => {
      void load().then(async (got) => {
        const s = got?.sending;
        if (!got || !s) {
          // 送り終えたら片付いている。断った・失敗したときは片付いていないので、画面に理由を出して直せるようにする
          if (got?.done && decided.current) setSent(true);
          return;
        }
        if (s.approvalId && decided.current !== s.approvalId) {
          decided.current = s.approvalId;
          await api.decide(s.approvalId, 'approved').catch((e) => setError(describeError(e, '送れませんでした')));
        }
      });
    }, 1_500);
    return () => clearInterval(t);
  }, [d?.sending, load]);

  if (error && !d) return <div className="mail"><BackButton label="メールの一覧" onClick={onBack} /><p className="error">{error}</p></div>;
  if (!d) return <p className="muted"><Busy>読み込んでいます…</Busy></p>;
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try { await fn(); } catch (e) { setError(describeError(e, 'うまくいきませんでした')); } finally { setBusy(null); }
  };
  const canReply = d.item.group === 'reply' || d.item.group === 'action' || d.item.group === 'waiting';
  const sending = !!d.sending;
  const messages = d.messages;

  if (sent) {
    return (
      <div className="mail">
        <BackButton label="メールの一覧" onClick={onBack} />
        <p className="ok-msg">返事を送りました（{splitList(to).join(', ')}）</p>
      </div>
    );
  }
  return (
    <div className="mail mail-thread">
      <BackButton label="メールの一覧" onClick={onBack} />
      <h2 className="mail-title">{d.item.subject}</h2>
      <p className="muted small">
        {MAIL_GROUP_LABELS[d.item.group]}{d.item.summary && `・${d.item.summary}`}{d.item.due && `・期限 ${d.item.due}`}
        {' '}<a className="link" href={d.gmailUrl} target="_blank" rel="noopener">Gmail で開く</a>
      </p>
      {d.readError && <p className="error small">{d.readError}</p>}
      <ol className="mail-messages">
        {messages.map((m, i) => (
          <li key={m.id} className={m.mine ? 'mine' : ''}>
            <details open={i >= messages.length - 2}>
              <summary><strong>{m.mine ? '自分' : nameOf(m.from)}</strong> <span className="muted small">{when(m.at)}</span></summary>
              {m.html ? <MailHtml html={m.html} /> : <div className="mail-body">{m.body}</div>}
            </details>
          </li>
        ))}
      </ol>

      {canReply && (
        <section className="mail-reply">
          <h3>{d.item.group === 'waiting' ? '催促' : '返事'}</h3>
          {!draft && !sending && (
            <button type="button" className="btn ghost" disabled={!!busy}
              onClick={() => void run('draft', async () => { const r = await api.mail.redraft(threadId); setDraft(r.draft); })}>
              {busy === 'draft' ? <Busy>下書きを作っています…</Busy> : '下書きを作る'}
            </button>
          )}
          {(draft || sending) && !confirming && (
            <>
              <label className="mail-field">宛先<input value={to} onChange={(e) => setTo(e.target.value)} disabled={sending} /></label>
              <label className="mail-field">CC<input value={cc} onChange={(e) => setCc(e.target.value)} disabled={sending} /></label>
              <textarea className="mail-draft" value={draft} rows={12} disabled={sending}
                onChange={(e) => setDraft(e.target.value)} onBlur={() => void api.mail.saveDraft(threadId, draft).catch(() => undefined)} />
              {!sending && (
                <div className="row mail-ask">
                  <input value={ask} placeholder="直してほしいこと" onChange={(e) => setAsk(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && ask.trim() && !e.nativeEvent.isComposing) (e.currentTarget.nextElementSibling as HTMLButtonElement | null)?.click(); }} />
                  <button type="button" className="btn ghost" disabled={!!busy || !ask.trim()}
                    onClick={() => void run('redraft', async () => { await api.mail.saveDraft(threadId, draft); const r = await api.mail.redraft(threadId, ask); setDraft(r.draft); setAsk(''); })}>
                    {busy === 'redraft' ? <Busy>直しています…</Busy> : '秘書に直してもらう'}
                  </button>
                </div>
              )}
              <div className="row">
                {sending
                  ? <Busy>送っています…</Busy>
                  : <button type="button" className="btn" disabled={!!busy || !draft.trim() || splitList(to).length === 0} onClick={() => setConfirming(true)}>送る</button>}
                {!sending && (
                  <button type="button" className="btn ghost" disabled={!!busy}
                    onClick={() => void run('gmail', async () => { await api.mail.saveDraft(threadId, draft); const r = await api.mail.gmailDraft(threadId); window.open(r.url, '_blank', 'noopener'); })}>
                    Gmail で直したい
                  </button>
                )}
              </div>
            </>
          )}
          {confirming && (
            <div className="mail-confirm card">
              <p><strong>宛先:</strong> {splitList(to).join(', ')}</p>
              {splitList(cc).length > 0 && <p><strong>CC:</strong> {splitList(cc).join(', ')}</p>}
              <p><strong>件名:</strong> {d.replySubject}</p>
              <div className="mail-body">{draft}</div>
              <div className="row">
                <button type="button" className="btn" disabled={!!busy}
                  onClick={() => void run('send', async () => {
                    await api.mail.send(threadId, { to: splitList(to), cc: splitList(cc), body: draft });
                    setConfirming(false);
                    await load();
                  })}>
                  {busy === 'send' ? <Busy>送っています…</Busy> : '送る'}
                </button>
                <button type="button" className="btn ghost" disabled={!!busy} onClick={() => setConfirming(false)}>戻る</button>
              </div>
            </div>
          )}
        </section>
      )}

      {!sending && (
        <div className="row mail-actions">
          <button type="button" className="btn ghost" disabled={!!busy}
            onClick={() => void run('done', async () => { await api.mail.done(threadId); onBack(); })}>済み</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <BackButton label="メールの一覧" onClick={onBack} place="bottom" />
    </div>
  );
}
