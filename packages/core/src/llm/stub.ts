/**
 * @file 推論を行わないスタブの LLM。**M2Office 自身の自動テスト（単体テストと通しの確認）の中だけで使う**（仕様書 第20.2.4節、ADR-0030）。
 *
 * 指示文の語句からツール呼び出しを組み立てて返す。利用者の画面では使わない。
 */

import type { EvalCase } from '@m2office/shared';
import { EMBEDDING_DIMENSIONS, type LlmEmbedRequest, type LlmEmbedResponse, type LlmExtractRequest, type LlmProvider, type LlmRequest, type LlmResponse, type LlmTranscribeRequest, type LlmTranscribeResponse } from './provider.js';

/**
 * 自動テストのためのスタブ実装。
 *
 * 実際の推論は行わない。システムプロンプトに書かれたツール一覧を読み取り、
 * 指示文の語句に応じて妥当なツール呼び出しを組み立てて返す。
 * これにより、自動テストで実行エンジンとツール層の経路を通して検証できる。
 *
 * @remarks
 * 利用者の画面では使わない。`LLM_PROVIDER=stub`（自動テスト専用）のときだけ選ばれる。
 */
export class StubLlmProvider implements LlmProvider {
  readonly name = 'stub';

  /**
   * 見本の埋め込み（知識の意味の検索の自動テスト。仕様書 第11.7.6.6節）。
   *
   * @remarks 推論は行わない。{@link STUB_EMBEDDING_CONCEPTS} の言い換えだけを近いとみなし、ほかは文字の組から作る弱い値にする
   */
  async embed(req: LlmEmbedRequest): Promise<LlmEmbedResponse> {
    return {
      vectors: req.items.map((x) => stubEmbedding(`${x.title ?? ''} ${x.text}`)),
      model: 'stub:concepts-1',
      inputTokens: req.items.reduce((n, x) => n + x.text.length, 0),
    };
  }

  /**
   * @param evalsFor 業務エージェントの評価のケース（自動テストの見本の応答を含む）を引く（仕様書 第12.9.4節）
   */
  constructor(private readonly evalsFor?: (agentId: string) => EvalCase[] | undefined) {}

  /**
   * 画像からの取り出し（名刺の読み取り。仕様書 第27.5節）の自動テスト用の応答。
   *
   * @remarks
   * 推論は行わない。画像のバイト列に `M2O-CARD:` に続く 1 行の JSON が埋め込まれていれば、それを読み取り結果として返す
   * （自動テストが名刺の見本の画像に書き込む）。無ければ「名刺ではない」と返す
   */
  async extractFromImage(req: LlmExtractRequest): Promise<LlmResponse> {
    const text = Buffer.from(req.bytes).toString('latin1');
    // 見積書の見本（第15.2.3節）の自動テスト。`M2O-QUOTE-SAMPLE:` に続く 1 行の JSON を読み取り結果にする
    const sample = text.indexOf('M2O-QUOTE-SAMPLE:');
    if (sample !== -1) return { text: Buffer.from(text.slice(sample + 'M2O-QUOTE-SAMPLE:'.length).split('\n')[0] ?? '', 'latin1').toString('utf8'), tokensUsed: 32 };
    const at = text.indexOf('M2O-CARD:');
    if (at === -1) return { text: JSON.stringify({ isCard: false }), tokensUsed: 8 };
    const line = text.slice(at + 'M2O-CARD:'.length).split('\n')[0] ?? '';
    // 見本の JSON は UTF-8 で書かれている
    return { text: Buffer.from(line, 'latin1').toString('utf8'), tokensUsed: 32 };
  }

  /**
   * 録音の文字起こし（第9.4.5節）の自動テスト用の応答。
   *
   * @remarks 推論は行わない。録音のバイト列に `M2O-TRANSCRIPT:` に続く文（UTF-8。`|` で行を分ける）が埋め込まれていれば、それを文字起こしとして返す
   * （自動テストが見本の録音に書き込む）。無ければ決まった 1 行を返す
   */
  async transcribeAudio(req: LlmTranscribeRequest): Promise<LlmTranscribeResponse> {
    const text = Buffer.from(req.bytes).toString('latin1');
    const at = text.indexOf('M2O-TRANSCRIPT:');
    const body = at === -1
      ? '[00:00] 話者 1: これは見本の文字起こしです。'
      : Buffer.from(text.slice(at + 'M2O-TRANSCRIPT:'.length).split('\n')[0] ?? '', 'latin1').toString('utf8').split('|').join('\n');
    return { text: body, model: 'stub', inputTokens: Math.round(req.bytes.byteLength / 500), outputTokens: body.length };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const replay = this.replay(req);
    if (replay) return replay;

    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = req.messages.at(-1)?.content ?? '';
    // 見積書の見本（第15.2.3節）の自動テスト。見本の文に `M2O-QUOTE-SAMPLE:` に続く 1 行の JSON があれば、それを返す
    const sampleAt = user.indexOf('M2O-QUOTE-SAMPLE:');
    if (sampleAt !== -1) return { text: user.slice(sampleAt + 'M2O-QUOTE-SAMPLE:'.length).split('\n')[0] ?? '', tokensUsed: 32 };
    // 秘書の段取り（仕様書 第10.14節）を自動テストで通しで確かめるための、決まった応答
    const planned = stubPlanning(system, user);
    if (planned !== null) return { text: planned, tokensUsed: 16 };
    // メールの画面の振り分け・返事待ちの見分け・下書き（仕様書 第9.5.1.1節）を、開発と自動テストで通しで確かめるための決まった応答
    const mail = stubMail(system, user);
    if (mail !== null) return { text: mail, tokensUsed: 24 };
    const tools = extractToolNames(system);
    const calls = chooseTools(tools, user);

    const lines = ['［スタブ応答］実際の推論は行っていません。'];
    for (const call of calls) {
      lines.push('', '```tool', JSON.stringify(call), '```');
    }
    // ツールを呼ばない段（まとめの段など）では、読み取った中身をそのまま添える。
    // 鍵が無い環境でも「読んだものが答えまで届く」ことを通しで確かめられるようにする
    if (calls.length === 0) {
      const read = readText(section(user, 'これまでの結果'));
      if (read) lines.push('', '［スタブ］読み取った内容をそのまま示します。', '', read);
      // 週次ブリーフのまとめの段は、集めた件数だけを本文にする（仕様書 第9.5.5節。届けるのは実行エンジン）
      if (/今週のブリーフを書く/.test(section(user, '指示'))) lines.push('', summarizeForBrief(section(user, 'これまでの結果')));
    }
    return { text: lines.join('\n'), tokensUsed: Math.ceil(user.length / 4) + 64 };
  }

