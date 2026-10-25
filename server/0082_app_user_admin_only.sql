-- 0082 (QA sweep, 26 Oct): the app_user policy let a MANAGER write any row, including
-- role — so a manager could make themselves admin (bypassing admin-users' admin-only rule).
-- Writes are now admin-only; managers keep read access through app_user_self.
begin;
drop policy if exists app_user_admin on public.app_user;
create policy app_user_admin_write on public.app_user for all to authenticated
  using (public.auth_role() = 'admin') with check (public.auth_role() = 'admin');
revoke update (id, created_at) on public.app_user from authenticated;
commit;
