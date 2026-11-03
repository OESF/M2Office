/**
 * @file 稼働状況の全体の状態（仕様書 第23.8.7節「全体の状態」）。区分ごとの材料から「平常」「注意」「警戒」と、対応が要るもの（すること付き）を決める。
 *
 * 画面が判断まで行い、上から「全体の状態」「対応が要るもの」「区分ごとの札」の 3 段で答えるための処理。
 * 判断の決まりは運営者マニュアル 第 7 章の「気にする目安」を決まりにしたもの。することは決まりごとに決めた文で、AI に作らせない
 * （いざというときに、毎回同じことが出るように）。材料を読めなかった区分は、平常とみなさず注意にする（推測しない）。
 */

import type { RuntimeEnvironment } from '@m2office/shared';
import type { CloudBackupView } from './cloud-backup.js';
import type { EdgeStatusView } from './edge-status.js';
import type { ServerStatus, TenantOverview } from './store.js';

/** 区分。 */
export type OpsHealthArea = 'jobs' | 'resources' | 'backup' | 'security' | 'external' | 'runtime' | 'tenants' | 'ai';

/** 状態（平常・注意・警戒）。 */
export type OpsHealthLevel = 'normal' | 'caution' | 'alert';

/** 対応が要るもの 1 件。 */
export interface OpsHealthItem {
  area: OpsHealthArea;
  level: 'caution' | 'alert';
  /** 何が（短い見出し）。 */
  title: string;
  /** 詳しい数（無ければ `null`）。 */
  detail: string | null;
  /** すること（誰が何をするか）。 */
  action: string;
  /** 手順。運営者マニュアルの章（`07-server`）か、運営の画面（`page:tenants`）。 */
  guide: string;
}

/** 区分ごとの札。 */
export interface OpsHealthAreaView {
  area: OpsHealthArea;
  label: string;
  level: OpsHealthLevel;
  /** 一言（平常なら代表の数、そうでなければ最初の問題の見出し）。 */
  summary: string;
}

/** 全体の状態。 */
export interface OpsHealthView {
  level: OpsHealthLevel;
  /** 警戒を先に並べた、対応が要るもの。 */
  items: OpsHealthItem[];
  /** 区分ごとの札（出す区分だけ。決まった順）。 */
  areas: OpsHealthAreaView[];
}

/** 材料。省いた区分は出さない。`null` は「読めなかった」（注意にする）。 */
export interface OpsHealthInput {
  status?: ServerStatus | null;
  runtime?: RuntimeEnvironment | null;
  /** バックアップを入れる形（クラウドの形で、結果のファイルの置き場を決めてある）のときだけ渡す。 */
  backup?: CloudBackupView | null;
  /** セキュリティを集める形のときだけ渡す。 */
  edge?: EdgeStatusView | null;
  tenants?: TenantOverview[] | null;
  /** 運営の鍵の今月の AI の費用と全体の上限（決めていなければ `capJpy` は `null`）。 */
  platformAi?: { usedJpy: number; capJpy: number | null } | null;
}

/** 区分の名前（札の順）。 */
export const OPS_HEALTH_AREAS: { area: OpsHealthArea; label: string }[] = [
  { area: 'jobs', label: '業務の実行' },
  { area: 'resources', label: 'サーバーの資源' },
  { area: 'backup', label: 'バックアップ' },
  { area: 'security', label: 'セキュリティ' },
  { area: 'external', label: '外部の接続' },
  { area: 'runtime', label: '稼働環境' },
  { area: 'tenants', label: '会社' },
  { area: 'ai', label: 'AI の費用' },
];

/** 判断の決まりの数（第23.8.7節「全体の状態」の表）。 */
export const OPS_HEALTH_RULES = {
  /** ワーカーが応答しないとみなす、最後の応答からの長さ（3 分）。 */
  workerSilentMs: 3 * 60_000,
  /** 待ちが詰まっているとみなす、最も古い待ちの長さ（5 分）。 */
  queueOldMs: 5 * 60_000,
  /** 失敗が多いとみなす割合と、判断する件数の下限。 */
  failRatio: 0.2,
  failMinRuns: 10,
  /** ディスク・データベースの接続の注意と警戒（%）。 */
  diskCaution: 80, diskAlert: 90,
  memCaution: 90,
  dbCaution: 80, dbAlert: 90,
  /** 会社の失敗が多いとみなす、30 日の件数の下限（割合は `failRatio`）。 */
  tenantFailMinRuns: 5,
  /** AI の費用が急に増えたとみなす倍率と、今月の費用の下限（円）。 */
  aiGrowthRatio: 2, aiGrowthMinJpy: 1000,
  /** 運営の鍵の全体の上限の注意（割合）。 */
  aiCapCaution: 0.8,
} as const;

