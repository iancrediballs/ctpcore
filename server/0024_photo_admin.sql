-- 0024_photo_admin.sql — photo management from the phone.
--
-- Ian's ask (2026-08-13): "there's some photos I'm not supposed to be there…
-- give me the ability to add and remove stuff as an admin."
--
-- Three staff-gated RPCs plus the first storage.objects policies this project
-- has needed. Same doctrine as 0020–0022: the phone holds NO table write
-- grants; SECURITY DEFINER functions are the only door, and every rule lives
-- here, not in the UI.
--
-- ── why soft delete ──────────────────────────────────────────────────────────
-- part_image already carries deleted_at, and every reader in the app — web
-- and desktop alike — filters `deleted_at IS NULL`. So a soft delete needs NO
-- sync-rule change and no redeploy: the row syncs down with deleted_at set,
-- every device's queries skip it, done. It is also reversible by one UPDATE,
-- which a storage delete is not — so the ROW is soft-deleted here, and the
-- app removes the storage OBJECT separately (best-effort; an orphaned file
-- behind an unguessable key is untidy, a lost original is a loss).
--
-- ── storage policies ─────────────────────────────────────────────────────────
-- Bucket ctp-assets is public-READ; until now every write went through
-- scripts holding the service key, and storage.objects had zero policies —
-- meaning no client could write anything. These two policies open exactly one
-- prefix (assets/photos/) to exactly one audience (staff, checked against the
-- app_user ROW via is_staff(), not the JWT claim). Brand art, diagrams and
-- .glb models stay script-only. There is deliberately NO UPDATE policy:
-- changed photos get new keys (the CDN caches immutably for a year), so
-- overwriting in place would only ever serve someone a stale cache.
--
-- ⚠ desktop is a separate world: deleting a photo here removes it from the
-- CLOUD (and so from every phone). The desktop's own SQLite copy stays until
-- it is deleted there too, and sync_assets.py must skip cloud-soft-deleted
-- paths or the next run would resurrect them.

BEGIN;

-- ── make a photo the face of its part ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_set_primary_photo(image_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_part bigint;
BEGIN
  IF NOT is_staff() THEN RAISE EXCEPTION 'Staff only.'; END IF;

  SELECT part_id INTO v_part
    FROM part_image WHERE id = image_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such photo.'; END IF;

  UPDATE part_image SET is_primary = 0, rev = rev + 1, updated_at = now()
   WHERE part_id = v_part AND is_primary = 1 AND id <> image_id AND deleted_at IS NULL;
  UPDATE part_image SET is_primary = 1, rev = rev + 1, updated_at = now()
   WHERE id = image_id;

  RETURN jsonb_build_object('ok', true, 'part_id', v_part);
END;
$$;

-- ── retire a photo ──────────────────────────────────────────────────────────
-- If the deleted photo was the primary, the next live sibling (by sort order)
-- is promoted — a part with photos but no primary is the desktop bug this
-- function refuses to reproduce. Returns the storage path so the caller can
-- remove the object too.
CREATE OR REPLACE FUNCTION public.admin_delete_photo(image_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row     part_image%ROWTYPE;
  v_promote bigint;
BEGIN
  IF NOT is_staff() THEN RAISE EXCEPTION 'Staff only.'; END IF;

  SELECT * INTO v_row FROM part_image WHERE id = image_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such photo.'; END IF;

  UPDATE part_image
     SET deleted_at = now(), is_primary = 0, rev = rev + 1, updated_at = now()
   WHERE id = image_id;

  IF v_row.is_primary = 1 THEN
    SELECT id INTO v_promote
      FROM part_image
     WHERE part_id = v_row.part_id AND deleted_at IS NULL
     ORDER BY sort_order, id LIMIT 1;
    IF v_promote IS NOT NULL THEN
      UPDATE part_image SET is_primary = 1, rev = rev + 1, updated_at = now()
       WHERE id = v_promote;
    END IF;
  END IF;

  RETURN jsonb_build_object('deleted', image_id, 'path', v_row.path,
                            'new_primary', v_promote);
END;
$$;

-- ── register an uploaded photo ──────────────────────────────────────────────
-- The app uploads the FILE first (storage policy below), then calls this to
-- create the row. Order matters: a row pointing at a missing file renders a
-- broken image everywhere, a file with no row is invisible. Idempotent on
-- (part, path) so a retried upload cannot double-register.
CREATE OR REPLACE FUNCTION public.admin_add_photo(part_id bigint, path text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id      bigint;
  v_primary int;
BEGIN
  IF NOT is_staff() THEN RAISE EXCEPTION 'Staff only.'; END IF;

  IF NOT EXISTS (SELECT 1 FROM part p
                  WHERE p.id = admin_add_photo.part_id AND p.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'No such part.';
  END IF;
  -- Only the prefix the storage policy opens; anything else is a mistake or a
  -- probe, and both get the same answer.
  IF admin_add_photo.path NOT LIKE 'assets/photos/%'
     OR admin_add_photo.path LIKE '%..%' THEN
    RAISE EXCEPTION 'Bad path.';
  END IF;

  SELECT pi.id INTO v_id FROM part_image pi
   WHERE pi.part_id = admin_add_photo.part_id
     AND pi.path = admin_add_photo.path AND pi.deleted_at IS NULL;
  IF FOUND THEN
    RETURN jsonb_build_object('id', v_id, 'already', true);
  END IF;

  -- First live photo becomes the primary by itself.
  SELECT CASE WHEN EXISTS (SELECT 1 FROM part_image pi
                            WHERE pi.part_id = admin_add_photo.part_id
                              AND pi.deleted_at IS NULL AND pi.is_primary = 1)
              THEN 0 ELSE 1 END
    INTO v_primary;

  INSERT INTO part_image (part_id, path, kind, is_primary, sort_order,
                          rev, updated_at, origin)
  SELECT admin_add_photo.part_id, admin_add_photo.path, 'photo', v_primary,
         COALESCE(MAX(pi.sort_order), 0) + 1, 1, now(), 'mobile'
    FROM part_image pi WHERE pi.part_id = admin_add_photo.part_id
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'is_primary', v_primary = 1);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_primary_photo(bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_delete_photo(bigint)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_add_photo(bigint, text)   FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_primary_photo(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_photo(bigint)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_photo(bigint, text)   TO authenticated;

-- ── storage: open ONE prefix to staff ───────────────────────────────────────
-- SELECT is included because supabase-js remove() reads the object row before
-- deleting it; without it, deletes fail silently with an empty result.
DROP POLICY IF EXISTS ctp_staff_photo_select ON storage.objects;
CREATE POLICY ctp_staff_photo_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'ctp-assets' AND name LIKE 'assets/photos/%' AND public.is_staff());

DROP POLICY IF EXISTS ctp_staff_photo_upload ON storage.objects;
CREATE POLICY ctp_staff_photo_upload ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'ctp-assets' AND name LIKE 'assets/photos/%' AND public.is_staff());

DROP POLICY IF EXISTS ctp_staff_photo_delete ON storage.objects;
CREATE POLICY ctp_staff_photo_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'ctp-assets' AND name LIKE 'assets/photos/%' AND public.is_staff());

COMMIT;
