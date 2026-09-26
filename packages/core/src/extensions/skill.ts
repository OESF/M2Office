/**
 * @file スキルの形式（SKILL.md）で書いた業務エージェントを、拡張機能に組み立てる（仕様書 第12.12節、ADR-0029）。
 *
 * SKILL.md は Agent Skills の決まりに準拠する（フロントマターの `name`・`description` と Markdown の本文）。
 * **本文がそのまま業務の指示になる。** M2Office に固有のこと（＋α）は `metadata` の中の `m2office-` で始まる名前で読む。
 * 段と承認の段は書き手に書かせず、ここで組み立てる。中ではこれまでと同じエージェント定義で動く。
 *
 * プログラム（`scripts/` など）は読み込まない（不変則 I-7）。除いたことを知らせる。
 */

import { RISK_ORDER, type AgentDefinition, type AgentStep, type ApprovalStep, type RiskLevel } from '@m2office/shared';
import type { ToolRegistry } from '../tools/registry.js';
import type { ExtensionFiles, ExtensionManifest } from './loader.js';

/** 本文の後ろに添える資料の合計の上限（字。第12.12.3節）。 */
export const SKILL_REFERENCE_MAX_CHARS = 50_000;

/** 道具を書かないときに使う、読むだけの道具（第12.12.2節）。 */
export const SKILL_DEFAULT_TOOLS = ['knowledge.search', 'file.read_text'];

/** 既定の上限（第12.12.3節）。 */
const LIMITS = { maxSteps: 10, maxTokens: 100_000, timeoutSec: 300 };

/** 資料として持ち込めるファイル（Markdown・テキスト）。 */
const REFERENCE = /\.(md|markdown|txt)$/i;

/** フロントマターの値。`metadata` だけが 1 段の入れ子を持つ（Agent Skills の決まり）。 */
export type Frontmatter = Record<string, string | Record<string, string>>;

/**
 * SKILL.md をフロントマターと本文に分ける。
 *
 * @remarks
 * YAML の基本の形だけを読む（依存のパッケージを増やさない。第20.8節）。
 * キーと値、引用符で囲んだ値、複数行の文字（`|`・`>`）、1 段の入れ子（`metadata` など）。
 *
 * @returns フロントマターが無い・閉じていなければ `null`
 */
export function parseSkill(text: string): { frontmatter: Frontmatter; body: string } | null {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return null;
  const lines = m[1]!.split('\n');
  const data: Frontmatter = {};
  let i = 0;
  // 字下げの深さが `min` 以上の行を集めて、複数行の文字にする
  const block = (min: number, folded: boolean): string => {
    const out: string[] = [];
    while (i < lines.length && (lines[i]!.trim() === '' || indent(lines[i]!) >= min)) {
      out.push(lines[i]!.slice(Math.min(min, indent(lines[i]!))));
      i++;
    }
    while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
    return folded ? out.join(' ').replace(/\s+/g, ' ').trim() : out.join('\n');
  };
  const value = (raw: string, childIndent: number): string => {
    const v = raw.trim();
    if (v === '|' || v === '|-' || v === '>' || v === '>-') {
      const first = lines[i];
      return first === undefined ? '' : block(Math.max(indent(first), childIndent), v.startsWith('>'));
    }
    return unquote(v);
  };
  while (i < lines.length) {
    const line = lines[i]!;
    i++;
    if (!line.trim() || line.trim().startsWith('#') || indent(line) > 0) continue;
    const kv = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const rest = kv[2]!.trim();
    if (rest === '' && i < lines.length && indent(lines[i]!) > 0) {
      // 入れ子の対応表（metadata）
      const child: Record<string, string> = {};
      const depth = indent(lines[i]!);
      while (i < lines.length && (lines[i]!.trim() === '' || indent(lines[i]!) >= depth)) {
        const c = /^\s+([A-Za-z0-9_.-]+):(.*)$/.exec(lines[i]!);
        i++;
        if (c) child[c[1]!] = value(c[2]!, depth + 1);
      }
      data[key] = child;
    } else {
      data[key] = value(rest, 1);
    }
  }
  return { frontmatter: data, body: src.slice(m[0].length).trim() };
}

const indent = (line: string) => line.length - line.trimStart().length;

/** 引用符を外す。 */
function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner.replace(/''/g, "'");
  }
  return v;
}

/** 入力の欄の種類（第12.12.2節）。 */
const INPUT_KINDS: Record<string, { format?: string }> = {
  短文: {}, 長文: { format: 'textarea' }, 日付: { format: 'date' }, ファイル: { format: 'file' },
};

/**
 * `m2office-inputs` を入力のスキーマにする。
 *
 * @returns スキーマと、読めなかった行の問題
 */
