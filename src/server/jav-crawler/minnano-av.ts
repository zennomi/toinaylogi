import type { ActressRatings } from '@/lib/actresses';
import type { ParsedProfile } from './parser';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

export type MinnanoAvProfile = {
  name: string;
  url: string;
  ratings?: ActressRatings;
  tags: string[];
  debutYear?: number;
};

export type MinnanoAvLookup =
  | { kind: 'matched'; profile: MinnanoAvProfile; url: string }
  | { kind: 'not-found' }
  | { kind: 'unavailable'; message: string };

export type MinnanoAvEnrichmentStats = {
  provider: 'minnano-av';
  attempted: number;
  matched: number;
  skipped: number;
  blocked: number;
};

const CRITERIA_MAP: Record<string, keyof ActressRatings> = {
  ルックス: 'looks',
  カラダ: 'body',
  魅力: 'charm',
  ヌケる: 'eroticAppeal',
  総合評価: 'overall',
};

/**
 * Normalizes text for strict identity comparison:
 * Handles Unicode NFKC, macrons (e.g. Yūki -> Yuki), case, spaces, and punctuation.
 */
export function normalizeName(s: string): string {
  return (s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[āáǎà]/g, 'a')
    .replace(/[ēéěè]/g, 'e')
    .replace(/[īíǐì]/g, 'i')
    .replace(/[ōóǒòūúǔù]/g, (m) =>
      m === 'ū' || m === 'ú' || m === 'ǔ' || m === 'ù' ? 'u' : 'o',
    )
    .replace(/[\s\-_・\(\)（）\/\\【】「」]/g, '');
}

export type MinnanoIdentity = {
  h1: string;
  cleanTitleName: string;
  romajiName: string;
  aliases: string[];
  normalizedNames: string[];
};

export function extractMinnanoIdentity(html: string): MinnanoIdentity | null {
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!h1Match) return null;
  const h1 = h1Match[1].replace(/<[^>]+>/g, '').trim();
  const [left, right] = h1.split('/').map((s) => (s ? s.trim() : ''));

  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1]
        .replace(/\s*[-–—]?\s*AV女優プロフィール[\s\S]*/i, '')
        .replace(/\s*[-–—]?\s*みんなのAV[\s\S]*/i, '')
        .trim()
    : '';

  const cleanTitleName = title
    .replace(/（[^）]*）|\([^\)]*\)|【[^】]*】/g, '')
    .trim();

  const aliasBlocks = [...html.matchAll(/別名\s*([^<\r\n]+)/g)].map((m) =>
    m[1].replace(/（[^）]*）|\([^\)]*\)|【[^】]*】/g, '').trim(),
  );

  const allNames = [cleanTitleName, left, right, ...aliasBlocks].filter(
    Boolean,
  );

  return {
    h1,
    cleanTitleName: cleanTitleName || left,
    romajiName: right || '',
    aliases: aliasBlocks,
    normalizedNames: allNames.map(normalizeName).filter(Boolean),
  };
}

export function matchesIdentity(
  candidates: string[],
  identity: MinnanoIdentity,
): boolean {
  for (const candidate of candidates) {
    const norm = normalizeName(candidate);
    if (!norm) continue;
    if (identity.normalizedNames.includes(norm)) {
      return true;
    }
  }
  return false;
}

