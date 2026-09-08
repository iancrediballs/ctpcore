-- 0032 — retire every non-SEC diagram in the cloud.
--
-- Ian's decision: "the only diagrams are the SEC diagrams that everything
-- should ref." SEC101-116 is the canonical set on both databases. This is the
-- cloud half; the desktop gets the same rule in its migration 0017.
--
-- The two databases are wrong in DIFFERENT ways, which is why the row counts
-- differ. The cloud already soft-deleted the 34 D-series/SFW/SRD rows at some
-- point; the desktop never did. Conversely the cloud carries 22 rows the
-- desktop has never had:
--
--   RU158, RU164, RU216 ... RU366 — 22 exploded views hotlinked straight from
--   rusauto43.ru, inserted by the ad-hoc script rusauto_diagrams.py. Their
--   image_path is a full https URL pointing at a third party's server, so the
--   product was rendering another company's images live, from their bandwidth,
--   in software being sold. That alone justifies retiring them independently
--   of the 16-diagram decision.
--
-- Expected effect: cloud diagram goes from 38 live to 16 live. If the count
-- after applying is anything other than 16, stop and look rather than assume.
--
-- THE 94 ORPHANED HOTSPOTS ARE LEFT ALONE, deliberately, matching the desktop.
-- They stay attached to already-retired diagrams and invisible to every query
-- that filters deleted_at. They are the record of which parts were annotated.
--
-- SOFT-DELETE ONLY — this is the load-bearing detail. rusauto_diagrams.py
-- upserts with ON CONFLICT(drawing_key) DO UPDATE and never touches
-- deleted_at, so a soft-deleted RU row STAYS retired even if the script runs
-- again; the upsert just re-stamps its title and image_path. A hard DELETE
-- would let the very next run re-insert all 22 with deleted_at NULL. Do not
-- "tidy up" these rows later with a DELETE.
--
-- Declarative rather than a list of 22 keys: it states the rule (keep SEC,
-- retire the rest) instead of a snapshot, so a stray re-insert is caught by
-- re-running this file.
--
-- Idempotent: the deleted_at IS NULL guard means a second run changes nothing.
-- ============================================================================

update public.diagram
   set deleted_at = now(),
       rev        = rev + 1,
       updated_at = now()
 where deleted_at is null
   and drawing_key not like 'SEC%';
