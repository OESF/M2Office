/**
 * @file 体験版（仕様書 第23.3.2節、ADR-0115）の公開窓口。決まり（rules.ts）・アプリの側の口（store.ts）・見本の会社のデータ（sample.ts）。
 */

export {
  DEMO_DEFAULT_DAYS, DEMO_DEFAULT_AI_CAP_JPY, DEMO_EXTEND_MAX_DAYS, DEMO_MAX_DAYS, DEMO_SESSION_HOURS, DEMO_STORAGE_BYTES,
  DEMO_RESTRICTED_MESSAGE, DEMO_TERMS, isDemoTenantId, demoSubdomain, newGuestLoginId, newGuestPassword, isGuestLoginId,
  demoRestrictionOf, demoBlocked, checkNewDemo, demoWelcomeText, type DemoRestriction, type NewDemoInput,
} from './rules.js';
export { PostgresDemoStore, MemoryDemoStore, type DemoStore, type DemoLoginRecord, type DemoTrialInfo } from './store.js';
export {
  DEMO_COMPANY_NAME, DEMO_COMPANY, DEMO_RULES, DEMO_CARDS, DEMO_ITEMS, DEMO_QUOTES, seedDemoCompany, type DemoSeedDeps,
} from './sample.js';
