import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SNAPSHOT_SCHEMA_VERSION, type ActressSnapshot } from '@/lib/actresses';
import { assignFoodAliases, createSeededRandom } from '@/lib/food-aliases';
import { fetchHtml, fetchImage, mapLimit, safeImageUrl } from './fetch';
import { createAvBaseEnricher, mergeAvBaseProfile } from './avbase';
import { createMinnanoAvEnricher, mergeMinnanoAvProfile } from './minnano-av';
import {
  isSingleActressMovie,
  parseActressProfile,
  parseMovieActressUrls,
  parseRankingPage,
  type RankedMovie,
  type SingleActressMovie,
} from './parser';
import {
  assignTiers,
  profilesWithImages,
  type ProfileWithMovies,
} from './scoring';
import { makeStaging, publishSnapshot, takeLock, writeStatus } from './store';

const rankingUrl = (page: number) =>
  page === 1
    ? 'https://jav.guru/?s=&orderby=views-monthly&order=DESC&category_name=jav'
    : `https://jav.guru/page/${page}/?s=&orderby=views-monthly&order=DESC&category_name=jav`;
const extensionFor = (contentType: string) =>
  contentType.includes('png')
    ? 'png'
    : contentType.includes('webp')
      ? 'webp'
      : 'jpg';

export async function refreshActressData(force = false) {
  let release: (() => Promise<void>) | null = null;
  let staging = '';
  let success = false;
  try {
    release = await takeLock();
    if (!release) return false;
    await writeStatus({
      state: 'refreshing',
      message: 'Fetching ranking pages',
    });
    const rankingPages: RankedMovie[][] = [];
    let nextRank = 1;
    for (const page of [1, 2, 3, 4, 5, 6, 7]) {
      const movies = parseRankingPage(
        await fetchHtml(rankingUrl(page)),
        nextRank,
      );
      rankingPages.push(movies);
      nextRank += movies.length;
    }
    const discovered = rankingPages.flat();
    if (discovered.length < 45)
      throw new Error(`Incomplete ranking: ${discovered.length} cards`);
    const uniqueMovies = [
      ...discovered
        .reduce((movies, movie) => {
          const existing = movies.get(movie.url);
          if (!existing || movie.rank < existing.rank)
            movies.set(movie.url, movie);
          return movies;
        }, new Map<string, RankedMovie>())
        .values(),
    ];
    await writeStatus({
      state: 'refreshing',
      message: `Reading ${uniqueMovies.length} movie pages`,
    });
    const movieActresses = await mapLimit(uniqueMovies, 2, async (movie) => {
      try {
        const actressUrls = parseMovieActressUrls(await fetchHtml(movie.url));
        return { movie, actressUrls };
      } catch (error) {
        console.warn(
          `[jav-crawler] Skipping movie ${movie.code}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { movie, actressUrls: [] };
      }
    });

    const singleActressMovies: SingleActressMovie[] = [];
    for (const item of movieActresses) {
      if (isSingleActressMovie(item)) {
        singleActressMovies.push(item);
      } else if (item.actressUrls.length >= 2) {
        console.info(
          `[jav-crawler] Skipping multi-actress movie ${item.movie.code} (${item.movie.url}): has ${item.actressUrls.length} actresses`,
        );
      } else {
        console.info(
          `[jav-crawler] Skipping movie ${item.movie.code} (${item.movie.url}): no actress found`,
        );
      }
    }

    const actressesToMovies = new Map<string, RankedMovie[]>();
    singleActressMovies.forEach(({ movie, actressUrls: [actressUrl] }) => {
      const list = actressesToMovies.get(actressUrl) ?? [];
      list.push(movie);
      actressesToMovies.set(actressUrl, list);
    });
    if (!actressesToMovies.size) throw new Error('No actresses discovered');
    const snapshotId = `${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}-${randomUUID().slice(0, 8)}`;
    staging = await makeStaging(snapshotId);
    await writeStatus({
      state: 'refreshing',
      message: `Reading ${actressesToMovies.size} actress profiles`,
    });
    const avbase = createAvBaseEnricher();
    const minnano = createMinnanoAvEnricher({ refreshCache: true });
    const profiles = await mapLimit(
      [...actressesToMovies.entries()],
      2,
      async ([sourceUrl, movies]) => {
        const javProfile = parseActressProfile(
          await fetchHtml(sourceUrl),
          sourceUrl,
        );
        const enriched = await avbase.lookup(javProfile);
        let profile =
          enriched.kind === 'matched'
            ? mergeAvBaseProfile(javProfile, enriched.profile, enriched.url)
            : javProfile;
        if (enriched.kind === 'unavailable' || enriched.kind === 'malformed')
          console.warn(`[jav-crawler] AvBase: ${enriched.message}`);

        const minnanoEnriched = await minnano.lookup(profile);
        if (minnanoEnriched.kind === 'matched') {
          profile = mergeMinnanoAvProfile(
            profile,
            minnanoEnriched.profile,
            minnanoEnriched.url,
          );
        } else if (minnanoEnriched.kind === 'unavailable') {
          console.warn(`[jav-crawler] Minnano-AV: ${minnanoEnriched.message}`);
        }

        const imageUrls = [...new Set([profile.imageUrl, javProfile.imageUrl])]
          .filter((value): value is string => typeof value === 'string')
          .map(safeImageUrl)
          .filter((value): value is URL => Boolean(value));
        for (const image of imageUrls) {
          try {
            const download = await fetchImage(image.href);
            const filename = `${profile.id}.${extensionFor(download.contentType)}`;
            await writeFile(join(staging, 'images', filename), download.bytes);
            return {
              ...profile,
              movies,
              imagePath: `/actress-cache/snapshots/${snapshotId}/images/${filename}`,
            } satisfies ProfileWithMovies;
          } catch (error) {
            console.warn(
              `[jav-crawler] Skipping image for ${profile.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return { ...profile, movies } satisfies ProfileWithMovies;
      },
    );
    const actresses = assignFoodAliases(
      assignTiers(profilesWithImages(profiles), discovered.length),
      createSeededRandom(snapshotId),
    );
    if (actresses.length < 5) throw new Error('Too few valid actresses');
    const snapshot: ActressSnapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      snapshotId,
      createdAt: new Date().toISOString(),
      source: {
        url: 'https://jav.guru/?s=&orderby=views-monthly&order=DESC&category_name=jav',
        orderBy: 'views-monthly',
        category: 'jav',
        pages: 3,
        listEntries: discovered.length,
        uniqueMovies: uniqueMovies.length,
        enrichment: avbase.stats,
      },
      actresses,
    };
    await writeFile(
      join(staging, 'snapshot.json'),
      JSON.stringify(snapshot),
      'utf8',
    );
    await publishSnapshot(snapshot, staging);
    staging = '';
    success = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[jav-crawler]', message);
    try {
      await writeStatus({ state: 'error', message: message.slice(0, 280) });
    } catch {}
  } finally {
    try {
      if (staging) await rm(staging, { recursive: true, force: true });
    } catch (error) {
      success = false;
      console.error('[jav-crawler] Staging cleanup failed', error);
    } finally {
      try {
        await release?.();
      } catch (error) {
        success = false;
        console.error('[jav-crawler] Lock release failed', error);
      }
    }
  }
  return success;
}