export function parseMinnanoAvProfile(
  html: string,
  pageUrl: string,
): MinnanoAvProfile {
  // 1. Actress Name
  const identity = extractMinnanoIdentity(html);
  const name = identity?.cleanTitleName || identity?.romajiName || 'Unknown';

  // 2. Quantitative Ratings (table.rate-table)
  const ratings: ActressRatings = {};
  const rateTableMatch = html.match(
    /<table[^>]*class=["'][^"']*rate-table[^"']*["'][\s\S]*?<\/table>/i,
  );
  if (rateTableMatch) {
    const rows = [...rateTableMatch[0].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)];
    for (const row of rows) {
      const cols = [
        ...row[1].matchAll(/<td class="t9">([\s\S]*?)<\/td>/gi),
      ].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
      if (cols.length >= 2) {
        const [rawCriteria, scoreStr] = cols;
        const key = CRITERIA_MAP[rawCriteria];
        const num = parseFloat(scoreStr);
        if (key && !Number.isNaN(num) && num >= 0 && num <= 10) {
          ratings[key] = Math.round(num * 100) / 100;
        }
      }
    }
  }

  // 3. Tags (<div class="tagarea">) - store original text for tags
  const rawTags: string[] = [];
  const tagAreaMatch = html.match(/<div class="tagarea">([\s\S]*?)<\/div>/i);
  if (tagAreaMatch) {
    const linkMatches = [
      ...tagAreaMatch[1].matchAll(/<a[^>]*>([^<]+)<\/a>/g),
    ].map((m) => m[1].trim());
    rawTags.push(...linkMatches);
  }

  const tags = [...new Set(rawTags.map((t) => t.trim()).filter(Boolean))];

  // 4. Debut Year
  let debutYear: number | undefined;
  const debutWorkMatch = html.match(
    /<span>デビュー作品<\/span>[\s\S]*?（(\d{4})年/i,
  );
  if (debutWorkMatch) {
    const parsed = parseInt(debutWorkMatch[1], 10);
    if (!Number.isNaN(parsed) && parsed >= 1980 && parsed <= 2035) {
      debutYear = parsed;
    }
  }
  if (!debutYear) {
    const periodMatch = html.match(
      /<span>AV出演期間<\/span>[\s\S]*?(\d{4})年/i,
    );
    if (periodMatch) {
      const parsed = parseInt(periodMatch[1], 10);
      if (!Number.isNaN(parsed) && parsed >= 1980 && parsed <= 2035) {
        debutYear = parsed;
      }
    }
  }

  const hasAnyRating = Object.keys(ratings).length > 0;

  return {
    name,
    url: pageUrl,
    ratings: hasAnyRating ? ratings : undefined,
    tags,
    debutYear,
  };
}

let sessionCookie: string | null = null;

class MinnanoUnavailableError extends Error {}

async function fetchPage(
  url: string,
): Promise<{ url: string; html: string } | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
    if (sessionCookie) {
      headers['Cookie'] = sessionCookie;
    }
    const res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/PHPSESSID=[^;]+/);
      if (match) {
        sessionCookie = match[0];
      }
    }
    // A genuine missing page is a miss; blocked/failed requests are not.
    // Propagating outages prevents them from becoming cached negative lookups.
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok)
      throw new MinnanoUnavailableError(`Minnano-AV HTTP ${res.status}`);
    const html = await res.text();
    if (/<title>\s*(?:Just a moment|Attention Required)/i.test(html)) {
      throw new MinnanoUnavailableError('Minnano-AV challenge page');
    }
    return { url: res.url, html };
  } catch (error) {
    if (error instanceof MinnanoUnavailableError) throw error;
    throw new MinnanoUnavailableError(
      error instanceof Error ? error.message : 'Minnano-AV request failed',
    );
  }
}

export type MinnanoActressEntry = {
  url: string;
  name: string;
  furi: string;
  romaji: string;
  normalizedNames: string[];
  tags: string[];
  debutYear?: number;
};

export type GojuonPageResult = {
  totalPages: number;
  items: MinnanoActressEntry[];
};

export type MinnanoCacheStats = {
  directorySize: number;
  cachedPages: number;
  cachedProfiles: number;
  resolvedLookups: number;
};

export const HIRA_TO_GOJUON: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  ざ: 'za', じ: 'zi', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  だ: 'da', ぢ: 'di', づ: 'du', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'hu', へ: 'he', ほ: 'ho',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', を: 'wo', ん: 'n',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
  ゃ: 'ya', ゅ: 'yu', ょ: 'yo', っ: 'tsu',
};

export function katakanaToHiragana(src: string): string {
  return src.replace(/[\u30a1-\u30f6]/g, (match) =>
    String.fromCharCode(match.charCodeAt(0) - 0x60),
  );
}

