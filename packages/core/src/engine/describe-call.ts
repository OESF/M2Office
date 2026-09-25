/**
 * @file 道具の呼び出しを、承認する人が読める業務の言葉にする（仕様書 第9.3.3節・第9.4節）。
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
  /** 道具の説明（業務の言葉）。知らない道具の言い方に使う。 */
  helpText?(name: string): string | undefined;
  /** 成果物の ID から題名を引く（知識への登録などで、ID の代わりに題名を出す）。 */
  artifactTitle?(id: string): string | undefined;
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
    case 'sheets.append':
      return `**表に行を足します**: ${Array.isArray(a['rows']) ? a['rows'].length : 0} 行`;
    default: {
      // 知らない道具は、道具の説明と、ID でない文字の引数だけを出す
      const help = ctx.helpText?.(call.name) ?? 'この業務の操作を行います';
      const shown = Object.entries(a)
        .filter(([k, v]) => typeof v === 'string' && v.trim() && !/id$/i.test(k))
        .map(([, v]) => (String(v).length > 80 ? `${String(v).slice(0, 80)}…` : String(v)));
      return `**${help.replace(/。.*$/, '')}**${shown.length ? `: ${shown.join('／')}` : ''}`;
    }
  }
}