  /**
   * 見本の応答を再生する。見本を持たない業務エージェントなら `null`（従来の推測に任せる）。
   *
   * @remarks
   * 見本を持つ業務エージェントでは、入力が一致しないときも推測でツールを呼ばない。
   * 拡張機能の業務の中身をスタブは知らないため、それらしい誤った成果物を作らないようにする。
   */
  private replay(req: LlmRequest): LlmResponse | null {
    const ctx = req.context;
    const cases = ctx ? (ctx.evals ?? this.evalsFor?.(ctx.agentId) ?? []).filter((c) => c.stub) : [];
    if (!ctx || cases.length === 0) return null;
    const hit = cases.find((c) => stableJson(c.input) === stableJson(ctx.input));
    const tokensUsed = Math.ceil(JSON.stringify(ctx.input).length / 4) + 32;
    if (!hit) {
      return {
        text: `［スタブ応答］この入力に対する見本の応答がありません（評価のケース: ${cases.map((c) => c.name).join('、')}）。`,
        tokensUsed,
      };
    }
    const calls = (hit.stub?.[ctx.stepId] ?? []).map((c) => ({
      ...c, args: fillPlaceholders(c.args, ctx.stepResults ?? {}) as Record<string, unknown>,
    }));
    const lines = [`［スタブ応答］見本の応答を再生しています（評価のケース「${hit.name}」）。`];
    for (const call of calls) lines.push('', '```tool', JSON.stringify(call), '```');
    return { text: lines.join('\n'), tokensUsed };
  }
}

/**
 * 見本の応答の引数にある `{{ステップ ID}}` を、そのステップのツールの結果に置き換える（仕様書 第12.11.4節）。
 *
 * @remarks 結果が無いステップを指していれば「（取得できませんでした）」に置き換える。推測で埋めない。
 */
function fillPlaceholders(v: unknown, results: Record<string, string>): unknown {
  if (typeof v === 'string') {
    return v.replace(/\{\{\s*([a-z0-9][a-z0-9-]*)\s*\}\}/g, (_, id: string) => results[id] ?? '（取得できませんでした）');
  }
  if (Array.isArray(v)) return v.map((x) => fillPlaceholders(x, results));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillPlaceholders(x, results)]));
  }
  return v;
}