export function extractGojuonSyllables(terms: string[]): string[] {
  const syllables = new Set<string>();
  for (const term of terms) {
    if (!term) continue;
    const clean = term.trim();
    const hira = katakanaToHiragana(clean);
    if (hira.length > 0 && HIRA_TO_GOJUON[hira[0]]) {
      syllables.add(HIRA_TO_GOJUON[hira[0]]);
    }
    const words = clean.split(/[\s\-_・\/]+/);
    for (const w of words) {
      const m = w
        .toLowerCase()
        .match(
          /^(chi|tsu|shi|hu|fu|zi|ji|[kgstnhmryrwgzdbp][aeiou]|[aeiou])/,
        );
      if (m) {
        let syl = m[1];
        if (syl === 'fu') syl = 'hu';
        if (syl === 'ji') syl = 'zi';
        if (syl === 'si') syl = 'shi';
        if (syl === 'ti') syl = 'chi';
        if (syl === 'tu') syl = 'tsu';
        syllables.add(syl);
      }
    }
  }
  return [...syllables];
}

export function extractTargetKanaForSyllable(
  terms: string[],
  syllable: string,
): string | undefined {
  for (const term of terms) {
    if (!term) continue;
    const clean = term.trim().replace(/[\s\-_・]/g, '');
    const hira = katakanaToHiragana(clean);
    if (/^[\u3040-\u309f]+$/.test(hira) && hira.length > 0) {
      if (HIRA_TO_GOJUON[hira[0]] === syllable) {
        return hira;
      }
    }
  }
  return undefined;
}

export function extractTargetKana(terms: string[]): string | undefined {
  for (const term of terms) {
    if (!term) continue;
    const hira = katakanaToHiragana(term.trim().replace(/[\s\-_・]/g, ''));
    if (/^[\u3040-\u309f]+$/.test(hira)) {
      return hira;
    }
  }
  return undefined;
}

// In-memory caches for fast reuse across actress queries
const actressDirectoryCache = new Map<string, MinnanoActressEntry>();
const pageListingCache = new Map<string, GojuonPageResult>();
const profileCache = new Map<string, MinnanoAvProfile>();
const resolvedLookupCache = new Map<string, MinnanoAvProfile | null>();

export function clearMinnanoAvCache(): void {
  actressDirectoryCache.clear();
  pageListingCache.clear();
  profileCache.clear();
  resolvedLookupCache.clear();
}

export function getMinnanoAvCacheStats(): MinnanoCacheStats {
  return {
    directorySize: actressDirectoryCache.size,
    cachedPages: pageListingCache.size,
    cachedProfiles: profileCache.size,
    resolvedLookups: resolvedLookupCache.size,
  };
}

export async function fetchGojuonPage(
  syllable: string,
  page: number,
): Promise<GojuonPageResult | null> {
  const cacheKey = `${syllable}:${page}`;
  if (pageListingCache.has(cacheKey)) {
    return pageListingCache.get(cacheKey)!;
  }

  const url = `https://www.minnano-av.com/actress_list.php?gojuon=${encodeURIComponent(syllable)}&sort=name&page=${page}`;
  const response = await fetchPage(url);
  if (!response) return null;

  const m = response.html.match(/(\d+)\s*\/\s*(\d+)\s*ページ/);
  const totalPages = m ? parseInt(m[2], 10) : 1;

  const items: MinnanoActressEntry[] = [];
  const regex =
    /<h2 class="ttl"><a href="([^"]*actress\d+\.html)"[^>]*>([^<]+)<\/a><\/h2>[\s\S]*?<p class="furi">([^<]+)<\/p>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(response.html)) !== null) {
    const rawUrl = match[1].startsWith('http')
      ? match[1]
      : `https://www.minnano-av.com/${match[1].replace(/^\/+/, '')}`;
    const title = match[2].trim();
    const cleanTitle = title
      .replace(/（[^）]*）|\([^\)]*\)|【[^】]*】/g, '')
      .trim();
    const [furiHiragana, furiRomaji] = match[3]
      .split('/')
      .map((s) => (s ? s.trim() : ''));

    const normalizedNames = [
      normalizeName(title),
      normalizeName(cleanTitle),
      normalizeName(furiHiragana || ''),
      normalizeName(furiRomaji || ''),
    ].filter(Boolean);

    const entry: MinnanoActressEntry = {
      url: rawUrl,
      name: cleanTitle || title,
      furi: furiHiragana || '',
      romaji: furiRomaji || '',
      normalizedNames,
      tags: [],
    };

    items.push(entry);

    for (const norm of normalizedNames) {
      if (!actressDirectoryCache.has(norm)) {
        actressDirectoryCache.set(norm, entry);
      }
    }
  }

  const result: GojuonPageResult = { totalPages, items };
  pageListingCache.set(cacheKey, result);
  return result;
}

