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
export { PostgresAttendanceStore, type AttendanceStore } from './attendance-store.js';
export {
  AttendanceService, termsOn, groupShifts, type AttState, type DayFix, type AttSummaryRow, type AttendanceServiceDeps,
} from './attendance-service.js';
export {
  summarizeDay, weeklyOvertime, periodTotals, periodOf, periodContaining, agreementAlerts, dayType, scheduledMinutes, jstDate, jstTime, shiftDate,
  DAILY_LIMIT, WEEKLY_LIMIT, OVER60, type AgreementAlert, type DaySchedule,
} from './attendance.js';
export { leaveBalance, dueGrantDates, grantDays, addMonths, LEAVE_NORMAL, LEAVE_PROPORTIONAL, LEAVE_OBLIGATION_DAYS } from './leave.js';
export { japaneseHolidays, isJapaneseHoliday, equinoxDays } from './holidays.js';
export { PostgresPayrollStore, type PayrollStore, type SlipWithRun } from './payroll-store.js';
export { buildTermsNotice, renderTermsNoticePdf, type NoticeItem, type TermsNoticeDoc, type TermsNoticeInput } from './terms-notice.js';
export { buildDeadlines, nextBusinessDay, isClosedDay, type CalendarInput, type MonthPayment } from './calendar.js';
export { LaborCalendar, type LaborCalendarDeps } from './calendar-service.js';
export { HR_TOOLS, hrDeadlines, type HrToolContext } from './tools.js';
export { PayrollService, type PayrollServiceDeps, type MySlipSummary, type NoticeApplyResult } from './payroll-service.js';
export { reviewRun, changedLines, explainDiff, type ReviewInput } from './payroll-review.js';
export { buildZenginFile, toZenginKana, type ZenginClient, type ZenginPayee, type ZenginProblem } from './zengin.js';
export { renderPayslipPdf, type PayslipPdfInput } from './payslip-pdf.js';
export { readResidentNotice, parseNoticeReading, noticeProblem, type NoticeEntry, type NoticeReading } from './resident-notice.js';
export { mapTrialHeaders, trialTotals, trialNumber, compareTrialRow, TRIAL_ITEMS, type TrialItem } from './payroll-trial.js';
export { calcSlip, round50, itemRule, reachMonth, insuredIn, shiftMonth as shiftPayMonth, type SlipInput, type SlipResult as PaySlipResult } from './payroll.js';
export { LAW_BOOK, Law, type LawHit } from './law/index.js';
export type { LawBook, LawMeta, LawReview, GradeRow, GradeTable, HealthRates, RateTable, EmploymentRates, WithholdingMonthly, WithholdingRow, WithholdingAbove, MinimumWage } from './law/types.js';
