/**
 * @file 画面の部品。入力フォームの自動生成・実行の詳細・承認トレイ・根拠の表示。
 *
 * @see 仕様書 第6章 ユーザー体験
 */

import { useEffect, useRef, useState } from 'react';
import { hideInternalIds, type Artifact, type RunStep } from '@m2office/shared';
import {
  api, describeError, type AgentSummary, type ApprovalView, type JsonSchemaField, type RunDetail,
} from './api.js';
import { Markdown, openHelp } from './help.js';
import { Icon } from './nav.js';
import { keyLabel, useHotkey } from './keys.js';

/**
 * 通常の停止の間、画面の上部に出す案内（仕様書 第23.8.6節）。停止していなければ何も出さない。
 *
 * @remarks 閲覧のみできることと、解除の方法をヘルプの記事で示す。停止の理由は運営が管理者へ別に知らせる
 */
export function SuspendedBanner({ status }: { status: string }) {
  if (status !== 'suspended') return null;
  return (
    <div className="suspended-banner" role="status">
      <strong>ご利用を停止しています。閲覧のみできます。</strong>
      {' '}<button className="link-btn" onClick={() => openHelp('faq-suspended')}>解除の方法</button>
    </div>
  );
}

/**
 * 「〇〇との接続が要ります」と接続のボタン（仕様書 第12.11.6.3節「求められたときに接続する」）。
 *
 * @remarks 押すと相手のサービスの許可の画面へ移り、終わると個人設定に戻る
 */
export function ConnectPrompt({ id, name }: { id: string; name: string }) {
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    try {
      location.href = (await api.connectConnection(id)).url;
    } catch (err) {
      setError(describeError(err, '接続を始められませんでした'));
    }
  };
  return (
    <div className="connect-prompt">
      <span>「{name}」との接続が要ります</span>
      <button type="button" className="btn small" onClick={() => void connect()}>{name}と接続する</button>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

/**
 * 入力スキーマからフォームを自動生成する（仕様書 FR-202）。
 *
 * エージェントが増えても画面側の実装を変えないため、
 * 定義の `inputs` からフォームを組み立てる。
 */
export function AgentForm({
  agent, onSubmitted, initial, fill,
}: {
  agent: AgentSummary;
  onSubmitted: (runId: string) => void;
  /** 初めから入れておく値。秘書に渡したファイルを引き継ぐのに使う（仕様書 第10.10.3節）。 */
  initial?: Record<string, string>;
  /**
   * あとから入れ直す値。題名の「？」の中の実行例から渡る（仕様書 第6.10.5.1節）。
   * 押すたびに新しい入れ物で渡るため、同じ例を二度押しても入り直す。
   */
  fill?: Record<string, string> | null;
}) {
  const [values, setValues] = useState<Record<string, string>>(initial ?? {});
  useEffect(() => { if (fill) setValues(fill); }, [fill]);
  // 入力欄から手を離さずに実行できるようにする（仕様書 第6.11.1節 k2）
  const hotkey = keyLabel('Mod+Enter');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 入力欄の中からでも効く（Mod を伴うため。仕様書 第6.11.2節）
  useHotkey('Mod+Enter', () => { if (!busy) void submit(); });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { runId } = await api.createJob(agent.id, values);
      onSubmitted(runId);
    } catch (err) {
      setError(describeError(err, '実行を開始できませんでした'));
    } finally {
      setBusy(false);
    }
  }

  // 本人がまだ接続していない会社の接続（仕様書 第12.11.6.3節）。接続するまで実行できない
  const missing = agent.needsConnection ?? [];

  return (
    <>
    <div className="card">
      {missing.map((m) => <ConnectPrompt key={m.id} id={m.id} name={m.name} />)}
      <InputFields agent={agent} values={values} onChange={(key, v) => setValues((s) => ({ ...s, [key]: v }))} />
      {error && <p className="error">{error}</p>}
      <button className="btn" onClick={submit} disabled={busy || missing.length > 0} title={hotkey ? `実行する（${hotkey}）` : '実行する'}>
        {busy ? '開始しています…' : '実行'}
        {hotkey && <kbd className="btn-key">{hotkey}</kbd>}
      </button>
    </div>
    </>
  );
}

/**
 * 業務の入力の欄を、定義（`inputs`）から並べる。
 *
 * @remarks 実行の画面と定時実行の登録（仕様書 第6.1.7節）で同じ欄を出すために共通にしている。
 */
