select cron.schedule('yttm-2026-sheet-sync','*/5 * * * *',$job$
select net.http_post(
 url:='https://zyiosfhyjwkmfprhmdem.supabase.co/functions/v1/yttm-sync',
 headers:=jsonb_build_object('Content-Type','application/json','x-yttm-sync-token',
 (select token from public.yttm_sync_config where id)),
 body:='{}'::jsonb,timeout_milliseconds:=60000);
$job$);
