import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  filterSingleActressMovies,
  isSingleActressMovie,
  parseActressProfile,
  parseMovieActressUrls,
  parseRankingPage,
} from '../src/server/jav-crawler/parser';
import {
  assignTiers,
  profilesWithImages,
} from '../src/server/jav-crawler/scoring';
import {
  SNAPSHOT_SCHEMA_VERSION,
  canonicalMinnanoAvUrl,
  validateSnapshot,
} from '../src/lib/actresses';
import {
  clearMinnanoAvCache,
  createMinnanoAvEnricher,
  extractGojuonSyllables,
  extractMinnanoIdentity,
  extractTargetKana,
  getMinnanoAvCacheStats,
  katakanaToHiragana,
  matchesIdentity,
  mergeMinnanoAvProfile,
  normalizeName,
  parseMinnanoAvProfile,
  searchMinnanoAv,
} from '../src/server/jav-crawler/minnano-av';
import {
  translateTagToVietnamese,
  translateTagToEnglish,
  translateTags,
} from '../src/lib/tag-translations';
import { assignFoodAliases, createSeededRandom } from '../src/lib/food-aliases';

const html = readFileSync(
  new URL('./fixtures/xxx-guru.html', import.meta.url),
  'utf8',
);
test('synthetic XXX.Guru fixture locks expected parser contract', () => {
  const movies = parseRankingPage(html, 1);
  assert.equal(movies.length, 15);
  assert.deepEqual(parseMovieActressUrls(html), [
    'https://jav.guru/actress/demo-star/',
  ]);
  const profile = parseActressProfile(
    html,
    'https://jav.guru/actress/demo-star/',
  );
  assert.equal(profile.name, 'Demo Star');
  assert.equal(profile.age, 24);
  assert.equal(profile.socialLinks[0]?.label, 'X');
});
test('tier scorer makes top performers rare and keeps each tier populated', () => {
  const data = Array.from({ length: 10 }, (_, index) => ({
    id: `star-${index}`,
    sourceUrl: `https://jav.guru/actress/star-${index}/`,
    name: `Star ${index}`,
    aliases: [],
    socialLinks: [],
    imagePath: `/actress-cache/snapshots/demo/images/star-${index}.jpg`,
    movies: [
      {
        rank: index + 1,
        url: `https://jav.guru/movie-${index}/`,
        code: `T-${index}`,
      },
    ],
  }));
  const ranked = assignTiers(data, data.length);
  assert.equal(new Set(ranked.map((item) => item.tier)).size, 5);
  assert.equal(ranked.find((item) => item.id === 'star-0')?.tier, 4);
  assert.ok(ranked.every((item) => item.imagePath));
});
test('crawler scorer excludes profiles without a downloaded image', () => {
  const profiles = [
    {
      id: 'with-image',
      sourceUrl: 'https://jav.guru/actress/with-image/',
      name: 'With Image',
      aliases: [],
      socialLinks: [],
      imagePath: '/actress-cache/snapshots/demo/images/with-image.jpg',
      movies: [
        { rank: 1, url: 'https://jav.guru/demo-movie/', code: 'DEMO-1' },
      ],
    },
    {
      id: 'without-image',
      sourceUrl: 'https://jav.guru/actress/without-image/',
      name: 'Without Image',
      aliases: [],
      socialLinks: [],
      movies: [
        { rank: 2, url: 'https://jav.guru/demo-movie-2/', code: 'DEMO-2' },
      ],
    },
  ];
  const imageBacked = profilesWithImages(profiles);
  assert.deepEqual(
    imageBacked.map((profile) => profile.id),
    ['with-image'],
  );
  assert.equal(assignTiers(imageBacked, 2)[0]?.id, 'with-image');
});
test('refresh preserves Minnano enrichment through scoring and snapshot serialization', async (t) => {
  const url = 'https://www.minnano-av.com/actress123.html';
  const cases = [
    {
      name: 'all enrichment fields',
      enrichment: {
        name: 'Demo Star',
        url,
        ratings: {
          looks: 8.83,
          body: 8.8,
          charm: 9.07,
          eroticAppeal: 9.03,
          overall: 9.07,
        },
        tags: ['美人', '48kg'],
        debutYear: 2024,
      },
    },
    {
      name: 'partial enrichment including a zero rating',
      enrichment: {
        name: 'Demo Star',
        url,
        ratings: { overall: 0 },
        tags: [],
      },
    },
    { name: 'no matching enrichment', enrichment: undefined },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const base = parseActressProfile(
        html,
        'https://jav.guru/actress/demo-star/',
      );
      const profile = entry.enrichment
        ? mergeMinnanoAvProfile(base, entry.enrichment, url)
        : base;
      const actresses = assignFoodAliases(
        assignTiers(
          profilesWithImages([
            {
              ...profile,
              imagePath:
                '/actress-cache/snapshots/enriched-refresh/images/demo-star.jpg',
              movies: [
                {
                  rank: 1,
                  url: 'https://jav.guru/demo-movie/',
                  code: 'DEMO-1',
                },
              ],
            },
          ]),
          45,
        ),
        createSeededRandom('enriched-refresh'),
      );
      const snapshot = validateSnapshot(
        JSON.parse(
          JSON.stringify({
            schemaVersion: SNAPSHOT_SCHEMA_VERSION,
            snapshotId: 'enriched-refresh',
            createdAt: '2026-11-16T00:00:00.000Z',
            source: {
              url: 'https://jav.guru/?s=&orderby=views-monthly&order=DESC&category_name=jav',
              orderBy: 'views-monthly',
              category: 'jav',
              pages: 3,
              listEntries: 45,
              uniqueMovies: 45,
              enrichment: {
                provider: 'avbase',
                attempted: 0,
                matched: 0,
                skipped: 0,
                blocked: 0,
              },
            },
            actresses,
          }),
        ),
      );
      assert.ok(snapshot);
      const actress = snapshot.actresses[0];
      assert.equal(actress.minnanoAvUrl, entry.enrichment?.url);
      assert.deepEqual(actress.ratings, entry.enrichment?.ratings);
      assert.deepEqual(
        actress.tags,
        entry.enrichment?.tags.length ? entry.enrichment.tags : undefined,
      );
      assert.equal(actress.debutYear, entry.enrichment?.debutYear);
      assert.equal(actress.score, 45);
      assert.equal(actress.bestRank, 1);
      assert.equal(actress.appearances, 1);
      assert.deepEqual(actress.contributingMovies, [
        { rank: 1, code: 'DEMO-1', movieUrl: 'https://jav.guru/demo-movie/' },
      ]);
      assert.equal('imageUrl' in actresses[0], false);
      assert.equal('movies' in actresses[0], false);
    });
  }
});