export function InputFields({ agent, values, onChange }: {
  agent: AgentSummary;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  const props = agent.inputs?.properties ?? {};
  const required = new Set(agent.inputs?.required ?? []);
  return (
    <>
      {Object.entries(props).map(([key, field]) => (
        <Field
          key={key}
          name={key}
          field={field}
          required={required.has(key)}
          value={values[key] ?? ''}
          onChange={(v) => onChange(key, v)}
        />
      ))}
    </>
  );
}

function Field({
  name, field, required, value, onChange,
}: {
  name: string;
  field: JsonSchemaField;
  required: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  const label = `${field.title ?? name}${required ? '（必須）' : ''}`;
  // 説明の文を足すより、例を薄く置く（仕様書 第6.10.4.1節）。例が無ければ何も出さない
  const hint = field.examples?.[0] ? `例: ${field.examples[0]}` : undefined;
  if (field.format === 'date') return <DateField name={name} label={label} optional={!required} value={value} onChange={onChange} />;
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      {field.format === 'textarea' ? (
        <textarea id={name} value={value} placeholder={hint} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={name} value={value} placeholder={hint} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

/**
 * 日付の入力（仕様書 第6.10.4.1節）。任意の項目は、チェックボックスを入れたときだけ日付を選ぶ。
 *
 * @remarks
 * 既定ではチェックせず、日付を渡さない。チェックするとカレンダーを開く（ブラウザの日付の選び方を使う）。
 * チェックを外すと日付を消す。必須の項目はチェックボックスを付けない。
 */
function DateField({ name, label, optional, value, onChange }: {
  name: string; label: string; optional: boolean; value: string; onChange: (v: string) => void;
}) {
  const [on, setOn] = useState(!optional || value !== '');
  const input = useRef<HTMLInputElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    // チェックを入れた直後に、カレンダーを開く。開けないブラウザでは、日付の欄を押せば開く
    if (!optional || !on || opened.current) return;
    opened.current = true;
    try { input.current?.showPicker?.(); } catch { /* 開けなくても、欄は使える */ }
    input.current?.focus();
  }, [on, optional]);
  const picker = (
    <input ref={input} id={name} type="date" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} />
  );
  if (!optional) {
    return <div className="field"><label htmlFor={name}>{label}</label>{picker}</div>;
  }
  return (
    <div className="field field-date">
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => {
          setOn(e.target.checked);
          opened.current = false;
          if (!e.target.checked) onChange('');
        }} />
        {label}
      </label>
      {on && picker}
    </div>
  );
}

/**
 * 実行の答え（仕様書 第6.2.2節）。
 *
 * @remarks
 * **最後に文を返した段**の応答を使う。途中の段の文には道具の呼び出しが混じるため、
 * その囲みは落とす。落とした結果が空なら、答えは無いものとして扱う。
 */
function answerOf(steps: RunStep[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const raw = (steps[i]?.output as { text?: string } | null)?.text ?? '';
    // 推論の文に混じった内部の ID（成果物・ファイル・実行）は出さない。リンクは残す（仕様書 第6.2.2節）
    const text = hideInternalIds(raw.replace(/```tool[\s\S]*?```/g, '')).trim();
    if (text) return text;
  }
  return '';
}

/** 比べるために、書式の記号と空白を落とす。 */
const plain = (t: string) => t.replace(/[#*`>\-_|]/g, '').replace(/\s+/g, '');

/**
 * 2 つの文が同じことを言っているか。片方がもう片方をそのまま含むときも同じとみなす（答えが成果物の本文を写しただけ、など）。
 *
 * @remarks 短い要約（「議事録を作りました」）は成果物に含まれないので、別のものとして両方出す
 */
export function sameText(a: string, b: string): boolean {
  const x = plain(a);
  const y = plain(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 20 && y.includes(x)) || (y.length >= 20 && x.includes(y));
}

/** 途中で止められる状態（仕様書 第9.3.1節）。終わった実行は止められない。 */
const CANCELLABLE = ['queued', 'running', 'awaiting_approval'];

/**
 * 実行の詳細（仕様書 第6.2.2節・第6.2.2.2節）。
 *
 * @remarks
 * **本人が読むものと、本人が決めることだけを出す。**
 * 動いている間は「動いていること」と「いま何をしているか」だけ。終わったら途中の表示を消し、
 * 結果と成果物だけを残す。実行 ID・トークン数・費用・段の一覧・道具の一覧は、
 * 利用者が変えられないため既定では出さない（閉じた「実行の記録」の中に置く）。
 *
 * @param viewerId 見ている人。依頼した本人にだけ「中止」を出す（第9.3.1節）
 * @param onCancelled 中止したあとに呼ぶ。呼び出し側が読み直す
 */
export function RunView({
  detail, viewerId, onCancelled,
}: {
  detail: RunDetail;
  viewerId: string;
  onCancelled: () => void;
}) {
  const { run, steps, artifacts } = detail;
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leftover, setLeftover] = useState<string[] | null>(null);
  const canCancel = detail.job?.requestedBy === viewerId && CANCELLABLE.includes(run.status);
  const done = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
  const answer = answerOf(steps);
  // 答えの文が、成果物のどれかと同じことを言っているだけか（同じものを 2 度並べない。仕様書 第6.2.2節）
  const repeated = !!answer && artifacts.some((a: Artifact) => sameText(answer, a.body));
  /*
    いま何をしているか。段は始まった時点で作られるため、動いている段があればそれを使う。
    待ち行列に入ったばかりで段がまだ無いこともある。**推測で名前を作らない。**
  */
  const doing = steps.find((x) => x.status === 'running');

  async function cancel() {
    // 中止は、すでに起きたことを取り消さない。押す前に伝える（第9.3.1節）
    const ok = window.confirm(
      'この業務を止めます。\n\n'
      + 'すでに送ったメールや、作った文書、書き込んだ予定は戻りません。'
      + '呼び出している最中の処理も、途中では止まりません。\n\n'
      + '止めてよろしいですか。',
    );
    if (!ok) return;
    setCancelling(true);
    setError(null);
    try {
      const res = await api.cancelRun(run.id);
      setLeftover(res.leftoverLinks);
      onCancelled();
    } catch (err) {
      setError(describeError(err, '止められませんでした'));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <>
      {/* 動いている間。だんまりにせず、動いていることだけを示す（仕様書 第6.2.2.2節） */}
      {!done && (
        <div className="card running">
          <p className="doing">
            {/* 承認待ちは人の番であり、こちらは動いていない。回さない */}
            {run.status !== 'awaiting_approval' && <span className="spin" aria-hidden="true" />}
            {run.status === 'awaiting_approval'
              ? '承認をお待ちしています'
              : `${doing?.label ?? '準備しています'}…`}
          </p>
          {canCancel && (
            <button className="btn ghost small" onClick={() => void cancel()} disabled={cancelling}>
              {cancelling ? '止めています…' : '中止'}
            </button>
          )}
        </div>
      )}
      {/*
        終わった実行の答えを必ず出す（仕様書 第6.2.2節）。成果物を作らない業務もある。
        **同じことを 2 度出さない。** 答えの文が成果物と同じなら、成果物だけを出す。「結果」「成果物」の見出しは付けない
      */}
      {done && (run.failureReason || (answer && !repeated) || artifacts.length === 0) && (
        <div className="card">
          {run.failureReason && <p className="error">{run.failureReason}</p>}
          {answer && !repeated
            ? <div className="reply"><Markdown text={answer} lineBreaks /></div>
            : !run.failureReason && artifacts.length === 0 && <p className="muted">結果がありません。</p>}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {leftover && leftover.length > 0 && (
        <p className="muted">
          作りかけの文書がドライブに残っています:{' '}
          {leftover.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>
          ))}
        </p>
      )}
      {artifacts.map((a: Artifact) => (
        <div className="card" key={a.id}>
          {/* 題名は、成果物が 2 つ以上あって見分けが要るときだけ出す */}
          {artifacts.length > 1 && <h3>{a.title}</h3>}
          {/* 書式として読み、改行を保つ。生の文字で出すと「## 決定事項」「**…**」がそのまま見える（2026-09-25 に確認） */}
          <div className="reply"><Markdown text={a.body} lineBreaks /></div>
          {a.fileId && (
            <button className="btn ghost small"
              onClick={() => void api.download(a.fileId!, a.body.replace(/（.*）$/, ''))}>
              ダウンロード
            </button>
          )}
        </div>
      ))}
      {/*
        承認する人は、判断の前に中身を確かめる必要がある（原則 u2）。
        **既定は閉じる。** 開いたときだけ段・道具・ID を出す（仕様書 第6.2.2.2節）
      */}
      {done && (
        <details className="record">
          <summary>実行の記録（確認用）</summary>
          <ul className="steps">
            {steps.map((x) => (
              <li key={x.id}>
                <span className="seq">{x.seq + 1}</span>
                <span className="name">
                  {x.label}
                  {/* 社外にもお金にも関わらない承認の段は、人を待たずに通る（仕様書 第9.3.3節、ADR-0028） */}
                  <span className="muted">（{x.kind !== 'approval' ? '処理'
                    : (x.output as { automatic?: boolean } | null)?.automatic ? '承認・自動で通過' : '承認'}）</span>
                </span>
                <span className={`status ${x.status}`}>{statusLabel(x.status)}</span>
              </li>
            ))}
          </ul>
          <h4>使った道具</h4>
          <Evidence steps={steps} />
          <p className="muted small">実行 ID: {run.id}</p>
        </details>
      )}
    </>
  );
}

/** 承認トレイ。差分を見て承認・却下する（仕様書 FR-306）。 */
export function ApprovalTray({
  items, onDecided,
}: {
  items: ApprovalView[];
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(id: string, decision: 'approved' | 'rejected') {
    setBusy(id);
    try {
      await api.decide(id, decision);
      onDecided();
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="card">
        <p className="muted">承認待ちはありません</p>
      </div>
    );
  }

  return (
    <>
      {items.map((a) => (
        <ApprovalRow key={a.id} approval={a} busy={busy === a.id} onDecide={decide} />
      ))}
    </>
  );
}

/**
 * 承認の依頼 1 件（仕様書 第6.2.4節）。**その場で開く。**
 *
 * @remarks
 * **判断のボタンは、開いたときにだけ出す。** 中身を見ずに押せてしまうと、
 * 承認が形だけのものになる（不変則 I-11 と同じ考え方）。
 * 1 件目は開いた状態で出す。ほとんどの場合、判断するのはその 1 件だからである。
 */
function ApprovalRow({ approval, busy, onDecide }: {
  approval: ApprovalView;
  busy: boolean;
  onDecide: (id: string, decision: 'approved' | 'rejected') => void;
}) {
  const [open, setOpen] = useState(false);
  const first = firstLine(approval.present);
  return (
    <div className={`card fold-row${open ? ' open' : ''}`}>
      <button className="fold-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'caret-down' : 'caret-right'} className="nav-caret" />
        <strong>{approval.agentName ?? '承認の依頼'}</strong>
        <span className="muted small">{first}</span>
        <span className="muted small tail">{ago(approval.createdAt)}</span>
      </button>
      {open && (
        <div className="fold-body">
          <div className="reply"><Markdown text={approval.present} lineBreaks /></div>
          <p className="muted small">
            {approval.approverUserId ? 'あなたの依頼です'
              : `承認できる役割: ${approval.approverRole.join(' / ')}`}
          </p>
          <button className="btn" disabled={busy} onClick={() => onDecide(approval.id, 'approved')}>
            承認する
          </button>{' '}
          <button className="btn danger" disabled={busy} onClick={() => onDecide(approval.id, 'rejected')}>
            却下する
          </button>
        </div>
      )}
    </div>
  );
}

/** 何の承認かを 1 行で示す。開く前に、どれを開くかが分かるようにする。 */
function firstLine(text: string): string {
  const line = text.split('\n').map((x) => x.trim()).find(Boolean) ?? '';
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/** 依頼からの経過。長く待たせているものが分かる。 */
function ago(at: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60000));
  if (min < 60) return `${min} 分前`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} 時間前` : `${Math.round(h / 24)} 日前`;
}

/** ステップと実行の状態を、利用者向けの言葉に直す（仕様書 原則 u1）。 */
export function statusLabel(status: string): string {
  const table: Record<string, string> = {
    queued: '待機中',
    running: '実行中',
    awaiting_approval: '承認待ち',
    awaiting: '承認待ち',
    completed: '完了',
    succeeded: '完了',
    failed: '失敗',
    cancelled: '中止',
    rejected: '却下',
    expired: '期限切れ',
  };
  return table[status] ?? status;
}

/**
 * 業務の実行の根拠（仕様書 第6.2節、ADR-0020）。
 *
 * @remarks
 * **実行の詳細の画面に置く。** 会話ペインには置かない。秘書の答えの根拠と並ぶと、
 * どちらの話かが読み取れなくなる。
 */
export function Evidence({ steps }: { steps: RunStep[] }) {
  const calls = steps.flatMap((s) => {
    const out = s.output as { tools?: { name: string; risk?: string }[] } | null;
    return (out?.tools ?? []).map((t) => ({ step: s.stepId, name: t.name, risk: t.risk }));
  });
  // 保存期間を過ぎて中身を消した実行（仕様書 第14.3.2節）。ツールの名前だけが残っている
  const redacted = steps.find((s) => (s.output as { redacted?: boolean } | null)?.redacted);
  const note = redacted && (
    <p className="muted small">
      {(redacted.output as { reason?: string }).reason === 'disconnect'
        ? '連携解除により中身を消去済み'
        : '保存期間切れで中身を消去済み'}
    </p>
  );
  if (calls.length === 0) return <>{note}<p className="muted">まだ根拠はありません。</p></>;
  return (
    <>
    {note}
    <dl className="kv">
      {calls.map((c, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{c.step}</dt>
          <dd>{c.name}{c.risk ? `（${c.risk}）` : ''}</dd>
        </div>
      ))}
    </dl>
    </>
  );
}
