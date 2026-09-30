-- 人事・給与の段 4（確定と明細）。仕様書 第30.10.3節、ADR-0053
--
-- 回の点検・確定（誰が・いつ・監修前の表で確定したか）・振込データの記録・試しの計算の比べ、
-- 明細の勤怠の集計（賃金台帳に使う）、明細を画面で受け取る本人の同意。
-- 確定した回と明細は、アプリの利用者（m2office_app）からは書き換えも削除もできない（H-6）。

alter table pay_runs drop constraint if exists pay_runs_kind_check;
alter table pay_runs add constraint pay_runs_kind_check check (kind in ('monthly', 'bonus', 'yea', 'correction', 'trial'));

alter table pay_runs add column if not exists checks jsonb not null default '[]'::jsonb;
alter table pay_runs add column if not exists compare jsonb;
alter table pay_runs add column if not exists confirmed_by text;
alter table pay_runs add column if not exists confirmed_at timestamptz;
alter table pay_runs add column if not exists confirmed_unverified boolean not null default false;
alter table pay_runs add column if not exists confirm_requested_at timestamptz;
alter table pay_runs add column if not exists transfer_by text;
alter table pay_runs add column if not exists transfer_at timestamptz;
-- 同じ支給月の確定した月の給与は 1 つ（訂正は訂正の回で）
create unique index if not exists pay_runs_confirmed_idx on pay_runs (tenant_id, kind, pay_month) where status in ('confirmed', 'paid');

alter table pay_slips add column if not exists attendance jsonb not null default '{}'::jsonb;

alter table hr_payroll_profiles add column if not exists payslip_consent_at timestamptz;

-- 確定した回と明細を守る。アプリの利用者のときだけ拒む（持ち主の保守の作業は妨げない）
create or replace function m2o_pay_protect() returns trigger language plpgsql as $$
declare locked boolean;
begin
  if current_user <> 'm2office_app' then
    return coalesce(new, old);
  end if;
  if tg_table_name = 'pay_runs' then
    if old.status not in ('confirmed', 'paid') then
      return coalesce(new, old);
    end if;
    if tg_op = 'DELETE' then
      raise exception '確定した給与の回は消せません';
    end if;
    -- 確定の後に変えてよいのは、振込データの記録と支払済みにすることだけ
    if (to_jsonb(new) - 'transfer_by' - 'transfer_at' - 'status') <> (to_jsonb(old) - 'transfer_by' - 'transfer_at' - 'status')
       or new.status not in ('confirmed', 'paid') then
      raise exception '確定した給与の回は書き換えられません';
    end if;
    return new;
  end if;
  -- pay_slips
  select status in ('confirmed', 'paid') into locked from pay_runs where id = coalesce(new.run_id, old.run_id);
  if coalesce(locked, false) then
    raise exception '確定した給与の明細は書き換えられません';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists pay_runs_protect on pay_runs;
create trigger pay_runs_protect before update or delete on pay_runs for each row execute function m2o_pay_protect();
drop trigger if exists pay_slips_protect on pay_slips;
create trigger pay_slips_protect before insert or update or delete on pay_slips for each row execute function m2o_pay_protect();
