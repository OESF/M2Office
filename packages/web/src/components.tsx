/**
 * @file 画面の部品。入力フォームの自動生成・実行の詳細・承認トレイ・根拠の表示。
 *
 * @see 仕様書 第6章 ユーザー体験
 */

import { useEffect, useState } from 'react';
import type { Approval, Artifact, RunStep } from '@m2office/shared';
import { api, describeError, type AgentSummary, type JsonSchemaField, type RunDetail } from './api.js';
import { Markdown, openHelp } from './help.js';
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
      {' '}業務の依頼・承認・設定の変更は、再開のあとに行えます。
      {' '}<button className="link-btn" onClick={() => openHelp('faq-suspended')}>解除の方法</button>
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
  const props = agent.inputs?.properties ?? {};
  const required = new Set(agent.inputs?.required ?? []);

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

  return (
    <>
    <div className="card">
      {agent.extension && (
        <p className="muted small">拡張機能「{agent.extension.name}」・提供: {agent.extension.publisher}</p>
      )}
      <p>{agent.description}</p>
      {agent.hasApproval && (
        <p className="muted">この業務には承認の確認が入ります（全 {agent.stepCount} 段階）。</p>
      )}
      {Object.entries(props).map(([key, field]) => (
        <Field
          key={key}
          name={key}
          field={field}
          required={required.has(key)}
          value={values[key] ?? ''}
          onChange={(v) => setValues((s) => ({ ...s, [key]: v }))}
        />
      ))}
      {error && <p className="error">{error}</p>}
      <button className="btn" onClick={submit} disabled={busy} title={hotkey ? `実行する（${hotkey}）` : '実行する'}>
        {busy ? '開始しています…' : '実行'}
        {hotkey && <kbd className="btn-key">{hotkey}</kbd>}
      </button>
    </div>
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
 * 実行の答え（仕様書 第6.2.2節）。
 *
 * @remarks
 * **最後に文を返した段**の応答を使う。途中の段の文には道具の呼び出しが混じるため、
 * その囲みは落とす。落とした結果が空なら、答えは無いものとして扱う。
 */
function answerOf(steps: RunStep[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const raw = (steps[i]?.output as { text?: string } | null)?.text ?? '';
    const text = raw.replace(/```tool[\s\S]*?```/g, '').trim();
    if (text) return text;
  }
  return '';
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
          {run.status === 'awaiting_approval' && (
            <p className="muted small">承認トレイで判断すると、続きから進みます。</p>
          )}
          {canCancel && (
            <button className="btn ghost small" onClick={() => void cancel()} disabled={cancelling}>
              {cancelling ? '止めています…' : '中止'}
            </button>
          )}
        </div>
      )}
      {/* 終わった実行の答えを必ず出す（仕様書 第6.2.2節）。成果物を作らない業務もある */}
      {done && (
        <div className="card">
          <h3>結果</h3>
          {run.failureReason && <p className="error">{run.failureReason}</p>}
          {answer
            ? <div className="reply"><Markdown text={answer} /></div>
            : !run.failureReason && <p className="muted">結果がありません。</p>}
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
          <h3>成果物: {a.title}</h3>
          <pre className="body">{a.body}</pre>
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
                  <span className="muted">（{x.kind === 'approval' ? '承認' : '処理'}）</span>
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
  items: Approval[];
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
        <p className="muted">承認待ちはありません。承認が必要な業務を実行すると、判断できる人のここに届きます。</p>
      </div>
    );
  }

  return (
    <>
      {items.map((a) => (
        <div className="card" key={a.id}>
          <h3>承認の依頼</h3>
          <p className="reply">{a.present}</p>
          <p className="muted">
            {a.approverUserId ? 'あなたが依頼した業務です。内容を確認してください。'
              : `承認できる役割: ${a.approverRole.join(' / ')}`}
          </p>
          <button className="btn" disabled={busy === a.id} onClick={() => decide(a.id, 'approved')}>
            承認する
          </button>{' '}
          <button className="btn danger" disabled={busy === a.id} onClick={() => decide(a.id, 'rejected')}>
            却下する
          </button>
        </div>
      ))}
    </>
  );
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
        ? 'Google との連携を解除したため、読んだメールや文書の中身を消しました。使ったツールの名前だけを残しています。'
        : '保存期間を過ぎたため、読んだメールや文書の中身を消しました。使ったツールの名前だけを残しています。'}
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
