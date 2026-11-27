-- One line: entries / lines / unsealed entries / unbalanced entries / entries without lines / net (Σdebit − Σcredit over ALL lines).
-- A healthy ledger prints  <n>/<m>/0/0/0/0.  Read-only; run as the superuser (RLS bypass) against any database.
\pset format unaligned
\pset tuples_only on
SELECT (SELECT count(*) FROM journal_entry) || '/' ||
       (SELECT count(*) FROM journal_line) || '/' ||
       (SELECT count(*) FROM journal_entry WHERE "sealedAt" IS NULL) || '/' ||
       (SELECT count(*) FROM (SELECT "journalEntryId" FROM journal_line GROUP BY 1 HAVING sum("debitMinor") <> sum("creditMinor")) x) || '/' ||
       (SELECT count(*) FROM journal_entry e WHERE NOT EXISTS (SELECT 1 FROM journal_line l WHERE l."journalEntryId" = e.id)) || '/' ||
       (SELECT coalesce(sum("debitMinor"), 0) - coalesce(sum("creditMinor"), 0) FROM journal_line);
