-- Both snapshots are already anonymously downloadable from Google Sheets.
-- On 2026-11-28 their SHA-256 hashes exactly matched the public /export?format=csv responses.
-- Expose only the CSV and its metadata, and expire access if public-source syncing stops.
grant select (sheet_name, csv, synced_at) on public.yttm_sheet_snapshots to anon;
create policy yttm_public_dashboard_snapshots on public.yttm_sheet_snapshots
  for select to anon
  using (spreadsheet_id = '1arhgy3QSwHxyM9gBy6nXdw76N-94R53kf0ogV4Nq2lA'
    and sheet_name in ('26_Roles', '26_Agenda')
    and synced_at > now() - interval '15 minutes');
