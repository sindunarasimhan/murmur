import { Text, View } from 'react-native';

import type { AppTheme } from '@/design/tokens';

type FoundationCardProps = {
  theme: AppTheme;
};

const platforms = [
  { label: 'iPhone', value: 'Expo Go + EAS' },
  { label: 'Web', value: 'Static export' },
  { label: 'Foundation', value: 'Type-safe' },
] as const;

export function FoundationCard({ theme }: FoundationCardProps) {
  return (
    <View
      style={{
        width: '100%',
        padding: 28,
        gap: 26,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.line,
        borderRadius: theme.radii.lg,
        borderCurve: 'continuous',
        boxShadow: theme.shadow,
      }}
    >
      <View style={{ gap: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: theme.colors.coral,
            }}
          />
          <Text
            selectable
            style={{
              color: theme.colors.muted,
              fontFamily: theme.fonts.semibold,
              fontSize: 11,
              letterSpacing: 1.8,
            }}
          >
            READY TO GROW
          </Text>
        </View>

        <Text
          selectable
          style={{
            color: theme.colors.ink,
            fontFamily: theme.fonts.display,
            fontSize: 34,
            lineHeight: 38,
            letterSpacing: -0.7,
          }}
        >
          One codebase.{`\n`}Two homes.
        </Text>

        <Text
          selectable
          style={{
            color: theme.colors.muted,
            fontFamily: theme.fonts.body,
            fontSize: 14,
            lineHeight: 22,
          }}
        >
          A calm, responsive shell for expressive product work on native and web.
        </Text>
      </View>

      <View style={{ height: 1, backgroundColor: theme.colors.line }} />

      <View style={{ gap: 15 }}>
        {platforms.map((platform) => (
          <View
            key={platform.label}
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            <Text
              selectable
              style={{
                color: theme.colors.muted,
                fontFamily: theme.fonts.body,
                fontSize: 13,
              }}
            >
              {platform.label}
            </Text>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'flex-end',
                flexShrink: 1,
                gap: 8,
              }}
            >
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: theme.colors.success,
                }}
              />
              <Text
                selectable
                style={{
                  color: theme.colors.ink,
                  fontFamily: theme.fonts.medium,
                  fontSize: 13,
                  flexShrink: 1,
                  textAlign: 'right',
                }}
              >
                {platform.value}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
