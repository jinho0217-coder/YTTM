create table public.library_booking_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  failures integer not null default 0,
  blocked_until timestamptz
);
insert into public.library_booking_settings default values;
alter table public.library_booking_settings enable row level security;
revoke all on public.library_booking_settings from public, anon, authenticated;
grant select, update on public.library_booking_settings to service_role;

create table public.library_booking_results (
  reservation_date date not null,
  hours text not null,
  status text not null check (status in ('success', 'failed', 'unknown')),
  primary key (reservation_date, hours)
);
alter table public.library_booking_results enable row level security;
revoke all on public.library_booking_results from public, anon, authenticated;
grant select, insert, update on public.library_booking_results to service_role;

create function public.library_record_result(p_date date, p_hours text, p_status text, p_claimed boolean)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_claimed then
    perform public.library_finish_run(p_date, p_status);
  end if;
  insert into public.library_booking_results values (p_date, p_hours, p_status)
  on conflict (reservation_date, hours) do update set status = excluded.status
    where library_booking_results.status <> 'success';
end;
$$;
revoke all on function public.library_record_result(date,text,text,boolean) from public, anon, authenticated;
grant execute on function public.library_record_result(date,text,text,boolean) to service_role;

create function public.library_booking_admin(
  p_pin_valid boolean, p_operation text, p_slot integer, p_secret text, p_enabled boolean
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  settings public.library_booking_settings%rowtype;
  owner_id constant uuid := '00000000-0000-4000-8000-000000000001';
  accounts jsonb;
begin
  select * into strict settings from public.library_booking_settings where id for update;
  if settings.blocked_until > now() then
    return jsonb_build_object('error', 'PIN 입력 시도가 너무 많습니다. 5분 후 다시 시도하세요.');
  end if;
  if p_pin_valid is distinct from true then
    update public.library_booking_settings
    set failures = case when settings.failures >= 4 then 0 else settings.failures + 1 end,
        blocked_until = case when settings.failures >= 4 then now() + interval '5 minutes' end
    where id;
    return jsonb_build_object('error', '관리자 PIN을 확인하세요.');
  end if;
  if p_operation not in ('read', 'toggle', 'save', 'delete') then
    return jsonb_build_object('error', '잘못된 요청입니다.');
  end if;
  if p_operation in ('save', 'delete') then
    if p_slot is null or p_slot not between 1 and 3 then
      return jsonb_build_object('error', '계정 번호를 확인하세요.');
    end if;
    perform public.library_account_manage(owner_id, p_operation, p_slot, '계정 ' || p_slot, p_secret);
  end if;
  accounts := public.library_account_manage(owner_id, 'list');
  if p_operation = 'toggle' then
    if p_enabled and jsonb_array_length(accounts) = 0 then
      return jsonb_build_object('error', '계정을 하나 이상 등록하세요.');
    end if;
    settings.enabled := p_enabled is true;
  elsif p_operation = 'delete' and jsonb_array_length(accounts) = 0 then
    settings.enabled := false;
  end if;
  update public.library_booking_settings
  set enabled = settings.enabled, failures = 0, blocked_until = null where id;
  return jsonb_build_object('ok', true, 'enabled', settings.enabled, 'accounts', accounts);
end;
$$;
revoke all on function public.library_booking_admin(boolean,text,integer,text,boolean) from public, anon, authenticated;
grant execute on function public.library_booking_admin(boolean,text,integer,text,boolean) to service_role;
