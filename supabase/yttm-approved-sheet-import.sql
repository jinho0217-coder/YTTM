create function public.yttm_approved_roles_snapshot(p_rows jsonb)
returns table(snapshot_rows jsonb, snapshot_csv text)
language sql security invoker set search_path = ''
as $$
  with base as (
    select p_rows as rows
  ), cells as (
    select r.position as row_no, c.position as col_no,
      case when r.position > 2 and m.meeting_date is not null and (r.data->>0) ~ '^(Attendees|Theme|Theme Question|Word of the day|Quote of the day|Special Event|Chairperson|Toastmaster|General Evaluator|Table Topic Master|Timer|Ah Counter|Grammarian|Word & Quote Master|Quiz Master|Table Topic Evaluator|Best Speaker|Best evaluator|Best table topic speaker|(Speaker|Project|Title|Time|Evaluator) [1-4])$'
        then coalesce(m.fields->>(r.data->>0), '')
        else coalesce(r.data->>(c.position - 1), '')
      end as value
    from base
    cross join lateral jsonb_array_elements(base.rows) with ordinality as r(data, position)
    cross join lateral generate_series(1, greatest(jsonb_array_length(r.data),
      (select max(source_column) from public.yttm_meetings))) as c(position)
    left join public.yttm_meetings m on m.source_column = c.position
  ), rebuilt as (
    select row_no, jsonb_agg(value order by col_no) as row_data,
      string_agg('"' || replace(value, '"', '""') || '"', ',' order by col_no) as csv_line
    from cells group by row_no
  )
  select jsonb_agg(row_data order by row_no), string_agg(csv_line, E'\r\n' order by row_no)
  from rebuilt;
$$;

revoke all on function public.yttm_approved_roles_snapshot(jsonb) from public, anon, authenticated;
grant execute on function public.yttm_approved_roles_snapshot(jsonb) to service_role;

create or replace function public.yttm_import_2026(p_snapshots jsonb, p_meetings jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  meeting_count integer;
  roles_rows jsonb;
  roles_csv text;
  editable_pattern constant text := '^(Attendees|Theme|Theme Question|Word of the day|Quote of the day|Special Event|Chairperson|Toastmaster|General Evaluator|Table Topic Master|Timer|Ah Counter|Grammarian|Word & Quote Master|Quiz Master|Table Topic Evaluator|Best Speaker|Best evaluator|Best table topic speaker|(Speaker|Project|Title|Time|Evaluator) [1-4])$';
begin
  perform pg_advisory_xact_lock(2026, 618);
  perform pg_advisory_xact_lock(2026, 619);
  if jsonb_array_length(p_snapshots) <> 2 or jsonb_array_length(p_meetings) <> 52 then
    raise exception 'Expected both 2026 sheets and all 52 weekly columns';
  end if;

  insert into public.yttm_meetings(meeting_date, meeting_number, source_column, fields)
  select meeting_date, meeting_number, source_column, fields
  from jsonb_to_recordset(p_meetings) as input(meeting_date date, meeting_number text, source_column integer, fields jsonb)
  on conflict (meeting_date) do update set
    meeting_number = excluded.meeting_number,
    source_column = excluded.source_column,
    fields = (
      select coalesce(jsonb_object_agg(field.key, field.value), '{}'::jsonb)
      from jsonb_each(excluded.fields) as field
      where field.key !~ editable_pattern
    ) || (
      select coalesce(jsonb_object_agg(field.key, field.value), '{}'::jsonb)
      from jsonb_each(yttm_meetings.fields) as field
      where field.key ~ editable_pattern
    ),
    synced_at = now();
  get diagnostics meeting_count = row_count;

  select s.snapshot_rows, s.snapshot_csv into roles_rows, roles_csv
  from jsonb_to_recordset(p_snapshots) as x(sheet_name text, rows jsonb)
  cross join lateral public.yttm_approved_roles_snapshot(x.rows) as s
  where x.sheet_name = '26_Roles';
  if roles_rows is null then raise exception 'Missing role sheet'; end if;

  insert into public.yttm_sheet_snapshots(sheet_name, spreadsheet_id, csv, rows)
  select x.sheet_name, x.spreadsheet_id,
    case when x.sheet_name = '26_Roles' then roles_csv else x.csv end,
    case when x.sheet_name = '26_Roles' then roles_rows else x.rows end
  from jsonb_to_recordset(p_snapshots) as x(sheet_name text, spreadsheet_id text, csv text, rows jsonb)
  on conflict (sheet_name) do update set csv = excluded.csv, rows = excluded.rows, synced_at = now();

  update public.yttm_sync_config set last_success_at = now() where id;
  return jsonb_build_object('meetings', meeting_count, 'sheets', 2);
end;
$$;

CREATE OR REPLACE FUNCTION public.yttm_commit_primary(p_expected bigint, p_payload jsonb, p_request_id text, p_fingerprint text, p_result jsonb, p_writes jsonb DEFAULT NULL::jsonb, p_pin text DEFAULT NULL::text, p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare s public.yttm_primary_state%rowtype; receipt public.yttm_save_receipts%rowtype; secret uuid; job bigint; d record;
begin
 perform pg_advisory_xact_lock(2026,619);
 select * into receipt from public.yttm_save_receipts where request_id=p_request_id;
 if found then
  if receipt.fingerprint<>p_fingerprint then raise exception 'Request ID reused with different input';end if;
  return receipt.result;
 end if;
 select * into s from public.yttm_primary_state where id for update;
 if not found then
  if p_expected<>-1 then return jsonb_build_object('retry',true);end if;
  insert into public.yttm_primary_state(id,revision,payload) values(true,0,p_payload);
 else
  if s.revision<>p_expected then return jsonb_build_object('retry',true);end if;
  update public.yttm_primary_state set revision=revision+1,payload=p_payload,updated_at=now() where id;
 end if;
 if p_writes is not null and jsonb_array_length(p_writes)>0 then
  insert into public.yttm_sheet_outbox(writes,secret_id,force) values(p_writes,secret,p_force) returning id into job;
  p_result=p_result||jsonb_build_object('syncJob',job,'syncPending',true);
 end if;
 -- Only approved values are projected into the main meeting records.
 for d in select * from jsonb_to_recordset(coalesce(p_writes,'[]'::jsonb)) as x("meetingDate" text,label text,value text) loop
  update public.yttm_meetings set fields=jsonb_set(fields,array[d.label],to_jsonb(d.value),true),synced_at=now()
  where meeting_date=d."meetingDate"::date;
 end loop;
 if p_writes is not null and jsonb_array_length(p_writes) > 0 then
  with rebuilt as (
    select s.snapshot_rows, s.snapshot_csv
    from public.yttm_sheet_snapshots t
    cross join lateral public.yttm_approved_roles_snapshot(t.rows) as s
    where t.sheet_name = '26_Roles'
  )
  update public.yttm_sheet_snapshots t
  set rows = rebuilt.snapshot_rows, csv = rebuilt.snapshot_csv
  from rebuilt where t.sheet_name = '26_Roles';
 end if;
 insert into public.yttm_save_receipts(request_id,fingerprint,result) values(p_request_id,p_fingerprint,p_result);
 return p_result;
end;$function$;