test('fresh enrichment refreshes both cached matches and misses between runs', async (t) => {
  for (const initiallyAvailable of [true, false]) {
    await t.test(
      initiallyAvailable ? 'cached match' : 'cached miss',
      async (t) => {
        clearMinnanoAvCache();
        t.after(clearMinnanoAvCache);
        let revision = 1;
        const fetchedUrls: string[] = [];
        t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
          const url = String(input);
          fetchedUrls.push(url);
          if (url.includes('actress_list.php')) {
            return new Response(
              initiallyAvailable || revision === 2
                ? `<h2 class="ttl"><a href="actress123.html">Demo Star</a></h2>
                 <p class="furi">でも / Demo Star</p>`
                : '',
            );
          }
          assert.equal(url, 'https://www.minnano-av.com/actress123.html');
          return new Response(`
          <h1>Demo Star</h1>
          <table class="rate-table">
            <tr><td class="t9">総合評価</td><td class="t9">${revision === 1 ? 8 : 9}</td></tr>
          </table>
          <div class="tagarea"><a>${revision === 1 ? '48kg' : '美人'}</a></div>
          <span>AV出演期間</span><p>${revision === 1 ? 2023 : 2024}年 -</p>
        `);
        });
        const profile = { name: 'Demo Star', aliases: [] };
        const firstRun = createMinnanoAvEnricher({ refreshCache: true });
        const initial = await firstRun.lookup(profile);
        assert.equal(
          initial.kind,
          initiallyAvailable ? 'matched' : 'not-found',
        );
        if (initial.kind === 'matched') {
          assert.equal(initial.profile.ratings?.overall, 8);
          assert.deepEqual(initial.profile.tags, ['48kg']);
          assert.equal(initial.profile.debutYear, 2023);
        }
        const initialRequests = fetchedUrls.length;
        revision = 2;
        assert.deepEqual(await firstRun.lookup(profile), initial);
        assert.equal(fetchedUrls.length, initialRequests);

        const nextRun = createMinnanoAvEnricher({ refreshCache: true });
        assert.equal(getMinnanoAvCacheStats().cachedPages, 0);
        assert.equal(getMinnanoAvCacheStats().cachedProfiles, 0);
        assert.equal(getMinnanoAvCacheStats().resolvedLookups, 0);
        const refreshed = await nextRun.lookup(profile);
        assert.equal(refreshed.kind, 'matched');
        if (refreshed.kind !== 'matched') return;
        assert.equal(refreshed.profile.ratings?.overall, 9);
        assert.deepEqual(refreshed.profile.tags, ['美人']);
        assert.equal(refreshed.profile.debutYear, 2024);
        assert.ok(fetchedUrls.length > initialRequests);
        const refreshedRequests = fetchedUrls.length;
        assert.deepEqual(await nextRun.lookup(profile), refreshed);
        assert.equal(fetchedUrls.length, refreshedRequests);
      },
    );
  }
});

