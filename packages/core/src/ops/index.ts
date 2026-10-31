/**
 * @file マスター管理画面（仕様書 第23.8.15節、ADR-0078）の公開窓口。決まり（rules.ts）とデータベースの口（store.ts）。
 */

export {
  RESERVED_SUBDOMAINS, OPERATOR_ROLES,
  operatorCan, parseOpsDomains, opsDomainAllowed, checkNewTenant, tenantErrorText, welcomeText, tenantsCsv, statusNoticeText, SUSPEND_REASONS, LOCK_REASONS,
  type OperatorRole, type OpsAction, type NewTenantInput,
} from './rules.js';
export {
  OpsStore, OpsRuleError, sha256,
  type Operator, type OpsSession, type TenantOverview, type OpsAuditEntry,
  type OperatorProfile, type OpsPlatformAiSettings, type TenantDetail, type ServerStatus, type StatusRequest, type OpsProxyGrant, type OpsIncident, type OpsPasskey, type OpsDemo, type OpsDemoDefaults, OPS_PASSKEY_MAX, OPS_ENROLL_CODE_HOURS,
} from './store.js';
export { OpsAppSide } from './app-side.js';
export { loadOpsManual, searchOpsManual, linkChapters, OPS_MANUAL_INTRO, type OpsManualChapter, type OpsManualEntry } from './manual.js';
export { serviceReport, monthRange, INCIDENT_IMPACT_LABEL, type IncidentImpact, type ServiceIncident, type ServiceReport } from './incidents.js';
export { proxyAllowed, ProxyAccessStore, PROXY_HOURS, PROXY_DEFAULT_HOURS, type ProxyScope, type ProxyGrant, type ProxySessionInfo } from './proxy.js';
export { readCloudBackupRun, cloudBackupView, CLOUD_BACKUP_STALE_MS, type CloudBackupRun, type CloudBackupView, type WalArchiveStatus } from './cloud-backup.js';
