/**
 * @file 一覧へ戻るボタン（仕様書 第6.1.2.2節）。詳しい画面と作業の欄の**上と下**に、同じ言い方（「‹ 〇〇の一覧」）で置く。
 *
 * 2026-10-20 に三浦さんが、戻るリンクが題名の下に小さく出ていて分かりにくいこと、長い画面ではいちばん上まで
 * スクロールしないと戻れないこと、言い方がそろっていないこと（「← 一覧」「← 在庫」「一覧に戻る」など）を挙げた。
 * 枠のあるボタンにして見つけやすくし、画面の終わりにも置く。押したら、戻った画面をいちばん上から見せる。
 */

/**
 * 一覧へ戻るボタン。
 *
 * @param label 戻る先の名前（「品目の一覧」など。頭の「‹」は付けない）
 * @param place 画面の上（既定）か下か（下は上との間を空ける）
 */
export function BackButton({ label, onClick, place = 'top' }: { label: string; onClick: () => void; place?: 'top' | 'bottom' }) {
  const go = (e: React.MouseEvent<HTMLButtonElement>) => {
    // 長い画面の下から戻っても、戻った画面をいちばん上から見せる（中身を流す枠と、画面全体の両方）
    let el: HTMLElement | null = e.currentTarget.parentElement;
    while (el) {
      if (el.scrollTop > 0) el.scrollTop = 0;
      el = el.parentElement;
    }
    window.scrollTo({ top: 0 });
    onClick();
  };
  return <button type="button" className={`back-btn back-${place}`} onClick={go}>‹ {label}</button>;
}
