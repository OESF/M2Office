/**
 * @file ツールの呼び出しを、承認する人が読める業務の言葉にする（仕様書 第9.3.3節・第9.4節）。
 *
 * 承認の画面と操作の確認に出す。**ツール名・JSON・内部の ID は出さない。**
 * 承認する人は、何が起きるかを読んで判断する。`tasks.create: {"due":…}` では判断できない
 * （2026-09-25 の受け入れテストで、承認した人が何を承認したのか分からなかった）。
 */

/** 呼び出し 1 件。 */
export interface DescribedCall {
  name: string;
  args: Record<string, unknown>;
  /** 承認の前に確かめた名前（例: スペースの名前。ADR-0024）。あれば引数の値の代わりに出す。 */
  shown?: string;
}

/** 言葉にするときに引くもの。 */
export interface DescribeContext {
  /** ツールの説明（業務の言葉）。知らないツールの言い方に使う。 */
  helpText?(name: string): string | undefined;
  /** 成果物の ID から題名を引く（知識への登録などで、ID の代わりに題名を出す）。 */
  artifactTitle?(id: string): string | undefined;
  /** 会社の接続のツールなら、接続の名前・相手のツールの名前・危険度（仕様書 第12.11節）。 */
  connectionOf?(name: string): { service: string; tool: string; risk: string; labels?: Record<string, string> } | undefined;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

/** 日付（`YYYY-MM-DD`）や日時を、日本の書き方にする。読めなければそのまま返す。 */
export function jpDate(v: string): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (d) return `${Number(d[1])}年${Number(d[2])}月${Number(d[3])}日`;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return v;
  const f = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(t));
  const g = (type: string) => f.find((p) => p.type === type)?.value ?? '';
  return `${g('year')}年${g('month')}月${g('day')}日 ${g('hour')}:${g('minute')}`;
}

/** 本文を引用の形にする。長ければ切る。 */
function quote(text: string, max = 2000): string {
  const body = text.length > max ? `${text.slice(0, max)}\n…（長いため、ここで切りました）` : text;
  return body.split('\n').map((l) => `> ${l}`).join('\n');
}

/**
 * 呼び出し 1 件を、承認の画面に出す言葉にする（Markdown）。
 *
 * @returns 1 行目が「何をするか」、送る本文があれば続けて引用で出す
 */
export function describeCall(call: DescribedCall, ctx: DescribeContext = {}): string {
  const a = call.args ?? {};
  switch (call.name) {
    case 'tasks.create': {
      const due = str(a['due']);
      return `**ToDo を登録します**: ${str(a['title']) || '（題名なし）'}${due ? `（期限 ${jpDate(due)}）` : '（期限なし）'}`;
    }
    case 'tasks.complete':
      return '**ToDo を完了にします**';
    case 'chat.post':
      // 確かめたスペースの名前があれば、それを出す（記録の引数は `spaces/…` になっている）
      return `**チャットのスペース「${call.shown || str(a['space']) || '（指定なし）'}」に投稿します**:\n${quote(str(a['text']))}`;
    case 'gmail.send': {
      const cc = list(a['cc']);
      return [
        `**メールを送ります**: 宛先 ${list(a['to']).join('、') || '（なし）'}${cc.length ? `／CC ${cc.join('、')}` : ''}／件名「${str(a['subject']) || '（件名なし）'}」`,
        quote(str(a['body'])),
      ].join('\n');
    }
    case 'mail.bulk_send':
      // 宛先の一覧・除いた人・見本は、承認の前の確かめで組み立てたもの（仕様書 第27.9.1節）
      return `**まとめてのメールを送ります**（あなたの Gmail から 1 人に 1 通ずつ）\n${call.shown ?? ''}`;
    case 'gmail.create_draft':
      return [`**メールの下書きを作ります**（送りません）: 宛先 ${str(a['to']) || '（なし）'}／件名「${str(a['subject']) || '（件名なし）'}」`, quote(str(a['body']))].join('\n');
    case 'calendar.create': {
      const who = list(a['attendees']);
      return `**予定を登録し、招待を送ります**: ${str(a['title']) || '（題名なし）'}（${jpDate(str(a['start']))}〜${jpDate(str(a['end']))}）${who.length ? `／参加者 ${who.join('、')}` : ''}`;
    }
    case 'calendar.update': {
      const parts = [
        str(a['title']) ? `題名を「${str(a['title'])}」に` : '',
        str(a['start']) ? `開始を ${jpDate(str(a['start']))} に` : '',
        str(a['end']) ? `終了を ${jpDate(str(a['end']))} に` : '',
        list(a['attendees']).length ? `参加者を ${list(a['attendees']).join('、')} に` : '',
      ].filter(Boolean);
      return `**予定を変えます**（参加者に通知が届きます）: ${parts.join('、') || '（変更なし）'}`;
    }
    case 'calendar.cancel':
      return '**予定を取り消します**（参加者に通知が届きます）';
    case 'knowledge.register': {
      const title = ctx.artifactTitle?.(str(a['artifactId']));
      return `**社内の知識に登録します**: ${title ? `「${title}」` : '作った成果物'}（会社の全員の秘書が参照できるようになります）`;
    }
    case 'notification.send':
      return `**あなたにお知らせを届けます**: ${str(a['title']) || '（題名なし）'}`;
    case 'document.create':
      return `**文書を作ります**: ${str(a['title']) || '（題名なし）'}`;
    case 'drive.share':
      return `**ファイルを共有します**: 相手 ${list(a['emails']).join('、') || '（なし）'}（${({ reader: '閲覧', commenter: 'コメント', writer: '編集' } as Record<string, string>)[str(a['role'])] ?? str(a['role'])}）`;
    case 'drive.share_company':
      // 承認の前に確かめたファイルの名前を出す（ADR-0024・ADR-0025）
      return `**会社の全員が閲覧できるようにします**: 「${call.shown || '保存した文書'}」（社外の人は見られません。リンクを知っている社内の人だけが開けます）`;
    case 'sheets.append':
      return `**表に行を足します**: ${Array.isArray(a['rows']) ? a['rows'].length : 0} 行`;
    default: {
      // 会社の接続のツールは、相手の説明が英語で長く、引数の意味も分からない。サービスとツールの名前と、
      // **送り先を含むすべての引数**を出す（承認する人が、どこへ何が行くかを見て判断できるように。2026-09-27 に Slack で確認）
      const conn = ctx.connectionOf?.(call.name);
      if (conn) return describeConnectionCall(conn, a, call.shown);
      // 知らないツールは、ツールの説明と、ID でない文字の引数だけを出す
      const help = ctx.helpText?.(call.name) ?? 'この業務の操作を行います';
      const shown = Object.entries(a)
        .filter(([k, v]) => typeof v === 'string' && v.trim() && !/id$/i.test(k))
        .map(([, v]) => (String(v).length > 80 ? `${String(v).slice(0, 80)}…` : String(v)));
      return `**${help.replace(/。.*$/, '')}**${shown.length ? `: ${shown.join('／')}` : ''}`;
    }
  }
}

