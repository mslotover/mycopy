-- Meaning-based search. Text is embedded into the Vectorize index "atrium-search";
-- these tables track what needs (re-)embedding and hold each chunk's text for snippets.

-- One row per searchable item. `dirty` counts changes not yet embedded: saving bumps it,
-- the embedding job clears it only if nothing changed meanwhile.
CREATE TABLE vector_docs (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  hash TEXT,
  chunks INTEGER NOT NULL DEFAULT 0,
  dirty INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (kind, ref)
);
CREATE INDEX vector_docs_dirty ON vector_docs (dirty) WHERE dirty > 0;

-- Vector ids are "<kind>:<ref>:<n>".
CREATE TABLE vector_chunks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX vector_chunks_doc ON vector_chunks (kind, ref);

-- Everything already in the keyword index is queued for embedding.
INSERT INTO vector_docs (kind, ref) SELECT DISTINCT kind, ref FROM search;
