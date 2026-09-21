import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo, type ComponentProps } from 'react';
import {
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useReducedMotion } from '@/design/use-reduced-motion';
import type { CatalogEpisode } from '@/domain/podcast';
import {
  railCardCenter,
  railDirectionForRow,
  railFocus,
  railScale,
  railRowSeedOffset,
  railRowSpeed,
  railTranslation,
  type RailDirection,
} from '@/features/home/ambient-podcast-rail-geometry';

export type AmbientPodcastRailProps = {
  episodes: readonly CatalogEpisode[];
  /** Override the system Reduce Motion preference when the parent already knows it. */
  reducedMotion?: boolean;
  /** Motion input; full-field rows turn this into a deliberately slower visual drift. */
  speed?: number;
  style?: StyleProp<ViewStyle>;
};

const MIN_CARD_WIDTH = 142;
const MAX_CARD_WIDTH = 196;
const CARD_HEIGHT_RATIO = 1.16;
const DEFAULT_SPEED = 19;
const MIN_ROW_COUNT = 4;
const MAX_ROW_COUNT = 6;
const ROW_TILT_DEGREES = 4;
const ROW_OPACITIES = [0.58, 0.5, 0.55, 0.48, 0.56, 0.49] as const;
const rankedPodcastArtwork = [
  {
    podcastTitle: 'Crime Junkie',
    uri: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts126/v4/8c/35/04/8c350430-2fbf-98d0-0a25-00b76550ffeb/mza_13445204151221888086.jpg/600x600bb.jpg',
  },
  {
    podcastTitle: 'The Daily',
    uri: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts221/v4/ab/64/66/ab6466a9-9a7d-e20e-7a3d-bc5be37d29ce/mza_15084852813176276273.jpg/600x600bb.jpg',
  },
  {
    podcastTitle: 'Pod Save America',
    uri: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts221/v4/44/dc/61/44dc6141-25e9-5bb3-e19e-a2337233d19e/mza_5506771870755587769.jpg/600x600bb.jpg',
  },
  {
    podcastTitle: 'Dateline NBC',
    uri: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts115/v4/8c/00/7a/8c007a42-e550-0214-d4cb-b59cd7edf194/mza_5305664083935674472.jpeg/600x600bb.jpg',
  },
  {
    podcastTitle: 'This American Life',
    uri: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts221/v4/64/aa/3a/64aa3a66-a08a-947c-cf21-a5722a1b77ae/mza_11390421932467026234.png/600x600bb.jpg',
  },
  {
    podcastTitle: 'The Joe Rogan Experience',
    uri: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts221/v4/28/ef/d3/28efd382-e0cf-7dd6-99c7-7b74b30a616f/mza_3890332495421370376.jpg/600x600bb.jpg',
  },
  {
    podcastTitle: 'Morbid',
    uri: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/v4/78/e9/0e/78e90ee0-567d-1ad8-17a0-17d7c988c4bd/mza_8425901783365617933.jpg/600x600bb.jpg',
  },
  {
    podcastTitle: 'Up First from NPR',
    uri: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/v4/0e/35/25/0e352569-e694-81d9-ea55-5f935981c15a/mza_1788275989855583986.png/600x600bb.jpg',
  },
  {
    podcastTitle: 'The Bill Simmons Podcast',
    uri: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/v4/7a/98/73/7a987302-599c-9285-c210-fca2c83b9450/mza_1946147658144436679.jpg/600x600bb.jpg',
  },
  {
    podcastTitle: 'The Rest Is History',
    uri: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/v4/a3/05/8f/a3058ff1-eff9-036b-f412-8c4e96aad380/mza_221907431660085079.jpg/600x600bb.jpg',
  },
  {
    podcastTitle: 'Mick Unplugged',
    uri: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts221/v4/f8/75/0c/f8750cf1-ca31-5d55-00a1-ce86329309d5/mza_11785095184998327365.jpeg/600x600bb.jpg',
  },
  {
    podcastTitle: 'COERCED',
    uri: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/v4/ca/db/35/cadb3557-aa6f-6cf2-38d8-524f2fcc4314/mza_10387182729682199580.jpeg/600x600bb.jpg',
  },
] as const;

type ArtworkSource = ComponentProps<typeof Image>['source'];

type AmbientArtworkRowProps = {
  cardHeight: number;
  cardWidth: number;
  cycleEpisodes: readonly CatalogEpisode[];
  cycleWidth: number;
  direction: RailDirection;
  gap: number;
  itemSpan: number;
  reducedMotion: boolean;
  rowIndex: number;
  speed: number;
  viewportWidth: number;
};

