import { isFoodAliasForTier } from './food-aliases';

export const SNAPSHOT_SCHEMA_VERSION = 4 as const;
const LEGACY_SNAPSHOT_SCHEMA_VERSION = 3 as const;
export const TIER_COUNT = 5 as const;

export type Tier = 0 | 1 | 2 | 3 | 4;
export type SocialLabel = 'X' | 'Instagram' | 'TikTok';
export type SocialLink = { label: SocialLabel; url: string; handle?: string };
export type ContributingMovie = {
  rank: number;
  code: string;
  movieUrl: string;
};
export type ActressRatings = {
  looks?: number;
  body?: number;
  charm?: number;
  eroticAppeal?: number;
  overall?: number;
};
export type Actress = {
  id: string;
  sourceUrl: string;
  name: string;
  publicName: string;
  aliases: string[];
  nativeName?: string;
  nameReading?: string;
  age?: number;
  birthDate?: string;
  cup?: string;
  heightCm?: number;
  bustCm?: number;
  waistCm?: number;
  hipCm?: number;
  bloodType?: string;
  hometown?: string;
  hobby?: string;
  videoCount?: number;
  imagePath: string;
  socialLinks: SocialLink[];
  avBaseUrl?: string;
  wikipediaUrl?: string;
  minnanoAvUrl?: string;
  ratings?: ActressRatings;
  tags?: string[];
  debutYear?: number;
  score: number;
  tier: Tier;
  bestRank: number;
  appearances: number;
  contributingMovies: ContributingMovie[];
};
export type EnrichmentStats = {
  provider: 'avbase' | 'minnano-av' | 'mixed';
  attempted: number;
  matched: number;
  skipped: number;
  blocked: number;
};
export type ActressSnapshot = {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  snapshotId: string;
  createdAt: string;
  source: {
    url: string;
    orderBy: 'views-monthly';
    category: 'jav';
    pages: number;
    listEntries: number;
    uniqueMovies: number;
    enrichment: EnrichmentStats;
  };
  actresses: Actress[];
};
export type CurrentSnapshot = {
  schemaVersion:
    typeof SNAPSHOT_SCHEMA_VERSION | typeof LEGACY_SNAPSHOT_SCHEMA_VERSION;
  snapshotId: string;
  snapshotPath: string;
  createdAt: string;
};
export type RefreshStatus = {
  schemaVersion:
    typeof SNAPSHOT_SCHEMA_VERSION | typeof LEGACY_SNAPSHOT_SCHEMA_VERSION;
  state: 'idle' | 'refreshing' | 'error';
  updatedAt: string;
  message?: string;
  attempt?: number;
};

const origin = 'https://jav.guru';
export const safeText = (value: unknown, max: number) =>
  typeof value === 'string' &&
  value.trim() &&
  value.length <= max &&
  !/[\x00-\x1f\x7f]/.test(value)
    ? value.trim().normalize('NFC')
    : null;
const optionalText = (value: unknown, max: number) =>
  value === undefined ? undefined : safeText(value, max);
const optionalNumber = (value: unknown, min: number, max: number) =>
  value === undefined
    ? undefined
    : typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= min &&
        value <= max
      ? value
      : null;
const optionalFloat = (value: unknown, min: number, max: number) =>
  value === undefined
    ? undefined
    : typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= min &&
        value <= max
      ? Math.round(value * 100) / 100
      : null;
const safeIsoDate = (value: unknown) => {
  const text = safeText(value, 10);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? text
    : null;
};

export function canonicalJavUrl(value: unknown, kind: 'actress' | 'movie') {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, origin);
    if (url.protocol !== 'https:' || url.hostname !== 'jav.guru') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (kind === 'actress' && (parts.length !== 2 || parts[0] !== 'actress'))
      return null;
    if (kind === 'movie' && (!parts.length || parts[0] === 'actress'))
      return null;
    url.search = '';
    url.hash = '';
    url.pathname = `/${parts.join('/')}/`;
    return url.href;
  } catch {
    return null;
  }
}

export function canonicalAvBaseUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.avbase.net' ||
      parts.length !== 2 ||
      parts[0] !== 'talents'
    )
      return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function canonicalMinnanoAvUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      (url.hostname !== 'www.minnano-av.com' &&
        url.hostname !== 'minnano-av.com') ||
      !/^\/actress\d+\.html$/.test(url.pathname)
    )
      return null;
    url.search = '';
    url.hash = '';
    url.hostname = 'www.minnano-av.com';
    return url.href;
  } catch {
    return null;
  }
}

