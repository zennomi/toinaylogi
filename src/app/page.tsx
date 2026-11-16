'use client';

import Link from 'next/link';
import { flushSync } from 'react-dom';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  Box,
  CircleHelp,
  ExternalLink,
  Sparkles,
  Star,
  StarHalf,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { readCookie, writeCookie } from '@/lib/cookies';
import {
  chooseTiered,
  createSpinProfile,
  spinProgress,
  stopFraction,
} from '@/lib/case-mechanics';
import { type Actress } from '@/lib/actresses';
import { copy, type Language } from '@/lib/i18n';
import { useActressSnapshot } from '@/hooks/use-actress-snapshot';
import { useLocalSpinCount } from '@/hooks/use-local-spin-count';
import { useServerSpinCount } from '@/hooks/use-server-spin-count';
import { usePreferences } from '@/hooks/use-preferences';
import { eligibleActresses } from '@/lib/actress-preferences';
import { PreferencesPanel } from '@/components/preferences-panel';
import { CaseAudio } from '@/lib/case-audio';
import { translateTags } from '@/lib/tag-translations';
import { isDirectCardDialogEnabled } from '@/lib/direct-card-dialog';
import { CharacterStatsRadar } from '@/components/character-stats-radar';

const colors = ['#4b69ff', '#8847ff', '#d32ce6', '#eb4b4b', '#e4ae39'];
const reelStep = 254;
const reelInitialOffset = -400;

function formatBirthDate(value: string, language: Language) {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat(language === 'vi' ? 'vi-VN' : 'en-US', {
    dateStyle: 'long',
  }).format(new Date(year, month - 1, day));
}

function getActressAge(actress: Actress): number | undefined {
  if (typeof actress.age === 'number' && actress.age > 0) {
    return actress.age;
  }
  if (!actress.birthDate) return undefined;
  const [year, month, day] = actress.birthDate.split('-').map(Number);
  if (!year) return undefined;
  const birth = new Date(year, (month || 1) - 1, day || 1);
  if (Number.isNaN(birth.getTime())) return undefined;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) {
    age--;
  }
  return age > 0 ? age : undefined;
}

function getCareerYears(debutYear?: number): number | undefined {
  if (!debutYear || debutYear < 1970) return undefined;
  const currentYear = new Date().getFullYear();
  const diff = currentYear - debutYear;
  return diff >= 0 ? diff : undefined;
}

function StarRating({
  score,
  showScore = true,
  max = 5,
}: {
  score: number;
  showScore?: boolean;
  max?: number;
}) {
  const starScore = Math.min(max, Math.max(0, score / 2));
  return (
    <div
      className="star-rating"
      title={`${score.toFixed(2)}/10 (${starScore.toFixed(2)}/${max})`}
    >
      <div className="star-icons" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((i) => {
          if (starScore >= i - 0.25) {
            return (
              <Star
                key={i}
                size={13}
                className="star-icon star-full"
                fill="currentColor"
                stroke="currentColor"
              />
            );
          }
          if (starScore >= i - 0.75) {
            return (
              <StarHalf
                key={i}
                size={13}
                className="star-icon star-half"
                fill="currentColor"
                stroke="currentColor"
              />
            );
          }
          return (
            <Star
              key={i}
              size={13}
              className="star-icon star-empty"
              stroke="currentColor"
              fill="none"
            />
          );
        })}
      </div>
      {showScore && <span className="star-score">{starScore.toFixed(1)}</span>}
    </div>
  );
}

function ActressImage({ actress, alt }: { actress: Actress; alt: string }) {
  // Cached user-generated image dimensions vary; avoid optimizer routes for local snapshots.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="actress-image" src={actress.imagePath} alt={alt} />
  );
}