test('snapshot schema requires a same-tier food alias and an image path', () => {
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'demo-snapshot',
    createdAt: '2026-09-11T00:00:00.000Z',
    source: {
      url: 'https://jav.guru/?s=&orderby=views-monthly&order=DESC&category_name=jav',
      orderBy: 'views-monthly',
      category: 'jav',
      pages: 3,
      listEntries: 45,
      uniqueMovies: 45,
      enrichment: {
        provider: 'avbase',
        attempted: 1,
        matched: 1,
        skipped: 0,
        blocked: 0,
      },
    },
    actresses: [
      {
        id: 'demo-star',
        sourceUrl: 'https://jav.guru/actress/demo-star/',
        name: 'Demo Star',
        publicName: 'Bánh mì',
        aliases: [],
        imagePath:
          '/actress-cache/snapshots/demo-snapshot/images/demo-star.jpg',
        socialLinks: [],
        score: 45,
        tier: 0,
        bestRank: 1,
        appearances: 1,
        contributingMovies: [
          {
            rank: 1,
            code: 'DEMO-1',
            movieUrl: 'https://jav.guru/demo-movie/',
          },
        ],
      },
    ],
  };
  assert.ok(validateSnapshot(snapshot));
  const { imagePath: _, ...withoutImage } = snapshot.actresses[0]!;
  assert.equal(
    validateSnapshot({
      ...snapshot,
      actresses: [withoutImage],
    }),
    null,
  );
  assert.equal(
    validateSnapshot({
      ...snapshot,
      actresses: [{ ...snapshot.actresses[0], publicName: 'Pizza' }],
    }),
    null,
  );
  assert.equal(
    validateSnapshot({
      ...snapshot,
      actresses: [
        {
          ...snapshot.actresses[0],
          socialLinks: [
            { label: 'TikTok', url: 'https://example.com/not-a-profile' },
          ],
        },
      ],
    }),
    null,
  );
  const legacy = validateSnapshot({
    ...snapshot,
    schemaVersion: 3,
    source: {
      ...snapshot.source,
      enrichment: undefined,
    },
  });
  assert.equal(legacy?.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.deepEqual(legacy?.source.enrichment, {
    provider: 'avbase',
    attempted: 0,
    matched: 0,
    skipped: 0,
    blocked: 0,
  });
});

test('parses minnano-av quantitative ratings, original tags, and debut year', () => {
  const sampleHtml = `
    <h1>彩月七緒 / Satsuki Nao</h1>
    <table class="rate-table">
      <tr><td class="t9">ルックス</td><td><img src="ebar.gif"></td><td class="t9">8.83</td></tr>
      <tr><td class="t9">カラダ</td><td><img src="ebar.gif"></td><td class="t9">8.80</td></tr>
      <tr><td class="t9">魅力</td><td><img src="ebar.gif"></td><td class="t9">9.07</td></tr>
      <tr><td class="t9">ヌケる</td><td><img src="ebar.gif"></td><td class="t9">9.03</td></tr>
      <tr><td class="t9"><b>総合評価</b></td><td><img src="ebar.gif"></td><td class="t9">9.07</td></tr>
    </table>
    <td><span>AV出演期間</span><p>2024年 -</p></td>
    <td><span>デビュー作品</span><p>超大物新人 彩月七緒 AV DEBUT（2024年01月 25日）</p></td>
    <div class="tagarea">
      <a href="tag=3">巨乳</a>
      <a href="tag=61">美人</a>
      <a href="tag=9596">48kg</a>
    </div>
  `;

  const parsed = parseMinnanoAvProfile(
    sampleHtml,
    'https://www.minnano-av.com/actress908789.html',
  );
  assert.equal(parsed.name, '彩月七緒');
  assert.equal(parsed.debutYear, 2024);
  assert.deepEqual(parsed.ratings, {
    looks: 8.83,
    body: 8.8,
    charm: 9.07,
    eroticAppeal: 9.03,
    overall: 9.07,
  });
  assert.deepEqual(parsed.tags, ['巨乳', '美人', '48kg']);
});

