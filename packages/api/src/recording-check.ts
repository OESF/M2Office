/**
 * @file 録音のファイルを受け取ってよいかの確かめ（仕様書 第9.4.5節）。手元から渡す口とドライブから渡す口で同じものを使う。
 *
 * ローカルの方針の会社は、社内の AI で録音を文字にできず、録音を社外の AI に渡すことも第16.3.7節でできないため受け取らない。
 * 会社の AI が録音を扱えない（設定されていない）ときも受け取らない。3 時間を超える録音も受け取らない。
 */

import { audioDurationSec, isLocalPolicy, MAX_AUDIO_SECONDS, type FileKind } from '@m2office/core';
import type { AppDeps } from './context.js';

/** 録音を受け取れないときの、利用者に見せる文。 */
export const LOCAL_RECORDING_REFUSAL = 'この会社の方針では録音を文字にできません。文字起こしの文書か、貼り付けで渡してください';

/**
 * 録音を受け取ってよいか。
 *
 * @returns 受け取れなければ理由（利用者に見せる文）。録音でないファイル・受け取れる録音は `null`
 */
export async function recordingRefusal(deps: Pick<AppDeps, 'ai'>, tenantId: string, kind: FileKind, bytes: Uint8Array): Promise<string | null> {
  if (kind !== 'mp3' && kind !== 'm4a' && kind !== 'wav') return null;
  const unavailable = await recordingUnavailable(deps, tenantId);
  if (unavailable) return unavailable;
  const sec = audioDurationSec(bytes, kind);
  if (sec !== null && sec > MAX_AUDIO_SECONDS * 1.02) return '録音が 3 時間を超えています。分けて渡してください';
  return null;
}

/**
 * 会社が録音を受け取れるか（その場で録る前にも確かめる。第9.4.5.1節）。
 *
 * @returns 受け取れなければ理由（利用者に見せる文）。受け取れれば `null`
 */
export async function recordingUnavailable(deps: Pick<AppDeps, 'ai'>, tenantId: string): Promise<string | null> {
  if (isLocalPolicy(await deps.ai.policyFor(tenantId))) return LOCAL_RECORDING_REFUSAL;
  const llm = await deps.ai.llmFor(tenantId).catch(() => null);
  if (!llm?.transcribeAudio) return 'この会社の AI が設定されていないため、録音を文字にできません。管理者に AI の設定を頼んでください';
  return null;
}
