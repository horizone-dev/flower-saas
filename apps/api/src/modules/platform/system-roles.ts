import { PHASE_1_TENANT_PERMISSIONS, PHASE_3_2_TENANT_PERMISSIONS } from '@flower/permissions';

/**
 * The 13 system role templates seeded into every tenant at provisioning
 * (ARCHITECTURE §9). OD6 — least privilege: real permission sets for
 * Owner / Admin / Manager and the Phase-1 foundation keys only; every other
 * future-domain role starts with a minimal safe set and is fleshed out when its
 * domain lands. `PHASE_1_TENANT_PERMISSIONS` is the full enforced set today:
 * users:view, users:manage, roles:manage, audit:view, settings:branch:manage,
 * settings:tenant:manage.
 *
 * Phase 3 task 3.2 (owner R-1): `owner` + `admin` gain `catalog:view` +
 * `catalog:manage`; `manager` gains `catalog:view` only. Existing tenants get
 * the identical backfill in the task 3.2 migration.
 */

const P = PHASE_1_TENANT_PERMISSIONS;
/** catalog:view + catalog:manage */
const CATALOG = PHASE_3_2_TENANT_PERMISSIONS;
const CATALOG_VIEW = 'catalog:view';

export interface SystemRoleTemplate {
  key: string;
  name: string;
  permissions: readonly string[];
}

export const SYSTEM_ROLE_TEMPLATES: readonly SystemRoleTemplate[] = Object.freeze([
  { key: 'owner', name: 'Owner', permissions: [...P, ...CATALOG] },
  { key: 'admin', name: 'Admin', permissions: [...P, ...CATALOG] },
  {
    key: 'manager',
    name: 'Manager',
    permissions: ['users:view', 'audit:view', 'settings:branch:manage', CATALOG_VIEW],
  },
  { key: 'supervisor', name: 'Supervisor', permissions: ['users:view'] },
  { key: 'cashier', name: 'Cashier', permissions: ['users:view'] },
  { key: 'sales', name: 'Sales', permissions: ['users:view'] },
  { key: 'florist', name: 'Florist', permissions: ['users:view'] },
  { key: 'storekeeper', name: 'Storekeeper', permissions: ['users:view'] },
  { key: 'purchase_staff', name: 'Purchase Staff', permissions: ['users:view'] },
  { key: 'accountant', name: 'Accountant', permissions: ['users:view'] },
  { key: 'dispatcher', name: 'Dispatcher', permissions: ['users:view'] },
  { key: 'driver', name: 'Driver', permissions: ['users:view'] },
  { key: 'receptionist', name: 'Receptionist', permissions: ['users:view'] },
]);
