-- ============================================================================
--  CTP Core — RETIRE EVERY NON-SEC DIAGRAM (migration 0017)
--
--  Ian's decision, and it is the whole rule: "the only diagrams are the SEC
--  diagrams that everything should ref." SEC101-116 is the canonical set on
--  both databases. Everything else goes.
--
--  WHAT THIS RETIRES ON THE DESKTOP — 34 rows
--    32 x D212..D867   per-drawing exploded views
--     1 x SFW          Front Wall
--     1 x SRD          Roof Deflector
--
--  WHY THEY HAD TO GO, WHICH IS NOT THE REASON YOU MIGHT ASSUME
--  These were not merely superseded — their IMAGE FILES NO LONGER EXIST. Every
--  D-series row points at `assets/diagrams/Drw_NNN.png`, and those files are
--  absent from app/public, absent from the built bundle, absent from the whole
--  machine, and absent from the Supabase bucket (HTTP 400). There is no backup.
--  So all 34 were rendering as broken images in the Diagrams list, and the
--  32 D-series were worse than blank: their rows carry img_w/img_h from the
--  original upload, so DiagramsView drew their hotspot markers at stored
--  coordinates ON TOP of a broken-image placeholder. That is what "the hotspots
--  are on the wrong diagrams" actually was.
--
--  THE HOTSPOTS ARE DELIBERATELY LEFT ALONE
--  All 91 stay exactly as they are, attached to these now-retired diagrams and
--  invisible in the UI (list_diagrams and the hotspot count both filter
--  deleted_at IS NULL). They are the only surviving record of which 81 parts
--  were annotated, they cost nothing dormant, and deleting them would forfeit
--  that for no gain. The cloud holds 94 in the same dormant state.
--
--  Their COORDINATES cannot be salvaged: the D-series were per-drawing views
--  (five separate front-door drawings) and SEC are per-category overviews (one
--  door overview). Different images at different granularity, so no transform
--  maps one onto the other — and the source images are gone, so no comparison
--  is even possible. Re-placing markers on the section images is manual work.
--  What is NOT lost is which part is which callout: 0010 put that in
--  part.diagram_ref for sections 101-112 (122 parts, complete). 113-116 remain
--  unset - 39 parts - which is the gap 0010 flagged as "refs to follow".
--
--  NOTHING ELSE READS THESE ROWS
--  Checked rather than assumed: part_detail resolves a part's diagram directly
--  by key -- (SELECT d.image_path FROM diagram d WHERE d.drawing_key =
--  'SEC'||p.category_id) -- since 0010, never through part_diagram_callout.
--  The 161 callout rows are consumed by no query in the Rust backend or the
--  web backend; they survive only as data. So retiring these diagrams breaks
--  no part panel and no lookup.
--
--  Declarative on purpose: "keep SEC, retire the rest" rather than a list of
--  34 keys. If anything non-SEC is ever inserted again -- for instance by
--  re-running the retired rusauto importer -- re-running this migration
--  retires that too, and it states the rule rather than a snapshot of it.
--
--  Soft-delete ONLY. Never hard-delete a diagram: rusauto_diagrams.py upserts
--  on ON CONFLICT(drawing_key) and does not touch deleted_at, so a soft-deleted
--  row stays retired across a re-run, whereas a hard-deleted one comes back
--  with deleted_at NULL.
-- ============================================================================

UPDATE diagram
   SET deleted_at = datetime('now'),
       rev        = rev + 1,
       updated_at = datetime('now')
 WHERE deleted_at IS NULL
   AND drawing_key NOT LIKE 'SEC%';