/** キーの順序によらず同じ文字列になる JSON。入力の一致を比べるために使う。 */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** システムプロンプトの「使えるツール:」行からツール名を取り出す。 */
function extractToolNames(system: string): string[] {
  const line = system.split('\n').find((l) => l.startsWith('使えるツール:'));
  if (!line) return [];
  return line
    .replace('使えるツール:', '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'なし');
}

type Call = { name: string; args: Record<string, unknown> };

/**
 * 指示文の語句から、呼ぶべきツールを選ぶ。
 *
 * @remarks
 * 指示文は「# 指示」の段だけを見る。前のステップの結果に含まれる語句で
 * 誤ってツールを選ばないためである。該当が無ければ何も呼ばない。
 */
function chooseTools(tools: string[], prompt: string): Call[] {
  const has = (n: string) => tools.includes(n);
  const instruction = section(prompt, '指示');
  const previous = section(prompt, 'これまでの結果');

  // 語句は「〜を収集」「〜を取得」のように目的語つきで見る。
  // 「収集した内容を要約する」のような後段の指示で、同じツールを呼び直さないため

  // まとめてのメール（仕様書 第27.9.1節）: 名刺の画面で作った下書きを確かめ、承認の後に送る
  if (has('contacts.bulk_preview') && instruction.includes('contacts.bulk_preview')) {
    const id = extractField(prompt, 'bulkMailId');
    if (id) return [{ name: 'contacts.bulk_preview', args: { bulkMailId: id } }];
  }
  if (has('mail.bulk_send') && instruction.includes('mail.bulk_send')) {
    const id = extractField(prompt, 'bulkMailId');
    if (id) return [{ name: 'mail.bulk_send', args: { bulkMailId: id } }];
  }

  // 見積書（仕様書 第9.5.8節）: 「デザイン 30 万円」のような書き方から品目を取り、作る → 送り先があれば用意 → 承認の後に送る
  if (has('quote.create') && instruction.includes('quote.create')) {
    const req = extractField(prompt, 'request');
    const items = [...req.matchAll(/([^\s、。,，0-9]+?)\s*(\d+(?:\.\d+)?)\s*(万)?円/g)]
      .map((m) => ({ name: m[1]!, quantity: 1, unitPrice: Math.round(Number(m[2]) * (m[3] ? 10_000 : 1)) }));
    if (!items.length && req) items.push(...req.split(/[、,，と]/).map((x) => x.trim()).filter(Boolean).slice(0, 5).map((name) => ({ name, quantity: 1 }) as { name: string; quantity: number; unitPrice: number }));
    return [{ name: 'quote.create', args: { to: extractField(prompt, 'to'), items, terms: extractField(prompt, 'terms') } }];
  }
  if (has('quote.prepare_mail') && instruction.includes('quote.prepare_mail')) {
    return [{ name: 'quote.prepare_mail', args: { quoteId: extractField(previous, 'quoteId'), sendTo: extractField(prompt, 'sendTo') } }];
  }
  if (has('gmail.send') && instruction.includes('quote.prepare_mail')) {
    const to = extractField(previous, 'to');
    const attachment = /"attachments"\s*:\s*\[\s*"([^"]+)"/.exec(previous)?.[1];
    if (to && attachment) return [{ name: 'gmail.send', args: { to: [to], subject: extractField(previous, 'subjectHint') || '御見積書', body: '見積書をお送りします。ご確認ください。', attachments: [attachment] } }];
  }

  // メールの返事を送る（第9.5.1.1節）。本人が確かめた控えを送る
  if (has('mail.reply_send') && instruction.includes('mail.reply_send')) {
    const id = extractField(prompt, 'threadId');
    if (id) return [{ name: 'mail.reply_send', args: { threadId: id } }];
  }
  // 問い合わせの返事（仕様書 第33.18節）: 「〇〇さんへの返事を書いて」で下書き、承認の後に送る
  if (has('inquiries.reply_send') && instruction.includes('inquiries.reply_send')) {
    const id = extractField(prompt, 'replyId');
    if (id) return [{ name: 'inquiries.reply_send', args: { replyId: id } }];
  }
  if (has('inquiries.reply_draft') && instruction.includes('inquiries.reply_draft')) {
    const q = /(.+?)(さん|様|社)?への返事/.exec(extractField(prompt, 'request'))?.[1]?.trim() ?? '';
    if (q) return [{ name: 'inquiries.reply_draft', args: { q } }];
  }
  if (has('inquiries.faq') && instruction.includes('inquiries.faq') && /よくある質問|よく聞かれ/.test(extractField(prompt, 'request'))) {
    return [{ name: 'inquiries.faq', args: {} }];
  }
  if (has('inquiries.review') && instruction.includes('inquiries.review') && /先月|件数|何件|どこから/.test(extractField(prompt, 'request'))) {
    return [{ name: 'inquiries.review', args: {} }];
  }
  // 問い合わせの記録（仕様書 第33.17節）: 話した文をそのまま残す。「今週の」「返事してない」で一覧を読む
  if (has('inquiries.record') && instruction.includes('inquiries.record')) {
    const text = extractField(prompt, 'request').replace(/(と|って)?(残して|記録して)(おいて)?(ください)?[。.]?$/, '').trim();
    if (text) return [{ name: 'inquiries.record', args: { text } }];
  }
  if (has('inquiries.list') && instruction.includes('inquiries.list')) {
    const req = extractField(prompt, 'request');
    const name = /(.+?)(さん|様|社)の問い合わせ/.exec(req)?.[1] ?? '';
    return [{ name: 'inquiries.list', args: {
      ...(/今週/.test(req) ? { days: 7 } : /今月/.test(req) ? { days: 31 } : {}),
      ...(/返事して(い)?ない|待たせ/.test(req) ? { waiting: true } : {}),
      ...(/済んだ|すべて|全部/.test(req) ? { status: 'all' } : {}),
      ...(name ? { q: name } : {}),
    } }];
  }

  // お知らせの作成（仕様書 第35.17節）: 下書き・直す・承認へ進める・一覧。承認の後に出す
  if (has('announcements.publish') && instruction.includes('announcements.publish')) {
    const id = extractField(prompt, 'announcementId');
    if (id) return [{ name: 'announcements.publish', args: { announcementId: id } }];
  }
  if (has('announcements.draft') && instruction.includes('announcements.draft')) {
    const req = extractField(prompt, 'request');
    if (/承認へ進めて|それで出して/.test(req)) return [{ name: 'announcements.submit', args: {} }];
    if (/友だち|何通|一覧/.test(req)) return [{ name: 'announcements.list', args: {} }];
    if (/営業|休み/.test(req) && /何日|いつ|\?|？/.test(req)) return [{ name: 'announcements.closures', args: {} }];
    if (/丁寧|短く|直して/.test(req)) return [{ name: 'announcements.revise', args: { instruction: req } }];
    if (req) return [{ name: 'announcements.draft', args: { request: req } }];
  }

  // 会社の見た目（仕様書 第46章）
  if (has('company_design.update') && instruction.includes('company_design.update')) {
    const req = extractField(prompt, 'request');
    if (/書き出/.test(req)) return [{ name: 'company_design.export', args: {} }];
    if (/CSS|サイトに反映|ホームページ/.test(req)) return [{ name: 'company_design.site_css', args: {} }];
    if (/戻して/.test(req)) return [{ name: 'company_design.update', args: { mode: 'restore', request: req } }];
    const url = /(https:\/\/\S+)/.exec(req)?.[1];
    if (/取り込/.test(req) || url) return [{ name: 'company_design.update', args: { mode: 'import', request: req, ...(url ? { url } : { text: req }) } }];
    if (/作って|作り直/.test(req)) return [{ name: 'company_design.update', args: { mode: 'create', request: req } }];
    if (/[？?]|教えて/.test(req)) return [{ name: 'company_design.show', args: {} }];
    return [{ name: 'company_design.update', args: { mode: 'edit', request: req } }];
  }

  // サイトの更新（仕様書 第45章）: 直し案を作る・元に戻す・記録。承認の後に入れる
  if (has('site_updates.apply') && instruction.includes('site_updates.apply')) {
    const id = extractField(prompt, 'editId');
    if (id) return [{ name: 'site_updates.apply', args: { editId: id } }];
  }
  if (has('site_updates.propose') && instruction.includes('site_updates.propose')) {
    const req = extractField(prompt, 'request');
    if (/戻して/.test(req)) return [{ name: 'site_updates.revert', args: {} }];
    if (/(カテゴリ|タグ)/.test(req) && /(何がある|一覧)/.test(req)) return [{ name: 'site_updates.term_list', args: {} }];
    if (/会社の見た目|会社の色/.test(req)) return [{ name: 'site_updates.design', args: { request: req } }];
    if (/(プラグイン|テーマ|サイトヘルス)/.test(req)) return [{ name: 'site_updates.health', args: {} }];
    if (/コメント/.test(req) && /(新しい|何がある|見せて|一覧|は？)/.test(req) && !/(承認して|返事|スパム|ゴミ箱)/.test(req)) return [{ name: 'site_updates.comment_list', args: {} }];
    if (/コメント/.test(req)) return [{ name: 'site_updates.comments', args: { request: req } }];
    if (/(メニュー|キャッチフレーズ|サイトのタイトル)/.test(req)) return [{ name: 'site_updates.menus', args: { request: req } }];
    if (/(作って|公開|下書きに|非公開|予約|ゴミ箱|前の版|アイキャッチ)/.test(req) && !/(カテゴリ|タグ)/.test(req)) return [{ name: 'site_updates.actions', args: { request: req } }];
    if (/(カテゴリ|タグ)/.test(req)) return [{ name: 'site_updates.terms', args: { request: req } }];
    if (/記録|何を直した/.test(req)) return [{ name: 'site_updates.list', args: {} }];
    if (req) return [{ name: 'site_updates.propose', args: { request: req } }];
  }

  // Webの分析の依頼文を送る（第34.21節）。承認の後に 1 回だけ
  if (has('web_review.request_send') && instruction.includes('web_review.request_send')) {
    const findingId = extractField(prompt, 'findingId');
    const to = extractField(prompt, 'to');
    if (findingId && to) return [{ name: 'web_review.request_send', args: { findingId, to } }];
  }
  // Webの分析（仕様書 第34.18節）: 便り・数字の問い・状態
  if (has('web_review.ask') && instruction.includes('web_review.ask')) {
    const req = extractField(prompt, 'request');
    if (/直した|直すべき|遅いページ|制作会社に頼む/.test(req)) return [{ name: 'web_review.findings', args: {} }];
    if (/つなぎ|つなが|閲覧の権限/.test(req)) return [{ name: 'web_review.status', args: {} }];
    if (/何人|何回|どこから|スマホ|検索され/.test(req)) {
      const page = /(.+?)のページ/.exec(req)?.[1]?.replace(/^.*[、,]\s*/, '').trim();
      const word = /[“"「](.+?)[”"」]\s*で検索/.exec(req)?.[1];
      return [{ name: 'web_review.ask', args: {
        metric: word ? 'searchClicks' : 'users',
        breakdown: word ? 'searchQuery' : /どこから/.test(req) ? 'source' : /スマホ/.test(req) ? 'device' : 'none',
        period: /先週/.test(req) ? 'lastWeek' : /今月/.test(req) ? 'thisMonth' : 'lastMonth',
        ...(word ? { contains: word } : page ? { contains: page === '料金' ? 'price' : page } : {}),
      } }];
    }
    return [{ name: 'web_review.report', args: {} }];
  }

  // 競合の分析（仕様書 第36.18節）: 探す・入れる・外す・見回る・動き・違い
  if (has('competitors.discover') && instruction.includes('competitors.discover')) {
    const req = extractField(prompt, 'request');
    const add = /(https?:\/\/\S+|.+?)を競合に入れて/.exec(req)?.[1]?.trim();
    if (add && has('competitors.add')) return [{ name: 'competitors.add', args: { text: add } }];
    const remove = /(.+?)(は競合じゃない|を外して)/.exec(req)?.[1]?.trim();
    if (remove && has('competitors.remove')) return [{ name: 'competitors.remove', args: { q: remove } }];
    if (/どこ|一覧/.test(req) && has('competitors.list')) return [{ name: 'competitors.list', args: {} }];
    const km = /半径\s*([0-9.]+)\s*km/.exec(req)?.[1];
    return [{ name: 'competitors.discover', args: { ...(km ? { radiusKm: Number(km) } : {}), ...(/全国/.test(req) ? { nationwide: true } : {}) } }];
  }
  if (has('competitors.report') && instruction.includes('competitors.report')) {
    const req = extractField(prompt, 'request');
    if (/見回って/.test(req)) return [{ name: 'competitors.check', args: {} }];
    const name = /(.+?)とうちの違い/.exec(req)?.[1]?.trim();
    if (name) return [{ name: 'competitors.facts', args: { q: name } }];
    if (/どこ|一覧/.test(req)) return [{ name: 'competitors.list', args: {} }];
    return [{ name: 'competitors.report', args: {} }];
  }

  // Web のコラム（仕様書 第32.18.1節）: 承認へ進めたコラムを確かめ、承認の後に WordPress に入れる。秘書から下書きを書く
  if (has('columns.preview') && instruction.includes('columns.preview')) {
    const id = extractField(prompt, 'columnId');
    if (id) return [{ name: 'columns.preview', args: { columnId: id } }];
  }
  if (has('columns.place') && instruction.includes('columns.place')) {
    const id = extractField(prompt, 'columnId');
    if (id) return [{ name: 'columns.place', args: { columnId: id } }];
  }
  if (has('columns.rules') && instruction.includes('columns.rules')) {
    const req = extractField(prompt, 'request');
    const pick = (s: string) => [/医療|歯科|クリニック/.test(s) ? 'medical' : '', /薬機法|化粧品|健康食品|サプリ|薬局/.test(s) ? 'health-products' : '', /士業|弁護士|税理士/.test(s) ? 'legal' : ''].filter(Boolean);
    if (/任せ|自動に戻/.test(req)) return [{ name: 'columns.rules', args: { auto: true } }];
    return [{ name: 'columns.rules', args: /外/.test(req) ? { remove: pick(req) } : { add: pick(req) } }];
  }
  if (has('columns.cover') && instruction.includes('columns.cover')) {
    const req = extractField(prompt, 'request');
    const kind = /写真/.test(req) ? 'photo' : /型/.test(req) ? 'template' : /挿絵|AI の絵/.test(req) ? 'ai' : '';
    const column = /^(.+?)のコラム/.exec(req)?.[1] ?? '';
    if (/前の画像|戻して/.test(req)) return [{ name: 'columns.cover', args: { ...(column ? { column } : {}), previous: true } }];
    return [{ name: 'columns.cover', args: { ...(column ? { column } : {}), ...(kind ? { kind } : {}) } }];
  }
  if (has('columns.draft') && instruction.includes('columns.draft')) {
    const req = extractField(prompt, 'request');
    // テーマ案・本数・予定表（第32.18.4節）
    const count = /(\d+)\s*本/.exec(req)?.[1];
    if (has('columns.prepare') && /用意して/.test(req) && count) return [{ name: 'columns.prepare', args: { count: Number(count) } }];
    if (has('columns.prepare') && /テーマ案を出して|何を書けば/.test(req)) return [{ name: 'columns.prepare', args: {} }];
    if (has('columns.themes') && /テーマ案は|予定は/.test(req)) return [{ name: 'columns.themes', args: {} }];
    const theme = extractField(prompt, 'request').replace(/(について|で|の)?コラムを書いて(ください)?[。.]?$/, '').trim();
    if (theme) return [{ name: 'columns.draft', args: { theme } }];
  }

  // 収集: 読み取り系をまとめて呼ぶ（AG-05。仕様書 第9.5.5節）
  if (/を収集/.test(instruction)) {
    const collectors: Call[] = [];
    for (const name of ['profile.read', 'brief.settings', 'notices.list']) if (has(name)) collectors.push({ name, args: {} });
    if (has('calendar.list')) collectors.push({ name: 'calendar.list', args: {} });
    if (has('tasks.list')) collectors.push({ name: 'tasks.list', args: {} });
    if (has('gmail.list')) collectors.push({ name: 'gmail.list', args: { limit: 20 } });
    if (has('gmail.unread')) collectors.push({ name: 'gmail.unread', args: {} });
    if (has('approvals.pending')) collectors.push({ name: 'approvals.pending', args: {} });
    if (collectors.length > 0) return collectors;
  }
  if (has('notification.send') && /通知/.test(instruction)) {
    return [{
      name: 'notification.send',
      args: { kind: 'brief', title: '今週のブリーフ（スタブ生成）', body: summarizeForBrief(previous) },
    }];
  }
  // 社外の参加者を含む日程調整（仕様書 第9.5.3.1節）: 見本では、参加者のドメインが 2 つ以上なら社外がいるとみなし、候補を送る
  if (has('schedule.send_candidates') && instruction.includes('schedule.send_candidates')) {
    const attendees = splitList(extractField(prompt, 'attendees'));
    if (new Set(attendees.map((a) => a.split('@')[1])).size > 1) {
      const minutes = Number(extractField(prompt, 'durationMin')) || 60;
      const candidates = [2, 3, 4].map((d) => {
        const start = new Date(Date.now() + d * 86_400_000);
        start.setUTCHours(5, 0, 0, 0); // 日本時間 14 時
        return { start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString() };
      });
      const title = extractField(prompt, 'title') || '打ち合わせ';
      return [{
        name: 'schedule.send_candidates',
        args: { title, attendees, candidates, subject: `${title}の日程のご相談`, body: 'ご都合のよい日時をお知らせください。' },
      }];
    }
  }
  // 採用支援（仕様書 第9.6.6節）: 書いた原稿を点検する（見本では依頼と条件をそのまま原稿として点検する）
  if (has('recruit.check_text') && instruction.includes('recruit.check_text') && !previous.includes('"checked"')) {
    return [{ name: 'recruit.check_text', args: { kind: 'posting', text: `${extractField(prompt, 'request')} ${extractField(prompt, 'position')}` } }];
  }
  if (has('schedule.confirm_prepare') && instruction.includes('schedule.confirm_prepare')) {
    return [{ name: 'schedule.confirm_prepare', args: { requestId: extractField(prompt, 'requestId') } }];
  }
  if (has('deliveries.send') && instruction.includes('deliveries.send')) {
    return [{ name: 'deliveries.send', args: { deliveryId: extractField(prompt, 'deliveryId') } }];
  }
  if (has('schedule.invite') && instruction.includes('schedule.invite')) {
    return [{ name: 'schedule.invite', args: { requestId: extractField(prompt, 'requestId') } }];
  }
  if (has('calendar.create') && /予定を作成/.test(instruction)) {
    const start = new Date(Date.now() + 2 * 86_400_000);
    start.setUTCHours(4, 0, 0, 0); // 日本時間 13 時
    const end = new Date(start.getTime() + 30 * 60_000);
    return [{
      name: 'calendar.create',
      args: {
        title: extractField(prompt, 'title') || '打ち合わせ',
        start: start.toISOString(), end: end.toISOString(),
        attendees: splitList(extractField(prompt, 'attendees')),
      },
    }];
  }
  if (has('calendar.freebusy') && /空き/.test(instruction)) {
    return [{ name: 'calendar.freebusy', args: { emails: splitList(extractField(prompt, 'attendees')) } }];
  }
  if (has('gmail.create_draft') && /下書き/.test(instruction)) {
    const mailId = /"id":\s*"(mock-mail-[^"]+-1)"/.exec(previous)?.[1] ?? null;
    if (!mailId) return [];
    return [{
      name: 'gmail.create_draft',
      args: {
        replyTo: mailId, to: '', subject: 'Re: （スタブ）',
        body: '［スタブ］いつもお世話になっております。内容を確認のうえ、改めてご連絡いたします。',
      },
    }];
  }
  // メールの整理は、受信トレイの「メイン」の未読を取る（仕様書 第9.5.1節）
  if (has('gmail.unread') && /取得/.test(instruction)) {
    return [{ name: 'gmail.unread', args: {} }];
  }
  if (has('gmail.list') && /を取得/.test(instruction)) {
    return [{ name: 'gmail.list', args: { limit: 20 } }];
  }
  if (has('chat.post') && /投稿|共有/.test(instruction)) {
    const calls: Call[] = [{ name: 'chat.post', args: { space: 'general', text: '議事録を共有します。' } }];
    // 共有とあわせて知識へ登録する（AG-02。仕様書 第9.5.2節）。成果物の ID は作成の手順の結果から拾う
    const artifactId = /"artifactId":\s*"([^"]+)"/.exec(previous)?.[1];
    if (has('knowledge.register') && /知識/.test(instruction) && artifactId) {
      calls.push({ name: 'knowledge.register', args: { artifactId } });
    }
    return calls;
  }
  if (has('tasks.create') && /起票|タスク|ToDo/.test(instruction)) {
    return [{ name: 'tasks.create', args: { title: '決定事項の対応', due: null } }];
  }
  // 本人のドライブに文書を作る基本の業務（文書の作成・録音のまとめ。第9.5.5.2節・第9.5.5.3節）。
  // 議事録の共有の段（成果物をそのまま保存する。artifactId を渡す）は除く
  if (has('docs.create') && instruction.includes('docs.create') && !/artifactId/.test(instruction)) {
    const read = /"text":\s*"((?:[^"\\]|\\.)*)"/.exec(previous)?.[1] ?? '';
    return [{
      name: 'docs.create',
      args: { title: extractField(prompt, 'title') || '文書（スタブ生成）', body: `［スタブ］\n${read.replace(/\\n/g, '\n').slice(0, 2000)}` },
    }];
  }
  if (has('document.create') && /作成|生成|まとめる|保存/.test(instruction)) {
    const isInbox = /分類/.test(instruction);
    return [{
      name: 'document.create',
      args: isInbox
        ? { kind: 'inbox-triage', title: '受信箱の分類（スタブ生成）',
            body: '［スタブ］要返信・要対応・情報共有のみ・不要の一覧をここにまとめます。' }
        : { kind: 'minutes', title: `${extractField(prompt, 'title') || '会議'}の議事録（スタブ生成）`,
            body: minutesStub(previous) },
    }];
  }
  // 渡された書類を読む（秘書の調べもの。仕様書 第10.11.4節）。
  // 語句ではなく、指示がツールの名前を挙げているかで見る。「利用者が読む文」のような
  // 別の意味の「読む」に反応して、まとめの段でもう一度読んでしまうため
  if (has('file.read_text') && instruction.includes('file.read_text')) {
    const fileId = extractField(prompt, 'fileId');
    if (fileId) return [{ name: 'file.read_text', args: { fileId } }];
  }
  if (/取得/.test(instruction)) {
    // 記録の取り方は、ファイル → 貼り付け → Meet の順（仕様書 第9.5.2節）
    const fileId = extractField(prompt, 'fileId');
    if (has('file.read_text') && fileId) return [{ name: 'file.read_text', args: { fileId } }];
    const transcript = extractField(prompt, 'transcript');
    // 貼り付けが無ければ Meet の文字起こしを探す（自動の議事録は会議の記録の ID を入れる。第9.5.2.1節）
    if (!transcript.trim() && has('meet.transcript')) {
      const meetingId = extractField(prompt, 'meetingId');
      return [{ name: 'meet.transcript', args: { query: extractField(prompt, 'title'), ...(meetingId ? { meetingId } : {}) } }];
    }
    if (has('meeting.get_transcript')) return [{ name: 'meeting.get_transcript', args: { transcript } }];
  }
  if (has('knowledge.search') && /検索|照会|探す|調べ/.test(instruction)) {
    return [{
      name: 'knowledge.search',
      args: { query: extractField(prompt, 'question') || '規程' },
    }];
  }
  return [];
}

