/**
 * @file 会議室・社用車・備品の予約を内蔵の拡張として並べるための包み（仕様書 第37.2節・第12.13節）。
 *
 * 段 1 はツールも付属の業務も持たない。予約は画面と、秘書の欄の本人の発言（第37.7節）から行う。料金は取らない標準の機能。
 */

import { RESERVATIONS_EXTENSION_ID } from '@m2office/shared';
import type { ExtensionPackage } from '../extensions/loader.js';

/** 予約の版（内蔵の拡張の版。段を足すたびに上げる）。 */
export const RESERVATIONS_EXTENSION_VERSION = '1.0.0';

/** 会議室・社用車・備品の予約（内蔵の拡張。既定は切り）。 */
export const RESERVATIONS_PACKAGE: ExtensionPackage = {
  manifest: {
    id: RESERVATIONS_EXTENSION_ID,
    name: '予約',
    version: RESERVATIONS_EXTENSION_VERSION,
    description: '会議室・社用車・備品を、画面か秘書に頼むだけで予約し、重なりを防ぎます。予約した人の Google カレンダーにも予定を入れます',
    publisher: { name: 'M2Office', verified: true },
    platform_schema: '>=1 <2',
    permissions: { tools: [], max_risk_level: 'read' },
  },
  agents: [],
  connectors: [],
  readme: null,
  icon: '/extensions/reservations.png',
  dir: null,
};