async function resolveProfileFromUrl(
  url: string,
  candidates: string[],
): Promise<MinnanoAvProfile | null> {
  if (profileCache.has(url)) {
    return profileCache.get(url)!;
  }

  const page = await fetchPage(url);
  if (!page) return null;

  const identity = extractMinnanoIdentity(page.html);
  if (identity && matchesIdentity(candidates, identity)) {
    const profile = parseMinnanoAvProfile(page.html, url);
    profileCache.set(url, profile);
    return profile;
  }

  return null;
}

async function findInGojuonSyllable(
  syllable: string,
  normalizedCandidates: string[],
  targetKana: string | undefined,
  rawCandidates: string[],
): Promise<MinnanoAvProfile | null> {
  const page1 = await fetchGojuonPage(syllable, 1);
  if (!page1 || page1.items.length === 0) return null;

  // 1. Check page 1
  const matched1 = page1.items.find((it) =>
    it.normalizedNames.some((n) => normalizedCandidates.includes(n)),
  );
  if (matched1) {
    const prof = await resolveProfileFromUrl(matched1.url, rawCandidates);
    if (prof) return prof;
  }

  if (page1.totalPages <= 1) return null;

  // 2. Binary search across pages if targetKana is available
  if (targetKana) {
    let L = 2;
    let R = page1.totalPages;

    while (L <= R) {
      const M = Math.floor((L + R) / 2);
      const pageM = await fetchGojuonPage(syllable, M);
      if (!pageM || pageM.items.length === 0) break;

      const matchedM = pageM.items.find((it) =>
        it.normalizedNames.some((n) => normalizedCandidates.includes(n)),
      );
      if (matchedM) {
        const prof = await resolveProfileFromUrl(matchedM.url, rawCandidates);
        if (prof) return prof;
      }

      const firstFuri = pageM.items[0].furi.replace(/[\s\-_・]/g, '');
      const lastFuri = pageM.items[pageM.items.length - 1].furi.replace(
        /[\s\-_・]/g,
        '',
      );

      const cmpFirst = targetKana.localeCompare(firstFuri, 'ja');
      const cmpLast = targetKana.localeCompare(lastFuri, 'ja');

      if (cmpFirst < 0) {
        R = M - 1;
      } else if (cmpLast > 0) {
        L = M + 1;
      } else {
        // targetKana is alphabetically within page M, check adjacent pages just in case
        for (const adj of [M - 1, M + 1]) {
          if (adj >= 2 && adj <= page1.totalPages) {
            const pageAdj = await fetchGojuonPage(syllable, adj);
            const matchedAdj = pageAdj?.items.find((it) =>
              it.normalizedNames.some((n) => normalizedCandidates.includes(n)),
            );
            if (matchedAdj) {
              const prof = await resolveProfileFromUrl(
                matchedAdj.url,
                rawCandidates,
              );
              if (prof) return prof;
            }
          }
        }
        break;
      }
    }
  } else {
    // If no kana reading, for small syllables (<= 5 pages), scan remaining pages
    if (page1.totalPages <= 5) {
      for (let p = 2; p <= page1.totalPages; p++) {
        const pageP = await fetchGojuonPage(syllable, p);
        const matchedP = pageP?.items.find((it) =>
          it.normalizedNames.some((n) => normalizedCandidates.includes(n)),
        );
        if (matchedP) {
          const prof = await resolveProfileFromUrl(matchedP.url, rawCandidates);
          if (prof) return prof;
        }
      }
    }
  }

  return null;
}

/**
 * Searches Minnano-AV for an actress using Gojuon syllabary index (Method 1)
 * with in-memory caching to bypass Cloudflare protection on search_result.php.
 * Ensures strict identity verification to avoid substring mismatches.
 */
