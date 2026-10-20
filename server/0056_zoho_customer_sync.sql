-- ============================================================================
--  CTP Core — Zoho customers selectable in CTP Core (0056)
--
--  Ian, 20 Oct 2026: "Zoho customers should be selectable within the CTP app."
--  zoho-sync reads Zoho Books contacts (contact_type customer, active) — READ
--  ONLY towards Zoho — and hands them to zoho_sync_customers(), which:
--
--   * matches each contact to a LIVE CTP customer by stored zoho_contact_id,
--     then exact name (contact or company name), then email;
--   * on a match with no Zoho id yet, stores the id (and fills an empty email);
--     never renames, never overwrites a different Zoho id (reported instead);
--   * skips a contact that matches a REMOVED CTP customer (deleted_at): those
--     were taken out on purpose (demo data, 0048) and are reported, not revived;
--   * otherwise creates the customer (code derived from the name, unique),
--     origin 'zoho', no login (auth_user_id stays null: logins are never made here);
--   * p_apply = false is a preview and writes nothing.
--
--  One transaction, a table lock against two syncs racing, and an id allocated
--  under that lock (customer.id has no default). Service role only.
-- ============================================================================
begin;

create or replace function public.zoho_sync_customers(p_contacts jsonb, p_apply boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c jsonb; v_id text; v_name text; v_company text; v_email text;
  m record; v_how text; v_code text; v_base text; v_n int; v_new bigint;
  out_linked jsonb := '[]'; out_already jsonb := '[]'; out_new jsonb := '[]';
  out_skipped jsonb := '[]'; out_conflict jsonb := '[]';
  v_used text[] := '{}';
begin
  if p_apply then lock table customer in share row exclusive mode; end if;
  for c in select * from jsonb_array_elements(coalesce(p_contacts, '[]'::jsonb)) loop
    v_id      := nullif(trim(c->>'contact_id'), '');
    v_name    := nullif(trim(c->>'contact_name'), '');
    v_company := nullif(trim(c->>'company_name'), '');
    v_email   := nullif(lower(trim(c->>'email')), '');
    if v_id is null or v_name is null then continue; end if;

    -- 1. live customer, by id / name / email
    v_how := null;
    select cu.id, cu.code, cu.name, cu.email, cu.zoho_contact_id into m
      from customer cu where cu.deleted_at is null and cu.zoho_contact_id = v_id limit 1;
    if m.id is not null then v_how := 'id'; end if;
    if v_how is null then
      select cu.id, cu.code, cu.name, cu.email, cu.zoho_contact_id into m from customer cu
       where cu.deleted_at is null
         and (lower(regexp_replace(trim(cu.name), '\s+', ' ', 'g')) in
              (lower(regexp_replace(v_name, '\s+', ' ', 'g')), lower(regexp_replace(coalesce(v_company, ''), '\s+', ' ', 'g'))))
       order by cu.id limit 1;
      if m.id is not null then v_how := 'name'; end if;
    end if;
    if v_how is null and v_email is not null then
      select cu.id, cu.code, cu.name, cu.email, cu.zoho_contact_id into m from customer cu
       where cu.deleted_at is null and lower(trim(cu.email)) = v_email order by cu.id limit 1;
      if m.id is not null then v_how := 'email'; end if;
    end if;

    if v_how is not null then
      if v_how = 'id' then
        out_already := out_already || jsonb_build_object('zoho', v_name, 'ctp', m.code);
      elsif m.zoho_contact_id is not null and m.zoho_contact_id <> v_id then
        out_conflict := out_conflict || jsonb_build_object('zoho', v_name, 'zoho_id', v_id, 'ctp', m.code,
                          'note', 'CTP customer already linked to another Zoho contact (' || m.zoho_contact_id || ')');
      else
        out_linked := out_linked || jsonb_build_object('zoho', v_name, 'ctp', m.code, 'by', v_how);
        if p_apply then
          update customer set zoho_contact_id = v_id,
                 email = coalesce(nullif(email, ''), v_email),
                 updated_at = now()
           where id = m.id;
        end if;
      end if;
      continue;
    end if;

    -- 2. removed on purpose? report, never revive
    select cu.code, cu.name into m from customer cu
     where cu.deleted_at is not null
       and (cu.zoho_contact_id = v_id
            or lower(regexp_replace(trim(cu.name), '\s+', ' ', 'g')) = lower(regexp_replace(v_name, '\s+', ' ', 'g'))
            or (v_email is not null and lower(trim(cu.email)) = v_email))
     limit 1;
    if m.code is not null then
      out_skipped := out_skipped || jsonb_build_object('zoho', v_name, 'ctp', m.code, 'note', 'removed in CTP Core — not re-added');
      continue;
    end if;

    -- 3. new customer
    v_base := upper(left(regexp_replace(coalesce(v_company, v_name), '[^A-Za-z0-9]', '', 'g'), 8));
    if v_base = '' then v_base := 'ZOHO'; end if;
    v_code := v_base; v_n := 1;
    while exists (select 1 from customer where code = v_code) or v_code = any(v_used) loop
      v_n := v_n + 1; v_code := left(v_base, 6) || v_n;
    end loop;
    v_used := v_used || v_code;
    out_new := out_new || jsonb_build_object('zoho', v_name, 'code', v_code, 'email', v_email);
    if p_apply then
      select coalesce(max(id), 0) + 1 into v_new from customer;
      insert into customer (id, code, name, email, price_tier, zoho_contact_id, origin, notes)
      values (v_new, v_code, v_name, v_email, 'list', v_id, 'zoho',
              '[' || to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM-DD') || '] Synced from Zoho Books contact ' || v_id || '.');
    end if;
  end loop;

  return jsonb_build_object('applied', p_apply, 'zoho_customers', jsonb_array_length(coalesce(p_contacts, '[]'::jsonb)),
    'already_linked', out_already, 'linked', out_linked, 'new', out_new, 'skipped', out_skipped, 'conflicts', out_conflict);
end $$;

revoke all on function public.zoho_sync_customers(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.zoho_sync_customers(jsonb, boolean) to service_role;

commit;
