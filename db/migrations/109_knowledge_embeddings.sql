-- 知識の意味の検索（仕様書 第11.7.6節、ADR-0009。第 0.302.0 版）。
-- 節ごとに、意味を表す数値の並び（埋め込み。768 次元）と、どのモデルで作ったか・本文のハッシュを持つ。
-- 埋め込みはワーカーが後から作る。本文が変わらない節は、分け直しても前の埋め込みを使い回す（ハッシュで見分ける）。
-- pgvector が無いデータベースでは埋め込みの列を作らず、言葉の検索（段階 2）だけで動く（第11.7.6.6節）。

-- 本文のハッシュ・作ったモデル・作った時刻・失敗の回数（pgvector の有無にかかわらず持つ）
alter table knowledge_sections add column if not exists body_hash text;
alter table knowledge_sections add column if not exists embedding_model text;
alter table knowledge_sections add column if not exists embedded_at timestamptz;
alter table knowledge_sections add column if not exists embed_attempts integer not null default 0;
alter table knowledge_sections add column if not exists embed_after timestamptz;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'vector') then
    create extension if not exists vector;
    execute 'alter table knowledge_sections add column if not exists embedding vector(768)';
  end if;
end $$;

-- 埋め込みを待つ節を探す（会社ごとに）
create index if not exists knowledge_sections_embed_idx on knowledge_sections (tenant_id) where embedded_at is null;
