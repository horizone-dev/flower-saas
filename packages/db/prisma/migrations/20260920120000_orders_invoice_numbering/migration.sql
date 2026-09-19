-- Phase 3b task 3b.3 CHECKPOINT A — Orders + Invoice + Numbering: schema, RLS,
-- composite FK integrity, closed-vocabulary CHECK constraints, and the
-- gapless-numbering counter structure ONLY. docs/phase-3/PHASE-3B-PLAN.md §C.3
-- (D3b-7: Order != Invoice). Additive, forward-only. NO Payment / PaymentAttempt
-- / PaymentAllocation / AR / Advance / Settlement / Cancellation / Refund /
-- CreditNote / Inventory / Purchase / COGS / BOM / Z-Report table.
--
-- CHECKPOINT A HARDENING PASS (owner conditional-pass review, same task,
-- folded into this still-uncommitted migration rather than a third one):
--   * `order.commercialSnapshotFingerprint` is NOT NULL — every Order has a
--     canonical fingerprint from creation onward, including an empty DRAFT.
--   * new tax-reference structural-shape CHECKs on `order_line`
--     (`resolutionSource` closed vocabulary + 3 cross-column consistency
--     CHECKs) encoding only the 3 legitimate `TaxResolutionResult` shapes.
--   * new branch-scoped `order` index (Branch is THE operational scope).
--   * `invoice.branchId` semantic freeze: = the confirmed Order's
--     `originBranchId`, NEVER `fulfillingBranchId` (see the CreateTable
--     comment below).
--   * the role-default permission backfill lives in the sibling
--     `20260920130000_orders_permissions` migration.
--
--   * `order` — the mutable operational/commercial transaction. Full frozen
--     16-value status vocabulary + the 7-value kind vocabulary from
--     `docs/architecture/DOMAIN-MODEL.md`'s Order aggregate exist from this
--     migration onward (CHECK-enforced); Task 3b.3 publicly wires ONLY
--     `DRAFT <-> HELD` (owner correction). `HELD -> CONFIRMED` is invalid; only
--     a later internal final-issuance primitive (Checkpoint C, never routed
--     from a controller in this task) may perform `DRAFT -> CONFIRMED`.
--     `orderNumber` is NULL for every row this task's public paths create —
--     allocated only by that later internal primitive.
--   * `order_line` — the immutable-once-issued commercial snapshot, captured
--     once via Phase 3a's read-only resolution services. `priceTaxMode` /
--     `roundingScope` / `roundingMode` / `lineTaxAmountMinor` are RESERVED
--     nullable columns Task 3b.3 never populates.
--   * `invoice` — references `order`; a row exists ONLY after final issuance
--     (no draft/incomplete shell). `invoicePaymentStatus` exists per plan §C.3,
--     Task 3b.3 only ever writes the `UNPAID` default.
--   * `document_number_counter` — ONE generic durable per-(tenant, company,
--     documentType) counter row, mirroring `OutboxTenantSeq`'s proven
--     `UPDATE … RETURNING` transactional-counter pattern (never `SEQUENCE`,
--     never `MAX()+1`). Tenant-owned (RLS ENABLE+FORCE) — the increment must
--     itself roll back with the caller's own issuance transaction, unlike
--     `OutboxTenantSeq` which is platform-dispatcher-owned. `documentType`
--     CHECK-closed to `ORDER`/`INVOICE` today; Task 3b.8's Credit-Note
--     numbering can extend this with a new value, never a new table.
--   * Status / kind / discount-mode / invoice-payment-status are closed sets
--     enforced by a CHECK constraint on a plain TEXT column — the SAME
--     convention already used by every comparable closed vocabulary in this
--     schema (`product.status`, `customer.status`, `variant.status`,
--     `accounting_period.status`, `item_identifier.codeType`), never a native
--     Postgres ENUM type. Dedicated reference tables with their own rows
--     (`tax_category`, `currency`, `country`) are reserved for genuinely
--     business-configurable/translatable data — these four vocabularies are
--     fixed and non-tenant-editable.
--   * Structural (not merely RLS) tenant/company/branch integrity — composite
--     FKs prevent, at the DB, a cross-tenant Company, a cross-company Branch
--     (both origin and fulfilling), a POS terminal attributed to a different
--     branch than the order's origin branch, a cross-tenant Customer, and an
--     `order_line` whose `variantId` belongs to a different `productId` than
--     its own `productId` column claims. RLS remains defense-in-depth, not
--     the primary mechanism.
--   * Every stored currency (`order.currencyCode`, `order_line.unitPrice*`,
--     `invoice.currencyCode`) is bound by composite FK to
--     `company(tenantId, id, defaultCurrency)` — mirroring Task 3.7's
--     `company_variant_uom_price` Inv-3 precedent — and to
--     `currency(code, exponent)`, so a stored exponent can never diverge from
--     the currency's authoritative one. No FX; Company.defaultCurrency remains
--     the sole authority (D3b-15).
--
-- ══════════════ DEFERRED TO CHECKPOINT C (documented, not silently omitted) ═══
-- Per the owner's own Checkpoint A/C split (§M: "C — … immutability DB
-- backstops"), NO trigger-based cross-row immutability enforcement is created
-- by this migration. This is safe: Checkpoint A introduces no service/
-- controller that can ever write these tables outside test fixtures. The
-- following triggers are MANDATORY FOR CHECKPOINT C, to ship alongside the
-- internal final-issuance primitive that is the only thing that can ever make
-- them relevant:
--
--   1. `order` / `order_line` conditional freeze — once an `invoice` row
--      exists referencing an `order` (`EXISTS (SELECT 1 FROM invoice WHERE
--      "orderId" = OLD."id")`), any further UPDATE to that order's or its
--      lines' commercial fields must be rejected, EXCEPT the internal
--      issuance primitive's own one-time `DRAFT -> CONFIRMED` transition +
--      `orderNumber` assignment, in the SAME shape as this migration's
--      sibling task 3b.1 sealed-journal `fn_enforce_journal_entry_seal_transition`
--      trigger (allow exactly one specific transition, reject everything
--      else). Must NOT block ordinary DRAFT/HELD edits or the `DRAFT<->HELD`
--      transition itself.
--   2. `invoice` UPDATE — unconditionally rejected (an Invoice row only ever
--      exists in its final, issued form; there is no legal UPDATE, ever).
--   3. `invoice` DELETE — unconditionally rejected, same reasoning as (2).
--   4. `invoice` INSERT — a `BEFORE INSERT` trigger (the CRITICAL INVOICE TAX
--      INVARIANT) that rejects the insert unless EVERY `order_line` row for
--      `NEW."orderId"` has `priceTaxMode`, `roundingScope`, `roundingMode`,
--      AND `lineTaxAmountMinor` all NOT NULL. A zero tax amount is valid; a
--      NULL mandatory tax snapshot on an issued Invoice's line is not.
--
-- These three tables/columns are already fully reserved/shaped for all four
-- triggers — no further schema change will be needed to add them in
-- Checkpoint C.

