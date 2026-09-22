import { useState } from 'react';
import type { Approval, Artifact, RunStep } from '@m2office/shared';
import { api, type AgentSummary, type JsonSchemaField, type RunDetail } from './api.js';

/**
 * 入力スキーマからフォームを自動生成する（仕様書 FR-202）。
 *
 * エージェントが増えても画面側の実装を変えないため、
 * 定義の `inputs` からフォームを組み立てる。
 */
export function AgentForm({
  agent, onSubmitted,
}: {
  agent: AgentSummary;
  onSubmitted: (runId: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
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
      setError(err instanceof Error ? err.message : '実行を開始できませんでした');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3>{agent.name}</h3>
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

/** 実行の詳細。進捗とステップを表示する（仕様書 FR-305）。 */
export function RunView({ detail }: { detail: RunDetail }) {
  const { run, steps, artifacts } = detail;
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
      </div>
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
    return <div className="card"><p className="muted">承認待ちはありません。</p></div>;
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

/** サッシパネルに出す根拠（仕様書 第18.2節）。 */
export function Evidence({ steps }: { steps: RunStep[] }) {
  const calls = steps.flatMap((s) => {
    const out = s.output as { tools?: { name: string; risk?: string }[] } | null;
    return (out?.tools ?? []).map((t) => ({ step: s.stepId, ...t }));
  });
  if (calls.length === 0) return <p className="muted">まだ根拠はありません。</p>;
  return (
    <dl className="kv">
      {calls.map((c, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{c.step}</dt>
          <dd>{c.name}{c.risk ? `（${c.risk}）` : ''}</dd>
        </div>
      ))}
    </dl>
  );
}
