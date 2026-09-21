import { LinearGradient } from 'expo-linear-gradient';
import { View } from 'react-native';

import type { AppTheme } from '@/design/tokens';

type AmbientBackdropProps = {
  accent?: string;
  accentSoft?: string;
  compact: boolean;
  theme: AppTheme;
};

export function AmbientBackdrop({ accent, accentSoft, compact, theme }: AmbientBackdropProps) {
  const largeOrb = compact ? 340 : 620;
  const smallOrb = compact ? 250 : 460;
  const primaryWash = accentSoft ?? theme.colors.coralWash;
  const hairline = accent ? `${accent}2E` : theme.colors.line;

  return (
    <View
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <LinearGradient
        colors={['#0F1013', theme.colors.canvas, '#090A0D']}
        start={{ x: 0.05, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={{ position: 'absolute', inset: 0 }}
      />
      <View
        style={{
          position: 'absolute',
          width: largeOrb,
          height: largeOrb,
          top: compact ? -168 : -330,
          right: compact ? -178 : -170,
          borderRadius: largeOrb / 2,
          backgroundColor: primaryWash,
          opacity: 0.66,
        }}
      />
      <View
        style={{
          position: 'absolute',
          width: smallOrb,
          height: smallOrb,
          bottom: compact ? -140 : -260,
          left: compact ? -130 : -170,
          borderRadius: smallOrb / 2,
          backgroundColor: theme.colors.violetWash,
          opacity: 0.7,
        }}
      />
      <View
        style={{
          position: 'absolute',
          width: compact ? 180 : 360,
          height: compact ? 180 : 360,
          top: compact ? '38%' : '31%',
          right: compact ? -132 : -190,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: hairline,
        }}
      />
      {Array.from({ length: 7 }).map((_, index) => (
        <View
          key={index}
          style={{
            position: 'absolute',
            left: `${10 + index * 14}%`,
            top: 0,
            bottom: 0,
            width: 1,
            backgroundColor: 'rgba(255,255,255,0.018)',
          }}
        />
      ))}
    </View>
  );
}