type AmbientArtworkCardProps = {
  artworkSource: ArtworkSource;
  cardHeight: number;
  cardWidth: number;
  episode: CatalogEpisode;
  index: number;
  itemSpan: number;
  progress: SharedValue<number>;
  reducedMotion: boolean;
  rowIndex: number;
  seedOffset: number;
  direction: RailDirection;
  cycleWidth: number;
  viewportWidth: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function artworkFor(
  episode: CatalogEpisode,
  itemIndex: number,
  rowIndex: number,
): ArtworkSource {
  const artworkIndex = (itemIndex + rowIndex * 3) % rankedPodcastArtwork.length;

  return rankedPodcastArtwork[artworkIndex]
    ?? (episode.artworkUrl ? { uri: episode.artworkUrl } : undefined);
}

function trackTestID(rowIndex: number) {
  if (rowIndex === 0) return 'ambient-podcast-track';
  if (rowIndex === 1) return 'ambient-podcast-depth-track';
  return `ambient-podcast-row-${rowIndex}`;
}

function AmbientArtworkCard({
  artworkSource,
  cardHeight,
  cardWidth,
  cycleWidth,
  direction,
  episode,
  index,
  itemSpan,
  progress,
  reducedMotion,
  rowIndex,
  seedOffset,
  viewportWidth,
}: AmbientArtworkCardProps) {
  const animatedStyle = useAnimatedStyle(() => {
    const translation = railTranslation(
      reducedMotion ? 0 : progress.value,
      cycleWidth,
      seedOffset,
      direction,
    );
    const cardCenter = railCardCenter(index, itemSpan, translation) + cardWidth / 2;
    const focus = railFocus(cardCenter, viewportWidth, itemSpan);
    const scale = reducedMotion ? 1 : railScale(focus);

    return {
      transform: [{ scale }],
    };
  });

  return (
    <Animated.View
      testID={`ambient-podcast-card-${rowIndex}-${index}`}
      style={[
        {
          width: cardWidth,
          height: cardHeight,
          overflow: 'hidden',
          borderRadius: clamp(Math.round(cardWidth * 0.1), 10, 16),
          borderCurve: 'continuous',
          backgroundColor: episode.accentSoft,
          boxShadow: '0 22px 48px rgba(0,0,0,0.56)',
        },
        animatedStyle,
      ]}
    >
      {artworkSource ? (
        <Image
          source={artworkSource}
          contentFit="cover"
          transition={0}
          style={{ position: 'absolute', inset: 0 }}
        />
      ) : null}
      <View
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(6,7,11,0.26)',
        }}
      />
    </Animated.View>
  );
}

function AmbientArtworkRow({
  cardHeight,
  cardWidth,
  cycleEpisodes,
  cycleWidth,
  direction,
  gap,
  itemSpan,
  reducedMotion,
  rowIndex,
  speed,
  viewportWidth,
}: AmbientArtworkRowProps) {
  const progress = useSharedValue(0);
  const seedOffset = railRowSeedOffset(rowIndex, itemSpan);
  const renderedEpisodes = useMemo(
    () => [...cycleEpisodes, ...cycleEpisodes],
    [cycleEpisodes],
  );

  useEffect(() => {
    cancelAnimation(progress);
    progress.set(0);

    if (reducedMotion || cycleWidth <= 0) return;

    const pixelsPerSecond = railRowSpeed(speed, rowIndex);
    const duration = Math.max(
      60_000,
      Math.round((cycleWidth / pixelsPerSecond) * 1_000),
    );

    progress.set(
      withRepeat(
        withTiming(1, {
          duration,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.Never,
        }),
        -1,
        false,
        undefined,
        ReduceMotion.Never,
      ),
    );

    return () => cancelAnimation(progress);
  }, [cycleWidth, progress, reducedMotion, rowIndex, speed]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{
      translateX: railTranslation(
        reducedMotion ? 0 : progress.value,
        cycleWidth,
        seedOffset,
        direction,
      ),
    }],
  }));

  return (
    <Animated.View
      testID={trackTestID(rowIndex)}
      style={[
        {
          position: 'absolute',
          top: 0,
          left: -itemSpan,
          height: cardHeight + 30,
          flexDirection: 'row',
          alignItems: 'center',
          gap,
          opacity: ROW_OPACITIES[rowIndex % ROW_OPACITIES.length] ?? 0.42,
        },
        animatedStyle,
      ]}
    >
      {renderedEpisodes.map((episode, index) => {
        const cycleIndex = index % cycleEpisodes.length;
        const artworkSource = artworkFor(episode, cycleIndex, rowIndex);

        return (
          <AmbientArtworkCard
            artworkSource={artworkSource}
            cardHeight={cardHeight}
            cardWidth={cardWidth}
            cycleWidth={cycleWidth}
            direction={direction}
            episode={episode}
            index={index}
            itemSpan={itemSpan}
            key={`row-${rowIndex}-${episode.id}-${index}`}
            progress={progress}
            reducedMotion={reducedMotion}
            rowIndex={rowIndex}
            seedOffset={seedOffset}
            viewportWidth={viewportWidth}
          />
        );
      })}
    </Animated.View>
  );
}

