-- 0030 — grant the table privilege that 0028 forgot.
--
-- Row-level security decides WHICH rows a role may see. It does not grant the
-- privilege to touch the table at all. `notify_setting` was created with
-- policies but no GRANT, so every read failed with "permission denied for table"
-- before RLS was even consulted — the Settings screen would have shown an error
-- instead of the notification options.
--
-- SELECT only. Writes go through set_notify_setting(), which checks is_manager()
-- server-side; granting UPDATE directly would create a second way in that
-- bypasses that check.

grant select on public.notify_setting to authenticated;
