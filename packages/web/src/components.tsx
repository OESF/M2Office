/**
 * @file 画面の部品。入力フォームの自動生成・実行の詳細・承認トレイ・根拠の表示。
 *
 * @see 仕様書 第6章 ユーザー体験
 */

import { useState } from 'react';
import type { Approval, Artifact, RunStep } from '@m2office/shared';
import { api, describeError, type AgentSummary, type JsonSchemaField, type RunDetail } from './api.js';
import { AgentHelpPanel, Markdown, openHelp } from './help.js';

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
  agent, onSubmitted, initial,
}: {
  agent: AgentSummary;
  onSubmitted: (runId: string) => void;
  /** 初めから入れておく値。秘書に渡したファイルを引き継ぐのに使う（仕様書 第10.10.3節）。 */
  initial?: Record<string, string>;
}) {
  const [values, setValues] = useState<Record<string, string>>(initial ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const props = agent.inputs?.properties ?? {};
  const required = new Set(agent.inputs?.required ?? []);

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
    <AgentHelpPanel agentId={agent.id} onExample={(input) =>
      setValues(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v ?? '')])))} />
    <div className="card">
      <h3>{agent.name}</h3>
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
      <button className="btn" onClick={submit} disabled={busy}>
        {busy ? '開始しています…' : '実行する'}
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
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      {field.format === 'textarea' ? (
        <textarea id={name} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={name} value={value} onChange={(e) => onChange(e.target.value)} />
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
 * 実行の詳細。進捗とステップを表示する（仕様書 FR-305）。
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
  const done = run.status === 'completed' || run.status === 'failed';
  const answer = answerOf(steps);

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
      <div className="card">
        <h3>
          実行の状況 <span className={`status ${run.status}`}>{statusLabel(run.status)}</span>
        </h3>
        <dl className="kv">
          <dt>実行 ID</dt><dd>{run.id}</dd>
          <dt>進捗</dt><dd>{run.cursor} / {steps.length} ステップ</dd>
          <dt>消費</dt><dd>{run.tokensUsed} トークン（約 {run.costJpy} 円）</dd>
          {run.failureReason && (<><dt>理由</dt><dd>{run.failureReason}</dd></>)}
        </dl>
        {canCancel && (
          <button className="btn ghost small" onClick={() => void cancel()} disabled={cancelling}>
            {cancelling ? '止めています…' : '中止'}
          </button>
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
      </div>
      {/* 終わった実行の答えを必ず出す（仕様書 第6.2.2節）。成果物を作らない業務もある */}
      {done && (
        <div className="card">
          <h3>結果</h3>
          {answer
            ? <div className="reply"><Markdown text={answer} /></div>
            : <p className="muted">結果がありません。ステップと根拠をご確認ください。</p>}
        </div>
      )}
      <div className="card">
        <h3>ステップ</h3>
        <ul className="steps">
          {steps.map((s) => (
            <li key={s.id}>
              <span className="seq">{s.seq + 1}</span>
              <span className="name">
                {s.stepId}
                <span className="muted">（{s.kind === 'approval' ? '承認' : '処理'}）</span>
              </span>
              <span className={`status ${s.status}`}>{statusLabel(s.status)}</span>
            </li>
          ))}
        </ul>
      </div>
      {/* 業務の実行の根拠。結果の隣で読む（仕様書 第6.2節、ADR-0020） */}
      <div className="card">
        <h3>実行した処理</h3>
        <Evidence steps={steps} />
      </div>
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
