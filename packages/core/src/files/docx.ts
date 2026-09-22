import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

/** 文書の 1 ブロック。見出しか段落。 */
export type DocBlock = { heading: string; level?: 1 | 2 | 3 } | { text: string };

/**
 * Word（docx）形式の文書を作る。
 *
 * @remarks
 * 体裁は最小限にとどめる。会社ごとのひな形（ロゴ・色・並び）は Q-57 で決める。
 * 文字の書体は Word 側の既定に任せ、ファイルには埋め込まない。
 */
export async function renderDocx(title: string, blocks: DocBlock[]): Promise<Uint8Array> {
  const levels = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;
  const doc = new Document({
    title,
    sections: [{
      children: [
        new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
        ...blocks.map((b) =>
          'heading' in b
            ? new Paragraph({ text: b.heading, heading: levels[b.level ?? 1] })
            : new Paragraph({ children: b.text.split('\n').map((t, i) => new TextRun({ text: t, break: i > 0 ? 1 : 0 })) }),
        ),
      ],
    }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}