const n = (v: number) => Math.round(v).toLocaleString('ja-JP');
const pct = (v: number) => `${Math.round(v)}%`;
const yen = (v: number) => `${n(v)} 円`;
/** 日本時間の「11/3 18:45」。 */
export function jstShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = Object.fromEntries(new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p['month']}/${p['day']} ${p['hour']}:${p['minute']}`;
}

type Push = (level: OpsHealthItem['level'], title: string, detail: string | null, action: string, guide: string) => void;
/** 区分ごとの判断。対応が要るものを足し、平常のときの一言を返す。 */
type Judge = (push: Push) => string;

/** 業務の実行（待ち行列・実行・ワーカー・定時実行）。 */
function jobs(s: ServerStatus, now: number): Judge {
  return (push) => {
    const last = s.workers[0]?.at ?? null;
    if (!last || now - Date.parse(last) > OPS_HEALTH_RULES.workerSilentMs) {
      push('alert', 'ワーカーが応答しません', `最終応答 ${jstShort(last)}`, '業務が止まっています。技術者に連絡し、ワーカーを起動し直してもらう（systemctl status m2office-worker）', '07-server');
    }
    if (s.queue.oldestQueuedAt && now - Date.parse(s.queue.oldestQueuedAt) > OPS_HEALTH_RULES.queueOldMs) {
      push('caution', '待ちが詰まっています', `待ち ${n(s.queue.queued)} 件・最も古い ${jstShort(s.queue.oldestQueuedAt)}`, 'ワーカーが稼働中かを見る。続くなら技術者に連絡する', '07-server');
    }
    if (s.schedulesLate > 0) {
      push('caution', '遅れている定時実行があります', `${n(s.schedulesLate)} 件`, 'ワーカーの止まりか待ちの詰まりを疑う。続くなら技術者に連絡する', '07-server');
    }
    if (s.runs.hour >= OPS_HEALTH_RULES.failMinRuns && s.runs.hourFailed / s.runs.hour >= OPS_HEALTH_RULES.failRatio) {
      push('caution', '業務の失敗が増えています', `直近 1 時間 ${n(s.runs.hourFailed)} ／ ${n(s.runs.hour)} 件（${pct((s.runs.hourFailed / s.runs.hour) * 100)}）`,
        '外部の接続で AI や Google の障害を確かめる。1 社に偏っていれば、会社一覧の「失敗」の印で確かめる', '07-server');
    }
    const failed = s.runs.hour ? pct((s.runs.hourFailed / s.runs.hour) * 100) : '—';
    return `待ち ${n(s.queue.queued)}・失敗 ${failed}・ワーカー稼働中`;
  };
}

/** サーバーの資源（ディスク・メモリー・CPU・データベースの接続）。 */
function resources(env: RuntimeEnvironment): Judge {
  return (push) => {
    const m = env.machine;
    if (!m) {
      push('caution', 'サーバーの資源を読めませんでした', null, 'API の知らせが届いていません。続くなら技術者に知らせる', '07-server');
      return '読めませんでした';
    }
    const disk = m.diskTotal && m.diskFree !== null ? (1 - m.diskFree / m.diskTotal) * 100 : null;
    const mem = m.memTotal && m.memFree !== null ? (1 - m.memFree / m.memTotal) * 100 : null;
    const freeText = m.diskFree !== null ? `・空き ${(m.diskFree / 1e9).toFixed(1)} GB` : '';
    if (disk !== null && disk >= OPS_HEALTH_RULES.diskAlert) {
      push('alert', 'ディスクがいっぱいに近づいています', `使用 ${pct(disk)}${freeText}`, 'すぐに技術者に連絡し、容量を足すか、要らないファイルを片付けてもらう（いっぱいになるとデータベースが止まる）', '07-server');
    } else if (disk !== null && disk >= OPS_HEALTH_RULES.diskCaution) {
      push('caution', 'ディスクの使用量が 80% を超えました', `使用 ${pct(disk)}${freeText}`, '技術者と容量を足す相談を始める', '07-server');
    }
    if (mem !== null && mem >= OPS_HEALTH_RULES.memCaution) {
      const swap = m.swapTotal ? `・Swap ${pct((1 - (m.swapFree ?? 0) / m.swapTotal) * 100)}` : '';
      push('caution', 'メモリーが足りなくなりかけています', `使用 ${pct(mem)}${swap}`, '続き、Swap も増えるなら、技術者とサーバーの大きさを上げる相談をする', '07-server');
    }
    if (m.load && m.cores && m.load[2] > m.cores) {
      push('caution', 'CPU の負荷が高い状態が続いています', `15 分の平均 ${pct((m.load[2] / m.cores) * 100)}`, '処理の暴走か攻撃を疑う。続くなら技術者に連絡する', '07-server');
    }
    const db = env.database;
    if (db && db.max > 0) {
      const used = (db.connections / db.max) * 100;
      const detail = `${n(db.connections)} ／ ${n(db.max)}`;
      if (used >= OPS_HEALTH_RULES.dbAlert) push('alert', 'データベースの接続が上限に近づいています', detail, 'すぐに技術者に連絡する（上限に届くと、画面が使えなくなる）', '07-server');
      else if (used >= OPS_HEALTH_RULES.dbCaution) push('caution', 'データベースの接続が多くなっています', detail, '技術者に知らせる', '07-server');
    }
    return [disk !== null ? `ディスク ${pct(disk)}` : null, mem !== null ? `メモリー ${pct(mem)}` : null].filter(Boolean).join('・') || '—';
  };
}

/** バックアップ（クラウドの形の毎晩のバックアップと変更の記録）。 */
function backup(b: CloudBackupView): Judge {
  return (push) => {
    if (!b.configured) {
      push('caution', 'バックアップが未導入です', null, '技術者に入れてもらう（運営者マニュアル 第 13 章）', '13-vps-m2office-setup');
      return '未導入';
    }
    const last = b.last;
    if (!last) {
      push('caution', 'バックアップをまだ一度も取っていません', null, '毎晩 2 時過ぎに取ります。翌朝も取れていなければ、技術者に連絡する', '17-backup-recovery');
      return 'まだ取っていません';
    }
    if (!last.ok) {
      const why = [last.database.error && `データベース: ${last.database.error}`, last.files.error && `ファイル: ${last.files.error}`].filter(Boolean).join(' ／ ');
      push('alert', '毎晩のバックアップに失敗しました', `${jstShort(last.at)}${why ? `・${why}` : ''}`, '技術者に連絡する（第 17 章「3.1」）。それまでのバックアップは残っています', '17-backup-recovery');
    } else if (b.stale) {
      push('alert', 'バックアップが止まっています', `最終 ${jstShort(last.at)}（26 時間より前）`, '技術者に連絡する（第 17 章「3.1」）', '17-backup-recovery');
    }
    if (b.archiveFailing) {
      push('alert', '変更の記録を送れていません', `最終更新 ${jstShort(b.archive?.lastArchivedAt)}`, '技術者に連絡する（第 17 章「3.2」）。このままだとサーバーのディスクが埋まる', '17-backup-recovery');
    }
    if (last.check && !last.check.ok) {
      push('alert', 'データチェックが異常です', `${jstShort(last.check.at)}${last.check.error ? `・${last.check.error}` : ''}`, 'バックアップが壊れているおそれがあります。技術者に連絡する', '17-backup-recovery');
    }
    return `取得完了 ${jstShort(last.at)}`;
  };
}

/** セキュリティ（入口の守りと VPN。判断は `edgeLevel`）。 */
function security(e: EdgeStatusView): Judge {
  return (push) => {
    if (!e.configured || !e.level) {
      push('caution', 'セキュリティの数を集める仕組みが未導入です', null, '技術者に setup.sh を走らせ直してもらう（運営者マニュアル 第 13 章）', '13-vps-m2office-setup');
      return '未導入';
    }
    for (const f of e.findings) push(f.level, f.text, null, f.action, '07-server');
    const l = e.last;
    const v = (x: number | null | undefined) => (typeof x === 'number' ? n(x) : '—');
    return `直近 24 時間 攻撃 ${v(l?.crowdsec?.alerts24h)}・WAF ${v(l?.waf?.hits24h)}`;
  };
}

/** 外部の接続（接続先ごとの 24 時間の失敗の割合）。 */
function external(s: ServerStatus): Judge {
  const group: Record<string, string> = { ai: 'AI', google: 'Google', mcp: '会社の接続（MCP）' };
  return (push) => {
    let ok = 0; let fail = 0;
    for (const t of s.targets) {
      ok += t.ok; fail += t.fail;
      const total = t.ok + t.fail;
      if (total >= OPS_HEALTH_RULES.failMinRuns && t.fail / total >= OPS_HEALTH_RULES.failRatio) {
        push('caution', `${group[t.group] ?? t.group}の呼び出しの失敗が多くなっています`, `24 時間 ${n(t.fail)} ／ ${n(total)} 件（${pct((t.fail / total) * 100)}）`,
          '相手のサービスの障害の情報を確かめる。続くなら技術者に知らせる', '07-server');
      }
    }
    return ok + fail ? `失敗 ${pct((fail / (ok + fail)) * 100)}（24 時間）` : 'まだありません';
  };
}

/** 稼働環境（Node.js のサポートとセキュリティの修正・版のずれ）。 */
function runtime(env: RuntimeEnvironment): Judge {
  return (push) => {
    if (env.nodeSecurity) {
      const secure = env.nodeSecurity[0]?.secure ?? '';
      push('alert', 'Node.js にセキュリティの修正があります', `${env.nodeSecurity.map((x) => `${x.role === 'api' ? 'API' : 'ワーカー'} ${x.version}`).join('・')}（${secure} 以上に）`,
        'できるだけ早く、技術者に Node.js の更新を頼む（M2Office は止まらない）', '07-server');
    }
    if (env.nodeWarn?.expired) {
      push('alert', 'Node.js のサポートが終わっています', env.nodeWarn.version, '技術者に、新しい LTS の版への更新を頼む', '07-server');
    } else if (env.nodeWarn) {
      push('caution', 'Node.js のサポートの終わりが近づいています', `${env.nodeWarn.version}（${env.nodeWarn.end ?? '近く'} まで）`, '技術者に、新しい LTS の版への更新を頼む', '07-server');
    }
    if (env.api?.version && env.worker?.version && env.api.version !== env.worker.version) {
      push('caution', 'ワーカーと API の版が違います', `API ${env.api.version}・ワーカー ${env.worker.version}`, '更新が途中で止まったおそれがあります。技術者に知らせる', '07-server');
    }
    const node = env.api?.node.version ?? env.worker?.node.version ?? null;
    return [env.api?.version ? `v${env.api.version}` : null, node ? `Node.js ${node.replace(/^v/, '').split('.')[0]}` : null].filter(Boolean).join('・') || '—';
  };
}

/** 会社（失敗が多い会社・重い不正の兆しがある会社）。 */
function tenants(rows: TenantOverview[]): Judge {
  return (push) => {
    const live = rows.filter((t) => t.status !== 'cancelled');
    const failing = live.filter((t) => t.runs30d >= OPS_HEALTH_RULES.tenantFailMinRuns && t.runsFailed30d / t.runs30d >= OPS_HEALTH_RULES.failRatio);
    if (failing.length) push('caution', `失敗が多い会社が ${failing.length} 社あります`, failing.slice(0, 3).map((t) => t.name).join('・') + (failing.length > 3 ? ' ほか' : ''), '会社一覧の「失敗が多い」の印で確かめ、会社の詳細の「稼働」で、どの業務・どの接続先かを見る', 'page:tenants');
    const risky = live.filter((t) => (t.securityHigh24h ?? 0) > 0);
    if (risky.length) push('caution', `重い不正の兆しがある会社が ${risky.length} 社あります`, risky.slice(0, 3).map((t) => t.name).join('・') + (risky.length > 3 ? ' ほか' : ''), '会社の詳細で中身を確かめ、必要なら停止を申請する', 'page:tenants');
    return `${live.length} 社`;
  };
}

/** AI の費用（運営の鍵の全体の上限・前の月との比べ）。 */
function ai(s: ServerStatus | null, p: OpsHealthInput['platformAi']): Judge {
  return (push) => {
    if (p?.capJpy) {
      if (p.usedJpy >= p.capJpy) push('alert', '運営の鍵の AI の費用が全体の上限に届きました', `${yen(p.usedJpy)} ／ ${yen(p.capJpy)}`, '運営の鍵を使う会社の AI が止まっています。設定で上限を見直すか、来月まで待つ', 'page:settings');
      else if (p.usedJpy >= p.capJpy * OPS_HEALTH_RULES.aiCapCaution) push('caution', '運営の鍵の AI の費用が全体の上限の 8 割を超えました', `${yen(p.usedJpy)} ／ ${yen(p.capJpy)}`, '会社一覧の「今月の AI」で、どの会社が使っているかを見る。要るなら設定で上限を見直す', 'page:settings');
    }
    if (s) {
      const month = Number(s.ai.month); const before = Number(s.ai.lastMonthSamePeriod);
      if (month >= OPS_HEALTH_RULES.aiGrowthMinJpy && month >= before * OPS_HEALTH_RULES.aiGrowthRatio) {
        push('caution', 'AI の費用が前の月の 2 倍を超えました', `今月 ${yen(month)}・前の月の同じ時期 ${yen(before)}`, '会社一覧の「今月の AI」で、どの会社が増えたかを見る', 'page:tenants');
      }
      return `今月 ${yen(month)}`;
    }
    return '—';
  };
}

/**
 * 全体の状態を決める（第23.8.7節「全体の状態」）。
 *
 * @param input 区分ごとの材料。省いた区分は札を出さず、`null`（読めなかった）は注意にする
 * @returns 全体の状態・対応が要るもの（警戒を先に）・区分ごとの札
 */
export function opsHealth(input: OpsHealthInput, now: number = Date.now()): OpsHealthView {
  const items: OpsHealthItem[] = [];
  const areas: OpsHealthAreaView[] = [];
  const judges: Partial<Record<OpsHealthArea, Judge | null>> = {};
  if ('status' in input) { judges.jobs = input.status ? jobs(input.status, now) : null; judges.external = input.status ? external(input.status) : null; }
  if ('runtime' in input) { judges.resources = input.runtime ? resources(input.runtime) : null; judges.runtime = input.runtime ? runtime(input.runtime) : null; }
  if ('backup' in input) judges.backup = input.backup ? backup(input.backup) : null;
  if ('edge' in input) judges.security = input.edge ? security(input.edge) : null;
  if ('tenants' in input) judges.tenants = input.tenants ? tenants(input.tenants) : null;
  if ('status' in input || 'platformAi' in input) judges.ai = input.status === null && input.platformAi === null ? null : ai(input.status ?? null, input.platformAi);
  for (const { area, label } of OPS_HEALTH_AREAS) {
    if (!(area in judges)) continue;
    const judge = judges[area];
    const mine: OpsHealthItem[] = [];
    const push: Push = (level, title, detail, action, guide) => mine.push({ area, level, title, detail, action, guide });
    let summary: string;
    if (judge) summary = judge(push);
    else { push('caution', `${label}を読めませんでした`, null, '続くなら技術者に知らせる', '07-server'); summary = '読めませんでした'; }
    mine.sort((a, b) => (a.level === b.level ? 0 : a.level === 'alert' ? -1 : 1));
    const level: OpsHealthLevel = mine.some((i) => i.level === 'alert') ? 'alert' : mine.length ? 'caution' : 'normal';
    areas.push({ area, label, level, summary: mine[0]?.title ?? summary });
    items.push(...mine);
  }
  items.sort((a, b) => (a.level === b.level ? 0 : a.level === 'alert' ? -1 : 1));
  return { level: items.some((i) => i.level === 'alert') ? 'alert' : items.length ? 'caution' : 'normal', items, areas };
}