-- ── CreateTable — order ──────────────────────────────────────────────────────
CREATE TABLE "order" (
    "id"                          UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"                    UUID NOT NULL,
    "companyId"                   UUID NOT NULL,
    "originBranchId"              UUID NOT NULL,
    "fulfillingBranchId"          UUID NOT NULL,
    "posTerminalId"               UUID,
    "customerId"                  UUID,
    "kind"                        TEXT NOT NULL,
    "status"                      TEXT NOT NULL DEFAULT 'DRAFT',
    "currencyCode"                TEXT NOT NULL,
    "currencyExponent"            SMALLINT NOT NULL,
    "documentDiscountMode"        TEXT NOT NULL DEFAULT 'NONE',
    "documentDiscountBps"         INTEGER,
    "documentDiscountAmountMinor" BIGINT NOT NULL DEFAULT 0,
    "documentDiscountReason"      TEXT,
    "orderNumber"                 TEXT,
    "version"                     INTEGER NOT NULL DEFAULT 1,
    "commercialSnapshotFingerprint" TEXT NOT NULL,
    "createdByUserId"             UUID,
    "actingUserId"                UUID,
    "createdAt"                   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                   TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — order_line ─────────────────────────────────────────────────
CREATE TABLE "order_line" (
    "id"                        UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"                  UUID NOT NULL,
    "companyId"                 UUID NOT NULL,
    "orderId"                   UUID NOT NULL,
    "linePosition"              INTEGER NOT NULL,
    "productId"                 UUID NOT NULL,
    "variantId"                 UUID NOT NULL,
    "quantity"                  DECIMAL(18,4) NOT NULL,
    "unitPriceAmountMinor"      BIGINT NOT NULL,
    "unitPriceCurrencyCode"     TEXT NOT NULL,
    "unitPriceCurrencyExponent" SMALLINT NOT NULL,
    "discountMode"              TEXT NOT NULL DEFAULT 'NONE',
    "discountBps"               INTEGER,
    "discountAmountMinor"       BIGINT NOT NULL DEFAULT 0,
    "discountReason"            TEXT,
    "taxCategoryKey"            TEXT,
    "rateBps"                   INTEGER,
    "effectiveFrom"             DATE,
    "resolutionSource"          TEXT NOT NULL,
    "priceTaxMode"              TEXT,
    "roundingScope"             TEXT,
    "roundingMode"              TEXT,
    "lineTaxAmountMinor"        BIGINT,
    "productNameEnSnapshot"     TEXT NOT NULL,
    "productNameArSnapshot"     TEXT,
    "variantNameEnSnapshot"     TEXT NOT NULL,
    "variantNameArSnapshot"     TEXT,
    "skuSnapshot"               TEXT,
    "selectedUomCode"           TEXT NOT NULL,
    "uomDisplayLabelSnapshot"   TEXT NOT NULL,
    "baseUomCode"               TEXT NOT NULL,
    "conversionNumerator"       BIGINT NOT NULL,
    "conversionDenominator"     BIGINT NOT NULL,
    "createdAt"                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                 TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "order_line_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — invoice ────────────────────────────────────────────────────
-- `invoice.branchId` semantic freeze (hardening pass, §4): = the confirmed
-- Order's `originBranchId`, NEVER `fulfillingBranchId` — sales attribution
-- belongs to the branch where the commercial sale originated. The internal
-- final-issuance primitive (Checkpoint C) derives this server-side; it is
-- never accepted from the client.
CREATE TABLE "invoice" (
    "id"                          UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"                    UUID NOT NULL,
    "companyId"                   UUID NOT NULL,
    "branchId"                    UUID NOT NULL,
    "orderId"                     UUID NOT NULL,
    "invoiceNumber"               TEXT NOT NULL,
    "issuedAt"                    TIMESTAMPTZ(6) NOT NULL,
    "invoiceDate"                 DATE NOT NULL,
    "customerDisplayNameSnapshot" TEXT,
    "currencyCode"                TEXT NOT NULL,
    "currencyExponent"            SMALLINT NOT NULL,
    "subtotalAmountMinor"         BIGINT NOT NULL,
    "documentDiscountAmountMinor" BIGINT NOT NULL,
    "taxTotalAmountMinor"         BIGINT NOT NULL,
    "totalAmountMinor"            BIGINT NOT NULL,
    "invoicePaymentStatus"        TEXT NOT NULL DEFAULT 'UNPAID',
    "createdAt"                   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — document_number_counter ────────────────────────────────────
CREATE TABLE "document_number_counter" (
    "tenantId"     UUID NOT NULL,
    "companyId"    UUID NOT NULL,
    "documentType" TEXT NOT NULL,
    "nextNumber"   BIGINT NOT NULL DEFAULT 1,
    "updatedAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_number_counter_pkey" PRIMARY KEY ("tenantId", "companyId", "documentType")
);

-- ── CreateIndex ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "order_tenantId_id_key" ON "order"("tenantId", "id");
CREATE UNIQUE INDEX "order_tenantId_companyId_id_key" ON "order"("tenantId", "companyId", "id");
-- company-scoped gapless order-number uniqueness (§24). NULL values are
-- distinct under standard PostgreSQL unique-index semantics — any number of
-- DRAFT/HELD rows with orderNumber IS NULL coexist without conflict.
CREATE UNIQUE INDEX "order_tenantId_companyId_orderNumber_key" ON "order"("tenantId", "companyId", "orderNumber");
CREATE INDEX "order_tenantId_companyId_status_idx" ON "order"("tenantId", "companyId", "status");
-- branch-scoped status list (index-review hardening pass) — Branch is THE
-- operational scope (CLAUDE.md rule 8); the dominant Manager/Cashier/POS read
-- path filters by a single branch + status. `fulfillingBranchId` deliberately
-- gets no index yet — no planned query filters by it in Task 3b.3.
CREATE INDEX "order_tenantId_companyId_originBranchId_status_idx" ON "order"("tenantId", "companyId", "originBranchId", "status");

CREATE UNIQUE INDEX "order_line_tenantId_id_key" ON "order_line"("tenantId", "id");
CREATE INDEX "order_line_tenantId_companyId_orderId_idx" ON "order_line"("tenantId", "companyId", "orderId");
-- CHECKPOINT C hardening (§1) — `linePosition` is the ONE authoritative,
-- server-assigned persistence ordering for a line array: 1-based, unique per
-- Order, never derived from `createdAt` (every line of one Order shares the
-- SAME `createdAt` — it is `CURRENT_TIMESTAMP` = transaction start time, not
-- statement time, so `ORDER BY createdAt` has no defined tie-break) nor from
-- physical/UUID row order. Every read that reconstructs commercial line order
-- (GET, the commercial-fingerprint recompute on a non-line-replacing PATCH)
-- MUST `ORDER BY "linePosition" ASC`.
CREATE UNIQUE INDEX "order_line_tenantId_companyId_orderId_linePosition_key" ON "order_line"("tenantId", "companyId", "orderId", "linePosition");

CREATE UNIQUE INDEX "invoice_tenantId_id_key" ON "invoice"("tenantId", "id");
CREATE UNIQUE INDEX "invoice_tenantId_companyId_id_key" ON "invoice"("tenantId", "companyId", "id");
CREATE UNIQUE INDEX "invoice_orderId_key" ON "invoice"("orderId");
-- one Invoice per Order (§11/§24) at company grain, plus the tenant-safe FK target
CREATE UNIQUE INDEX "invoice_tenantId_companyId_orderId_key" ON "invoice"("tenantId", "companyId", "orderId");
CREATE UNIQUE INDEX "invoice_tenantId_companyId_invoiceNumber_key" ON "invoice"("tenantId", "companyId", "invoiceNumber");
CREATE INDEX "invoice_tenantId_companyId_idx" ON "invoice"("tenantId", "companyId");

-- ── AddForeignKey — plain FKs (tenant / company / id-only references) ───────
ALTER TABLE "order"
  ADD CONSTRAINT "order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "order_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "order_originBranchId_fkey" FOREIGN KEY ("originBranchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "order_fulfillingBranchId_fkey" FOREIGN KEY ("fulfillingBranchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "order_posTerminalId_fkey" FOREIGN KEY ("posTerminalId") REFERENCES "pos_terminal"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "order_line"
  ADD CONSTRAINT "order_line_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "order_line_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "order_line_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "order_line_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variant"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "invoice_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "document_number_counter"
  ADD CONSTRAINT "document_number_counter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "document_number_counter_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── AddForeignKey — composite tenant/company/branch-safe FKs (structural
--    integrity, §16/§17/§18) — a row cannot reference a tenant/company/branch/
--    product/variant/customer from outside its own scope even under an
--    application bug. RLS remains defense-in-depth, not primary. ────────────
ALTER TABLE "order"
  ADD CONSTRAINT "order_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId")
    REFERENCES "company"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "order_origin_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "originBranchId")
    REFERENCES "branch"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "order_fulfilling_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "fulfillingBranchId")
    REFERENCES "branch"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  -- POS terminal attribution is pinned to the order's ORIGIN branch — a
  -- terminal from a different branch (even in the same company) can never be
  -- the attributed origin device (CLAUDE.md rule 8 — identity/attribution
  -- only, never isolation, but still structurally consistent).
  ADD CONSTRAINT "order_pos_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "originBranchId", "posTerminalId")
    REFERENCES "pos_terminal"("tenantId", "companyId", "branchId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "order_customer_tenant_fkey"
    FOREIGN KEY ("tenantId", "customerId")
    REFERENCES "customer"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  -- currency authority (D3b-15) — the stored order currency must be the
  -- company's CURRENT default currency at write time, mirroring task 3.7's
  -- `company_variant_uom_price` Inv-3 precedent exactly.
  ADD CONSTRAINT "order_currency_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "currencyCode")
    REFERENCES "company"("tenantId", "id", "defaultCurrency")
    ON UPDATE RESTRICT ON DELETE NO ACTION,
  ADD CONSTRAINT "order_currency_exponent_fkey"
    FOREIGN KEY ("currencyCode", "currencyExponent")
    REFERENCES "currency"("code", "exponent")
    ON UPDATE RESTRICT ON DELETE NO ACTION;

ALTER TABLE "order_line"
  ADD CONSTRAINT "order_line_order_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "orderId")
    REFERENCES "order"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "order_line_product_tenant_fkey"
    FOREIGN KEY ("tenantId", "productId")
    REFERENCES "product"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  -- §18: an order_line cannot claim productId=A while variantId belongs to
  -- productId=B — mirrors `variant`'s own `(tenantId, productId, id)` unique
  -- (the exact same-product invariant used by task 3.4's
  -- `variant_option_value` composite FK).
  ADD CONSTRAINT "order_line_variant_same_product_fkey"
    FOREIGN KEY ("tenantId", "productId", "variantId")
    REFERENCES "variant"("tenantId", "productId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "order_line_unit_price_currency_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "unitPriceCurrencyCode")
    REFERENCES "company"("tenantId", "id", "defaultCurrency")
    ON UPDATE RESTRICT ON DELETE NO ACTION,
  ADD CONSTRAINT "order_line_unit_price_currency_exponent_fkey"
    FOREIGN KEY ("unitPriceCurrencyCode", "unitPriceCurrencyExponent")
    REFERENCES "currency"("code", "exponent")
    ON UPDATE RESTRICT ON DELETE NO ACTION;

ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId")
    REFERENCES "company"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "invoice_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId")
    REFERENCES "branch"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "invoice_order_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "orderId")
    REFERENCES "order"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "invoice_currency_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "currencyCode")
    REFERENCES "company"("tenantId", "id", "defaultCurrency")
    ON UPDATE RESTRICT ON DELETE NO ACTION,
  ADD CONSTRAINT "invoice_currency_exponent_fkey"
    FOREIGN KEY ("currencyCode", "currencyExponent")
    REFERENCES "currency"("code", "exponent")
    ON UPDATE RESTRICT ON DELETE NO ACTION;

ALTER TABLE "document_number_counter"
  ADD CONSTRAINT "document_number_counter_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId")
    REFERENCES "company"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION;

-- ── CHECK constraints — closed vocabularies (never a native Postgres ENUM) ──
ALTER TABLE "order"
  ADD CONSTRAINT "order_kind_chk" CHECK ("kind" IN (
    'WALK_IN', 'PICKUP', 'DELIVERY', 'SCHEDULED', 'EVENT',
    'SUBSCRIPTION_INSTANCE', 'QUOTATION'
  )),
  ADD CONSTRAINT "order_status_chk" CHECK ("status" IN (
    'DRAFT', 'HELD', 'PLACED', 'CONFIRMED', 'IN_PRODUCTION', 'READY',
    'OUT_FOR_DELIVERY', 'AWAITING_PICKUP', 'COMPLETED', 'DELIVERED',
    'REJECTED', 'CANCELLED', 'PAYMENT_FAILED', 'REFUNDED',
    'DELIVERY_FAILED', 'RESCHEDULED'
  )),
  ADD CONSTRAINT "order_document_discount_mode_chk" CHECK ("documentDiscountMode" IN ('NONE', 'AMOUNT', 'PERCENT_BPS'));

ALTER TABLE "order_line"
  ADD CONSTRAINT "order_line_discount_mode_chk" CHECK ("discountMode" IN ('NONE', 'AMOUNT', 'PERCENT_BPS')),
  ADD CONSTRAINT "order_line_resolution_source_chk" CHECK ("resolutionSource" IN ('VARIANT', 'PRODUCT', 'NONE'));

-- ── CHECK constraints — tax-reference snapshot structural shape (hardening
--    pass, §11) — only universally-true invariants across the 3 legitimate
--    `TaxResolutionResult` shapes (NO_CATEGORY_ASSIGNED / REGIME_NONE-or-
--    NO_RATE_FOR_CATEGORY / fully resolved). Deliberately NOT an
--    all-4-non-null requirement — that would incorrectly reject the first two
--    real, non-error terminal states. ───────────────────────────────────────
ALTER TABLE "order_line"
  -- `resolutionSource = 'NONE'` iff no tax category was resolved at all.
  ADD CONSTRAINT "order_line_tax_category_source_consistency_chk" CHECK (
    ("resolutionSource" = 'NONE') = ("taxCategoryKey" IS NULL)
  ),
  -- `rateBps` and `effectiveFrom` are always resolved together from the same
  -- `tax_rate` row (`TaxResolutionService.resolve` never sets one without
  -- the other).
  ADD CONSTRAINT "order_line_tax_rate_date_pair_chk" CHECK (
    ("rateBps" IS NULL) = ("effectiveFrom" IS NULL)
  ),
  -- a resolved rate never exists without a resolved category.
  ADD CONSTRAINT "order_line_tax_rate_implies_category_chk" CHECK (
    "rateBps" IS NULL OR "taxCategoryKey" IS NOT NULL
  );

ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_payment_status_chk" CHECK ("invoicePaymentStatus" IN (
    'UNPAID', 'PARTIAL', 'PAID', 'SETTLED', 'PARTIALLY_REFUNDED', 'REFUNDED',
    'CANCELLED', 'VOID'
  ));

