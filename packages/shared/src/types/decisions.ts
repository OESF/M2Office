/**
 * @file 意思決定支援（内蔵の拡張。仕様書 第43章）の型と決まり。
 *
 * 経営者のお題について、慎重の役（反対の立場）と推進の役（賛成の立場）の 2 人の AI が討論し、判定の役がまとめて報告する。
 * **決めるのは経営者**で、AI は判断も、決めたことの実行もしない（第43.12節）。
 * 討論の推移（どの主張に、どの材料でどう反論し、どこで流れが変わったか）を、報告と同じくらい大事な成果として残す（第43.6.2節）。
 */

/** 意思決定支援の拡張機能の ID。 */
export const DECISIONS_EXTENSION_ID = 'decisions';

/** 会社の設定。 */
export interface DecisionSettings {
  enabled: boolean;
}

/** 意思決定支援は既定で切り（第43.2節）。 */
export const DEFAULT_DECISION_SETTINGS: DecisionSettings = { enabled: false };

/** 決まりの数（第43.5節・第43.6節）。 */
export const DECISION_LIMITS = {
  /** ターン数の既定（1 ターンは慎重と推進が 1 回ずつ発言。三浦さんが決めた） */
  turnsDefault: 10,
  /** 指定できるターン数 */
  turnsMin: 1,
  turnsMax: 30,
  /** 本討論に使うのは指定の何割までか（残りは深掘り。第43.6.3節） */
  mainShare: 0.7,
  /** 深掘りする論点の数の上限 */
  digIssuesMax: 3,
  /** これ以下のターン数では深掘りをしない */
  digMinTurns: 3,
  /** 途中のまとめをするターンの間隔 */
  summaryEvery: 3,
  /** 1 回の発言の字数の目安 */
  speechChars: 600,
  /** 1 回の発言の主張の数 */
  claimsMax: 4,
  /** 役に渡す材料の文の上限（字） */
  materialChars: 8000,
  /** 1 つの相談の添付の数と大きさ */
  attachmentsMax: 10,
  attachmentBytesMax: 20 * 1024 * 1024,
  /** お題の字数 */
  topicMax: 2000,
  /** 割り込みの字数 */
  interjectMax: 1000,
  /** ゴミ箱に置く日数 */
  trashDays: 30,
} as const;

/** 話し手。慎重の役（エージェント A）・推進の役（エージェント B）・判定の役（エージェント C）・人。 */
export type DecisionRole = 'con' | 'pro' | 'judge' | 'human';

/** 話し手の名前。 */
export const DECISION_ROLE_LABELS: Record<DecisionRole, string> = { con: '慎重の役', pro: '推進の役', judge: '判定の役', human: '経営者' };

/** 主張の番号の頭（`A3-2` の `A`）。 */
export const DECISION_ROLE_LETTERS: Record<'con' | 'pro', 'A' | 'B'> = { con: 'A', pro: 'B' };

/** 相談の状態。 */
export type DecisionStatus = 'queued' | 'gathering' | 'debating' | 'summarizing' | 'done' | 'stopped' | 'failed';

/** 状態の名前。 */
export const DECISION_STATUS_LABELS: Record<DecisionStatus, string> = {
  queued: '始める前', gathering: '材料を集めています', debating: '討論中', summarizing: '報告をまとめています',
  done: '完了', stopped: '止めた', failed: '失敗',
};

/** 討論の終わった理由（第43.6.1節）。 */
export type DecisionEndReason = 'turns' | 'exhausted' | 'stopped' | 'cost' | 'failed';

/** 終わった理由の名前。 */
export const DECISION_END_LABELS: Record<DecisionEndReason, string> = {
  turns: '指定のターン数に達した', exhausted: '論点が出尽くした', stopped: '途中で止めた', cost: 'AI の費用の上限に当たった', failed: '失敗した',
};

/** 主張の種類（第43.6.2節）。 */
export type DecisionClaimKind = 'new' | 'rebut' | 'counter' | 'support' | 'concede' | 'revise';

/** 種類の名前（役の出力の見出しにもこの名前を書かせる）。 */
export const DECISION_CLAIM_KIND_LABELS: Record<DecisionClaimKind, string> = {
  new: '新しい論点', rebut: '反論', counter: '再反論', support: '裏づけ', concede: '譲歩', revise: '修正案',
};