test('translates tags to Vietnamese cleanly with composite tags and patterns', () => {
  assert.deepEqual(translateTagToVietnamese('巨乳'), ['Vó tu']);
  assert.deepEqual(translateTagToVietnamese('美人'), ['Mỹ nhân']);
  assert.deepEqual(translateTagToVietnamese('パフィーニップル，美体，美肌'), [
    'Nầm múp',
    'Dáng người tuyệt mỹ',
    'Làn da mịn màng',
  ]);
  assert.deepEqual(translateTagToVietnamese('48kg'), ['48kg']);
  assert.deepEqual(translateTagToVietnamese('20歳'), ['20 tuổi']);
  assert.deepEqual(translateTagToVietnamese('両手両足タトゥー'), [
    'Hình xăm tay chân',
  ]);
  assert.deepEqual(translateTagToVietnamese('タトゥー'), ['Hình xăm']);
});

test('translates tags to English cleanly with composite tags and patterns', () => {
  assert.deepEqual(translateTagToEnglish('巨乳'), ['Big Breasts']);
  assert.deepEqual(translateTagToEnglish('美人'), ['Beauty']);
  assert.deepEqual(translateTagToEnglish('パフィーニップル，美体，美肌'), [
    'Puffy Nipples',
    'Great Body',
    'Smooth Skin',
  ]);
  assert.deepEqual(translateTagToEnglish('48kg'), ['48kg']);
  assert.deepEqual(translateTagToEnglish('20歳'), ['20 y/o']);
  assert.deepEqual(translateTagToEnglish('両手両足タトゥー'), [
    'Arm & Leg Tattoos',
  ]);
  assert.deepEqual(translateTagToEnglish('タトゥー'), ['Tattoo']);
});

test('skips tags without translations', () => {
  assert.deepEqual(translateTagToVietnamese('未知のタグ'), []);
  assert.deepEqual(translateTagToEnglish('未知のタグ'), []);
  assert.deepEqual(translateTagToVietnamese('巨乳，未知のタグ'), [
    'Vó tu',
  ]);
  assert.deepEqual(translateTagToEnglish('巨乳，未知のタグ'), ['Big Breasts']);
  assert.deepEqual(translateTags(['巨乳', '未知のタグ', '美人'], 'vi'), [
    'Vó tu',
    'Mỹ nhân',
  ]);
  assert.deepEqual(translateTags(['巨乳', '未知のタグ', '美人'], 'en'), [
    'Big Breasts',
    'Beauty',
  ]);
  assert.deepEqual(translateTags(['未知のタグ1', '未知のタグ2'], 'vi'), []);
  assert.deepEqual(translateTags(['未知のタグ1', '未知のタグ2'], 'en'), []);
});

test('distinguishes exact names and avoids substring mapping errors like Meguri vs Minoshima Meguri', () => {
  const meguriHtml = `
    <title>めぐり（めぐり）- AV女優プロフィール - みんなのAV</title>
    <h1>めぐりめぐり / Meguri</h1>
    <table><tr><td>別名 藤浦めぐ （ふじうらめぐ / Fujiura Megu）</td></tr></table>
  `;
  const minoshimaHtml = `
    <title>美ノ嶋めぐり（みのしまめぐり）- AV女優プロフィール - みんなのAV</title>
    <h1>美ノ嶋めぐりみのしまめぐり / Minoshima Meguri</h1>
  `;

  const meguriIdentity = extractMinnanoIdentity(meguriHtml)!;
  const minoshimaIdentity = extractMinnanoIdentity(minoshimaHtml)!;

  assert.ok(meguriIdentity);
  assert.ok(minoshimaIdentity);

  // Target actress: Meguri / めぐり
  const targetCandidates = ['めぐり', 'Meguri', '藤浦めぐ'];

  // Should match Meguri profile
  assert.equal(matchesIdentity(targetCandidates, meguriIdentity), true);

  // Must NOT match Minoshima Meguri!
  assert.equal(matchesIdentity(targetCandidates, minoshimaIdentity), false);

  // Nor normalizeName issue with macrons like Yūki Kanoha
  assert.equal(normalizeName('Yūki Kanoha'), 'yukikanoha');
  assert.equal(normalizeName('Yuki Kanoha'), 'yukikanoha');
});

