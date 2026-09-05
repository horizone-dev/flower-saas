# GCC fiscal / localization reference data (Task 2.7)

> **This is a verified platform reference starting point, not a permanent
> legal or compliance guarantee.** Values below were checked against the
> sources cited, on the dates cited, during Task 2.7's implementation
> (2026-09-05). Tax law changes; verifying the current rate/regime against an
> official source **immediately before onboarding a tenant in a given
> country is mandatory**, every time — never assume this document is still
> current at onboarding time. This file, and the seed it documents
> (`packages/db/prisma/gcc-reference-data.ts`), are Task 2.7's data
> deliverable; the tax-calculation engine that consumes this data is Phase 3,
> not built here.

## How to use this document

For each country: the seeded values, the source used to verify them, the
verification date, and any known limitation. `effective_from`/`effective_to`
dates are exactly what is seeded in `country_tax_config`/`tax_rate` — nothing
here is invented or extrapolated beyond what the cited source states.

---

## United Arab Emirates (AE)

- **Currency**: AED, 2 decimal places.
- **Weekend**: Saturday–Sunday (federal government entities), effective
  2022-01-01 — Friday afternoon is a half day. Before 2022-01-01 the weekend
  was Friday–Saturday; this seed reflects the **current** model only (no
  historical weekend-model row exists in the schema to represent the change).
  - Source: UAE Government announcement via the UAE Media Office;
    corroborated by [Al Jazeera](https://www.aljazeera.com/economy/2021/12/7/uae-announces-changes-to-workweek-for-employees-of-govt-sector) and [CNBC](https://www.cnbc.com/2021/12/07/uae-to-shift-weekend-to-saturday-and-sunday-from-next-year.html).
  - Verified: 2026-09-05.
- **VAT**: Standard rate **5%**, effective **2018-01-01**, no change since.
  - Source: [UAE Ministry of Finance](https://mof.gov.ae/en/public-finance/tax/value-added-tax-vat/); rate set by Federal Decree-Law No. 8 of 2017, Article 3.
  - Verified: 2026-09-05.
- **National Day**: 2 December (Union Day, 1971). Seeded for 2026 only.
  - Source: [UAE Government official portal (u.ae)](https://u.ae/en/information-and-services/public-holidays-and-religious-affairs/public-holidays/uae-national-day-celebrations).
  - Verified: 2026-09-05.
- **Known limitation**: many sources describe a 2-day observance (Dec 2–3);
  only the 2 December row is seeded — confirm the exact observed dates
  (which can shift for a weekend) before relying on this for scheduling.

## Saudi Arabia (SA)

- **Currency**: SAR, 2 decimal places.
- **Weekend**: Friday–Saturday.
- **VAT**: Standard rate **5%** from **2018-01-01**, raised to **15%**
  effective **2020-07-01** (announced 2020-05-11 as a fiscal response to the
  COVID-19 impact on government revenue). Both periods are seeded as separate
  `tax_rate` rows under one continuous `VAT` regime.
  - Source: [Deloitte Middle East](https://www.deloitte.com/middle-east/en/services/tax/perspectives/ksa-vat-rate-increase-15percent-1-july-2020.html); corroborated by [PwC](https://www.pwc.com/m1/en/tax/documents/2021/saudi-arabia-end-of-the-transitional-period-for-vat-rate-increase.pdf). Regulator: ZATCA (Zakat, Tax and Customs Authority).
  - Verified: 2026-09-05.
- **National Day**: 23 September. Seeded for 2026 only.
  - Source: general GCC public-holiday reporting (gulfbusiness.com and others); not cross-checked against a Saudi government primary source in this session.
  - Verified: 2026-09-05 (secondary sources only — lower confidence than the VAT figures above; re-verify against a Saudi government source before relying on it).
- **Known limitation**: this is the highest-fiscal-impact country in the seed
  (15% standard rate, one rate change already on record) — verify current
  rate and any newer change against ZATCA directly before onboarding.

## Bahrain (BH)

- **Currency**: BHD, **3 decimal places**.
- **Weekend**: Friday–Saturday.
- **VAT**: Standard rate **5%** from **2019-01-01**, raised to **10%**
  effective **2022-01-01**. Both periods seeded as separate `tax_rate` rows.
  - Source: [Kingdom of Bahrain official VAT page](https://www.bahrain.bh/wps/portal/en/BNP/HomeNationalPortal/ContentDetailsPage/) (National Bureau for Revenue); corroborated by [vatcalc.com](https://www.vatcalc.com/bahrain/bahrain-vat-rises-to-10-from-5-2022-implementation-guidance/) and [VATupdate](https://www.vatupdate.com/2021/12/29/bahrain-publishes-law-increasing-vat-rate-to-10-from-2022/).
  - Verified: 2026-09-05.
- **National Day**: 16 December. Seeded for 2026 only. (Several sources
  describe a 2-day 16–17 December observance; only 16 December is seeded —
  same limitation as UAE's, confirm before relying on it for scheduling.)
  - Source: general GCC public-holiday reporting; not cross-checked against a Bahraini government primary source in this session.
  - Verified: 2026-09-05 (secondary sources only).

## Oman (OM)

- **Currency**: OMR, **3 decimal places**.
- **Weekend**: Friday–Saturday.
- **VAT**: Standard rate **5%**, effective **2021-04-16** (Royal Decree No.
  121/2020, published in the Official Gazette 2020-10-18), no change since.
  - Source: [Pinsent Masons](https://www.pinsentmasons.com/out-law/analysis/oman-confirms-vat-implementation-april-2021); corroborated by PwC's Worldwide Tax Summaries.
  - Verified: 2026-09-05.
- **National Day**: 18 November. Seeded for 2026 only.
  - Source: general GCC public-holiday reporting; not cross-checked against an Omani government primary source in this session.
  - Verified: 2026-09-05 (secondary sources only).

## Qatar (QA)

- **Currency**: QAR, 2 decimal places.
- **Weekend**: Friday–Saturday.
- **VAT**: **No VAT law in force** (`regime = NONE`, never a 0% rate — a
  distinct, deliberately-modelled state). Qatar committed to the 2016 GCC VAT
  Framework Agreement but has not implemented VAT as of the verification date;
  as of mid-2026 no official implementation date has been announced (some
  industry commentary cites 2027 as a planning estimate, explicitly **not**
  an official date, and is not seeded as one).
  - Source: [vatcalc.com](https://www.vatcalc.com/qatar/qatar-bides-its-time-on-vat-implementation/); [MBG Corp](https://www.mbgcorp.com/qatar/insights/vat-implementation-in-qatar/).
  - Verified: 2026-09-05.
- **National Day**: 18 December. Seeded for 2026 only.
  - Source: general GCC public-holiday reporting; not cross-checked against a Qatari government primary source in this session.
  - Verified: 2026-09-05 (secondary sources only).
- **Onboarding note**: if Qatar introduces VAT before this tenant-onboarding
  gate is next reviewed, this file and the seed are both stale until updated
  — the `regime = NONE` row must be closed with an `effective_to` and a new
  `VAT` regime + `tax_rate` row(s) added; this is a manual follow-up task, not
  an automatic transition.

## Kuwait (KW)

- **Currency**: KWD, **3 decimal places**.
- **Weekend**: Friday–Saturday.
- **VAT**: **No VAT law in force** (`regime = NONE`). Kuwait's government
  fiscal plan for 2026–2030, per industry reporting, explicitly excludes VAT
  implementation; Parliament has historically been the primary blocker.
  - Source: [vatcalc.com](https://www.vatcalc.com/kuwait/kuwait-election-means-vat-implementation-unlikely-soon/); [CentrixPlus](https://www.centrixplus.com/blog/kuwait-vat-2026-odoo-readiness/).
  - Verified: 2026-09-05.
- **National Day**: 25 February (Kuwait also observes a Liberation Day on 26
  February — only National Day, 25 February, is seeded; Liberation Day is a
  known gap, not seeded in this pass).
  - Source: general GCC public-holiday reporting; not cross-checked against a Kuwaiti government primary source in this session.
  - Verified: 2026-09-05 (secondary sources only).
- **Onboarding note**: same manual-follow-up requirement as Qatar if Kuwait's
  VAT-implementation posture changes.

---

## Deliberately NOT seeded

- **Any Islamic/lunar (Hijri) holiday** — Eid al-Fitr, Eid al-Adha, Hijri New
  Year, the Prophet's Birthday, Isra and Mi'raj, Arafat Day, and any other
  moon-sighting-dependent observance, for **any** GCC country. Their Gregorian
  dates are announced only shortly before the observance and cannot be
  predicted in advance without risk of being wrong. Seeding a manufactured
  future date for one of these would violate the explicit "do not invent or
  predict future public-holiday dates" rule. **This is a known, deliberate gap
  in the Holiday reference data**, not an oversight — any feature that
  eventually consumes `holiday` data for scheduling/delivery-slot purposes
  (Phase 7+) must account for lunar holidays being absent from this table by
  design, until a per-year, per-country manual/administrative confirmation
  process is built to add them close to each actual observance.
- **Holiday years beyond 2026** — only the current calendar year's
  fixed-Gregorian-date national holidays are seeded. Extending the holiday
  calendar to 2027 and beyond is an operational task for a later pass, not
  automated by this seed.
- **Kuwait's Liberation Day** (26 February) — a known, narrow gap; only
  National Day (25 February) is currently seeded.
- **The tax-calculation engine** (cart → tax lines) — Phase 3, explicitly out
  of Task 2.7's scope.
- **Any e-invoicing/ZATCA adapter** — the `EInvoicingProvider` port ships as
  an interface + a no-op stub only; a real adapter is gated behind Z-8's
  existing KSA-onboarding compliance gate (ADR-0012), separately approved
  work, not part of Task 2.7.

## Pre-onboarding verification checklist (mandatory, per country, every time)

Before onboarding the **first** tenant with a company in a given country (and
periodically thereafter — tax law changes without this document being
updated automatically):

1. Confirm the current VAT/tax regime and standard rate against that
   country's official tax authority (UAE: Federal Tax Authority; KSA: ZATCA;
   Bahrain: National Bureau for Revenue; Oman: Oman Tax Authority; Qatar/
   Kuwait: confirm VAT is still not implemented, or capture the new regime if
   it has been).
2. Confirm the currency and its minor-unit exponent are still correct
   (extremely stable, but verify once per onboarding, not assumed).
3. Confirm the weekend model is still correct for the country's current
   public/private-sector norm (can differ; this seed reflects one
   commonly-cited default per country, not necessarily every sector).
4. Confirm which, if any, lunar holidays need manual entry for the
   onboarding tenant's operating window, since none are pre-seeded.
5. Record the verification (source + date) for this specific onboarding —
   this document's own verification dates above are **not** a substitute for
   re-checking at onboarding time.