/** プロンプトから「# 見出し」の段を取り出す。無ければ空文字。 */
function section(prompt: string, heading: string): string {
  const parts = prompt.split(/^# /m);
  const hit = parts.find((p) => p.startsWith(`${heading}\n`));
  return hit ? hit.slice(heading.length + 1) : '';
}

function splitList(v: string): string[] {
  return v.split(/[,、\s]+/).map((x) => x.trim()).filter(Boolean);
}

/** 前のステップの結果から件数だけを拾い、ブリーフの本文にする。 */
function summarizeForBrief(previous: string): string {
  const count = (tool: string) => {
    // 前の段の結果が長いと、ツールの結果は文字列に包まれて渡る（引用符が \\" になる。第9.3.2節「前の段の結果」）。どちらの形でも拾う
    const q = '\\\\?"';
    const re = new RegExp(`${q}name${q}:\\s*${q}${tool.replace('.', '\\.')}${q}[\\s\\S]*?${q}count${q}:\\s*(\\d+)`);
    const m = re.exec(previous);
    return m ? `${m[1]} 件` : '取得できませんでした';
  };
  return [
    '［スタブ］今週のまとめです。',
    `- 予定: ${count('calendar.list')}`,
    `- 未完了のタスク: ${count('tasks.list')}`,
    `- 受信箱: ${/"name":\s*"gmail\.unread"/.test(previous) ? count('gmail.unread') : count('gmail.list')}`,
    `- 承認待ち: ${count('approvals.pending')}`,
  ].join('\n');
}

/**
 * 議事録の見本。取得の手順で得た記録をそのまま「記録」の節に入れる。
 *
 * @remarks 推論をしないため、決定事項を取り出したふりはしない。記録が無ければそう書く
 */
function minutesStub(previous: string): string {
  // 推論の応答文（同じ "text" の名前を持つ）ではなく、記録を取ったツールの結果から拾う。
  // 記録は、渡されたファイル（file.read_text）か Meet（meeting.get_transcript）から来る（仕様書 第9.5.2節）
  const from = (tool: string) =>
    new RegExp(`"name":\\s*"${tool}"[\\s\\S]*?"result":\\s*\\{[\\s\\S]*?"text":\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(previous)?.[1];
  const text = from('file\\.read_text') ?? from('meeting\\.get_transcript');
  const record = text ? (JSON.parse(`"${text}"`) as string) : '（記録を取得できませんでした）';
  return [
    '## 決定事項',
    '［スタブ］推論を行っていないため、取り出していません。',
    '',
    '## 記録',
    record,
  ].join('\n');
}

/**
 * これまでの結果から、読み取った中身を拾う。
 *
 * @remarks 読み取りのツール（`file.read_text`）の結果だけを見る。応答文は見ない。
 */
function readText(previous: string): string {
  const m = /"name":\s*"file\.read_text"[\s\S]*?"result":\s*\{[\s\S]*?"text":\s*"((?:[^"\\]|\\.)*)"/.exec(previous);
  return m ? (JSON.parse(`"${m[1]}"`) as string) : '';
}

/** 入力の JSON から指定した項目を拾う。見つからなければ空文字。 */
function extractField(text: string, key: string): string {
  const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(text);
  return m?.[1] ?? '';
}

/**
 * 秘書の段取りの推論に、決まった応答を返す（自動テスト専用。仕様書 第10.14節）。当たらなければ `null`。
 *
 * @remarks
 * - 取次で「段取り」を含む依頼には `plan` を返す
 * - 段取りを立てる指示には、使える業務のうち秘書の調べもの（1 段目）と社内ナレッジ Q&A（1 段目の答えを使う 2 段目）を返す
 * - 問いへの答えかの見分けには「はい」を返す
 */
function stubPlanning(system: string, user: string): string | null {
  if (system.includes('依頼に最も合う業務を 1 つ選び') && system.includes('plan: 段取り') && user.includes('段取り')) return 'plan';
  if (system.includes('問いへの答えなら「はい」')) return 'はい';
  if (user.startsWith('# 段取り')) {
    const listed = (id: string) => user.includes(`\n- ${id}: `);
    const request = user.split('## 本人の依頼\n')[1]?.trim() ?? '';
    const steps = [
      ...(listed('secretary-lookup') ? [{ agent: 'secretary-lookup', purpose: request, after: [] as number[] }] : []),
      ...(listed('knowledge-qa') ? [{ agent: 'knowledge-qa', purpose: '社内の規程で確かめる', after: listed('secretary-lookup') ? [1] : [] }] : []),
    ];
    return JSON.stringify({ steps, cannot: '' });
  }
  return null;
}

/**
 * 見本の埋め込みが近いとみなす言い換えの組（自動テスト用）。言葉の検索では見つからない組を選んでいる。
 */
export const STUB_EMBEDDING_CONCEPTS: readonly (readonly string[])[] = [
  ['育児のための休み', '子育ての休み', '育児休業'],
  ['残業', '時間外労働'],
  ['宿代', 'ホテル代', '宿泊費'],
  ['休みは何日', '有休', '年次有給休暇'],
  ['テレワーク', 'リモートワーク', '在宅勤務'],
];

/** 見本の埋め込み。言い換えの組ごとに 1 つの次元を持ち、文字の組を弱く散らす。長さ 1 にそろえる。 */
export function stubEmbedding(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const t = text.normalize('NFKC');
  STUB_EMBEDDING_CONCEPTS.forEach((group, i) => { if (group.some((w) => t.includes(w))) v[i] = 1; });
  const chars = [...t.replace(/\s+/g, '')];
  for (let i = 0; i + 1 < chars.length; i++) {
    let h = 0;
    for (const c of chars[i]! + chars[i + 1]!) h = (h * 31 + c.codePointAt(0)!) >>> 0;
    const at = STUB_EMBEDDING_CONCEPTS.length + (h % (EMBEDDING_DIMENSIONS - STUB_EMBEDDING_CONCEPTS.length));
    v[at] = v[at]! + 0.05;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/**
 * メールの画面（仕様書 第9.5.1.1節）の推論の見本。言葉で決める。
 *
 * - 振り分け: 「ご教示・いかがでしょうか・お知らせください」は返事が要る、「締め切り・期限・申請」は対応が要る、ほかは目を通すだけ
 * - 返事待ち: 問いかけ・お願いを含めば待っている
 * - 下書き: 決まった丁寧な返事
 *
 * @returns メールの画面の推論でなければ `null`
 */
function stubMail(system: string, user: string): string | null {
  // 直しから学ぶ（第11.13.7節）。「いつも」「次から」「毎回」を含む直しだけを、次からもの好みとみなす
  if (system.includes('次からもそうしてほしい仕事のやり方の好み')) {
    let d: { 直し?: string } = {};
    try { d = JSON.parse(user) as { 直し?: string }; } catch { d = {}; }
    const text = (d.直し ?? '').trim();
    return /いつも|次から|毎回|常に/.test(text) ? JSON.stringify({ keep: true, preference: text.replace(/^(次から(は)?|いつも)/, '').slice(0, 60) }) : JSON.stringify({ keep: false, preference: '' });
  }
  // メールのカテゴリー（第9.5.1.1.1節）。名前が件名か冒頭に出てくるカテゴリーを選ぶ
  const categoryNames = [...(system.split('いまのカテゴリー:')[1] ?? '').matchAll(/^- ([^（\n]+)/gm)].map((x) => x[1]!.trim());
  const pick = (t: string) => categoryNames.find((n) => t.includes(n)) ?? '';
  if (system.includes('カテゴリーの名前を付けてください')) {
    // 最初の候補: 同じ差出人のドメインから 2 通以上あれば、その組織の名前にする
    let list: { from?: string }[] = [];
    try { list = JSON.parse(user) as { from?: string }[]; } catch { list = []; }
    const by = new Map<string, number>();
    for (const x of list) {
      const d = /@([^>\s]+)/.exec(x.from ?? '')?.[1]?.split('.')[0] ?? '';
      if (d) by.set(d, (by.get(d) ?? 0) + 1);
    }
    return JSON.stringify({ categories: [...by].filter(([, n]) => n >= 2).map(([d]) => ({ name: d, note: `${d} とのやり取り` })) });
  }
  if (system.includes('同じプロジェクト・同じ取引先・同じ用件を指すものをまとめて')) return JSON.stringify({ merges: [] });
  if (system.includes('メールのカテゴリー（仕事のまとまり）か振り分けの直しを頼みました')) {
    // 正規表現で文の頭から読ませず、目印の言葉を文字で探して切り出す（長い文で遅くならないように）
    const reqAt = user.lastIndexOf('本人の頼み: ');
    const req = reqAt >= 0 ? user.slice(reqAt + 7).split('\n')[0]! : '';
    const before = (s: string, re: RegExp) => { const i = s.search(re); return i > 0 ? s.slice(0, i) : null; };
    const after = (s: string, re: RegExp) => { const m = re.exec(s); return m ? s.slice(m.index + m[0].length) : null; };
    let data: { current?: string | null; threads?: { threadId: string; from: string }[] } = {};
    const dataAt = user.indexOf('データ:\n');
    const dataEnd = user.indexOf('\n\n本人の頼み');
    try { data = JSON.parse(dataAt >= 0 && dataEnd > dataAt ? user.slice(dataAt + 5, dataEnd) : '{}') as typeof data; } catch { data = {}; }
    // 振り分けの直し（第9.5.1.1.2節）
    const threads = data.threads ?? [];
    let t = /^(これ|このメール)は(返事|返信)(は)?(要らない|いらない|不要)/.test(req) && data.current ? data.current : null;
    if (t) return JSON.stringify({ teach: [{ threadId: t, scope: 'from', target: 'read' }], reply: 'この相手のメールは、これから「目を通すだけ」にします。' });
    let who = before(req, /(さん|様)?の(メール)?は(大事|重要)/);
    t = who ? threads.find((x) => x.from.includes(who!))?.threadId ?? null : null;
    if (who && t) return JSON.stringify({ teach: [{ threadId: t, scope: 'from', target: 'important' }], reply: `「${who}」さんのメールは大事なものとして扱います。` });
    who = before(req, /からの?(メール|お知らせ)?は(宣伝|見なくて)/);
    t = who ? threads.find((x) => x.from.includes(who!))?.threadId ?? null : null;
    if (who && t) return JSON.stringify({ teach: [{ threadId: t, scope: 'from', target: 'promo' }], reply: `「${who}」からのメールは宣伝・お知らせにします。` });
    const categoryIn = (s: string) => before(s, /の(件|カテゴリー|プロジェクト)/);
    who = before(req, /からの?メール[はを]/);
    const named = categoryIn(after(req, /メール[はを]/) ?? '');
    if (!who && named && data.current) return JSON.stringify({ assign: [{ threadId: data.current, category: named }], reply: `このメールを「${named}」にしました。` });
    if (who && named) {
      const hits = (data.threads ?? []).filter((x) => x.from.includes(who!));
      return JSON.stringify({ assign: hits.map((x) => ({ threadId: x.threadId, category: named })), reply: `「${who}」からのメールを「${named}」にしました。` });
    }
    const created = before(req, /という(カテゴリー|プロジェクト)を作って/);
    if (created) return JSON.stringify({ create: [created], reply: `「${created}」を作りました。` });
    const sameAt = req.indexOf('は同じ');
    const pair = sameAt > 0 ? req.slice(0, sameAt) : '';
    const andAt = pair.indexOf('と');
    if (andAt > 0) {
      const [into, from] = [pair.slice(0, andAt), pair.slice(andAt + 1)];
      return JSON.stringify({ merge: [{ from, into }], reply: `「${from}」を「${into}」にまとめました。` });
    }
    return JSON.stringify({ reply: '' });
  }
  const rows = (): { i: number; subject: string; head: string }[] => {
    try {
      const v = JSON.parse(user) as { i: number; subject?: string; head?: string }[];
      return Array.isArray(v) ? v.map((x) => ({ i: x.i, subject: x.subject ?? '', head: x.head ?? '' })) : [];
    } catch {
      return [];
    }
  };
  if (system.includes('reply（返事が要る）')) {
    const items = rows().map((x) => {
      const t = `${x.subject} ${x.head}`;
      const category = pick(t);
      if (/ご教示|いかがでしょうか|お知らせください|ご回答/.test(t)) return { i: x.i, group: 'reply', summary: '回答を求められています', due: /今週中/.test(t) ? '今週中' : '', dueDate: '', category };
      if (/締め切り|期限|申請/.test(t)) return { i: x.i, group: 'action', summary: '期限までに申請', due: (/(\d{1,3}) ?日まで/.exec(t)?.[0]) ?? '', dueDate: '', category };
      return { i: x.i, group: 'read', summary: '', due: '', dueDate: '', category };
    });
    return JSON.stringify({ items });
  }
  if (system.includes('相手からの返事を待っているものか')) {
    return JSON.stringify({ items: rows().map((x) => ({ i: x.i, waiting: /？|\?|ください|いかが|お願い/.test(`${x.subject} ${x.head}`), category: pick(`${x.subject} ${x.head}`) })) });
  }
  if (system.includes('の秘書です。') && (system.includes('返事の下書き') || system.includes('催促の下書き'))) {
    return system.includes('催促') ? 'お世話になっております。\n先日お送りしたメールの件、ご確認いただけましたでしょうか。\nお手すきの際にご返信いただけますと幸いです。'
      : 'いつもお世話になっております。\nご連絡ありがとうございます。内容を確認して、改めてご連絡いたします。\nよろしくお願いいたします。';
  }
  return null;
}
