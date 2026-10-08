/**
 * @file マスター管理画面（仕様書 第23.8.15節、ADR-0078）の公開窓口。決まり（rules.ts）とデータベースの口（store.ts）。
 */

export {
  RESERVED_SUBDOMAINS, OPERATOR_ROLES, MACHINE_REPORT_MAX_BYTES, MACHINE_SILENT_MS,
  operatorCan, checkNewTenant, tenantErrorText, welcomeText, parseMachineReport, machineFlags, tenantsCsv,
  type OperatorRole, type OpsAction, type NewTenantInput, type MachineReport, type MachineFlag,
} from './rules.js';
export {
  OpsStore, OpsRuleError, sha256,
  type Operator, type OpsSession, type TenantOverview, type OpsMachine, type OpsAuditEntry,
  type OperatorProfile, type TenantDetail, type ServerStatus,
} from './store.js';
export { OpsAppSide } from './app-side.js';
