-- security_event — a read-only union view over the security-relevant slice of
-- audit_log plus every login_security_event (PHASE-1-PLAN §1.14). Alerting is
-- Phase 2; for now this is the one place a Super Admin's security feed is
-- assembled. Reached only through the platform (BYPASSRLS) path.

CREATE VIEW "security_event" AS
  SELECT
    a."id",
    a."at",
    a."tenantId",
    a."action"                     AS "kind",
    a."resourceType",
    a."resourceId",
    a."actorUserId",
    a."actorPlatformUserId",
    a."actorAccountType",
    a."impersonatorPlatformUserId",
    a."reason",
    'audit'::text                  AS "source"
  FROM "audit_log" a
  WHERE a."action" LIKE 'tenant.%'
     OR a."action" LIKE 'role.%'
     OR a."action" LIKE 'user.%'
     OR a."action" LIKE 'provider_credential.%'
     OR a."action" LIKE 'session.%'
     OR a."action" LIKE 'IMPERSONATION:%'
  UNION ALL
  SELECT
    l."id",
    l."at",
    l."tenantId",
    l."kind",
    'login'::text                  AS "resourceType",
    NULL::text                     AS "resourceId",
    l."userId"                     AS "actorUserId",
    NULL::uuid                     AS "actorPlatformUserId",
    NULL::text                     AS "actorAccountType",
    NULL::uuid                     AS "impersonatorPlatformUserId",
    NULL::text                     AS "reason",
    'login'::text                  AS "source"
  FROM "login_security_event" l;

-- the audited cross-tenant path reads it; the app role never does.
GRANT SELECT ON "security_event" TO flower_platform;
