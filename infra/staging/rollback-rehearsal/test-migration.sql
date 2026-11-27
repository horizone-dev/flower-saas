-- LOCAL ROLLBACK REHEARSAL — TEST MIGRATION ONLY.
-- NOT an approved migration. NEVER copy this into packages/db/prisma/migrations or infra/migrate/approved-migrations.json of the repository.
-- It exists so that rollback-rehearsal-local.sh can bake it into the throw-away "set B" migrate image and apply it to a DISPOSABLE database,
-- to prove that the documented rollback (restore the pre-migration backup into a NEW database, redeploy the previous image set by its recorded
-- immutable IDs) really discards a schema change AND a data change made after the backup.
--
-- It deliberately does both kinds of change a real release can make:
--   1. a brand-new table with a row;
--   2. an ADDED column on an EXISTING application table plus a backfill UPDATE of existing rows.
CREATE TABLE "rollback_rehearsal_probe" (
  "id" INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "note" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

INSERT INTO "rollback_rehearsal_probe" ("note") VALUES ('created by the set B test migration');

ALTER TABLE "customer" ADD COLUMN "rehearsalMarker" TEXT;

UPDATE "customer" SET "rehearsalMarker" = 'migrated-by-set-B';