export function AmbientPodcastRail({
  episodes,
  reducedMotion,
  speed = DEFAULT_SPEED,
  style,
}: AmbientPodcastRailProps) {
  const { height: viewportHeight, width: viewportWidth } = useWindowDimensions();
  const systemReducedMotion = useReducedMotion();
  const shouldReduceMotion = reducedMotion ?? systemReducedMotion;
  const cardWidth = clamp(
    Math.round(viewportWidth * 0.365),
    MIN_CARD_WIDTH,
    MAX_CARD_WIDTH,
  );
  const cardHeight = Math.round(cardWidth * CARD_HEIGHT_RATIO);
  const gap = clamp(Math.round(viewportWidth * 0.042), 14, 22);
  const itemSpan = cardWidth + gap;
  const fieldOverscan = clamp(Math.round(cardHeight * 0.46), 64, 92);
  const fieldHeight = viewportHeight + fieldOverscan * 2;
  const rowGap = clamp(Math.round(cardHeight * 0.2), 25, 38);
  const rowStride = cardHeight + rowGap;
  const rowCount = clamp(
    Math.ceil(fieldHeight / rowStride),
    MIN_ROW_COUNT,
    MAX_ROW_COUNT,
  );

  const cycleEpisodes = useMemo(() => {
    if (episodes.length === 0) return [];

    const itemCount = Math.max(
      5,
      Math.ceil((viewportWidth + itemSpan * 2) / itemSpan),
    );

    return Array.from(
      { length: itemCount },
      (_, index) => episodes[index % episodes.length]!,
    );
  }, [episodes, itemSpan, viewportWidth]);

  const cycleWidth = cycleEpisodes.length * itemSpan;

  if (cycleEpisodes.length === 0) return null;

  return (
    <View
      testID="ambient-podcast-rail"
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width: '100%',
          height: viewportHeight,
          overflow: 'visible',
          pointerEvents: 'none',
        },
        style,
      ]}
    >
      <View
        style={{
          position: 'absolute',
          top: -fieldOverscan,
          right: 0,
          bottom: -fieldOverscan,
          left: 0,
          overflow: 'hidden',
        }}
      >
        {Array.from({ length: rowCount }, (_, rowIndex) => (
          <View
            key={`ambient-row-${rowIndex}`}
            style={{
              position: 'absolute',
              top: rowIndex * rowStride,
              right: -Math.round(cardWidth * 0.28),
              left: -Math.round(cardWidth * 0.28),
              height: cardHeight + 18,
              transform: [{ rotate: `${ROW_TILT_DEGREES}deg` }],
            }}
          >
            <AmbientArtworkRow
              cardHeight={cardHeight}
              cardWidth={cardWidth}
              cycleEpisodes={cycleEpisodes}
              cycleWidth={cycleWidth}
              direction={railDirectionForRow(rowIndex)}
              gap={gap}
              itemSpan={itemSpan}
              reducedMotion={shouldReduceMotion}
              rowIndex={rowIndex}
              speed={speed}
              viewportWidth={viewportWidth}
            />
          </View>
        ))}

        <LinearGradient
          colors={[
            'rgba(8,9,13,0.28)',
            'rgba(8,9,13,0.1)',
            'rgba(8,9,13,0.18)',
            'rgba(8,9,13,0.5)',
          ]}
          end={{ x: 0.5, y: 1 }}
          locations={[0, 0.24, 0.66, 1]}
          start={{ x: 0.5, y: 0 }}
          style={{ position: 'absolute', inset: 0 }}
        />
        <LinearGradient
          colors={[
            'rgba(8,9,13,0.24)',
            'rgba(8,9,13,0.02)',
            'rgba(8,9,13,0.22)',
          ]}
          end={{ x: 1, y: 0.5 }}
          locations={[0, 0.48, 1]}
          start={{ x: 0, y: 0.5 }}
          style={{ position: 'absolute', inset: 0 }}
        />
        <View
          style={{
            position: 'absolute',
            width: Math.min(viewportWidth * 1.05, 520),
            height: Math.min(viewportWidth * 1.05, 520),
            top: Math.round(fieldHeight * 0.28),
            alignSelf: 'center',
            borderRadius: 999,
            backgroundColor: 'rgba(8,6,13,0.15)',
            boxShadow: '0 0 120px rgba(9,5,13,0.58)',
          }}
        />
      </View>
    </View>
  );
}