export function isSafeWikipediaUrl(value: unknown) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'ja.wikipedia.org' &&
      url.pathname.startsWith('/wiki/')
    );
  } catch {
    return false;
  }
}

export function isSafeLocalAsset(value: unknown) {
  return (
    typeof value === 'string' &&
    /^\/actress-cache\/snapshots\/[a-z0-9-]+\/images\/[a-z0-9-]+\.(?:jpg|jpeg|png|webp)$/i.test(
      value,
    )
  );
}

const socialHosts: Record<SocialLabel, readonly string[]> = {
  X: ['x.com', 'www.x.com'],
  Instagram: ['instagram.com', 'www.instagram.com'],
  TikTok: ['tiktok.com', 'www.tiktok.com'],
};
export function isSafeSocialLink(value: unknown, label?: SocialLabel) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const allowed = label
      ? socialHosts[label]
      : Object.values(socialHosts).flat();
    return url.protocol === 'https:' && allowed.includes(url.hostname);
  } catch {
    return false;
  }
}

function parseSocialLinks(value: unknown): SocialLink[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const links: SocialLink[] = [];
  const seen = new Map<string, number>();
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    const label = row.label;
    if (label !== 'X' && label !== 'Instagram' && label !== 'TikTok')
      return null;
    if (!isSafeSocialLink(row.url, label)) return null;
    const handle = optionalText(row.handle, 100);
    if (handle === null) return null;
    const url = row.url as string;
    const key = `${label}:${url.trim().toLowerCase().replace(/\/+$/, '')}`;
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      if (!links[existingIndex].handle && handle) {
        links[existingIndex] = { label, url, handle };
      }
    } else {
      seen.set(key, links.length);
      links.push({ label, url, ...(handle ? { handle } : {}) });
    }
  }
  return links;
}

function parseEnrichment(value: unknown): EnrichmentStats | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (
    row.provider !== 'avbase' &&
    row.provider !== 'minnano-av' &&
    row.provider !== 'mixed'
  )
    return null;
  const attempted = optionalNumber(row.attempted, 0, 2_500);
  const matched = optionalNumber(row.matched, 0, 500);
  const skipped = optionalNumber(row.skipped, 0, 500);
  const blocked = optionalNumber(row.blocked, 0, 2_500);
  return attempted === null ||
    matched === null ||
    skipped === null ||
    blocked === null
    ? null
    : {
        provider: row.provider as 'avbase' | 'minnano-av' | 'mixed',
        attempted: attempted ?? 0,
        matched: matched ?? 0,
        skipped: skipped ?? 0,
        blocked: blocked ?? 0,
      };
}

function parseRatings(value: unknown): ActressRatings | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const looks = optionalFloat(row.looks, 0, 10);
  const body = optionalFloat(row.body, 0, 10);
  const charm = optionalFloat(row.charm, 0, 10);
  const eroticAppeal = optionalFloat(row.eroticAppeal, 0, 10);
  const overall = optionalFloat(row.overall, 0, 10);
  if (
    looks === null ||
    body === null ||
    charm === null ||
    eroticAppeal === null ||
    overall === null
  )
    return null;
  if (
    looks === undefined &&
    body === undefined &&
    charm === undefined &&
    eroticAppeal === undefined &&
    overall === undefined
  )
    return undefined;
  return {
    ...(looks !== undefined ? { looks } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(charm !== undefined ? { charm } : {}),
    ...(eroticAppeal !== undefined ? { eroticAppeal } : {}),
    ...(overall !== undefined ? { overall } : {}),
  };
}

function parseTags(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) return null;
  const tags: string[] = [];
  for (const item of value) {
    const text = safeText(item, 80);
    if (!text) return null;
    tags.push(text);
  }
  return tags;
}