const Card = memo(function Card({
  actress,
  language,
  small = false,
  slot,
  onClick,
}: {
  actress: Actress;
  language: Language;
  small?: boolean;
  slot?: number;
  onClick?: () => void;
}) {
  return (
    <div
      className={`actress-card ${small ? 'small' : ''} ${onClick ? 'clickable' : ''}`}
      data-slot-id={slot}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? actress.publicName : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      style={
        {
          '--rarity': colors[actress.tier],
          ...(slot === undefined
            ? {}
            : { position: 'absolute', left: slot * reelStep }),
        } as React.CSSProperties
      }
    >
      <span className="tier">{copy[language].tiers[actress.tier]}</span>
      <ActressImage actress={actress} alt={actress.publicName} />
      <div className="card-copy">
        <strong>{actress.publicName}</strong>
      </div>
    </div>
  );
});

export default function Home() {
  const { snapshot, status, error } = useActressSnapshot();
  const preferences = usePreferences();
  const { count: localSpins, recordSpin } = useLocalSpinCount();
  const {
    count: serverSpins,
    status: serverSpinStatus,
    increment: recordServerSpin,
  } = useServerSpinCount();
  const [language, setLanguage] = useState<Language>('vi');
  const [sound, setSound] = useState(true);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<Actress | null>(null);
  const [lastChoice, setLastChoice] = useState<Actress | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [active, setActive] = useState<Actress[]>([]);
  const [reel, setReel] = useState<{ actress: Actress; id: number }[]>([]);
  const [visibleStart, setVisibleStart] = useState(0);
  const busy = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const position = useRef(-400);
  const frame = useRef(0);
  const audio = useRef<CaseAudio | null>(null);
  const t = copy[language];

  useEffect(() => {
    const saved = readCookie<Language>('language');
    const next = saved === 'en' ? 'en' : 'vi';
    setLanguage(next);
    document.documentElement.lang = next;
  }, []);
  const changeLanguage = (next: Language) => {
    setLanguage(next);
    document.documentElement.lang = next;
    try {
      writeCookie('language', next);
    } catch {}
  };
  useEffect(() => {
    document.title = language === 'vi' ? 'Tối Nay Lọ Gì?' : 'Who tonight?';
  }, [language]);
  useEffect(() => {
    const engine = new CaseAudio();
    audio.current = engine;
    engine.preload();
    const handleVisibility = () => {
      if (document.hidden) engine.pause();
      else engine.recover();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      engine.dispose();
      audio.current = null;
    };
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => {
    if (snapshot && !spinning) setActive(snapshot.actresses);
  }, [snapshot, spinning]);
  const eligible = useMemo(
    () => eligibleActresses(active, preferences.profile),
    [active, preferences.profile],
  );
  useEffect(() => {
    if (!eligible.length) {
      setReel([]);
      setVisibleStart(0);
      position.current = reelInitialOffset;
      if (track.current)
        track.current.style.transform = `translate3d(${position.current}px,0,0)`;
      return;
    }
    const firstSlot = Math.floor(Math.random() * eligible.length);
    setReel(
      Array.from({ length: 12 }, (_, index) => {
        const id = firstSlot + index;
        return { id, actress: eligible[id % eligible.length] };
      }),
    );
    setVisibleStart(firstSlot);
    position.current = reelInitialOffset - firstSlot * reelStep;
    if (track.current)
      track.current.style.transform = `translate3d(${position.current}px,0,0)`;
  }, [eligible]);
  useEffect(() => {
    const last = readCookie<{ id?: unknown }>('last-choice');
    if (last?.id && typeof last.id === 'string') {
      const found = active.find((item) => item.id === last.id) ?? null;
      setResult(found);
      setLastChoice(found);
    }
  }, [active]);
  const attachTrack = useCallback((node: HTMLDivElement | null) => {
    track.current = node;
    if (node) node.style.transform = `translate3d(${position.current}px,0,0)`;
  }, []);

  function open() {
    if (busy.current || !eligible.length || !track.current || !viewport.current)
      return;
    audio.current?.unlock();
    busy.current = true;
    const winner = chooseTiered(eligible);
    const step = reelStep,
      tileWidth = 240,
      width = viewport.current.clientWidth;
    const start = position.current;
    const center = Math.floor((width / 2 - start) / step);
    const profile = createSpinProfile(
      Math.random,
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    const target = center + profile.tiles;
    const end = width / 2 - tileWidth * stopFraction() - target * step;
    const current = reel.filter(
      ({ id }) => id >= Math.max(0, center - 6) && id <= target + 4,
    );
    let last = current.length
      ? Math.max(...current.map((item) => item.id))
      : center;
    const recent: Actress[] = [];
    while (last < target + 4) {
      last++;
      const options = eligible.filter((item) => !recent.includes(item));
      const actress =
        last === target
          ? winner
          : chooseTiered(options.length ? options : eligible);
      current.push({ id: last, actress });
      recent.push(actress);
      if (recent.length > 8) recent.shift();
    }
    flushSync(() => {
      setReel(current);
      setSpinning(true);
      setResult(null);
    });
    audio.current?.play('csgo_ui_crate_open');
    const began = performance.now();
    let shown = visibleStart;
    let lastCell = Math.floor((start - width / 2) / step);
    const animate = (now: number) => {
      const progress = Math.max(
        0,
        Math.min(1, (now - began) / profile.durationMs),
      );
      const next =
        start + (end - start) * spinProgress(progress, profile.friction);
      position.current = next;
      const first = Math.max(0, Math.floor(-next / step));
      if (first - shown >= 4 || first < shown) {
        shown = Math.max(0, first - 2);
        setVisibleStart(shown);
      }
      if (track.current)
        track.current.style.transform = `translate3d(${next}px,0,0)`;
      const cell = Math.floor((next - width / 2) / step);
      while (cell !== lastCell) {
        lastCell += cell > lastCell ? 1 : -1;
        audio.current?.play('csgo_ui_crate_item_scroll');
      }
      if (progress < 1) {
        frame.current = requestAnimationFrame(animate);
        return;
      }
      recordSpin(winner);
      void recordServerSpin();
      busy.current = false;
      setSpinning(false);
      setResult(winner);
      setLastChoice(winner);
      setRevealed(true);
      audio.current?.play(
        (
          [
            'item_reveal3_rare',
            'item_reveal4_mythical',
            'item_reveal5_legendary',
            'item_reveal6_ancient',
            'item_reveal6_ancient',
          ] as const
        )[winner.tier],
      );
    };
    frame.current = requestAnimationFrame(animate);
  }

  const allowDirectCardDialog = isDirectCardDialogEnabled();

  const handleCardClick = useCallback(
    (actress: Actress) => {
      if (!allowDirectCardDialog || spinning || busy.current) return;
      setResult(actress);
      setRevealed(true);
    },
    [allowDirectCardDialog, spinning],
  );

  const inventory = useMemo(
    () =>
      [...eligible]
        .sort(
          (a, b) => b.tier - a.tier || a.publicName.localeCompare(b.publicName),
        )
        .map((actress) => (
          <Card
            key={actress.id}
            actress={actress}
            language={language}
            small
            onClick={
              allowDirectCardDialog ? () => handleCardClick(actress) : undefined
            }
          />
        )),
    [eligible, language, allowDirectCardDialog, handleCardClick],
  );
  if (!snapshot)
    return (
      <main className="cache-state">
        <h1>Tối Nay Lọ Gì?</h1>
        <p role="status" title={error?.detail}>
          {error ? t.cacheError : t.loading}
        </p>
      </main>
    );

  return (
    <div className="site-shell">
      <header>
        <Link href="/" className="brand">
          <CircleHelp className="brand-case" size={24} strokeWidth={2.5} />
          <span>
            TỐI NAY <b>LỌ GÌ?</b>
          </span>
        </Link>
        <div className="header-actions">
          <PreferencesPanel
            preferences={preferences}
            actresses={active}
            language={language}
            disabled={spinning}
          />
          <button
            className="language-button"
            onClick={() => changeLanguage(language === 'vi' ? 'en' : 'vi')}
            aria-label={t.language}
          >
            {language === 'vi' ? 'EN' : 'VI'}
          </button>
          <button
            className="sound-button"
            onClick={() => {
              audio.current?.setMuted(sound);
              setSound(!sound);
            }}
            aria-label={sound ? t.turnSoundOff : t.turnSoundOn}
          >
            {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
          <a
            className="github-button"
            href="https://github.com/zennomi/toinaylogi"
            target="_blank"
            rel="noreferrer"
            aria-label={t.github}
          >
            GitHub <ExternalLink size={14} />
          </a>
        </div>
      </header>
      <main>
        <div className="intro">
          <div>
            <h1>{t.subtitle}</h1>
          </div>
          <div className="stattrak-container" title={t.serverCounterTitle}>
            <div className="stattrak-badge">
              <span className="stattrak-label">{t.stattrakLabel}</span>
              <span className="stattrak-caption">{t.stattrakSpins}</span>
              <span
                className="stattrak-digits"
                aria-label={
                  serverSpinStatus === 'unavailable'
                    ? t.serverCounterUnavailable
                    : undefined
                }
              >
                {serverSpins === null
                  ? '—'
                  : String(serverSpins).padStart(6, '0')}
              </span>
            </div>
          </div>
        </div>
        {!error && status?.state === 'refreshing' && (
          <p className="refresh-status" role="status">
            {t.refreshing}
          </p>
        )}
        {error && (
          <p className="preferences-message" role="status" title={error.detail}>
            {error.kind === 'delivery'
              ? t.cacheStale
              : error.kind === 'status'
                ? t.cacheStatusUnavailable
                : t.cacheRefreshFailed}
          </p>
        )}
        {!eligible.length && (
          <p className="preferences-message">{t.noEligible}</p>
        )}
        <div className="cs-case-heading">
          <div className="cs-case-emblem" aria-hidden="true">
            <Box size={20} />
          </div>
          <div className="cs-case-info">
            <span className="cs-case-subtitle">{t.crateCollection}</span>
            <h2 className="cs-case-title">{t.crateTitle}</h2>
          </div>
          <div className={`cs-case-status ${spinning ? 'opening' : 'ready'}`}>
            <span className="cs-case-status-dot" />
            <span>{spinning ? t.openingCase : t.readyToOpen}</span>
          </div>
        </div>
        <section className="case-panel" aria-label={t.caseLabel}>
          <div className="reel-window" ref={viewport}>
            <div className="selector-line">
              <div className="selector-marker top" />
              <div className="selector-marker bottom" />
            </div>
            <div className="reel-track" ref={attachTrack}>
              {reel
                .filter(
                  ({ id }) => id >= visibleStart && id < visibleStart + 12,
                )
                .map(({ actress, id }) => (
                  <Card
                    key={id}
                    actress={actress}
                    language={language}
                    slot={id}
                  />
                ))}
            </div>
            <div className="reel-fade left" />
            <div className="reel-fade right" />
          </div>
        </section>
        <div className="control-bar">
          <div className="last-choice-slot">
            <span className="last-choice-tag">
              {t.lastChoice} ({localSpins}):
            </span>
            {lastChoice ? (
              <div className="last-choice-card">
                <span
                  className="last-choice-tier-pill"
                  style={
                    {
                      '--rarity': colors[lastChoice.tier],
                    } as React.CSSProperties
                  }
                >
                  {t.tiers[lastChoice.tier]}
                </span>
                <strong className="last-choice-name">
                  {lastChoice.publicName}
                </strong>
              </div>
            ) : (
              <span className="last-choice-empty">—</span>
            )}
          </div>
          <button
            className="open-button"
            disabled={spinning || !eligible.length}
            onClick={open}
          >
            {spinning ? <AudioLines size={22} /> : <Sparkles size={21} />}
            {spinning ? t.opening : result ? t.openAgain : t.open}
          </button>
        </div>
        <Dialog open={revealed} onOpenChange={setRevealed}>
          <DialogContent className="winner-dialog" showCloseButton={false}>
            {result &&
              (() => {
                const subNames: string[] = [];
                if (result.nativeName) subNames.push(result.nativeName);
                if (result.nameReading) subNames.push(result.nameReading);
                if (
                  subNames.length === 0 &&
                  result.aliases &&
                  result.aliases.length > 0
                ) {
                  subNames.push(...result.aliases.slice(0, 2));
                }
                const filmCountText = result.videoCount
                  ? `${result.videoCount} ${t.videoCountUnit}`
                  : null;
                const subtitle = [...subNames, filmCountText]
                  .filter(Boolean)
                  .join(' · ');

                const actressAge = getActressAge(result);
                const ageText =
                  actressAge !== undefined
                    ? `${actressAge} ${t.ageLifeUnit}`
                    : null;
                const birthDateText = result.birthDate
                  ? formatBirthDate(result.birthDate, language)
                  : null;
                const birthAndAge =
                  [birthDateText, ageText].filter(Boolean).join(' · ') || '—';

                const careerYears = getCareerYears(result.debutYear);
                const careerYearsText =
                  careerYears !== undefined
                    ? careerYears === 0
                      ? t.careerLessThanOneYear
                      : `${careerYears} ${t.careerYearsUnit}`
                    : null;
                const debutText = result.debutYear
                  ? `${t.debut}: ${result.debutYear}${careerYearsText ? ` · ${careerYearsText}` : ''}`
                  : `${t.debut}: —`;

                const measurements =
                  result.bustCm || result.waistCm || result.hipCm || result.cup
                    ? `B${result.bustCm ?? '—'}${result.cup ? ` (${result.cup.replace(/-Cup$/i, '').trim()})` : ''} · W${result.waistCm ?? '—'} · H${result.hipCm ?? '—'}`
                    : null;
                const heightText = result.heightCm
                  ? `${result.heightCm} cm`
                  : null;

                let measurementsAndHeight: string;
                if (measurements && heightText) {
                  measurementsAndHeight = `${measurements} · ${heightText}`;
                } else if (measurements) {
                  measurementsAndHeight = `${measurements} cm`;
                } else if (heightText) {
                  measurementsAndHeight = heightText;
                } else {
                  measurementsAndHeight = '—';
                }

                const bloodTypeText = `${t.bloodType}: ${result.bloodType || '—'}`;

                const hasProfileData = Boolean(
                  result.birthDate ||
                  actressAge !== undefined ||
                  result.debutYear ||
                  result.bustCm ||
                  result.waistCm ||
                  result.hipCm ||
                  result.cup ||
                  result.heightCm ||
                  result.bloodType,
                );

                return (
                  <>
                    <DialogTitle className="winner-title">
                      {result.name}
                    </DialogTitle>
                    {subtitle && (
                      <p className="winner-native-name">{subtitle}</p>
                    )}
                    <DialogDescription className="winner-description">
                      {t.tiers[result.tier]}
                    </DialogDescription>
                    <div
                      className="winner-art"
                      style={
                        {
                          '--rarity': colors[result.tier],
                        } as React.CSSProperties
                      }
                    >
                      <ActressImage actress={result} alt={result.name} />
                    </div>
                    {hasProfileData && (
                      <div className="winner-details">
                        <div className="winner-detail">
                          <span>{t.profile}</span>
                          <strong>{birthAndAge}</strong>
                          <small className="winner-subdetail">
                            {debutText}
                          </small>
                        </div>

                        <div className="winner-detail">
                          <span>{t.measurements}</span>
                          <strong>{measurementsAndHeight}</strong>
                          <small className="winner-subdetail">
                            {bloodTypeText}
                          </small>
                        </div>
                      </div>
                    )}

                    {result.ratings && (
                      <div className="winner-ratings-card">
                        <div className="winner-ratings-header">
                          <span className="winner-ratings-label">
                            {t.ratings}
                          </span>
                          {result.ratings.overall !== undefined && (
                            <div className="winner-rating-overall">
                              <span className="overall-label">
                                {t.overallScore}
                              </span>
                              <StarRating score={result.ratings.overall} />
                            </div>
                          )}
                        </div>
                        <CharacterStatsRadar ratings={result.ratings} t={t} />
                      </div>
                    )}

                    {(() => {
                      const displayTags = translateTags(result.tags, language);
                      if (displayTags.length === 0) return null;
                      return (
                        <div className="winner-tags" aria-label={t.tags}>
                          <span className="winner-tags-label">{t.tags}:</span>
                          {displayTags.map((tag) => (
                            <span key={tag} className="winner-tag">
                              {tag}
                            </span>
                          ))}
                        </div>
                      );
                    })()}

                    {result.contributingMovies &&
                      result.contributingMovies.length > 0 && (
                        <div className="winner-movies">
                          <span className="winner-movies-label">
                            {t.topFilms}:
                          </span>
                          <div className="winner-movies-list">
                            {result.contributingMovies.map((movie) => (
                              <a
                                key={movie.code}
                                className="winner-movie-chip"
                                href={`https://www.google.com/search?q=${encodeURIComponent(movie.code)}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <span>
                                  #{movie.rank} · {movie.code}
                                </span>
                                <ExternalLink size={11} />
                              </a>
                            ))}
                          </div>
                        </div>
                      )}

                    {(result.socialLinks.length > 0 ||
                      result.wikipediaUrl ||
                      result.minnanoAvUrl) && (
                      <div className="winner-socials">
                        {result.socialLinks.map((social, index) => (
                          <a
                            key={`${social.label}-${social.url}-${index}`}
                            href={social.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {social.label}
                            {social.handle ? ` @${social.handle}` : ''}{' '}
                            <ExternalLink size={11} />
                          </a>
                        ))}
                        {result.wikipediaUrl && (
                          <a
                            href={result.wikipediaUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t.wikipedia} <ExternalLink size={11} />
                          </a>
                        )}
                      </div>
                    )}

                    <div className="winner-actions">
                      <a
                        className="find-button"
                        href={`https://www.google.com/search?q=${encodeURIComponent(result.nativeName || result.name)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span>{t.source}</span>
                        <ExternalLink size={15} />
                      </a>
                      <button onClick={() => setRevealed(false)}>
                        {t.continue}
                      </button>
                    </div>
                  </>
                );
              })()}
          </DialogContent>
        </Dialog>
        <section className="inventory">
          <div className="section-heading">
            <div>
              <span className="eyebrow">{t.whatsInside}</span>
              <div className="inventory-title-row">
                <h2>
                  {t.items} <span>{eligible.length}</span>
                </h2>
                <PreferencesPanel
                  preferences={preferences}
                  actresses={active}
                  language={language}
                  disabled={spinning}
                  variant="inventory"
                />
              </div>
            </div>
            <div className="rarity-legend">
              {t.tiers.map((tier, index) => (
                <span key={tier}>
                  <i style={{ background: colors[index] }} />
                  {tier}
                </span>
              ))}
            </div>
          </div>
          <div className="inventory-grid">{inventory}</div>
        </section>
        <footer>
          <div className="footer-left">
            <span>
              Tối Nay Lọ Gì? ·{' '}
              <a href="/privacy.html">
                {language === 'vi' ? 'Quyền riêng tư' : 'Privacy'}
              </a>{' '}
              ·{' '}
              <a href="/terms.html">
                {language === 'vi' ? 'Điều khoản' : 'Terms'}
              </a>
            </span>
            <span className="footer-source">
              {t.sourceData}{' '}
              {new Intl.DateTimeFormat(language === 'vi' ? 'vi-VN' : 'en-US', {
                dateStyle: 'medium',
              }).format(new Date(snapshot.createdAt))}
            </span>
          </div>
          <div className="footer-right">
            <span>
              {t.inspiredBy}{' '}
              <a
                href="https://github.com/nagisanzenin/truanayangi"
                target="_blank"
                rel="noreferrer"
              >
                nagisanzenin/truanayangi
              </a>
            </span>
            <span>
              {t.adultNote} {t.footer}{' '}
              <a
                href="https://github.com/sourcesounds/csgo"
                target="_blank"
                rel="noreferrer"
              >
                SourceSounds
              </a>
            </span>
          </div>
        </footer>
      </main>
    </div>
  );
}
