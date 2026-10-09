/**
 * @file 運営者のパスキー（仕様書 第23.8.15節「運営者のパスキー」、Q-211）。Google のログインのあと、ログインのたびにパスキーで確かめる。
 *
 * WebAuthn の手続きは @simplewebauthn/server に任せる。テストでは手続きを差し替えられるよう、関数の組（{@link WebAuthnFns}）で受け取る。
 * 最初の登録は、運営管理者が出す 1 回だけの登録の合言葉で行う（Google のアカウントが乗っ取られても、合言葉が無ければ登録できない）。
 */

import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';

/** WebAuthn の手続き（テストで差し替える）。 */
export interface WebAuthnFns {
  registrationOptions: typeof generateRegistrationOptions;
  verifyRegistration: typeof verifyRegistrationResponse;
  authenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthentication: typeof verifyAuthenticationResponse;
}

/** 本物の手続き。 */
export const realWebAuthn: WebAuthnFns = {
  registrationOptions: generateRegistrationOptions,
  verifyRegistration: verifyRegistrationResponse,
  authenticationOptions: generateAuthenticationOptions,
  verifyAuthentication: verifyAuthenticationResponse,
};

/** 出した問いかけ（challenge）を、ログイン状態ごとに 5 分だけ覚えておく。 */
const CHALLENGE_TTL_MS = 5 * 60_000;

export class ChallengeStore {
  private readonly items = new Map<string, { challenge: string; kind: 'register' | 'verify'; expires: number }>();

  put(sessionId: string, kind: 'register' | 'verify', challenge: string, now = Date.now()): void {
    for (const [k, v] of this.items) if (v.expires < now) this.items.delete(k);
    this.items.set(sessionId, { challenge, kind, expires: now + CHALLENGE_TTL_MS });
  }

  /** 1 回だけ取り出す。種類が違う・切れていれば `null`。 */
  take(sessionId: string, kind: 'register' | 'verify', now = Date.now()): string | null {
    const hit = this.items.get(sessionId);
    this.items.delete(sessionId);
    return hit && hit.kind === kind && hit.expires >= now ? hit.challenge : null;
  }
}

/** base64url と Uint8Array の行き来（公開鍵を文字で持つため）。 */
export const toB64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');
export const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
