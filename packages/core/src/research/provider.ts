/**
 * @file Web での調査（Google 検索グラウンディング）の提供者。Gemini を直接呼ぶ実装と、鍵が無い環境の見本。
 *
 * 調査の指示文と、グラウンディングの結果（検索の言葉・出典）の取り出し方は、AI Radio の
 * `server/lib/secretary-tools-presentation.js`（`_researchTopicForSlides`）と `server/lib/llm-client.js`
 * （`extractGrounding`）を移植した（MIT、同じ作者。ADR-0006）。
 *
 * OpenAI 互換の窓口ではグラウンディングの出典を受け取れないため、Gemini の `generateContent` を直接呼ぶ。
 * 応答は外部のデータであり、指示として扱わない（不変則 I-6）。
 *
 * @see 仕様書 第9.4.2節 調べてスライドにまとめる共通ツール
 */

/** 調べた結果。 */
export interface ResearchResult {
  /** `gemini` は実際に調べた結果、`mock` は見本（実際には調べていない）。 */
  source: 'gemini' | 'mock';
  /** 調べた結果の文章。 */
  text: string;
  /** 出典（題名と URL）。 */
  sources: { title: string; url: string }[];
  /** 使った検索の言葉。 */
  queries: string[];
  tokensUsed: number;
}

/** 調査の提供者。 */
export interface ResearchProvider {
  readonly name: string;
  research(topic: string, opts?: { focus?: string }): Promise<ResearchResult>;
}

/** 調査の指示。数値・比較・時系列を集めさせ、分からない点は推測させない（AI Radio から移植）。 */
const RESEARCH_INSTRUCTION = 'あなたはプレゼンテーション作成のためのリサーチ担当です。指定された'
  + 'テーマについてWeb検索を使って調査してください。数値・比較・時系列の変化など、スライドの'
  + 'グラフや表にできる具体的なデータがあれば必ず含めてください。分からなかった点は推測で'
  + '埋めず「不明」と書いてください。出力は調査結果の文章のみとし、前置きや締めの言葉は'
  + '含めないでください。';

/** 応答として推論に渡す量の上限（文字数）。 */
const RESEARCH_TEXT_LIMIT = 8000;

/**
 * Gemini の Google 検索グラウンディングで調べる。
 *
 * @param apiKey Gemini の API 鍵
 * @param model 使うモデル（例: `gemini-flash-latest`）
 */
export class GeminiResearchProvider implements ResearchProvider {
  readonly name = 'gemini';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
    private readonly timeoutMs = 120_000,
  ) {}

  async research(topic: string, opts: { focus?: string } = {}): Promise<ResearchResult> {
    const prompt = opts.focus ? `テーマ: ${topic}\n特に知りたいこと: ${opts.focus}` : `テーマ: ${topic}`;
    const res = await fetch(`${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: RESEARCH_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        // 温度などの抜き出しの指定は送らない（Gemini 3.6 Flash から効かず、これからのモデルではエラーになる。2026-10 の Google の知らせ）
        tools: [{ googleSearch: {} }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`調査の呼び出しに失敗しました（HTTP ${res.status}）`);
    const json = (await res.json()) as GeminiResponse;
    const candidate = json.candidates?.[0];
    // 思考のパーツは除く。本文だけをつなぐ
    const text = (candidate?.content?.parts ?? []).filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
    const gm = candidate?.groundingMetadata;
    return {
      source: 'gemini',
      text: text.length > RESEARCH_TEXT_LIMIT ? `${text.slice(0, RESEARCH_TEXT_LIMIT)}\n…（以降は省略）` : text,
      sources: (gm?.groundingChunks ?? [])
        .map((c) => ({ title: c.web?.title ?? c.web?.uri ?? '', url: c.web?.uri ?? '' }))
        .filter((s) => s.url),
      queries: gm?.webSearchQueries ?? [],
      tokensUsed: json.usageMetadata?.totalTokenCount ?? 0,
    };
  }
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: { web?: { uri?: string; title?: string } }[];
    };
  }[];
  usageMetadata?: { totalTokenCount?: number };
}

/**
 * 鍵が無い環境の見本。実際には調べず、見本であることを明示した文章を返す。
 *
 * @remarks 見本の内容に事実らしい数値や製品名を入れない。見本が本物の調査として資料に残ることを防ぐ。
 */
export class MockResearchProvider implements ResearchProvider {
  readonly name = 'mock';

  async research(topic: string): Promise<ResearchResult> {
    return {
      source: 'mock',
      text: [
        `［見本の調査結果］「${topic}」について、実際には調べていません。`,
        'LLM の鍵が無い開発環境のため、Web の検索を行わずに、この見本の文章を返しています。',
        '鍵を設定すると、Google 検索で調べた結果と出典がここに入ります。',
      ].join('\n'),
      sources: [],
      queries: [],
      tokensUsed: 0,
    };
  }
}