/** 主張の状態（判定の役が付ける）。 */
export type DecisionClaimState = 'standing' | 'refuted' | 'conceded' | 'unanswered';

/** 状態の名前。 */
export const DECISION_CLAIM_STATE_LABELS: Record<DecisionClaimState, string> = {
  standing: '立っている', refuted: '崩された', conceded: '認められた', unanswered: '答えが無い',
};

/** 論点の優勢。 */
export type DecisionLean = 'con' | 'pro' | 'even' | 'open';

/** 優勢の名前。 */
export const DECISION_LEAN_LABELS: Record<DecisionLean, string> = { con: '慎重が優勢', pro: '推進が優勢', even: '互角', open: '決着前' };

/** 材料の種類。 */
export type DecisionMaterialKind = 'attachment' | 'company' | 'knowledge' | 'data' | 'drive' | 'human';

/** 材料の種類の名前。 */
export const DECISION_MATERIAL_KIND_LABELS: Record<DecisionMaterialKind, string> = {
  attachment: '添付', company: '会社情報', knowledge: '会社の知識', data: '社内のデータ', drive: 'ドライブ', human: '経営者の発言',
};

/** 材料の 1 つ（第43.5節）。 */
export interface DecisionMaterial {
  /** 番号（発言は「材料 3」のように根拠を示す） */
  no: number;
  kind: DecisionMaterialKind;
  title: string;
  /** 出どころ（ツールの名前・ファイルの名前など） */
  source: string;
  /** 要約と、討論に要る数 */
  summary: string;
  /** 読めたか（読めなかったものも一覧に出す。推測で埋めない） */
  ok: boolean;
}

/** 発言の段。本討論か、深掘り（論点の名前つき）か、判定の役のまとめ・突き合わせ・報告か。 */
export type DecisionStage = 'main' | 'dig' | 'summary' | 'compare' | 'report';

/** 発言の 1 つ。全文を残し、画面で略さない（第43.6.2節）。 */
export interface DecisionTurn {
  id: string;
  /** 討論の番号（突き合わせのときの 1・2。人と報告は 0） */
  debate: number;
  /** 相談の中の通し番号 */
  seq: number;
  /** 何ターン目か（判定の役のまとめは、そのときのターン） */
  turn: number;
  stage: DecisionStage;
  /** 深掘りの論点（深掘りのときだけ） */
  issue: string | null;
  role: DecisionRole;
  /** 本文の全文（書きかけの間は書き足す） */
  text: string;
  /** 書き終えたか */
  done: boolean;
  /** 途中で止めたか */
  stopped: boolean;
  /** 形が崩れていたので書き直させたか */
  rewritten: boolean;
  createdAt: string;
  /** 変わるたびに増える番号（画面の差分の受け取りに使う） */
  rev: number;
}

/** 主張の 1 つ（第43.6.2節）。 */
export interface DecisionClaim {
  /** 主張の番号（`A3-2`・`B4-1`・`人2`。討論 2 は `2:A3-2`） */
  code: string;
  debate: number;
  turnId: string;
  role: 'con' | 'pro' | 'human';
  /** 属する論点 */
  issue: string;
  kind: DecisionClaimKind;
  /** 向けた主張の番号（新しい論点は `null`） */
  target: string | null;
  /** 根拠（「材料 3」「A2-1」「推測」） */
  grounds: string[];
  /** 1 行の要旨 */
  gist: string;
  /** 本文（その主張の部分） */
  body: string;
  state: DecisionClaimState;
  /** 状態を付けた理由 */
  stateReason: string;
  /** 崩した主張の番号 */
  refutedBy: string | null;
  /** 分かれ目か */
  pivot: boolean;
}

/** 論点の優勢の 1 つの区切り（第43.6.2節）。 */
export interface DecisionIssueState {
  debate: number;
  issue: string;
  /** 区切り（`t3`・`main`・`dig`・`end`） */
  at: string;
  /** 区切りの名前（「3 ターン」「本討論の終わり」「深掘りの終わり」） */
  label: string;
  lean: DecisionLean;
  /** 優勢を変えた主張の番号 */
  changedBy: string | null;
  reason: string;
}

/** 深掘りの 1 つ（第43.6.3節）。 */
export interface DecisionDig {
  debate: number;
  issue: string;
  /** 決着させたい問い */
  question: string;
  /** 割り当てたターン数 */
  turns: number;
  /** 行ったターン数 */
  used: number;
  /** 人が選んだか */
  byHuman: boolean;
  done: boolean;
}

