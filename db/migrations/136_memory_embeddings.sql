-- 秘書の成長の段 2: 記憶と会話の要約を意味で探す（仕様書 第11.13.4節。第 0.364.0 版）
--
-- 本人の覚えていることと会話の要約に、意味を表す数値の並び（埋め込み。768 次元）と、作ったモデル・時刻・失敗の回数を持つ。
-- 埋め込みはワーカーが後から作る。文が変わったら作った時刻を消して作り直す。pgvector が無いデータベースでは埋め込みの列を作らない（言葉で探す）。
alter table memories add column if not exists embedding_model text;
alter table memories add column if not exists embedded_at timestamptz;
alter table memories add column if not exists embed_attempts integer not null default 0;
alter table memories add column if not exists embed_after timestamptz;

alter table conversation_digests add column if not exists embedding_model text;
alter table conversation_digests add column if not exists embedded_at timestamptz;
alter table conversation_digests add column if not exists embed_attempts integer not null default 0;
alter table conversation_digests add column if not exists embed_after timestamptz;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'vector') then
    create extension if not exists vector;
    execute 'alter table memories add column if not exists embedding vector(768)';
    execute 'alter table conversation_digests add column if not exists embedding vector(768)';
  end if;
end $$;

-- 埋め込みを待つものを探す（会社ごとに）
create index if not exists memories_embed_idx on memories (tenant_id) where embedded_at is null and status = 'active';
create index if not exists conversation_digests_embed_idx on conversation_digests (tenant_id) where embedded_at is null and compartment is null;
