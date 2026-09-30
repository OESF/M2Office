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
  summarizeDay, weeklyOvertime, periodTotals, variableTotals, variableCapMinutes, periodOf, periodContaining, agreementAlerts, dayType, scheduledMinutes, jstDate, jstTime, shiftDate,
  DAILY_LIMIT, WEEKLY_LIMIT, OVER60, type AgreementAlert, type DaySchedule,
} from './attendance.js';
export { leaveBalance, dueGrantDates, grantDays, addMonths, LEAVE_NORMAL, LEAVE_PROPORTIONAL, LEAVE_OBLIGATION_DAYS } from './leave.js';
export { japaneseHolidays, isJapaneseHoliday, equinoxDays } from './holidays.js';
export { PostgresPayrollStore, type PayrollStore, type SlipWithRun } from './payroll-store.js';
export { buildTermsNotice, renderTermsNoticePdf, type NoticeItem, type TermsNoticeDoc, type TermsNoticeInput } from './terms-notice.js';
export { buildDeadlines, nextBusinessDay, isClosedDay, type CalendarInput, type MonthPayment } from './calendar.js';
export { LaborCalendar, type LaborCalendarDeps } from './calendar-service.js';
export { HR_TOOLS, hrDeadlines, type HrToolContext } from './tools.js';
export { parseProposal, proposeFromRules, type ProposalField } from './rules-proposal.js';
export { PostgresYeaStore, type YeaStore } from './yea-store.js';
export { YearEndService, type YearEndServiceDeps, type YearTotals, type YeaOverviewRow } from './yea-service.js';
export { calcYea, declarationProblems, type YeaInput } from './yea-calc.js';
export { readCertificate, parseCertificate, type CertificateReading, type CertificateKind } from './yea-certificate.js';
export { renderWithholdingPdf, type WithholdingPdfInput } from './withholding-pdf.js';
export { PostgresLaborStore, type LaborStore, type LaborRecord } from './labor-store.js';
export { PostgresShiftStore, type ShiftStore } from './shift-store.js';
export { ShiftService, type ShiftServiceDeps } from './shift-service.js';
export { generatePlan, checkPlan, variableCap, needsOn, patternMinutes, MAX_STREAK, type PlanInput, type PlanMember } from './shift-plan.js';
export { HrBooksExport, type BooksExportDeps, type BooksExportSummary } from './books-export.js';
export { LaborInsuranceService, type LaborServiceDeps } from './labor-service.js';
export { laborMonths, laborCalc, premium, installments, perMille, thousands, fiscalMonths, laborWage, type LaborInput, type LaborSlip } from './labor-insurance.js';
export { PostgresSocialStore, type SocialStore, type HrFilingRecord } from './social-store.js';
export { SocialInsuranceService, type SocialServiceDeps, type SocialOverview, type SpecificOffice, type FilingSheet } from './social-service.js';
export {
  regularDetermination, changeCandidates, changeQualifies, socialEvents, eligibility, acquirePay, averageOf, remunerationOf, fixedWageOf, baseDaysOfSlip, isShortTime,
  gradeOf, standardPayAt, healthIn, day70, day75, type PaidSlip, type FixedWage,
} from './social.js';
export { PayrollService, type PayrollServiceDeps, type MySlipSummary, type NoticeApplyResult } from './payroll-service.js';
export { reviewRun, reviewOther, changedLines, explainDiff, type ReviewInput } from './payroll-review.js';
export { calcBonus, HEALTH_BONUS_CAP, PENSION_BONUS_CAP, type BonusInput } from './bonus.js';
export { buildZenginFile, toZenginKana, type ZenginClient, type ZenginPayee, type ZenginProblem } from './zengin.js';
export { renderPayslipPdf, type PayslipPdfInput } from './payslip-pdf.js';
export { readResidentNotice, parseNoticeReading, noticeProblem, type NoticeEntry, type NoticeReading } from './resident-notice.js';
export { mapTrialHeaders, trialTotals, trialNumber, compareTrialRow, TRIAL_ITEMS, type TrialItem } from './payroll-trial.js';
export { calcSlip, adjustmentLines, round50, itemRule, reachMonth, insuredIn, shiftMonth as shiftPayMonth, type SlipInput, type SlipResult as PaySlipResult } from './payroll.js';
export { LAW_BOOK, Law, type LawHit } from './law/index.js';
export type { LawBook, LawMeta, LawReview, GradeRow, GradeTable, ChangeLimit, InsuranceRules, WorkersCompRates, WorkersCompRow, HealthRates, RateTable, EmploymentRates, WithholdingMonthly, WithholdingRow, WithholdingAbove, MinimumWage } from './law/types.js';