ALTER TABLE "document_number_counter"
  ADD CONSTRAINT "document_number_counter_document_type_chk" CHECK ("documentType" IN ('ORDER', 'INVOICE')),
  ADD CONSTRAINT "document_number_counter_next_number_positive_chk" CHECK ("nextNumber" >= 1);

-- ── CHECK constraints — discount shape (§7/§15, applied identically to the
--    Order-level document discount and the OrderLine-level line discount) ───
ALTER TABLE "order"
  ADD CONSTRAINT "order_document_discount_shape_chk" CHECK (
    ("documentDiscountMode" = 'NONE' AND "documentDiscountBps" IS NULL AND "documentDiscountAmountMinor" = 0)
    OR ("documentDiscountMode" = 'AMOUNT' AND "documentDiscountBps" IS NULL AND "documentDiscountAmountMinor" >= 0)
    OR ("documentDiscountMode" = 'PERCENT_BPS' AND "documentDiscountBps" IS NOT NULL
        AND "documentDiscountBps" >= 0 AND "documentDiscountBps" <= 10000
        AND "documentDiscountAmountMinor" >= 0)
  );

ALTER TABLE "order_line"
  ADD CONSTRAINT "order_line_discount_shape_chk" CHECK (
    ("discountMode" = 'NONE' AND "discountBps" IS NULL AND "discountAmountMinor" = 0)
    OR ("discountMode" = 'AMOUNT' AND "discountBps" IS NULL AND "discountAmountMinor" >= 0)
    OR ("discountMode" = 'PERCENT_BPS' AND "discountBps" IS NOT NULL
        AND "discountBps" >= 0 AND "discountBps" <= 10000
        AND "discountAmountMinor" >= 0)
  );

