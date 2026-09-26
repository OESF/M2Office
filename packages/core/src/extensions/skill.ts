/**
 * @file スキル（SKILL.md）で書いた業務エージェントを、拡張機能に組み立てる（仕様書 第12.12節、ADR-0029）。
 *
 * **エンジニアが知っているスキル（Claude Code の Skills・Agent Skills）の書き方のまま読む。**
 * スキルの項目は、M2Office で意味のあるものは同じ意味で効かせ（`name`・`description`・`when_to_use`・`argument-hint`・
 * `arguments` と `$ARGUMENTS` の置き換え・`disable-model-invocation`・`user-invocable`・`effort`・補助のファイル）、
 * 意味の無いものは無視して知らせる。M2Office で覚えることは 4 つだけ（第12.12.1節）:
 * 道具は `allowed-tools` に M2Office の道具を書く・利用者向けの説明は `HELP.md`・プログラムは動かない・承認は書かない。
 *
 * プログラム（`scripts/`、本文の `` !`コマンド` ``）は読み込まず、実行しない（不変則 I-7）。
 */

import { RISK_ORDER, type AgentDefinition, type AgentStep, type ApprovalStep, type RiskLevel } from '@m2office/shared';
import type { ToolRegistry } from '../tools/registry.js';
import type { ExtensionFiles, ExtensionManifest } from './loader.js';

/** 補助のファイルの合計の上限（字。第12.12.2節）。 */
export const SKILL_FILES_MAX_CHARS = 500_000;

/** 道具を書かないときに使う、読むだけの道具（第12.12.1節）。 */
export const SKILL_DEFAULT_TOOLS = ['knowledge.search', 'file.read_text'];

/** 補助のファイルを読む道具（第12.12.2節）。補助のファイルがあるときだけ足す。 */
export const SKILL_READ_TOOL = 'skill.read';

/** フォルダの名前を覚えておくための、パッケージの中の印（`name` を省いたとき。第12.12.2節）。 */
export const SKILL_FOLDER_ENTRY = '.skill-folder';

/** 既定の上限（第12.12.5節）。 */
const LIMITS = { maxSteps: 10, maxTokens: 100_000, timeoutSec: 300 };

/** 補助のファイルとして持ち込めるもの（Markdown・テキスト）。 */
const TEXT_FILE = /\.(md|markdown|txt)$/i;

/** M2Office で使わないスキルの項目。取り込みの画面で知らせる（第12.12.2節）。 */
const IGNORED_FIELDS: Record<string, string> = {
  model: 'M2Office は会社の Gemini で動きます',
  context: 'M2Office の業務は、もともと 1 件ずつ独立して動きます',
  agent: 'M2Office の業務は、もともと 1 件ずつ独立して動きます',
  background: 'M2Office の業務は、もともと 1 件ずつ独立して動きます',
  'disallowed-tools': 'M2Office では、allowed-tools に書いた道具しか使えません',
  hooks: 'M2Office ではフックを動かしません',
  paths: 'M2Office にはファイルの場所がありません',
  shell: 'M2Office はコマンドを動かしません',
};

/** effort から推論の強さへ（第12.12.2節）。 */
const EFFORT_TIER: Record<string, AgentDefinition['tier']> = {
  low: 'fast', medium: 'standard', high: 'standard', xhigh: 'advanced', max: 'advanced',
};

/** フロントマターの値。一覧（`arguments` など）と、1 段の入れ子（`metadata`）を持てる。 */
export type Frontmatter = Record<string, string | string[] | Record<string, string>>;

/**
 * SKILL.md をフロントマターと本文に分ける。フロントマターが無ければ、全体を本文として読む（スキルと同じく、すべての項目は任意）。
 *
 * @remarks
 * YAML の基本の形だけを読む（依存のパッケージを増やさない。第20.8節）。
 * キーと値・引用符・複数行の文字（`|`・`>`）・一覧（`[a, b]` と `- a`）・1 段の入れ子（`metadata`）。
 */
