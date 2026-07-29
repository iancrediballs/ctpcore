-- ============================================================================
--  CTP Core — Jefrey's learned vocabulary.
--
--  Every time the operator corrects a match, that correction is written here.
--  This is the whole reason Jefrey gets better without retraining anything:
--  a counter's phrasing is small and repetitive, so binding a phrase to a part
--  once is worth more than any amount of generic language modelling.
--
--  Negative rows matter as much as positive ones. A candidate the operator
--  rejected must not resurface on the next identical request.
-- ============================================================================
PRAGMA foreign_keys = ON;

CREATE TABLE part_alias (
  id           INTEGER PRIMARY KEY,
  phrase_norm  TEXT    NOT NULL,                 -- normalised customer wording
  part_id      INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  polarity     INTEGER NOT NULL DEFAULT 1        -- 1 = means this, -1 = never this
               CHECK (polarity IN (1, -1)),
  hits         INTEGER NOT NULL DEFAULT 1,       -- how often it has been confirmed
  source       TEXT    NOT NULL DEFAULT 'operator'
               CHECK (source IN ('operator','seed','import')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (phrase_norm, part_id, polarity)
);

CREATE INDEX part_alias_phrase_idx ON part_alias(phrase_norm, polarity);
CREATE INDEX part_alias_part_idx   ON part_alias(part_id);