-- ── CHECK constraints — defense-in-depth value shape ─────────────────────────
ALTER TABLE "order_line"
  ADD CONSTRAINT "order_line_quantity_positive_chk" CHECK ("quantity" > 0),
  ADD CONSTRAINT "order_line_unit_price_nonneg_chk" CHECK ("unitPriceAmountMinor" >= 0),
  ADD CONSTRAINT "order_line_conversion_ratio_positive_chk" CHECK ("conversionNumerator" > 0 AND "conversionDenominator" > 0),
  ADD CONSTRAINT "order_line_line_position_positive_chk" CHECK ("linePosition" > 0),
  -- the CRITICAL INVOICE TAX INVARIANT's four reserved columns are populated
  -- together or not at all — Task 3b.4 never leaves a line half-populated.
  ADD CONSTRAINT "order_line_tax_snapshot_shape_chk" CHECK (
    ("priceTaxMode" IS NULL AND "roundingScope" IS NULL AND "roundingMode" IS NULL AND "lineTaxAmountMinor" IS NULL)
    OR ("priceTaxMode" IS NOT NULL AND "roundingScope" IS NOT NULL AND "roundingMode" IS NOT NULL AND "lineTaxAmountMinor" IS NOT NULL)
  );

ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_totals_nonneg_chk" CHECK (
    "subtotalAmountMinor" >= 0 AND "documentDiscountAmountMinor" >= 0
    AND "taxTotalAmountMinor" >= 0 AND "totalAmountMinor" >= 0
  );

