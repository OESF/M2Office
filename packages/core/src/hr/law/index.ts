/**
 * @file 法令の表のひとそろい（仕様書 第30.10.2節）。版を足すときは、ここの並びに足す（古い版も残す。確定した回は使った版を記録している）。
 */

import type { LawBook } from './types.js';
import { CARE_R8, CHILD_SUPPORT_R8, GRADES_R8, HEALTH_R8, PENSION } from './social-2026.js';
import { EMPLOYMENT_R8, MINIMUM_WAGE, WITHHOLDING_R8 } from './tax-2026.js';

/** いま本体が持つ法令の表。 */
export const LAW_BOOK: LawBook = {
  health: [HEALTH_R8],
  care: [CARE_R8],
  childSupport: [CHILD_SUPPORT_R8],
  pension: [PENSION],
  grades: [GRADES_R8],
  employment: [EMPLOYMENT_R8],
  withholding: [WITHHOLDING_R8],
  minimumWage: [MINIMUM_WAGE],
};

export type * from './types.js';
export { Law, type LawHit } from './lookup.js';
