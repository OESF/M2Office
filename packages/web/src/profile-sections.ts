/**
 * @file 秘書から見たあなた（本人の像）を見出しごとに分ける（仕様書 第6.5.4.2節・第11.13.1節）。
 *
 * 本人の像は「## 役割と担当」などの見出しで書かれる。画面では見出しごとに枠に分けて並べる。
 */

/** 見出し 1 つ分。 */
export interface ProfileSection {
  /** 見出し（`## ` を除いたもの） */
  heading: string;
  /** 見出しの下の Markdown */
  body: string;
  /** まだ分からない見出しか（中身が「（まだ分かりません）」だけ） */
  unknown: boolean;
}

/**
 * 本人の像を `## ` の見出しごとに分ける。
 *
 * @param text 本人の像の Markdown
 * @returns 見出しの順の区画。見出しが 1 つも無ければ空の配列（呼び出し側は全文をそのまま出す）
 */
export function profileSections(text: string): ProfileSection[] {
  const sections: ProfileSection[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  const close = () => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    sections.push({ heading: current.heading, body, unknown: /^[-*]?\s*（まだ分かりません）$/.test(body) || body === '' });
  };
  for (const line of text.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) { close(); current = { heading: m[1]!, lines: [] }; continue; }
    current?.lines.push(line);
  }
  close();
  return sections;
}
