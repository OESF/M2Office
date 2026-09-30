-- 接続のアプリの自動登録（動的クライアント登録。仕様書 第12.11.6.2節、Q-99、ADR-0044 の追記）
--
-- 相手の認可サーバが自動登録の口を持っていれば、M2Office が会社ごとにアプリを登録し、返ってきたクライアント ID とシークレットを
-- 手で登録したものと同じ表（connection_secrets）に暗号化して持つ。自動で登録したかを印で持つ（管理者ページに示し、無効になったら登録し直すため）。
-- シークレットを持たないアプリ（公開クライアント）もあるため、クライアント ID だけで使えるようにする（client_secret_enc は元から空にできる）。

alter table connection_secrets add column if not exists auto_registered boolean not null default false;