-- ══════════════════════ grants for the DB roles ═════════════════════════════
GRANT ALL ON "order", "order_line", "invoice", "document_number_counter" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON "order", "order_line", "invoice", "document_number_counter" TO flower_platform;
-- full DML — tenant business data written via runScoped / flower_app; RLS
-- narrows every statement to the request tenant. The Checkpoint C trigger set
-- documented above will apply regardless of role (including flower_app), same
-- discipline as task 3b.1's sealed-journal backstop.
GRANT SELECT, INSERT, UPDATE, DELETE ON "order", "order_line", "invoice", "document_number_counter" TO flower_app;

-- ══════════════════════ Row-Level Security (plan §C.11 / CLAUDE.md rule 7) ══
ALTER TABLE "order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_tenant_isolation" ON "order"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "order_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_line_tenant_isolation" ON "order_line"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice" FORCE ROW LEVEL SECURITY;
CREATE POLICY "invoice_tenant_isolation" ON "invoice"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "document_number_counter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_number_counter" FORCE ROW LEVEL SECURITY;
CREATE POLICY "document_number_counter_tenant_isolation" ON "document_number_counter"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ══════════════════════ CHECKPOINT C — immutability + tax backstop ══════════
-- Mirrors task 3b.1's sealed-journal trigger discipline exactly: service-layer
-- validation is the primary path (this is only ever expected to fire under an
-- application bug, never in normal operation — no SQLSTATE/domain-error
-- mapping is built for these, matching 3b.1's own precedent of leaving its
-- sealed-journal triggers as an unmapped structural backstop).

