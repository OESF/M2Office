/**
 * @file 定時実行の画面。登録・編集・削除・停止と再開・今すぐ実行。
 *
 * @see 仕様書 第6.1.7節 定時実行の画面
 */

import { useCallback, useEffect, useState } from 'react';
import type { ScheduleRule } from '@m2office/shared';
import { api, describeError, type AgentSummary, type ScheduleView } from './api.js';
import { InputFields } from './components.js';

type Kind = ScheduleRule['kind'];

const KIND_LABELS: Record<Kind, string> = { daily: '毎日', weekdays: '毎平日（月〜金）', weekly: '毎週' };
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * 本人の定時実行の一覧と、登録・編集の欄。
 *
 * @remarks 本人の定時実行だけを出す。削除は確かめずに行う（社外にもお金にも関わらない。ADR-0028）
 */
export function Schedules({ agents, reloadKey }: {
  agents: AgentSummary[];
  /** 変わるたびに読み直す。秘書に頼んで止めた・再開したことを一覧に映すのに使う（仕様書 第10.9.8節）。 */
  reloadKey?: string;
}) {
  const [items, setItems] = useState<ScheduleView[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 開いている欄。新しく登録するなら 'new'、編集なら定時実行の ID
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const load = useCallback(() => {
    api.schedules().then((r) => setItems(r.items)).catch((err) => setMessage(describeError(err)));
  }, []);
  useEffect(load, [load, reloadKey]);

  const nameOf = (agentId: string) => agents.find((a) => a.id === agentId)?.name ?? agentId;
  const act = (run: () => Promise<unknown>, done?: string) => {
    setMessage(null);
    run().then(() => { if (done) setMessage(done); load(); }).catch((err) => setMessage(describeError(err)));
  };
  const saved = () => { setEditing(null); load(); };

  if (!items) return message ? <p className="error">{message}</p> : <p className="muted">読み込み中…</p>;
  return (
    <>
      {message && <p className="muted">{message}</p>}
      {editing === 'new' ? (
        <ScheduleEditor agents={agents} onSaved={saved} onCancel={() => setEditing(null)} />
      ) : (
        <div className="row schedule-add">
          <button className="btn small" onClick={() => setEditing('new')}>追加</button>
        </div>
      )}
      {items.length === 0 && editing !== 'new' && <p className="muted">定時実行はありません。</p>}
      {items.map((s) => editing === s.id ? (
        <ScheduleEditor key={s.id} agents={agents} schedule={s} onSaved={saved} onCancel={() => setEditing(null)} />
      ) : (
        <div key={s.id} className="card">
          <h3>
            {nameOf(s.agentId)}{' '}
            <span className={`status ${s.enabled ? 'succeeded' : ''}`}>{s.enabled ? '有効' : '停止中'}</span>
          </h3>
          <dl className="kv">
            <dt>繰り返し</dt><dd>{s.label}</dd>
            <dt>次回</dt><dd>{s.enabled ? localTime(s.nextRunAt, s.timezone) : '—'}</dd>
            <dt>前回</dt><dd>{s.lastRunAt ? localTime(s.lastRunAt, s.timezone) : 'まだ実行していません'}</dd>
          </dl>
          <div className="row">
            <button className="btn ghost small" onClick={() => setEditing(s.id)}>編集</button>
            <button className="btn ghost small" onClick={() => act(() => api.updateSchedule(s.id, { enabled: !s.enabled }))}>
              {s.enabled ? '停止する' : '再開する'}
            </button>
            <button className="btn ghost small" onClick={() =>
              act(() => api.triggerSchedule(s.id), '次の見回りで実行します。結果は「お知らせ」と「実行履歴」に出ます。')}>
              今すぐ実行
            </button>
            <button className="btn danger small" onClick={() => act(() => api.deleteSchedule(s.id), `「${nameOf(s.agentId)}」の定時実行を削除しました。`)}>
              削除
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * 登録・編集の欄。業務・繰り返し・時刻・業務の入力。
 *
 * @remarks 編集では業務を変えない（変えたいときは削除して登録し直す。仕様書 第6.1.7節）
 */
function ScheduleEditor({ agents, schedule, onSaved, onCancel }: {
  agents: AgentSummary[];
  schedule?: ScheduleView;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const choices = agents.filter((a) => a.schedulable !== false);
  const [agentId, setAgentId] = useState(schedule?.agentId ?? choices[0]?.id ?? '');
  const [kind, setKind] = useState<Kind>(schedule?.rule.kind ?? 'weekdays');
  const [weekday, setWeekday] = useState(schedule?.rule.kind === 'weekly' ? schedule.rule.weekday : 1);
  const [time, setTime] = useState(schedule ? `${pad(schedule.rule.hour)}:${pad(schedule.rule.minute)}` : '08:00');
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(schedule?.input ?? {}).map(([k, v]) => [k, String(v ?? '')])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = agents.find((a) => a.id === agentId);

  async function save() {
    const [hour, minute] = time.split(':').map(Number);
    if (!agentId || hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) {
      setError('業務と時刻を選んでください');
      return;
    }
    const rule: ScheduleRule = kind === 'weekly' ? { kind, weekday, hour, minute } : { kind, hour, minute };
    // 空の欄は渡さない（任意の欄は業務の既定に任せる）
    const input = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ''));
    setBusy(true);
    setError(null);
    try {
      if (schedule) await api.updateSchedule(schedule.id, { rule, input });
      else await api.createSchedule(agentId, rule, input);
      onSaved();
    } catch (err) {
      setError(describeError(err, '保存できませんでした'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="field">
        <label htmlFor="schedule-agent">業務</label>
        {schedule ? (
          <input id="schedule-agent" value={agent?.name ?? schedule.agentId} disabled />
        ) : (
          <select id="schedule-agent" value={agentId} onChange={(e) => { setAgentId(e.target.value); setValues({}); }}>
            {choices.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
      </div>
      <div className="schedule-when">
        <div className="field">
          <label htmlFor="schedule-kind">繰り返し</label>
          <select id="schedule-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {(Object.keys(KIND_LABELS) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </select>
        </div>
        {kind === 'weekly' && (
          <div className="field">
            <label htmlFor="schedule-weekday">曜日</label>
            <select id="schedule-weekday" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
              {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}曜</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="schedule-time">時刻</label>
          <input id="schedule-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
      </div>
      {agent && <InputFields agent={agent} values={values} onChange={(key, v) => setValues((s) => ({ ...s, [key]: v }))} />}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn" onClick={() => void save()} disabled={busy}>{busy ? '保存しています…' : '保存'}</button>
        <button className="btn ghost" onClick={onCancel} disabled={busy}>キャンセル</button>
      </div>
    </div>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 定時実行の地域の時刻で出す。 */
function localTime(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: timezone });
}
