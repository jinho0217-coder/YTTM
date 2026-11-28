create table public.yttm_pin_credentials (
  id boolean primary key default true check (id),
  admin_hash text not null,
  master_hash text not null,
  failures integer not null default 0,
  blocked_until timestamptz
);

alter table public.yttm_pin_credentials enable row level security;
revoke all on public.yttm_pin_credentials from public, anon, authenticated;
grant select, insert, update on public.yttm_pin_credentials to service_role;

create function public.yttm_initialize_pins(p_admin text, p_master text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if coalesce(p_admin, '') !~ '^[0-9]{4}$'
      or coalesce(p_master, '') !~ '^[0-9]{4}$' then
    raise exception 'Invalid YTTM PIN configuration';
  end if;
  insert into public.yttm_pin_credentials (admin_hash, master_hash)
  values (extensions.crypt(p_admin, extensions.gen_salt('bf', 10)),
          extensions.crypt(p_master, extensions.gen_salt('bf', 10)))
  on conflict (id) do nothing;
  return exists (select 1 from public.yttm_pin_credentials where id);
end;
$$;

create function public.yttm_manage_pin(p_pin text, p_action text, p_new_pin text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  credential public.yttm_pin_credentials%rowtype;
  admin_matches boolean := false;
  master_matches boolean := false;
begin
  if p_action is null or p_action not in ('approve', 'change_admin', 'change_master') then
    raise exception 'Invalid PIN action';
  end if;
  if p_action <> 'approve' and coalesce(p_new_pin, '') !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'The new PIN must contain exactly 4 digits.');
  end if;

  select * into credential from public.yttm_pin_credentials where id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'YTTM PINs are not configured.');
  end if;
  if credential.blocked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'Too many incorrect PIN attempts. Try again later.');
  end if;

  if coalesce(p_pin, '') ~ '^[0-9]{4}$' then
    if p_action <> 'change_master' then
      admin_matches := extensions.crypt(p_pin, credential.admin_hash) = credential.admin_hash;
    end if;
    if p_action <> 'approve' and not admin_matches then
      master_matches := extensions.crypt(p_pin, credential.master_hash) = credential.master_hash;
    end if;
  end if;
  if not admin_matches and not master_matches then
    update public.yttm_pin_credentials
    set failures = case when credential.failures >= 4 then 0 else credential.failures + 1 end,
        blocked_until = case when credential.failures >= 4 then now() + interval '5 minutes' else null end
    where id;
    return jsonb_build_object('ok', false, 'error', 'Incorrect PIN.');
  end if;

  update public.yttm_pin_credentials set failures = 0, blocked_until = null where id;
  if p_action = 'change_admin' then
    if extensions.crypt(p_new_pin, credential.master_hash) = credential.master_hash then
      return jsonb_build_object('ok', false, 'error', 'Administrator and master PINs must be different.');
    end if;
    update public.yttm_pin_credentials set admin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)) where id;
  elsif p_action = 'change_master' then
    if extensions.crypt(p_new_pin, credential.admin_hash) = credential.admin_hash then
      return jsonb_build_object('ok', false, 'error', 'Administrator and master PINs must be different.');
    end if;
    update public.yttm_pin_credentials set master_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)) where id;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.yttm_initialize_pins(text,text), public.yttm_manage_pin(text,text,text) from public, anon, authenticated;
grant execute on function public.yttm_initialize_pins(text,text), public.yttm_manage_pin(text,text,text) to service_role;