export async function searchMinnanoAv(
  query: string,
  candidates: string[],
): Promise<MinnanoAvProfile | null> {
  const clean = query.trim();
  if (!clean && candidates.length === 0) return null;

  const allTerms = [clean, ...candidates].filter(Boolean);
  const normalizedCandidates = allTerms.map(normalizeName).filter(Boolean);
  if (normalizedCandidates.length === 0) return null;

  // 1. Check resolved lookup cache
  for (const norm of normalizedCandidates) {
    if (resolvedLookupCache.has(norm)) {
      return resolvedLookupCache.get(norm)!;
    }
  }

  // 2. Check in-memory actress directory
  for (const norm of normalizedCandidates) {
    const directoryEntry = actressDirectoryCache.get(norm);
    if (directoryEntry) {
      const prof = await resolveProfileFromUrl(directoryEntry.url, allTerms);
      if (prof) {
        for (const n of normalizedCandidates) {
          resolvedLookupCache.set(n, prof);
        }
        return prof;
      }
    }
  }

  // 3. Extract Gojuon syllables and target Kana
  const syllables = extractGojuonSyllables(allTerms);
  const targetKana = extractTargetKana(allTerms);

  // 4. Search in Gojuon syllables
  for (const syl of syllables) {
    const syllableTargetKana =
      extractTargetKanaForSyllable(allTerms, syl) || targetKana;
    const prof = await findInGojuonSyllable(
      syl,
      normalizedCandidates,
      syllableTargetKana && HIRA_TO_GOJUON[syllableTargetKana[0]] === syl
        ? syllableTargetKana
        : undefined,
      allTerms,
    );
    if (prof) {
      for (const n of normalizedCandidates) {
        resolvedLookupCache.set(n, prof);
      }
      return prof;
    }
  }

  // Cache negative result so we don't repeat failed network lookups
  for (const n of normalizedCandidates) {
    resolvedLookupCache.set(n, null);
  }
  return null;
}

export function mergeMinnanoAvProfile(
  base: ParsedProfile,
  minnano: MinnanoAvProfile,
  minnanoAvUrl: string,
): ParsedProfile {
  return {
    ...base,
    minnanoAvUrl,
    ratings: minnano.ratings ?? base.ratings,
    tags: minnano.tags.length ? minnano.tags : base.tags,
    debutYear: minnano.debutYear ?? base.debutYear,
  };
}

export function createMinnanoAvEnricher({
  refreshCache = false,
}: { refreshCache?: boolean } = {}) {
  // Reset once at the start of a locked refresh, not between profile lookups.
  // Matches, misses, and directory pages must not outlive that refresh cycle.
  if (refreshCache) clearMinnanoAvCache();

  const stats: MinnanoAvEnrichmentStats = {
    provider: 'minnano-av',
    attempted: 0,
    matched: 0,
    skipped: 0,
    blocked: 0,
  };
  let circuitOpen = false;

  const lookup = async (
    profile: Pick<
      ParsedProfile,
      'name' | 'aliases' | 'nativeName' | 'nameReading'
    >,
  ): Promise<MinnanoAvLookup> => {
    if (circuitOpen) {
      stats.skipped++;
      return {
        kind: 'unavailable',
        message: 'Minnano-AV circuit breaker open',
      };
    }

    // Candidate search terms in order of priority:
    // 1. Japanese nativeName (e.g. "彩月七緒", "めぐり")
    // 2. English / Romaji name (e.g. "Satsuki Nao", "MINAMO")
    // 3. Hiragana ruby (e.g. "さつきなお")
    // 4. Aliases (e.g. "藤浦めぐ")
    const searchTerms = [
      profile.nativeName,
      profile.name,
      profile.nameReading,
      ...profile.aliases,
    ]
      .filter((v): v is string => Boolean(v && typeof v === 'string'))
      .map((v) => v.trim())
      .filter((v, i, arr) => v.length > 1 && arr.indexOf(v) === i);

    const allCandidates = [
      profile.nativeName,
      profile.name,
      profile.nameReading,
      ...profile.aliases,
    ].filter((v): v is string => Boolean(v && typeof v === 'string'));

    for (const term of searchTerms) {
      stats.attempted++;
      try {
        const found = await searchMinnanoAv(term, allCandidates);
        if (found) {
          stats.matched++;
          return { kind: 'matched', profile: found, url: found.url };
        }
      } catch (error) {
        circuitOpen = true;
        stats.blocked++;
        return {
          kind: 'unavailable',
          message:
            error instanceof Error ? error.message : 'Minnano-AV request failed',
        };
      }
    }

    stats.skipped++;
    return { kind: 'not-found' };
  };

  return { lookup, stats };
}