export function parseInputs(text: string | undefined): { schema: { type: 'object'; required: string[]; properties: Record<string, { type: 'string'; title: string; format?: string }> }; problems: string[] } {
  if (!text?.trim()) {
    return { schema: { type: 'object', required: ['request'], properties: { request: { type: 'string', title: '依頼', format: 'textarea' } } }, problems: [] };
  }
  const properties: Record<string, { type: 'string'; title: string; format?: string }> = {};
  const required: string[] = [];
  const problems: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[-*・\s]+/, '').trim();
    if (!line) continue;
    const m = /^(.+?)\s*[:：]\s*(.+)$/.exec(line);
    const optional = m ? /[（(]任意[）)]/.test(m[2]!) : false;
    const kind = m ? m[2]!.replace(/[（(]任意[）)]/, '').trim() : '';
    if (!m || !(kind in INPUT_KINDS)) {
      problems.push(`m2office-inputs の「${line}」が読めません。「欄の名前: 種類」で、種類は ${Object.keys(INPUT_KINDS).join('・')} のどれかです`);
      continue;
    }
    const name = m[1]!.trim();
    properties[name] = { type: 'string', title: name, ...INPUT_KINDS[kind] };
    if (!optional) required.push(name);
  }
  return { schema: { type: 'object', required, properties }, problems };
}

/** SKILL.md から組み立てた拡張機能のファイルと、知らせること・問題。 */
export interface SkillPackage {
  /** 検証に回すファイル（組み立てた `manifest.json` と `agents/<name>.json` を含む）。 */
  files: ExtensionFiles;
  /** 保存するファイル（元の SKILL.md と資料・アイコン。除いたものを含まない）。 */
  keep: ExtensionFiles;
  /** 取り込みの画面に出すこと（除いたプログラムなど）。 */
  notices: string[];
  problems: string[];
}

/**
 * SKILL.md を含むファイルの集まりを、拡張機能のファイルに組み立てる（仕様書 第12.12.3節）。
 *
 * @param registry 道具の登録簿（道具の危険度で、承認の段を組むかと、扱う最大の危険度を決める）
 */
export function buildSkillPackage(files: ExtensionFiles, registry: ToolRegistry): SkillPackage {
  const notices: string[] = [];
  const problems: string[] = [];
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  const parsed = parseSkill(decode(files.get('SKILL.md') ?? new Uint8Array()));
  const empty = { files: new Map(), keep: new Map(), notices, problems } as SkillPackage;
  if (!parsed) return { ...empty, problems: ['SKILL.md の先頭に、--- で囲んだフロントマター（name と description）がありません'] };
  const fm = parsed.frontmatter;
  const meta = (typeof fm['metadata'] === 'object' ? fm['metadata'] : {}) as Record<string, string>;
  const name = typeof fm['name'] === 'string' ? fm['name'] : '';
  const description = typeof fm['description'] === 'string' ? fm['description'].trim() : '';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    problems.push('name は英小文字・数字・ハイフンで書いてください（64 字まで。例: expense-check）');
  }
  if (!description) problems.push('description がありません。何をするか・いつ使うかを書いてください');
  if (!parsed.body) problems.push('SKILL.md に本文（業務の指示）がありません');

  // 持ち込めるもの: SKILL.md・資料（Markdown・テキスト）・アイコン・README。ほかは除く（第12.12.4節）
  const keep: ExtensionFiles = new Map();
  const dropped: string[] = [];
  const references: { path: string; text: string }[] = [];
  for (const [path, bytes] of files) {
    // 評価のケース（鍵が無い環境での見本の応答。第12.9.4節）も持ち込める
    if (path === 'SKILL.md' || path === 'icon.png' || path === 'README.md' || /^evals\/[^/]+\.json$/.test(path)) { keep.set(path, bytes); continue; }
    if (REFERENCE.test(path) && !path.startsWith('scripts/')) {
      keep.set(path, bytes);
      references.push({ path, text: decode(bytes) });
      continue;
    }
    dropped.push(path);
  }
  if (dropped.length > 0) {
    notices.push(`次のファイルは取り込みませんでした（プログラムは実行せず、画像などの資料は持ち込みません）: ${dropped.join(', ')}。本文がこれらに頼る部分は動きません`);
  }
  const refChars = references.reduce((n, r) => n + r.text.length, 0);
  if (refChars > SKILL_REFERENCE_MAX_CHARS) {
    problems.push(`資料が長すぎます（合計 ${refChars.toLocaleString('ja-JP')} 字。${SKILL_REFERENCE_MAX_CHARS.toLocaleString('ja-JP')} 字まで）`);
  }

  const tools = meta['m2office-tools']
    ? [...new Set(meta['m2office-tools'].split(/[\s、,]+/).map((t) => t.trim()).filter(Boolean))]
    : SKILL_DEFAULT_TOOLS;
  const { schema, problems: inputProblems } = parseInputs(meta['m2office-inputs']);
  problems.push(...inputProblems);
  if (problems.length > 0) return { ...empty, keep, notices, problems };

  const def = compileSkill({
    name, description, body: parsed.body, references, tools, inputs: schema,
    title: meta['m2office-title']?.trim() || name,
    approver: meta['m2office-approver']?.trim() ?? '',
    examples: (meta['m2office-examples'] ?? '').split('\n').map((l) => l.replace(/^[-*・\s]+/, '').trim()).filter(Boolean),
  }, registry);
  const risks = tools.map((t) => registry.get(t)?.risk).filter((r): r is RiskLevel => !!r);
  const manifest: ExtensionManifest = {
    id: meta['m2office-id']?.trim() || `skill.${name}`,
    name: def.name,
    version: /^\d+\.\d+\.\d+$/.test(meta['version'] ?? '') ? meta['version']! : '1.0.0',
    description,
    publisher: { name: meta['author']?.trim() || '自社' },
    platform_schema: '>=1 <2',
    permissions: {
      tools,
      max_risk_level: risks.reduce<RiskLevel>((top, r) => (RISK_ORDER[r] > RISK_ORDER[top] ? r : top), 'read'),
    },
  };
  const out: ExtensionFiles = new Map();
  const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  out.set('manifest.json', encode(manifest));
  out.set(`agents/${name}.json`, encode(def));
  for (const [k, v] of keep) if (k === 'icon.png' || k === 'README.md' || k.startsWith('evals/')) out.set(k, v);
  return { files: out, keep, notices, problems };
}