/** 会社の接続のツールの危険度ごとの言い方。 */
const CONNECTION_VERBS: Record<string, string> = {
  read: 'から読みます',
  draft: 'に下書きを作ります',
  'write-internal': 'に書き込みます',
  'external-send': 'へ送ります',
  financial: 'でお金に関わる操作をします',
};

/**
 * 会社の接続のツールの呼び出しを、承認の画面に出す言葉にする。
 *
 * @param shown 承認の前に確かめた名前（`{"channel_id":"#研究開発"}` の形。型の `resolvers`）
 * @remarks
 * 1 行目に「Slack へ送ります（slack_send_message）」、続けて引数を 1 つずつ。引数の名前は型の言葉にし（送り先・本文）、
 * 確かめた名前があれば ID の前に出す。長い文字の引数は引用で出す
 */
function describeConnectionCall(
  conn: { service: string; tool: string; risk: string; labels?: Record<string, string> }, a: Record<string, unknown>, shown?: string,
): string {
  const head = `**${conn.service}${CONNECTION_VERBS[conn.risk] ?? 'の操作を行います'}**（${conn.tool}）`;
  let names: Record<string, string> = {};
  try { names = shown ? JSON.parse(shown) as Record<string, string> : {}; } catch { names = {}; }
  const lines: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined || v === null || v === '') continue;
    const label = conn.labels?.[k] ?? k;
    const raw = typeof v === 'string' ? v : JSON.stringify(v);
    const text = names[k] ? `${names[k]}（${raw}）` : raw;
    lines.push(text.includes('\n') || text.length > 80 ? `- ${label}:\n${quote(text)}` : `- ${label}: ${text}`);
  }
  return lines.length > 0 ? [head, ...lines].join('\n') : head;
}

/**
 * 承認の前の組み立てで**済ませたこと**（下書きのツールの結果）を、承認の画面に出す言葉にする（ADR-0025）。
 *
 * @returns 出す言葉。承認する人に知らせる必要の無いもの（M2Office の中の成果物など）は `null`
 */
export function describeDone(call: DescribedCall, result: unknown): string | null {
  const r = (result ?? {}) as { created?: boolean; file?: { name?: string; url?: string | null }; reason?: string; title?: string };
  switch (call.name) {
    case 'docs.create': {
      if (r.created && r.file) {
        const name = r.file.name || str(call.args['title']) || '文書';
        const link = r.file.url ? `[${name}](${r.file.url})` : `「${name}」`;
        return `**Google ドキュメントに保存しました**: ${link}（あなたのドライブ。まだ誰にも共有していません）`;
      }
      return `**Google ドキュメントに保存できませんでした**: ${r.reason ?? '理由が分かりません'}`;
    }
    default:
      return null;
  }
}