-- Trigger 1 — invoice is immutable: UPDATE is never permitted, once inserted.
CREATE FUNCTION fn_enforce_invoice_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'invoice % is immutable: UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_invoice_no_update
  BEFORE UPDATE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_invoice_no_update();

-- Trigger 2 — invoice is immutable: DELETE is never permitted.
CREATE FUNCTION fn_enforce_invoice_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'invoice % is immutable: DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_invoice_no_delete
  BEFORE DELETE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_invoice_no_delete();

-- Trigger 3 — the FULL INVOICE ISSUANCE-SHAPE BACKSTOP (widened, Checkpoint C
-- final-hardening pass, §3): an Invoice can never be inserted unless its
-- referenced Order is fully, correctly issued — not merely "has complete tax
-- lines". Checked, in order, against the referenced `order` row itself:
--   1. the order exists (defense-in-depth on top of the composite FK, which
--      may not have been validated yet at BEFORE-INSERT-trigger time)
--   2. order.status = 'CONFIRMED'
--   3. order."orderNumber" IS NOT NULL
--   4. NEW."branchId" = order."originBranchId" (never fulfillingBranchId)
--   5. NEW."currencyCode" = order."currencyCode"
--   6. NEW."currencyExponent" = order."currencyExponent"
-- then, as before, against its `order_line` rows:
--   7. at least one line exists
--   8. every line has a complete mandatory finalized tax snapshot (a zero tax
--      amount is valid; a NULL mandatory field is not)
-- Do NOT compute or duplicate 3b.4 tax arithmetic here — every check above is
-- a structural/referential shape check, never a rate/rounding computation.
-- NOT deferred — final issuance is one atomic transaction (order_line tax
-- fields and the order's CONFIRMED/orderNumber transition are written BEFORE
-- this INSERT, in the same transaction, unlike journal_entry's multi-
-- statement build-then-seal sequence), so the current transactional state is
-- already final by the time this fires — and a caller reads its own prior
-- writes within the same transaction, so checks 2-6 see the just-applied
-- values, not stale pre-issuance ones.
CREATE FUNCTION fn_check_invoice_tax_completeness() RETURNS trigger AS $$
DECLARE
  order_status TEXT;
  order_number TEXT;
  order_origin_branch UUID;
  order_currency TEXT;
  order_currency_exponent SMALLINT;
  line_count BIGINT;
  incomplete_count BIGINT;
BEGIN
  SELECT "status", "orderNumber", "originBranchId", "currencyCode", "currencyExponent"
    INTO order_status, order_number, order_origin_branch, order_currency, order_currency_exponent
    FROM "order" WHERE "id" = NEW."orderId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice %: referenced order % does not exist', NEW."id", NEW."orderId";
  END IF;
  IF order_status IS DISTINCT FROM 'CONFIRMED' THEN
    RAISE EXCEPTION 'invoice %: order % is not CONFIRMED (status %)', NEW."id", NEW."orderId", order_status;
  END IF;
  IF order_number IS NULL THEN
    RAISE EXCEPTION 'invoice %: order % has no orderNumber assigned', NEW."id", NEW."orderId";
  END IF;
  IF NEW."branchId" IS DISTINCT FROM order_origin_branch THEN
    RAISE EXCEPTION 'invoice %: branchId must equal order %''s originBranchId', NEW."id", NEW."orderId";
  END IF;
  IF NEW."currencyCode" IS DISTINCT FROM order_currency THEN
    RAISE EXCEPTION 'invoice %: currencyCode must equal order %''s currencyCode', NEW."id", NEW."orderId";
  END IF;
  IF NEW."currencyExponent" IS DISTINCT FROM order_currency_exponent THEN
    RAISE EXCEPTION 'invoice %: currencyExponent must equal order %''s currencyExponent', NEW."id", NEW."orderId";
  END IF;

  SELECT COUNT(*) INTO line_count FROM "order_line" WHERE "orderId" = NEW."orderId";
  IF line_count < 1 THEN
    RAISE EXCEPTION 'invoice %: order % has zero order_line rows', NEW."id", NEW."orderId";
  END IF;
  SELECT COUNT(*) INTO incomplete_count FROM "order_line"
    WHERE "orderId" = NEW."orderId"
      AND ("priceTaxMode" IS NULL OR "roundingScope" IS NULL
           OR "roundingMode" IS NULL OR "lineTaxAmountMinor" IS NULL);
  IF incomplete_count > 0 THEN
    RAISE EXCEPTION 'invoice %: order % has % line(s) with an incomplete mandatory tax snapshot',
      NEW."id", NEW."orderId", incomplete_count;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_invoice_tax_completeness
  BEFORE INSERT ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION fn_check_invoice_tax_completeness();

-- Trigger 4 — order_line is immutable once its parent order is issued
-- (`order.orderNumber IS NOT NULL`). A DRAFT/HELD order's lines (orderNumber
-- still NULL) remain freely editable — Checkpoint B's PATCH replace-set is
-- unaffected. The internal issuance primitive writes each line's finalized
-- tax snapshot BEFORE it sets the parent's `orderNumber`, so that write is
-- never blocked by this trigger.
CREATE FUNCTION fn_enforce_order_line_freeze() RETURNS trigger AS $$
DECLARE
  parent_order_number TEXT;