/**
 * スキルからエージェント定義を組み立てる（仕様書 第12.12.3節）。
 *
 * @remarks
 * 本文を指示にした段を 1 つ作る。送る道具（`external-send` 以上）があれば「作業 → 承認 → 送る」にする。
 * 承認は、社外にもお金にも関わらなければ自動で通る（ADR-0028）。
 */
export function compileSkill(s: {
  name: string; title: string; description: string; body: string;
  references: { path: string; text: string }[];
  tools: string[]; inputs: { properties?: Record<string, unknown> } & Record<string, unknown>; approver: string; examples: string[];
}, registry: ToolRegistry): AgentDefinition {
  const sends = s.tools.filter((t) => {
    const risk = registry.get(t)?.risk;
    return risk ? RISK_ORDER[risk] >= RISK_ORDER['external-send'] : false;
  });
  const works = s.tools.filter((t) => !sends.includes(t));
  const refs = s.references.length === 0 ? '' : [
    '', '---', '以下は、このスキルの書き手が用意した資料です。',
    ...s.references.map((r) => `\n## 資料: ${r.path}\n\n${r.text.trim()}`),
  ].join('\n');
  const work: AgentStep = {
    id: 'work', type: 'agent', label: '作業', tools: works,
    instruction: sends.length > 0
      ? `${s.body}${refs}\n\n---\nこの段では、送る前の作業までを行う。送る中身（宛先・本文など）は、この段の答えに書く。送ることは次の段で行う。`
      : `${s.body}${refs}`,
  };
  const steps: AgentDefinition['steps'] = [work];
  if (sends.length > 0) {
    const byRequester = !s.approver || /依頼|本人/.test(s.approver);
    const roles = /管理者/.test(s.approver) ? ['admin'] : ['admin', 'approver'];
    const gate: ApprovalStep = {
      id: 'approve', type: 'approval', label: '承認',
      ...(byRequester ? { approver: 'requester' as const, approverRole: [] } : { approverRole: roles }),
      present: '送る内容', onReject: 'stop',
    };
    steps.push(gate, {
      id: 'send', type: 'agent', label: '送る', tools: sends, required: [sends[0]!],
      instruction: `${s.body}\n\n---\nこの段では、作業の段の答えに書いた中身を、そのとおりに送る。中身を書き換えない。作業の段で送らないと決めたものは送らない。`,
    });
  }
  const firstField = Object.keys(s.inputs.properties ?? {})[0] ?? 'request';
  return {
    schemaVersion: 1, id: s.name, version: 1, name: s.title, category: 'skill',
    description: s.description, locale: 'ja-JP', compartment: null,
    inputs: s.inputs, tools: s.tools, steps, constraints: [], limits: LIMITS,
    help: {
      summary: s.description,
      ...(s.examples.length > 0 ? { examples: s.examples.map((e) => ({ title: e, input: { [firstField]: e } })) } : {}),
    },
  };
}