test('canonicalMinnanoAvUrl validates valid and rejects invalid URLs', () => {
  assert.equal(
    canonicalMinnanoAvUrl(
      'https://www.minnano-av.com/actress908789.html?foo=bar#baz',
    ),
    'https://www.minnano-av.com/actress908789.html',
  );
  assert.equal(
    canonicalMinnanoAvUrl('https://minnano-av.com/actress123.html'),
    'https://www.minnano-av.com/actress123.html',
  );
  assert.equal(
    canonicalMinnanoAvUrl('https://www.minnano-av.com/other_page.html'),
    null,
  );
  assert.equal(
    canonicalMinnanoAvUrl('https://attacker.com/actress123.html'),
    null,
  );
});

test('validateSnapshot accepts enriched minnano-av fields', () => {
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'demo-minnano',
    createdAt: '2026-09-12T00:00:00.000Z',
    source: {
      url: 'https://jav.guru/?s=&orderby=views-monthly&order=DESC&category_name=jav',
      orderBy: 'views-monthly',
      category: 'jav',
      pages: 3,
      listEntries: 45,
      uniqueMovies: 45,
      enrichment: {
        provider: 'avbase',
        attempted: 1,
        matched: 1,
        skipped: 0,
        blocked: 0,
      },
    },
    actresses: [
      {
        id: 'demo-star',
        sourceUrl: 'https://jav.guru/actress/demo-star/',
        name: 'Demo Star',
        publicName: 'Bánh mì',
        aliases: [],
        imagePath: '/actress-cache/snapshots/demo-minnano/images/demo-star.jpg',
        socialLinks: [],
        minnanoAvUrl: 'https://www.minnano-av.com/actress908789.html',
        debutYear: 2024,
        ratings: {
          looks: 8.83,
          body: 8.8,
          charm: 9.07,
          eroticAppeal: 9.03,
          overall: 9.07,
        },
        tags: ['巨乳', '美人'],
        score: 45,
        tier: 0,
        bestRank: 1,
        appearances: 1,
        contributingMovies: [
          {
            rank: 1,
            code: 'DEMO-1',
            movieUrl: 'https://jav.guru/demo-movie/',
          },
        ],
      },
    ],
  };

  const validated = validateSnapshot(snapshot);
  assert.ok(validated);
  assert.equal(
    validated.actresses[0].minnanoAvUrl,
    'https://www.minnano-av.com/actress908789.html',
  );
  assert.equal(validated.actresses[0].debutYear, 2024);
  assert.equal(validated.actresses[0].ratings?.overall, 9.07);
  assert.deepEqual(validated.actresses[0].tags, ['巨乳', '美人']);
});

test('parseMovieActressUrls handles single actress, multiple actresses, and no actress', () => {
  const singleActressHtml = `
    <div class="infoleft">
      <ul>
        <li><strong>Actor:</strong> <a href="https://jav.guru/actor/actor-1/">Actor 1</a></li>
        <li><strong>Actress:</strong> <a href="https://jav.guru/actress/star-1/">Star 1</a></li>
      </ul>
    </div>
  `;
  assert.deepEqual(parseMovieActressUrls(singleActressHtml), [
    'https://jav.guru/actress/star-1/',
  ]);

  const multiActressesHtml = `
    <div class="infoleft">
      <ul>
        <li><strong>Actress:</strong> <a href="https://jav.guru/actress/star-1/">Star 1</a>, <a href="https://jav.guru/actress/star-2/">Star 2</a></li>
      </ul>
    </div>
  `;
  assert.deepEqual(parseMovieActressUrls(multiActressesHtml), [
    'https://jav.guru/actress/star-1/',
    'https://jav.guru/actress/star-2/',
  ]);

  const pluralActressesHtml = `
    <div class="infoleft">
      <ul>
        <li><strong>Actresses:</strong> <a href="https://jav.guru/actress/star-1/">Star 1</a>, <a href="https://jav.guru/actress/star-2/">Star 2</a>, <a href="https://jav.guru/actress/star-3/">Star 3</a></li>
      </ul>
    </div>
  `;
  assert.deepEqual(parseMovieActressUrls(pluralActressesHtml), [
    'https://jav.guru/actress/star-1/',
    'https://jav.guru/actress/star-2/',
    'https://jav.guru/actress/star-3/',
  ]);

  const noActressHtml = `
    <div class="infoleft">
      <ul>
        <li><strong>Actor:</strong> <a href="https://jav.guru/actor/actor-1/">Actor 1</a></li>
        <li><strong>Tags:</strong> <a href="https://jav.guru/tag/vr/">VR</a></li>
      </ul>
    </div>
  `;
  assert.deepEqual(parseMovieActressUrls(noActressHtml), []);
});