export function parseSkill(text: string): { frontmatter: Frontmatter; body: string } {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { frontmatter: {}, body: src.trim() };
  const lines = m[1]!.split('\n');
  const data: Frontmatter = {};
  let i = 0;
  const block = (min: number, folded: boolean): string => {
    const out: string[] = [];
    while (i < lines.length && (lines[i]!.trim() === '' || indent(lines[i]!) >= min)) {
      out.push(lines[i]!.slice(Math.min(min, indent(lines[i]!))));
      i++;
    }
    while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
    return folded ? out.join(' ').replace(/\s+/g, ' ').trim() : out.join('\n');
  };
  const scalar = (raw: string, childIndent: number): string | string[] => {
    const v = raw.trim();
    if (v === '|' || v === '|-' || v === '>' || v === '>-') {
      const first = lines[i];
      return first === undefined ? '' : block(Math.max(indent(first), childIndent), v.startsWith('>'));
    }
    if (v.startsWith('[') && v.endsWith(']')) {
      return v.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean);
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
      const depth = indent(lines[i]!);
      if (/^\s*-\s/.test(lines[i]!)) {
        // 一覧（- a）
        const items: string[] = [];
        while (i < lines.length && (lines[i]!.trim() === '' || indent(lines[i]!) >= depth)) {
          const it = /^\s*-\s+(.*)$/.exec(lines[i]!);
          i++;
          if (it) items.push(unquote(it[1]!.trim()));
        }
        data[key] = items;
        continue;
      }
      // 入れ子の対応表（metadata）
      const child: Record<string, string> = {};
      while (i < lines.length && (lines[i]!.trim() === '' || indent(lines[i]!) >= depth)) {
        const c = /^\s+([A-Za-z0-9_.-]+):(.*)$/.exec(lines[i]!);
        i++;
        if (c) {
          const v = scalar(c[2]!, depth + 1);
          child[c[1]!] = Array.isArray(v) ? v.join(' ') : v;
        }
      }
      data[key] = child;
    } else {
      data[key] = scalar(rest, 1);
    }
  }
  return { frontmatter: data, body: src.slice(m[0].length).trim() };
}

const indent = (line: string) => line.length - line.trimStart().length;

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner.replace(/''/g, "'");
  }
  return v;
}

/** 文字の値（一覧なら空白でつなぐ）。 */
const text = (v: Frontmatter[string] | undefined): string =>
  typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : '';
/** 一覧の値（文字なら空白・「、」・「,」で区切る）。 */
const list = (v: Frontmatter[string] | undefined): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s、,]+/) : []).map((x) => x.trim()).filter(Boolean);
/** 真偽の値（スキルと同じく yes・on・1 も真）。 */
const truthy = (v: Frontmatter[string] | undefined): boolean => /^(true|yes|on|1)$/i.test(text(v).trim());

/** 入力の欄の種類（`m2office-inputs`。第12.12.3節）。 */
const INPUT_KINDS: Record<string, { format?: string }> = {
  短文: {}, 長文: { format: 'textarea' }, 日付: { format: 'date' }, ファイル: { format: 'file' },
};

type InputSchema = {
  type: 'object'; required: string[];
  properties: Record<string, { type: 'string'; title: string; format?: string; examples?: string[] }>;
};

/**
 * 入力のフォームを作る（第12.12.5節）。`m2office-inputs`、無ければ `arguments`、無ければ「依頼」の欄 1 つ。
 *
 * @param hint `argument-hint`。依頼の欄（または最初の欄）に薄く置く例
 */
export function parseInputs(
  inputs: string | undefined, args: string[] = [], hint = '',
): { schema: InputSchema; problems: string[] } {
  const examples = hint ? { examples: [hint] } : {};
  if (inputs?.trim()) {
    const properties: InputSchema['properties'] = {};
    const required: string[] = [];
    const problems: string[] = [];
    for (const raw of inputs.split('\n')) {
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
      properties[name] = { type: 'string', title: name, ...INPUT_KINDS[kind], ...(Object.keys(properties).length === 0 ? examples : {}) };
      if (!optional) required.push(name);
    }
    return { schema: { type: 'object', required, properties }, problems };
  }
  if (args.length > 0) {
    const properties: InputSchema['properties'] = {};
    for (const [n, a] of args.entries()) properties[a] = { type: 'string', title: a, ...(n === 0 ? examples : {}) };
    return { schema: { type: 'object', required: [...args], properties }, problems: [] };
  }
  return {
    schema: { type: 'object', required: ['request'], properties: { request: { type: 'string', title: '依頼', format: 'textarea', ...examples } } },
    problems: [],
  };
}

/**
 * 指示の中の `$ARGUMENTS`・`$ARGUMENTS[N]`・`$N`・`$名前` を入力で置き換える（スキルと同じ。仕様書 第12.12.2節）。
 *
 * @param names 欄の名前の並び（`arguments` か入力の欄の順）
 * @remarks `\$` は置き換えずに `$` として残す
 */