BEGIN
  SELECT "orderNumber" INTO parent_order_number
    FROM "order" WHERE "id" = OLD."orderId";
  IF parent_order_number IS NOT NULL THEN
    RAISE EXCEPTION 'order_line %: parent order % is issued — order_line is immutable',
      OLD."id", OLD."orderId";
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_order_line_freeze
  BEFORE UPDATE OR DELETE ON "order_line"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_order_line_freeze();

-- Trigger 5 — order commercial-field freeze + orderNumber immutability.
-- `orderNumber` is the freeze signal: NULL -> DRAFT/HELD, free commercial
-- edits (Checkpoint B) are entirely unaffected. The ONE legal NULL -> non-NULL
-- transition is the internal issuance primitive's own update, which must be
-- EXACTLY `status DRAFT -> CONFIRMED` + `version + 1`, with every commercial
-- field unchanged from its already-frozen (at create/patch time) value. Once
-- `orderNumber` is non-NULL, it can never change again, and every commercial
-- field is frozen — but `status`/`version`/`actingUserId`/`updatedAt` remain
-- free for a FUTURE phase's operational lifecycle (fulfillment progression),
-- never globally sealing the row.
-- Every field comparison below uses `IS NOT DISTINCT FROM`, NEVER `=` — a
-- bare `=` against a NULL operand evaluates to SQL NULL (not TRUE/FALSE),
-- which `IF NOT (... AND NULL AND ...)` silently treats as "don't raise"
-- (three-valued logic), so a malicious `SET "orderNumber" = NULL` on an
-- already-issued row would otherwise slip past an `=`-based check entirely
-- (caught by adversarial self-review, this checkpoint).
CREATE FUNCTION fn_enforce_order_commercial_freeze() RETURNS trigger AS $$
BEGIN
  IF OLD."orderNumber" IS NULL THEN
    IF NEW."orderNumber" IS NULL THEN
      RETURN NEW; -- ordinary DRAFT/HELD edit — unaffected
    END IF;
    -- the one-time issuance transition
    IF NOT (
      OLD."status" IS NOT DISTINCT FROM 'DRAFT' AND NEW."status" IS NOT DISTINCT FROM 'CONFIRMED'
      AND NEW."version" IS NOT DISTINCT FROM OLD."version" + 1
      AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
      AND NEW."companyId" IS NOT DISTINCT FROM OLD."companyId"
      AND NEW."originBranchId" IS NOT DISTINCT FROM OLD."originBranchId"
      AND NEW."fulfillingBranchId" IS NOT DISTINCT FROM OLD."fulfillingBranchId"
      AND NEW."posTerminalId" IS NOT DISTINCT FROM OLD."posTerminalId"
      AND NEW."customerId" IS NOT DISTINCT FROM OLD."customerId"
      AND NEW."kind" IS NOT DISTINCT FROM OLD."kind"
      AND NEW."currencyCode" IS NOT DISTINCT FROM OLD."currencyCode"
      AND NEW."currencyExponent" IS NOT DISTINCT FROM OLD."currencyExponent"
      AND NEW."documentDiscountMode" IS NOT DISTINCT FROM OLD."documentDiscountMode"
      AND NEW."documentDiscountBps" IS NOT DISTINCT FROM OLD."documentDiscountBps"
      AND NEW."documentDiscountAmountMinor" IS NOT DISTINCT FROM OLD."documentDiscountAmountMinor"
      AND NEW."documentDiscountReason" IS NOT DISTINCT FROM OLD."documentDiscountReason"
      AND NEW."commercialSnapshotFingerprint" IS NOT DISTINCT FROM OLD."commercialSnapshotFingerprint"
      AND NEW."createdByUserId" IS NOT DISTINCT FROM OLD."createdByUserId"
      AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
    ) THEN
      RAISE EXCEPTION
        'order %: the final-issuance transition may only set orderNumber + status(CONFIRMED) + version(+1) — no other field may change',
        OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  -- already issued — orderNumber immutable, every commercial field frozen;
  -- status/version/actingUserId/updatedAt remain free for a future phase's
  -- FORWARD operational progression ONLY (Checkpoint D final-closure §1,
  -- owner correction) — an issued Order must never REGRESS to a pre-issuance
  -- status. DRAFT/HELD/PLACED are structurally pre-commercial-commitment
  -- states (an Order with orderNumber assigned has already left them for
  -- good); every other status in the frozen 16-value vocabulary
  -- (CONFIRMED and everything after it) remains a legitimate forward/
  -- terminal state a future phase may still transition into. This is
  -- deliberately NOT a global status seal — only the 3 pre-issuance values
  -- are blocked, nothing else.
  IF NEW."status" IN ('DRAFT', 'HELD', 'PLACED') THEN
    RAISE EXCEPTION 'order %: an issued order can never regress to status %', OLD."id", NEW."status";
  END IF;

  IF NOT (
    NEW."orderNumber" IS NOT DISTINCT FROM OLD."orderNumber"
    AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
    AND NEW."companyId" IS NOT DISTINCT FROM OLD."companyId"
    AND NEW."originBranchId" IS NOT DISTINCT FROM OLD."originBranchId"
    AND NEW."fulfillingBranchId" IS NOT DISTINCT FROM OLD."fulfillingBranchId"
    AND NEW."posTerminalId" IS NOT DISTINCT FROM OLD."posTerminalId"
    AND NEW."customerId" IS NOT DISTINCT FROM OLD."customerId"
    AND NEW."kind" IS NOT DISTINCT FROM OLD."kind"
    AND NEW."currencyCode" IS NOT DISTINCT FROM OLD."currencyCode"
    AND NEW."currencyExponent" IS NOT DISTINCT FROM OLD."currencyExponent"
    AND NEW."documentDiscountMode" IS NOT DISTINCT FROM OLD."documentDiscountMode"
    AND NEW."documentDiscountBps" IS NOT DISTINCT FROM OLD."documentDiscountBps"
    AND NEW."documentDiscountAmountMinor" IS NOT DISTINCT FROM OLD."documentDiscountAmountMinor"
    AND NEW."documentDiscountReason" IS NOT DISTINCT FROM OLD."documentDiscountReason"
    AND NEW."commercialSnapshotFingerprint" IS NOT DISTINCT FROM OLD."commercialSnapshotFingerprint"
    AND NEW."createdByUserId" IS NOT DISTINCT FROM OLD."createdByUserId"
    AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'order %: commercial fields (including orderNumber) are frozen once issued', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_order_commercial_freeze
  BEFORE UPDATE ON "order"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_order_commercial_freeze();

-- Trigger 6 — user-attribution write-once immutability (Checkpoint C
-- final-hardening pass, §2, owner correction). `createdByUserId`/
-- `actingUserId` are original attribution (CLAUDE.md rule 12) — they must
-- never be overwritten, in ANY status, not only post-issuance. This is
-- DELIBERATELY a separate, unconditional trigger from
-- `fn_enforce_order_commercial_freeze` above: that trigger's "ordinary
-- DRAFT/HELD edit" branch (`OLD."orderNumber" IS NULL AND NEW."orderNumber"
-- IS NULL`) returns immediately with NO field checks at all, so a DRAFT-state
-- attribution change would otherwise slip through entirely uninspected. This
-- trigger fires on EVERY UPDATE regardless of `orderNumber`/status, and
-- checks ONLY these two columns — it is intentionally silent about every
-- other field (that remains the commercial-freeze trigger's job). A same-
-- value UPDATE (including NULL -> NULL) is harmless and permitted, via
-- `IS NOT DISTINCT FROM`, consistent with the freeze trigger's own
-- convention. No "last actor" concept is introduced here — a future
-- operational actor-tracking need belongs in audit/events, not this column.
CREATE FUNCTION fn_enforce_order_attribution_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId" THEN
    RAISE EXCEPTION 'order %: createdByUserId is original attribution and is never overwritten', OLD."id";
  END IF;
  IF NEW."actingUserId" IS DISTINCT FROM OLD."actingUserId" THEN
    RAISE EXCEPTION 'order %: actingUserId is original attribution and is never overwritten', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_order_attribution_immutable
  BEFORE UPDATE ON "order"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_order_attribution_immutable();

-- ══════════════════════ trigger error-contract precedent (§4) ═══════════════
-- All 6 Checkpoint C triggers above deliberately follow Task 3b.1's
-- `fn_enforce_journal_entry_seal_transition` precedent EXACTLY: a plain
-- `RAISE EXCEPTION` (SQLSTATE P0001), no dedicated domain-error mapping.
-- This is safe, not an oversight, for the SAME reason it was safe in 3b.1:
-- every one of these six triggers is a pure "never trust the caller alone"
-- backstop that the legitimate domain path (`OrderRepository`,
-- `InvoiceIssuanceRepository`) already makes structurally unreachable —
--   * `OrderRepository.updateDraftForBranchScoped`/`transitionForBranchScoped`
--     reject with a `DomainError` BEFORE touching a row whenever status isn't
--     the required DRAFT/HELD value, so application code never attempts an
--     UPDATE that could hit the commercial-freeze, order_line-freeze, or
--     attribution triggers outside their one legal shape.
--   * `InvoiceIssuanceRepository.issueFinalInvoice` independently validates
--     every condition triggers 3/6 re-check (status, version, fingerprint,
--     line completeness, currency, branch) with its OWN `DomainError`s
--     BEFORE ever issuing the `order.update`/`invoice.create` calls, and
--     never calls `tx.invoice.update()`/`.delete()` or mutates
--     createdByUserId/actingUserId anywhere.
-- A raw-SQL bypass (an application bug, or a direct DB session) is the ONLY
-- way any of these six triggers can fire — never a real HTTP/repository call
-- path. Given that, this codebase's single global `AllExceptionsFilter`
-- (`apps/api/src/common/errors/all-exceptions.filter.ts`) already fails
-- closed for ANY exception that is not a recognised `DomainError`/
-- `HttpException`: it returns a generic `500 INTERNAL_ERROR` /
-- "An unexpected error occurred" and logs the real exception server-side
-- only (`rootLogger.error`) — so even in the hypothetical case one of these
-- triggers did fire behind a repository call, no raw PostgreSQL trigger
-- message would ever reach an HTTP response. This global convention is
-- exercised across the whole existing test suite (every
-- `*.integration.test.ts` that asserts `INTERNAL_ERROR`/uses
-- `AllExceptionsFilter`) and is not re-tested per-trigger here; Checkpoint
-- C's own tests instead prove point-of-fire (the raw-SQL trigger message
-- itself, `packages/db/test/orders-invoice-numbering.integration.test.ts`),
-- which is the only thing that changes per trigger.