test('isSingleActressMovie and filterSingleActressMovies skip movies with 2 or more actresses', () => {
  const movie1 = {
    movie: { rank: 1, url: 'https://jav.guru/movie-1/', code: 'M-1' },
    actressUrls: ['https://jav.guru/actress/solo-star/'],
  };
  const movie2 = {
    movie: { rank: 2, url: 'https://jav.guru/movie-2/', code: 'M-2' },
    actressUrls: [
      'https://jav.guru/actress/star-1/',
      'https://jav.guru/actress/star-2/',
    ],
  };
  const movie3 = {
    movie: { rank: 3, url: 'https://jav.guru/movie-3/', code: 'M-3' },
    actressUrls: [
      'https://jav.guru/actress/star-1/',
      'https://jav.guru/actress/star-2/',
      'https://jav.guru/actress/star-3/',
    ],
  };
  const movie4 = {
    movie: { rank: 4, url: 'https://jav.guru/movie-4/', code: 'M-4' },
    actressUrls: [],
  };
  const movie5 = {
    movie: { rank: 5, url: 'https://jav.guru/movie-5/', code: 'M-5' },
    actressUrls: ['https://jav.guru/actress/another-solo-star/'],
  };

  assert.equal(isSingleActressMovie(movie1), true);
  assert.equal(isSingleActressMovie(movie2), false);
  assert.equal(isSingleActressMovie(movie3), false);
  assert.equal(isSingleActressMovie(movie4), false);
  assert.equal(isSingleActressMovie(movie5), true);

  const filtered = filterSingleActressMovies([
    movie1,
    movie2,
    movie3,
    movie4,
    movie5,
  ]);
  assert.equal(filtered.length, 2);
  assert.deepEqual(
    filtered.map((item) => item.movie.code),
    ['M-1', 'M-5'],
  );
  assert.deepEqual(
    filtered.map((item) => item.actressUrls[0]),
    [
      'https://jav.guru/actress/solo-star/',
      'https://jav.guru/actress/another-solo-star/',
    ],
  );
});

test('extracts Gojuon syllables and target kana accurately', () => {
  assert.equal(katakanaToHiragana('ミア・ケイ'), 'みあ・けい');
  assert.equal(katakanaToHiragana('エマ'), 'えま');

  assert.deepEqual(
    extractGojuonSyllables(['波多野結衣', 'はたのゆい', 'Hatano Yui']),
    ['ha', 'yu'],
  );
  assert.deepEqual(
    extractGojuonSyllables(['彩月七緒', 'さつきなお', 'Satsuki Nao']),
    ['sa', 'na'],
  );
  assert.deepEqual(
    extractGojuonSyllables(['神宮寺ナオ', 'じんぐうじなお', 'Jinguuji Nao']),
    ['zi', 'na'],
  );
  assert.deepEqual(
    extractGojuonSyllables(['三上悠亜', 'みかみゆあ', 'Mikami Yua']),
    ['mi', 'yu'],
  );

  assert.equal(
    extractTargetKana(['波多野結衣', 'はたのゆい', 'Hatano Yui']),
    'はたのゆい',
  );
  assert.equal(
    extractTargetKana(['Hatano Yui', 'はたの ゆい']),
    'はたのゆい',
  );
});