export function validateSnapshot(input: unknown): ActressSnapshot | null {
  if (!input || typeof input !== 'object') return null;
  const snapshot = input as Record<string, unknown>;
  const isLegacy = snapshot.schemaVersion === LEGACY_SNAPSHOT_SCHEMA_VERSION;
  if (
    !isSnapshotVersion(snapshot.schemaVersion) ||
    !safeText(snapshot.snapshotId, 80) ||
    !safeText(snapshot.createdAt, 40) ||
    !snapshot.source ||
    !Array.isArray(snapshot.actresses) ||
    !snapshot.actresses.length ||
    snapshot.actresses.length > 500
  )
    return null;
  const source = snapshot.source as Record<string, unknown>;
  if (
    source.url !==
      'https://jav.guru/?s=&orderby=views-monthly&order=DESC&category_name=jav' ||
    source.orderBy !== 'views-monthly' ||
    source.category !== 'jav' ||
    source.pages !== 3 ||
    !Number.isSafeInteger(source.listEntries) ||
    !Number.isSafeInteger(source.uniqueMovies)
  )
    return null;
  const enrichment = isLegacy
    ? {
        provider: 'avbase' as const,
        attempted: 0,
        matched: 0,
        skipped: 0,
        blocked: 0,
      }
    : parseEnrichment(source.enrichment);
  if (!enrichment) return null;

  const ids = new Set<string>();
  const actresses: Actress[] = [];
  for (const item of snapshot.actresses) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    const id = safeText(row.id, 100);
    const name = safeText(row.name, 120);
    const publicName = safeText(row.publicName, 120);
    const sourceUrl = canonicalJavUrl(row.sourceUrl, 'actress');
    if (
      !id ||
      ids.has(id) ||
      !name ||
      !publicName ||
      !sourceUrl ||
      !Array.isArray(row.aliases) ||
      !Array.isArray(row.contributingMovies) ||
      typeof row.score !== 'number' ||
      !Number.isFinite(row.score) ||
      typeof row.tier !== 'number' ||
      !Number.isInteger(row.tier) ||
      row.tier < 0 ||
      row.tier >= TIER_COUNT ||
      typeof row.bestRank !== 'number' ||
      !Number.isSafeInteger(row.bestRank) ||
      row.bestRank < 1 ||
      typeof row.appearances !== 'number' ||
      !Number.isSafeInteger(row.appearances) ||
      row.appearances < 1
    )
      return null;
    if (!isFoodAliasForTier(publicName, row.tier as Tier)) return null;
    const aliases = row.aliases
      .map((x) => safeText(x, 120))
      .filter(Boolean) as string[];
    if (aliases.length > 20 || aliases.some((x) => x === name)) return null;
    const socialLinks = parseSocialLinks(row.socialLinks);
    if (!socialLinks) return null;
    const contributingMovies = row.contributingMovies.map((movie) => {
      if (!movie || typeof movie !== 'object') return null;
      const parsed = movie as Record<string, unknown>;
      const code = safeText(parsed.code, 80);
      const movieUrl = canonicalJavUrl(parsed.movieUrl, 'movie');
      return Number.isSafeInteger(parsed.rank) &&
        (parsed.rank as number) >= 1 &&
        code &&
        movieUrl
        ? { rank: parsed.rank as number, code, movieUrl }
        : null;
    });
    if (
      !contributingMovies.length ||
      contributingMovies.some((x) => !x) ||
      contributingMovies.length > 60
    )
      return null;
    const age = optionalNumber(row.age, 18, 100);
    const heightCm = optionalNumber(row.heightCm, 100, 250);
    const videoCount = optionalNumber(row.videoCount, 0, 100_000);
    const bustCm = optionalNumber(row.bustCm, 40, 180);
    const waistCm = optionalNumber(row.waistCm, 30, 150);
    const hipCm = optionalNumber(row.hipCm, 40, 180);
    const cup = optionalText(row.cup, 20);
    const nativeName = optionalText(row.nativeName, 120);
    const nameReading = optionalText(row.nameReading, 120);
    const bloodType = optionalText(row.bloodType, 10);
    const hometown = optionalText(row.hometown, 120);
    const hobby = optionalText(row.hobby, 300);
    const birthDate =
      row.birthDate === undefined ? undefined : safeIsoDate(row.birthDate);
    const avBaseUrl =
      row.avBaseUrl === undefined
        ? undefined
        : canonicalAvBaseUrl(row.avBaseUrl);
    const wikipediaUrl =
      row.wikipediaUrl === undefined
        ? undefined
        : typeof row.wikipediaUrl === 'string' &&
            isSafeWikipediaUrl(row.wikipediaUrl)
          ? row.wikipediaUrl
          : null;
    const minnanoAvUrl =
      row.minnanoAvUrl === undefined
        ? undefined
        : canonicalMinnanoAvUrl(row.minnanoAvUrl);
    const debutYear = optionalNumber(row.debutYear, 1980, 2035);
    const ratings = parseRatings(row.ratings);
    const tags = parseTags(row.tags);
    if (
      [
        age,
        heightCm,
        videoCount,
        bustCm,
        waistCm,
        hipCm,
        cup,
        nativeName,
        nameReading,
        bloodType,
        hometown,
        hobby,
        birthDate,
        avBaseUrl,
        wikipediaUrl,
        minnanoAvUrl,
        debutYear,
        ratings,
        tags,
      ].some((value) => value === null) ||
      !isSafeLocalAsset(row.imagePath)
    )
      return null;
    ids.add(id);
    actresses.push({
      id,
      sourceUrl,
      name,
      publicName,
      aliases,
      ...(nativeName ? { nativeName } : {}),
      ...(nameReading ? { nameReading } : {}),
      ...(age != null ? { age } : {}),
      ...(birthDate ? { birthDate } : {}),
      ...(cup ? { cup } : {}),
      ...(heightCm != null ? { heightCm } : {}),
      ...(bustCm != null ? { bustCm } : {}),
      ...(waistCm != null ? { waistCm } : {}),
      ...(hipCm != null ? { hipCm } : {}),
      ...(bloodType ? { bloodType } : {}),
      ...(hometown ? { hometown } : {}),
      ...(hobby ? { hobby } : {}),
      ...(videoCount != null ? { videoCount } : {}),
      imagePath: row.imagePath as string,
      socialLinks,
      ...(avBaseUrl ? { avBaseUrl } : {}),
      ...(wikipediaUrl ? { wikipediaUrl } : {}),
      ...(minnanoAvUrl ? { minnanoAvUrl } : {}),
      ...(ratings ? { ratings } : {}),
      ...(tags && tags.length ? { tags } : {}),
      ...(debutYear != null ? { debutYear } : {}),
      score: row.score as number,
      tier: row.tier as Tier,
      bestRank: row.bestRank as number,
      appearances: row.appearances as number,
      contributingMovies: contributingMovies as ContributingMovie[],
    });
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: snapshot.snapshotId as string,
    createdAt: snapshot.createdAt as string,
    source: {
      url: source.url as ActressSnapshot['source']['url'],
      orderBy: 'views-monthly',
      category: 'jav',
      pages: 3,
      listEntries: source.listEntries as number,
      uniqueMovies: source.uniqueMovies as number,
      enrichment,
    },
    actresses,
  };
}

