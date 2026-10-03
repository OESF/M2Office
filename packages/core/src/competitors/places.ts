/**
 * @file Google Places API（New）で、自社の場所と近くの同業を引く（競合の分析。仕様書 第36.5節・第36.13節）。
 *
 * 会社の Gemini の鍵（同じ Google Cloud のプロジェクト）で呼ぶ。**残してよいのは place ID だけ**で、名前・住所・Web サイトの URL は
 * 引いたときに使って捨てる（緯度と経度は 30 日まで）。表示するときは「Google Maps」の表記と、返った出典を付ける。
 * 開発の見本の会社では、外に出ない見本の口（{@link MockPlaces}）を使う。
 */

/** 引いた場所（使って捨てる。place ID のほかは残さない）。 */
export interface PlaceHit {
  id: string;
  name: string;
  website: string;
  lat: number | null;
  lng: number | null;
  primaryType: string;
  /** 出典の表示（第三者のもの） */
  attributions: string[];
}

/** Places API の口。 */
export interface PlacesClient {
  /** 言葉で探す（自社の場所・名前で入れた競合）。`near` があれば、その近くを先にする。 */
  search(query: string, near?: { lat: number; lng: number; radiusM: number }): Promise<PlaceHit[]>;
  /** 中心から半径の中を、種類で探す（Nearby Search）。 */
  nearby(center: { lat: number; lng: number }, radiusM: number, types: string[]): Promise<PlaceHit[]>;
  /** 1 つの場所を引き直す（名前・Web サイト・位置）。 */
  details(placeId: string): Promise<PlaceHit | null>;
}

/** Places API を使えない（鍵が無い・Places API を有効にしていない・届かない）。 */
export class PlacesUnavailableError extends Error {}

const FIELDS = ['id', 'displayName', 'websiteUri', 'location', 'primaryType', 'attributions'];

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  websiteUri?: string;
  location?: { latitude?: number; longitude?: number };
  primaryType?: string;
  attributions?: { provider?: string }[];
}

function toHit(p: RawPlace): PlaceHit | null {
  if (!p.id) return null;
  return {
    id: p.id, name: p.displayName?.text ?? '', website: p.websiteUri ?? '',
    lat: typeof p.location?.latitude === 'number' ? p.location.latitude : null,
    lng: typeof p.location?.longitude === 'number' ? p.location.longitude : null,
    primaryType: p.primaryType ?? '', attributions: (p.attributions ?? []).map((a) => a.provider ?? '').filter(Boolean),
  };
}

/** 本物の Places API（New）。 */
export class GooglePlacesClient implements PlacesClient {
  constructor(private readonly apiKey: string, private readonly base = 'https://places.googleapis.com/v1') {}