test('manages in-memory cache correctly for Gojuon lookups', async () => {
  clearMinnanoAvCache();
  const initialStats = getMinnanoAvCacheStats();
  assert.equal(initialStats.directorySize, 0);
  assert.equal(initialStats.cachedPages, 0);
  assert.equal(initialStats.cachedProfiles, 0);
  assert.equal(initialStats.resolvedLookups, 0);

  // Mock global fetch
  const originalFetch = globalThis.fetch;
  const fetchedUrls: string[] = [];

  const mockListPageHtml = `
    <html>
      <div class="pagination"><span class='page_info'>1 / 1 ページ (2件)</span></div>
      <table>
        <tr>
          <td><a href="actress101.html"><img src="101.jpg" alt="波多野結衣" /></a></td>
          <td class="details">
            <h2 class="ttl"><a href="actress101.html">波多野結衣</a></h2>
            <p class="furi">はたのゆい / Hatano Yui</p>
          </td>
        </tr>
        <tr>
          <td><a href="actress102.html"><img src="102.jpg" alt="八蜜凛" /></a></td>
          <td class="details">
            <h2 class="ttl"><a href="actress102.html">八蜜凛</a></h2>
            <p class="furi">はちみつりん / Hachimitsu Rin</p>
          </td>
        </tr>
      </table>
    </html>
  `;

  const mockHatanoProfileHtml = `
    <html>
      <title>波多野結衣（はたのゆい）- AV女優プロフィール - みんなのAV</title>
      <h1>波多野結衣はたのゆい / Hatano Yui</h1>
      <table class="rate-table">
        <tr><td class="t9">総合評価</td><td class="t9">8.5</td></tr>
      </table>
    </html>
  `;

  const mockHachimitsuProfileHtml = `
    <html>
      <title>八蜜凛（はちみつりん）- AV女優プロフィール - みんなのAV</title>
      <h1>八蜜凛はちみつりん / Hachimitsu Rin</h1>
      <table class="rate-table">
        <tr><td class="t9">総合評価</td><td class="t9">9.0</td></tr>
      </table>
    </html>
  `;

  globalThis.fetch = async (input: RequestInfo | URL) => {
    const urlStr = String(input);
    fetchedUrls.push(urlStr);

    if (urlStr.includes('actress_list.php')) {
      return new Response(mockListPageHtml, { status: 200 });
    }
    if (urlStr.includes('actress101.html')) {
      return new Response(mockHatanoProfileHtml, { status: 200 });
    }
    if (urlStr.includes('actress102.html')) {
      return new Response(mockHachimitsuProfileHtml, { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  };

  try {
    // 1. First lookup: Hatano Yui (fetches list page + profile page)
    const result1 = await searchMinnanoAv('Hatano Yui', [
      '波多野結衣',
      'はたのゆい',
      'Hatano Yui',
    ]);
    assert.ok(result1);
    assert.equal(result1.name, '波多野結衣');
    assert.equal(result1.ratings?.overall, 8.5);
    assert.equal(fetchedUrls.length, 2); // 1 list page + 1 profile page

    // 2. Second lookup: Hatano Yui AGAIN (100% in-memory cache hit, 0 network requests!)
    const result2 = await searchMinnanoAv('Hatano Yui', [
      '波多野結衣',
      'はたのゆい',
      'Hatano Yui',
    ]);
    assert.ok(result2);
    assert.equal(result2.name, '波多野結衣');
    assert.equal(fetchedUrls.length, 2); // No new requests!

    // 3. Third lookup: Hachimitsu Rin (was already indexed from page 1 into directory cache! Only fetches her profile page)
    const result3 = await searchMinnanoAv('Hachimitsu Rin', [
      '八蜜凛',
      'はちみつりん',
      'Hachimitsu Rin',
    ]);
    assert.ok(result3);
    assert.equal(result3.name, '八蜜凛');
    assert.equal(result3.ratings?.overall, 9.0);
    assert.equal(fetchedUrls.length, 3); // Only 1 profile page request, 0 list requests!

    // 4. Fourth lookup: Hachimitsu Rin AGAIN (100% in-memory cache hit)
    const result4 = await searchMinnanoAv('Hachimitsu Rin', [
      '八蜜凛',
      'はちみつりん',
      'Hachimitsu Rin',
    ]);
    assert.ok(result4);
    assert.equal(fetchedUrls.length, 3); // No new requests!

    // Verify cache statistics
    const stats = getMinnanoAvCacheStats();
    assert.ok(stats.directorySize >= 2);
    assert.equal(stats.cachedPages, 1);
    assert.equal(stats.cachedProfiles, 2);

    // Clear cache
    clearMinnanoAvCache();
    const clearedStats = getMinnanoAvCacheStats();
    assert.equal(clearedStats.directorySize, 0);
    assert.equal(clearedStats.cachedPages, 0);
    assert.equal(clearedStats.cachedProfiles, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