export const ACTRESS_CACHE_ROOT = '/actress-cache';
export const isValidSnapshotId = (id: string) => /^[a-z0-9-]{1,80}$/i.test(id);
export const snapshotPathFor = (id: string) =>
  `${ACTRESS_CACHE_ROOT}/snapshots/${id}/snapshot.json`;

function isSnapshotVersion(
  value: unknown,
): value is CurrentSnapshot['schemaVersion'] {
  return (
    value === SNAPSHOT_SCHEMA_VERSION ||
    value === LEGACY_SNAPSHOT_SCHEMA_VERSION
  );
}

export function validateStatus(input: unknown): RefreshStatus | null {
  if (!input || typeof input !== 'object') return null;
  const status = input as Record<string, unknown>;
  if (
    !isSnapshotVersion(status.schemaVersion) ||
    (status.state !== 'idle' &&
      status.state !== 'refreshing' &&
      status.state !== 'error') ||
    typeof status.updatedAt !== 'string'
  )
    return null;
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    state: status.state,
    updatedAt: status.updatedAt,
    message:
      typeof status.message === 'string'
        ? status.message.slice(0, 280)
        : undefined,
    attempt: Number.isSafeInteger(status.attempt)
      ? Number(status.attempt)
      : undefined,
  };
}

export function validateCurrent(input: unknown): CurrentSnapshot | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  const snapshotId = safeText(value.snapshotId, 80);
  const { schemaVersion, snapshotPath, createdAt } = value;
  if (
    !isSnapshotVersion(schemaVersion) ||
    !snapshotId ||
    !isValidSnapshotId(snapshotId) ||
    snapshotPath !== snapshotPathFor(snapshotId) ||
    typeof createdAt !== 'string' ||
    !safeText(createdAt, 40) ||
    !Number.isFinite(Date.parse(createdAt))
  )
    return null;
  return { schemaVersion, snapshotId, snapshotPath, createdAt };
}

export const tierNames = [
  'MIL-SPEC',
  'RESTRICTED',
  'CLASSIFIED',
  'COVERT',
  '★ SPECIAL ITEM',
] as const;
