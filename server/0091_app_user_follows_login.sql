-- 0091 (26 Oct): app_user had no tie to auth.users, so deleting a login anywhere except
-- Staff & access left its role row behind, and a login recreated for the same person started
-- with no role. Michelle hit this: invited through Staff & access at 06:58 (7d02d921), then the
-- login was deleted and re-added in the Supabase dashboard at 07:02–07:03 (d0e05d00), and her
-- new login synced nothing.
--
-- Now:
--   * A login deleted outside the app takes its app_user row with it (unless stock moves or
--     sales orders still name it, which keep the row for history). Its role is parked by email.
--   * When a login for that email is next CONFIRMED (dashboard auto-confirm, or the invite
--     accepted), the parked role comes back. Confirmation proves the person controls the email,
--     so an unconfirmed public sign-up can never pick up a staff role.
--   * Staff & access → Remove deletes the role row first, so nothing is parked: removing
--     someone on purpose stays removed.
begin;

create table if not exists public.app_user_parked (
  email        text primary key,
  role         text not null,
  display_name text,
  old_id       uuid not null,
  parked_at    timestamptz not null default now()
);
alter table public.app_user_parked enable row level security;   -- no policies: server only
revoke all on public.app_user_parked from anon, authenticated;

create or replace function public.app_user_on_login_deleted()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.app_user;
begin
  select * into r from public.app_user where id = old.id;
  if not found then return old; end if;
  if old.email is not null then
    insert into public.app_user_parked (email, role, display_name, old_id)
    values (lower(old.email), r.role, r.display_name, old.id)
    on conflict (email) do update
      set role = excluded.role, display_name = excluded.display_name,
          old_id = excluded.old_id, parked_at = now();
  end if;
  if not exists (select 1 from public.stock_movement where actor_id = old.id)
     and not exists (select 1 from public.sales_order where raised_by = old.id) then
    delete from public.app_user where id = old.id;
  end if;
  return old;
end $$;

create or replace function public.app_user_on_login_confirmed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.app_user_parked;
begin
  if new.email_confirmed_at is null or new.email is null then return new; end if;
  if exists (select 1 from public.app_user where id = new.id) then return new; end if;
  delete from public.app_user_parked
   where email = lower(new.email) and parked_at > now() - interval '30 days'
  returning * into p;
  if found then
    insert into public.app_user (id, role, display_name) values (new.id, p.role, p.display_name)
    on conflict (id) do nothing;
  end if;
  return new;
end $$;

revoke all on function public.app_user_on_login_deleted() from public, anon, authenticated;
revoke all on function public.app_user_on_login_confirmed() from public, anon, authenticated;

drop trigger if exists app_user_follows_login_delete on auth.users;
create trigger app_user_follows_login_delete
  after delete on auth.users for each row execute function public.app_user_on_login_deleted();

drop trigger if exists app_user_follows_login_confirm on auth.users;
create trigger app_user_follows_login_confirm
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.app_user_on_login_confirmed();

commit;
