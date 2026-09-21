import { Image } from 'expo-image';
import { Text, View } from 'react-native';

import type { AppTheme } from '@/design/tokens';

type BrandLockupProps = {
  gap?: number;
  markSize?: number;
  textSize?: number;
  theme: AppTheme;
};

export function BrandLockup({
  gap = 12,
  markSize = 42,
  textSize = 14,
  theme,
}: BrandLockupProps) {
  const markRadius = Math.round(markSize / 3);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap }}>
      <View
        style={{
          width: markSize,
          height: markSize,
          borderRadius: markRadius,
          borderCurve: 'continuous',
          overflow: 'hidden',
        }}
      >
        <Image
          accessibilityLabel="Murmur mark"
          source={require('@/assets/images/brand-mark.png')}
          contentFit="cover"
          style={{ width: markSize, height: markSize }}
        />
      </View>
      <Text
        selectable
        style={{
          color: theme.colors.ink,
          fontFamily: theme.fonts.semibold,
          fontSize: textSize,
          letterSpacing: textSize * 0.17,
        }}
      >
        MURMUR
      </Text>
    </View>
  );
}
