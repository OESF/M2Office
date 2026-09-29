/**
 * @file 人事・給与（内蔵の拡張。仕様書 第30章）の入口。段 1（土台）の台帳・手続き・取り込み・労働者名簿。
 */

export { HR_PACKAGE, HR_EXTENSION_VERSION } from './package.js';
export { PostgresHrStore, type HrStore, type EmployeeRecord, type TermsRecord } from './store.js';
export {
  HrService, hrAccess, ensureHrCompartment, jstToday, toHrDate, toFlag, HR_IMPORT_FIELDS, HR_IMPORT_MAX_ROWS, HR_IMPORT_PROCEDURE_DAYS,
  type HrServiceDeps, type EmployeeInput, type TermsInput, type HrImportResult, type HrImportField,
} from './service.js';
export {
  hireProcedures, leaveProcedures, payDateFor, addOneMonth, tenthOfNextMonth, dayOfMonth,
  type ProcedureDraft, type ProcedureSubject,
} from './procedures.js';
