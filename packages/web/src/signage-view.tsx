/**
 * @file 店頭サイネージの割り込みと HTML の素材の見た目（仕様書 第31.7.1節・第31.6.3節）。再生のページと管理の画面の見本が使う。
 *
 * 文字の割り込みは決まった計算で作る（推論に文を渡さない）。画面に収まる最大の大きさにし、先頭の番号をさらに大きく出す。
 * 会社の HTML は外と通信できない囲い（`sandbox`・中に入れた見出し）の中でだけ開き、ワークスペースの画面の中に直に描かない。
 */

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/** HTML の素材に先に入れる見出し（外と通信させない。第31.6.3節）。 */
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";

/**
 * 囲いの中で開く HTML の文書にする（先頭に、外と通信させない見出しを入れる）。
 */
export function sandboxDoc(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + meta + html.slice(doctype[0].length) : meta + html;
}

/**
 * 会社の HTML を開く囲い。スクリプトは囲いの中だけで動き、外と通信できず、ページや M2Office のデータに触れられない。音は出させない。
 */
export function HtmlFrame({ html, onLoad, className }: { html: string; onLoad?: () => void; className?: string }) {
  return (
    <iframe className={className ?? 'signage-html'} title="" srcDoc={sandboxDoc(html)} sandbox="allow-scripts" allow="autoplay 'none'; camera 'none'; microphone 'none'; geolocation 'none'"
      referrerPolicy="no-referrer" onLoad={onLoad} />
  );
}

/** 背景との明るさの比（WCAG の計算）が大きいほうの文字の色（白か黒）。 */
export function textColorOn(bg: string): '#ffffff' | '#000000' {
  const hex = /^#?([0-9a-f]{6})$/i.exec(bg)?.[1] ?? '1f3a5f';
  const lum = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * lum[0]! + 0.7152 * lum[1]! + 0.0722 * lum[2]!;
  return (1.05) / (l + 0.05) >= (l + 0.05) / 0.05 ? '#ffffff' : '#000000';
}

/**
 * 文字の割り込み。画面の幅の 90%・高さの 85% の中に収まる最大の大きさを、1 画素ずつ探して決める（決まった計算）。
 *
 * @param number 大きく出す番号（文の先頭の「数字番」）
 */
export function InterruptText({ text, number, color }: { text: string; number: string | null; color: string }) {
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(40);
  const m = number ? new RegExp(`^${number}番`).exec(text) : /^\d{1,4}番/.exec(text);
  const head = m ? m[0] : null;
  const rest = head ? text.slice(head.length).replace(/^[、,\s]+/, '') : text;
  useLayoutEffect(() => {
    const b = box.current;
    const t = body.current;
    if (!b || !t) return;
    // 収まる最大の大きさを二分で探す（画素の単位）
    let lo = 8;
    let hi = 800;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      t.style.fontSize = `${mid}px`;
      if (t.scrollWidth <= b.clientWidth && t.scrollHeight <= b.clientHeight) lo = mid; else hi = mid;
    }
    t.style.fontSize = `${lo}px`;
    setSize(lo);
  }, [text, number]);
  const fg = textColorOn(color);
  const style: CSSProperties = { background: color, color: fg };
  return (
    <div className="signage-int-text" style={style}>
      <div className="signage-int-box" ref={box}>
        <div className="signage-int-body" ref={body} style={{ fontSize: size }}>
          {head && <div className="signage-int-num">{head}</div>}
          {rest && <div>{rest}</div>}
        </div>
      </div>
    </div>
  );
}
