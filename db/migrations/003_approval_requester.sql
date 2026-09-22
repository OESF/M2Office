-- 承認者の指定（仕様書 第9.2.3節）
-- approver: requester の承認では、判断できるのは依頼した本人だけである。
-- その本人を承認の記録に持たせる。null なら approver_role による判断。
alter table approvals add column if not exists approver_user_id text references users(id) on delete set null;