export function substituteArguments(instruction: string, input: Record<string, unknown>, names: string[]): string {
  const keys = names.length > 0 ? names : Object.keys(input);
  const values = keys.map((k) => String(input[k] ?? '').trim());
  const all = values.filter(Boolean).join(' ');
  const byName = new Map(keys.map((k, n) => [k, values[n]!]));
  const ESC = '\u0000';
  return instruction
    .replace(/\\\$/g, ESC)
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_, n) => values[Number(n)] ?? '')
    .replace(/\$ARGUMENTS\b/g, all)
    .replace(/\$(\d+)\b/g, (_, n) => values[Number(n)] ?? '')
    .replace(/\$([^\s$0-9.,;:!?、。「」()（）\[\]{}'"`*]+)/gu, (whole, name: string) => (byName.has(name) ? byName.get(name)! : whole))
    .replaceAll(ESC, '$');
}

/** SKILL.md から組み立てた拡張機能のファイルと、知らせること・問題。 */
export interface SkillPackage {
  /** 検証に回すファイル（組み立てた `manifest.json` と `agents/<name>.json` を含む）。 */
  files: ExtensionFiles;
  /** 保存するファイル（元の SKILL.md・HELP.md・補助のファイル・アイコン。除いたものを含まない）。 */
  keep: ExtensionFiles;
  /** 取り込みの画面に出すこと（無視した項目・除いたプログラムなど）。 */
  notices: string[];
  problems: string[];
}

/**
 * SKILL.md を含むファイルの集まりを、拡張機能のファイルに組み立てる（仕様書 第12.12.5節）。
 *
 * @param registry 道具の登録簿（道具の有無と危険度で、承認の段と扱う最大の危険度を決める）
 */
export function buildSkillPackage(files: ExtensionFiles, registry: ToolRegistry): SkillPackage {
  const notices: string[] = [];
  const problems: string[] = [];
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  const { frontmatter: fm, body: rawBody } = parseSkill(decode(files.get('SKILL.md') ?? new Uint8Array()));
  const meta = (typeof fm['metadata'] === 'object' && !Array.isArray(fm['metadata']) ? fm['metadata'] : {}) as Record<string, string>;

  // 本文のコマンド（!`...`）は実行しない。消して知らせる（第12.12.6節）
  let body = rawBody;
  const commands = [...body.matchAll(/!`[^`\n]+`|```!\n[\s\S]*?```/g)].length;
  if (commands > 0) {
    body = body.replace(/```!\n[\s\S]*?```/g, '（コマンドの実行は M2Office では行いません）').replace(/!`[^`\n]+`/g, '（コマンドの実行は M2Office では行いません）');
    notices.push(`本文のコマンド（!\`…\`）${commands} か所は実行しません。消して取り込みました`);
  }
  if (/\$\{CLAUDE_[A-Z_]+\}/.test(body)) notices.push('本文の ${CLAUDE_…} は M2Office では使えません。そのまま残しています');

  const folder = files.has(SKILL_FOLDER_ENTRY) ? decode(files.get(SKILL_FOLDER_ENTRY)!).trim() : '';
  const name = text(fm['name']).trim() || folder;
  const description = (text(fm['description']).trim() || firstLine(body)).slice(0, 1536);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    problems.push(name
      ? `name（${name}）は英小文字・数字・ハイフンで書いてください（64 字まで。例: expense-check）`
      : 'name がありません。name を書くか、SKILL.md をスキルの名前のフォルダに入れて ZIP にしてください');
  }
  if (!description) problems.push('description がありません。何をするか・いつ使うかを書いてください');
  if (!body) problems.push('SKILL.md に本文（業務の指示）がありません');
  for (const [k, why] of Object.entries(IGNORED_FIELDS)) if (k in fm) notices.push(`${k} は使いません（${why}）`);

  // 持ち込むもの: SKILL.md・HELP.md・補助のファイル（Markdown・テキスト）・アイコン・評価のケース。ほかは除く
  const keep: ExtensionFiles = new Map();
  const dropped: string[] = [];
  const supporting: { path: string; text: string }[] = [];
  let help = '';
  for (const [path, bytes] of files) {
    if (path === 'SKILL.md' || path === 'icon.png' || path === 'README.md' || path === SKILL_FOLDER_ENTRY || /^evals\/[^/]+\.json$/.test(path)) {
      keep.set(path, bytes);
      continue;
    }
    if (path === 'HELP.md') { keep.set(path, bytes); help = decode(bytes).trim(); continue; }
    if (TEXT_FILE.test(path) && !path.startsWith('scripts/')) {
      keep.set(path, bytes);
      supporting.push({ path, text: decode(bytes) });
      continue;
    }
    dropped.push(path);
  }
  if (dropped.length > 0) {
    notices.push(`次のファイルは取り込みませんでした（プログラムは実行せず、画像などは持ち込みません）: ${dropped.join(', ')}。本文がこれらに頼る部分は動きません`);
  }
  const chars = supporting.reduce((n, r) => n + r.text.length, 0);
  if (chars > SKILL_FILES_MAX_CHARS) {
    problems.push(`補助のファイルが長すぎます（合計 ${chars.toLocaleString('ja-JP')} 字。${SKILL_FILES_MAX_CHARS.toLocaleString('ja-JP')} 字まで）`);
  }

  // 道具は allowed-tools に M2Office の道具を書く。スキルの環境の道具は無視して知らせる（第12.12.1節 1）
  const declared = list(fm['allowed-tools']).map((t) => t.replace(/\(.*\)$/, ''));
  const known = declared.filter((t) => registry.get(t));
  const unknown = declared.filter((t) => !registry.get(t));
  if (unknown.length > 0) notices.push(`allowed-tools の ${[...new Set(unknown)].join('・')} は M2Office の道具ではないため使いません（M2Office の道具は開発者マニュアル 第4章）`);
  // allowed-tools を空で書けば道具を使わない。書かない・M2Office の道具が 1 つも無いときは、読むだけの道具
  const none = 'allowed-tools' in fm && declared.length === 0;
  const tools = [...new Set(none ? [] : known.length > 0 ? known : SKILL_DEFAULT_TOOLS), ...(supporting.length > 0 ? [SKILL_READ_TOOL] : [])];

  const args = list(fm['arguments']);
  const { schema, problems: inputProblems } = parseInputs(meta['m2office-inputs'], args, text(fm['argument-hint']));
  problems.push(...inputProblems);
  if (problems.length > 0) return { files: new Map(), keep, notices, problems };

  const effort = text(fm['effort']).trim().toLowerCase();
  const def = compileSkill({
    name, description, whenToUse: text(fm['when_to_use']).trim(), body, supporting, tools, inputs: schema,
    title: firstHeading(body) || name, approver: meta['m2office-approver']?.trim() ?? '',
    examples: (meta['m2office-examples'] ?? '').split('\n').map((l) => l.replace(/^[-*・\s]+/, '').trim()).filter(Boolean),
    help, arguments: meta['m2office-inputs'] ? Object.keys(schema.properties) : args,
    route: !truthy(fm['disable-model-invocation']),
    menu: !('user-invocable' in fm) || truthy(fm['user-invocable']),
    tier: EFFORT_TIER[effort],
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

/** 本文の最初の見出し（`# 〇〇`）。 */
const firstHeading = (body: string) => /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? '';
/** 本文の最初の空でない行（見出しの印を外す）。 */
const firstLine = (body: string) => (body.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').trim();

/**
 * スキルからエージェント定義を組み立てる（仕様書 第12.12.5節）。
 *
 * @remarks
 * 本文を指示にした段を 1 つ作る。送る道具（`external-send` 以上）があれば「作業 → 承認 → 送る」にする。
 * 承認は、社外にもお金にも関わらなければ自動で通る（ADR-0028）。
 */
export function compileSkill(s: {
  name: string; title: string; description: string; whenToUse: string; body: string;
  supporting: { path: string; text: string }[];
  tools: string[]; inputs: InputSchema; approver: string; examples: string[]; help: string;
  arguments: string[]; route: boolean; menu: boolean; tier?: AgentDefinition['tier'];
}, registry: ToolRegistry): AgentDefinition {
  const sends = s.tools.filter((t) => {
    const risk = registry.get(t)?.risk;
    return risk ? RISK_ORDER[risk] >= RISK_ORDER['external-send'] : false;
  });
  const works = s.tools.filter((t) => !sends.includes(t));
  const files = s.supporting.length === 0 ? '' : [
    '', '---', `補助のファイル（本文で参照しているものは、必要なときに ${SKILL_READ_TOOL} で開く）: ${s.supporting.map((f) => f.path).join('、')}`,
  ].join('\n');
  const work: AgentStep = {
    id: 'work', type: 'agent', label: '作業', tools: works,
    instruction: sends.length > 0
      ? `${s.body}${files}\n\n---\nこの段では、送る前の作業までを行う。送る中身（宛先・本文など）は、この段の答えに書く。送ることは次の段で行う。`
      : `${s.body}${files}`,
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
  const firstField = Object.keys(s.inputs.properties)[0] ?? 'request';
  return {
    schemaVersion: 1, id: s.name, version: 1, name: s.title, category: 'skill',
    // 秘書が取り次ぐ手がかり（スキルの自動の呼び出しと同じ役割）。when_to_use を添える
    description: s.whenToUse ? `${s.description}（${s.whenToUse}）` : s.description,
    locale: 'ja-JP', compartment: null,
    ...(s.route ? {} : { secretaryRoute: false }),
    ...(s.menu ? {} : { menu: false }),
    ...(s.tier ? { tier: s.tier } : {}),
    skill: { arguments: s.arguments, files: s.supporting },
    inputs: s.inputs, tools: s.tools, steps, constraints: [], limits: LIMITS,
    help: {
      summary: s.description,
      ...(s.help ? { body: s.help } : {}),
      ...(s.examples.length > 0 ? { examples: s.examples.map((e) => ({ title: e, input: { [firstField]: e } })) } : {}),
    },
  };
}
