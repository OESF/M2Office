/**
 * @file 人事・給与を内蔵の拡張として並べるための包み（仕様書 第30.2節・第12.13節）。
 *
 * 段 1（土台）では道具も付属の業務も持たない。台帳は人事区画の人だけが画面から扱う。
 */

import { HR_EXTENSION_ID } from '@m2office/shared';
import type { ExtensionPackage } from '../extensions/loader.js';

/** 人事・給与の版（内蔵の拡張の版。段を足すたびに上げる）。 */
export const HR_EXTENSION_VERSION = '0.1.0';

/** 人事・給与（内蔵の拡張。既定は切り）。 */
export const HR_PACKAGE: ExtensionPackage = {
  manifest: {
    id: HR_EXTENSION_ID,
    name: '人事・給与',
    version: HR_EXTENSION_VERSION,
    description: '従業員の台帳と雇用条件の履歴を持ち、入社・退職の手続きを期限つきで並べます。今の表計算から取り込め、労働者名簿を書き出せます。人事区画の人だけが扱えます',
    publisher: { name: 'M2Office', verified: true },
    platform_schema: '>=1 <2',
    permissions: { tools: [], max_risk_level: 'read' },
  },
  agents: [],
  connectors: [],
  readme: null,
  icon: '/extensions/hr.png',
  dir: null,
};
