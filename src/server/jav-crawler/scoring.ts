import type { Actress, Tier } from '@/lib/actresses';
import type { ParsedProfile, RankedMovie } from './parser';

export type ProfileWithMovies = ParsedProfile & {
  movies: RankedMovie[];
  imagePath?: string;
};
export type ProfileWithImage = ProfileWithMovies & { imagePath: string };
export type ScoredActress = Omit<Actress, 'publicName'>;

export function profilesWithImages(
  profiles: ProfileWithMovies[],
): ProfileWithImage[] {
  return profiles.filter(
    (profile): profile is ProfileWithImage =>
      typeof profile.imagePath === 'string' && profile.imagePath.length > 0,
  );
}

export function assignTiers(
  profiles: ProfileWithImage[],
  rankedMovieCount: number,
): ScoredActress[] {
  if (rankedMovieCount < 1) throw new Error('No ranked movies');
  const scored = profiles
    .map((profile) => {
      const movies = [...profile.movies].sort((a, b) => a.rank - b.rank);
      return {
        ...profile,
        score: movies.reduce(
          (sum, movie) => sum + (rankedMovieCount - movie.rank + 1),
          0,
        ),
        bestRank: movies[0].rank,
        appearances: movies.length,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.bestRank - b.bestRank ||
        b.appearances - a.appearances ||
        a.sourceUrl.localeCompare(b.sourceUrl),
    );
  const n = scored.length;
  const proportions = [0.02, 0.08, 0.15, 0.25, 0.5];
  const exact = proportions.map((value) => value * n);
  const counts = exact.map(Math.floor);
  let left = n - counts.reduce((sum, value) => sum + value, 0);
  [...exact.keys()]
    .sort((a, b) => (exact[b] % 1) - (exact[a] % 1))
    .forEach((index) => {
      if (left-- > 0) counts[index]++;
    });
  if (n >= 5) {
    for (let tier = 0; tier < 5; tier++) {
      if (counts[tier]) continue;
      const donor = counts.findIndex(
        (count, index) => count > 1 && index !== tier,
      );
      if (donor >= 0) {
        counts[donor]--;
        counts[tier]++;
      }
    }
  }
  let offset = 0;
  return counts.flatMap((count, tier) =>
    scored.slice(offset, (offset += count)).map((profile) => ({
      id: profile.id,
      sourceUrl: profile.sourceUrl,
      name: profile.name,
      aliases: profile.aliases,
      nativeName: profile.nativeName,
      nameReading: profile.nameReading,
      age: profile.age,
      birthDate: profile.birthDate,
      cup: profile.cup,
      heightCm: profile.heightCm,
      bustCm: profile.bustCm,
      waistCm: profile.waistCm,
      hipCm: profile.hipCm,
      bloodType: profile.bloodType,
      hometown: profile.hometown,
      hobby: profile.hobby,
      videoCount: profile.videoCount,
      imagePath: profile.imagePath,
      socialLinks: profile.socialLinks,
      avBaseUrl: profile.avBaseUrl,
      wikipediaUrl: profile.wikipediaUrl,
      minnanoAvUrl: profile.minnanoAvUrl,
      ratings: profile.ratings,
      tags: profile.tags,
      debutYear: profile.debutYear,
      score: profile.score,
      tier: (4 - tier) as Tier,
      bestRank: profile.bestRank,
      appearances: profile.appearances,
      contributingMovies: profile.movies.map((movie) => ({
        rank: movie.rank,
        code: movie.code,
        movieUrl: movie.url,
      })),
    })),
  );
}
