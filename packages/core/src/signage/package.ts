/**
 * @file 店頭サイネージを内蔵の拡張として並べるための包み（仕様書 第31.2節・第12.13節）。
 *
 * 段 1 は道具も付属の業務も持たない。画面・素材・流れは使える人が画面から扱う。料金は取らない標準の機能。
 */

import { SIGNAGE_EXTENSION_ID } from '@m2office/shared';
import type { ExtensionPackage } from '../extensions/loader.js';

/** 店頭サイネージの版（内蔵の拡張の版。段を足すたびに上げる）。 */
export const SIGNAGE_EXTENSION_VERSION = '0.1.0';

/** 店頭サイネージ（内蔵の拡張。既定は切り）。 */
export const SIGNAGE_PACKAGE: ExtensionPackage = {
  manifest: {
    id: SIGNAGE_EXTENSION_ID,
    name: '店頭サイネージ',
    version: SIGNAGE_EXTENSION_VERSION,
    description: '店頭や待合に置いた画面（1 社 3 台まで）に、画像と動画を繰り返し流します。画面は QR を読むだけで登録でき、通信が切れても流し続けます',
    publisher: { name: 'M2Office', verified: true },
    platform_schema: '>=1 <2',
    permissions: { tools: [], max_risk_level: 'read' },
  },
  agents: [],
  connectors: [],
  readme: null,
  icon: '/extensions/signage.png',
  dir: null,
};