  private async call<T>(path: string, init: RequestInit, fieldMask: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey, 'x-goog-fieldmask': fieldMask, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    }).catch((err: unknown) => { throw new PlacesUnavailableError(`Google Maps に届きませんでした（${err instanceof Error ? err.message : String(err)}）`); });
    if (res.status === 403 || res.status === 401) {
      const body = await res.text().catch(() => '');
      throw new PlacesUnavailableError(/not been used|disabled|SERVICE_DISABLED/i.test(body)
        ? '会社の Google Cloud のプロジェクトで Places API（New）が有効になっていません。管理者が有効にしてください'
        : '会社の Gemini の鍵で Places API を使えません（鍵の制限を確かめてください）');
    }
    if (res.status === 404) return {} as T;
    if (!res.ok) throw new PlacesUnavailableError(`Google Maps が断りました（${res.status}）`);
    return (await res.json()) as T;
  }

  async search(query: string, near?: { lat: number; lng: number; radiusM: number }): Promise<PlaceHit[]> {
    const r = await this.call<{ places?: RawPlace[] }>('/places:searchText', {
      method: 'POST',
      body: JSON.stringify({
        textQuery: query.slice(0, 200), languageCode: 'ja', regionCode: 'JP', pageSize: 10,
        ...(near ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: Math.min(50_000, near.radiusM) } } } : {}),
      }),
    }, FIELDS.map((f) => `places.${f}`).join(','));
    return (r.places ?? []).map(toHit).filter((h): h is PlaceHit => !!h);
  }

  async nearby(center: { lat: number; lng: number }, radiusM: number, types: string[]): Promise<PlaceHit[]> {
    const r = await this.call<{ places?: RawPlace[] }>('/places:searchNearby', {
      method: 'POST',
      body: JSON.stringify({
        includedPrimaryTypes: types.slice(0, 5), maxResultCount: 20, rankPreference: 'DISTANCE', languageCode: 'ja', regionCode: 'JP',
        locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: Math.min(50_000, Math.max(100, radiusM)) } },
      }),
    }, FIELDS.map((f) => `places.${f}`).join(','));
    return (r.places ?? []).map(toHit).filter((h): h is PlaceHit => !!h);
  }

  async details(placeId: string): Promise<PlaceHit | null> {
    if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) return null;
    const r = await this.call<RawPlace>(`/places/${encodeURIComponent(placeId)}?languageCode=ja&regionCode=JP`, { method: 'GET' }, FIELDS.join(','));
    return toHit(r);
  }
}

/** 2 点の間の距離（メートル）。表示のときに計算し、残さない。 */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** 見本の場所（開発の見本の会社）。中心は見本の会社。 */
const MOCK_CENTER = { lat: 35.6812, lng: 139.7671 };

/** 見本の口で探せる場所。 */
export const MOCK_PLACES: (PlaceHit & { keywords: string[] })[] = [
  { id: 'mock-place-self-0000', name: 'アルファ商事（見本）', website: 'https://www.alpha.example.jp/', lat: MOCK_CENTER.lat, lng: MOCK_CENTER.lng, primaryType: 'store', attributions: [], keywords: ['自社', 'アルファ'] },
  { id: 'mock-place-near-0001', name: '見本の競合 A', website: 'https://shop-a.example.jp/', lat: 35.6840, lng: 139.7690, primaryType: 'store', attributions: [], keywords: ['競合', '事務用品'] },
  { id: 'mock-place-near-0002', name: '見本の競合 B', website: 'https://shop-b.example.jp/', lat: 35.6780, lng: 139.7620, primaryType: 'store', attributions: [], keywords: ['競合', '事務用品'] },
  { id: 'mock-place-far-00003', name: '見本の遠い店', website: 'https://far.example.jp/', lat: 35.9000, lng: 139.9000, primaryType: 'store', attributions: [], keywords: ['事務用品'] },
];

/** 開発の見本の会社で使う、外に出ない見本の Places API。 */
export class MockPlaces implements PlacesClient {
  async search(query: string): Promise<PlaceHit[]> {
    const q = query.toLowerCase();
    return MOCK_PLACES.filter((p) => p.keywords.some((k) => q.includes(k.toLowerCase())) || q.includes(p.name.toLowerCase()) || /丁目|番地|区|市/.test(query) && p.id.includes('self'))
      .map(({ keywords: _k, ...p }) => p);
  }

  async nearby(center: { lat: number; lng: number }, radiusM: number): Promise<PlaceHit[]> {
    return MOCK_PLACES.filter((p) => distanceM(center, { lat: p.lat!, lng: p.lng! }) <= radiusM)
      .sort((a, b) => distanceM(center, { lat: a.lat!, lng: a.lng! }) - distanceM(center, { lat: b.lat!, lng: b.lng! }))
      .map(({ keywords: _k, ...p }) => p);
  }

  async details(placeId: string): Promise<PlaceHit | null> {
    const p = MOCK_PLACES.find((x) => x.id === placeId);
    if (!p) return null;
    const { keywords: _k, ...hit } = p;
    return hit;
  }
}