/** 突き合わせの結果（第43.6.4節）。 */
export interface DecisionComparison {
  /** 見立てがそろったか */
  agreement: 'agree' | 'split';
  /** 割れた論点と理由（本当の争点） */
  splits: { issue: string; reason: string }[];
  /** 片方にしか出なかった論点 */
  onlyIn: { debate: number; issue: string }[];
}

/** 報告の欄（第43.7節）。判定の役が書いた文を見出しごとに分けたもの。 */
export interface DecisionReport {
  /** 見立ての一言 */
  verdict: string;
  /** 見出しごとの本文（「見立て」「本当の争点」「議論の流れ」「分かれ目」「確かめていない前提」「第三の案」「進めるなら」「専門家に確かめること」） */
  sections: { heading: string; body: string }[];
}

/** 報告の見出し（この順に書かせる）。 */
export const DECISION_REPORT_HEADINGS = ['見立て', '本当の争点', '議論の流れ', '分かれ目', '確かめていない前提', '第三の案', '進めるなら', '専門家に確かめること'] as const;

/** 一覧の 1 件。 */
export interface DecisionSummary {
  id: string;
  /** 判断の問い（作る前はお題） */
  title: string;
  status: DecisionStatus;
  verdict: string | null;
  createdBy: string;
  /** 自分の相談か（共有されたものは偽） */
  mine: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 相談の全体（第43.15節）。 */
export interface DecisionSession {
  id: string;
  createdBy: string;
  /** お題（元の文） */
  topic: string;
  /** 判断の問い（AI が言い直したもの） */
  question: string;
  /** 観点 */
  viewpoints: string[];
  /** 指定したターン数（討論ごと） */
  turns: number;
  crossCheck: boolean;
  status: DecisionStatus;
  endReason: DecisionEndReason | null;
  /** 早めに終えたときの根拠など、終わりの説明 */
  endNote: string;
  /** いま誰が話しているか・何ターン目か（画面の上の様子） */
  progress: string;
  /** 材料に無かったもの（判断に要るのに無い材料） */
  missing: string[];
  digs: DecisionDig[];
  comparison: DecisionComparison | null;
  report: DecisionReport | null;
  /** 使った AI（社内・外部） */
  ai: 'local' | 'cloud' | null;
  /** AI の費用の目安（円。分からなければ `null`） */
  costJpy: number | null;
  /** 共有した人 */
  sharedWith: string[];
  createdAt: string;
  updatedAt: string;
  /** 変わるたびに増える番号 */
  rev: number;
}

/** 相談の画面に渡すもの。 */
export interface DecisionDetail {
  session: DecisionSession;
  materials: DecisionMaterial[];
  turns: DecisionTurn[];
  claims: DecisionClaim[];
  issueStates: DecisionIssueState[];
  /** 見ている人が始めた人か（共有・消す・止めるができる） */
  mine: boolean;
  /** この中身の通し番号（画面はこれより後の差分を受け取る） */
  rev: number;
}

/** 画面に流す差分（`GET /v1/decisions/{id}/stream`。第43.11.2節）。 */
export interface DecisionStreamEvent {
  /** この差分の番号（次につなぎ直すときに渡す） */
  rev: number;
  session?: DecisionSession;
  materials?: DecisionMaterial[];
  turns?: DecisionTurn[];
  claims?: DecisionClaim[];
  issueStates?: DecisionIssueState[];
}

/** 新しい相談の依頼。 */
export interface DecisionStartInput {
  topic: string;
  /** ターン数（既定 10） */
  turns?: number;
  crossCheck?: boolean;
  /** 添付（上げたファイルの ID） */
  fileIds?: string[];
}

/** ターン数を、指定できる範囲に収める（既定 10）。 */
export function clampDecisionTurns(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : DECISION_LIMITS.turnsDefault;
  return Math.min(DECISION_LIMITS.turnsMax, Math.max(DECISION_LIMITS.turnsMin, v));
}

/**
 * 本討論に使うターン数（第43.6.3節「配り方」）。指定の 7 割まで（切り上げ）。指定が 3 以下なら全部を本討論に使う。
 */
export function decisionMainTurns(turns: number): number {
  if (turns <= DECISION_LIMITS.digMinTurns) return turns;
  return Math.min(turns, Math.ceil(turns * DECISION_LIMITS.mainShare));
}
