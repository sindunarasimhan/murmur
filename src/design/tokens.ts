export const spacing = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 24,
  xl: 36,
  xxl: 56,
  hero: 88,
} as const;

export const radii = {
  sm: 14,
  md: 22,
  lg: 32,
  pill: 999,
} as const;

export const fonts = {
  display: 'Newsreader_400Regular',
  displayItalic: 'Newsreader_400Regular_Italic',
  body: 'Manrope_400Regular',
  medium: 'Manrope_500Medium',
  semibold: 'Manrope_600SemiBold',
} as const;

const lightColors = {
  canvas: '#F4F0E8',
  ink: '#171512',
  muted: '#655F58',
  subtle: '#817A72',
  line: 'rgba(23, 21, 18, 0.12)',
  surface: 'rgba(255, 253, 249, 0.84)',
  surfaceStrong: '#FFFCF7',
  coral: '#C86946',
  coralWash: 'rgba(200, 105, 70, 0.14)',
  violetWash: 'rgba(105, 88, 167, 0.11)',
  success: '#437B68',
  gold: '#A5763C',
  dim: 'rgba(23, 21, 18, 0.48)',
  scrim: 'rgba(244, 240, 232, 0.86)',
} as const;

const darkColors = {
  canvas: '#08090B',
  ink: '#F6F2E9',
  muted: '#B5B0A9',
  subtle: '#817E79',
  line: 'rgba(246, 242, 233, 0.12)',
  surface: 'rgba(24, 24, 27, 0.86)',
  surfaceStrong: '#18191D',
  coral: '#E9A267',
  coralWash: 'rgba(222, 126, 82, 0.18)',
  violetWash: 'rgba(114, 91, 172, 0.18)',
  success: '#72C6A8',
  gold: '#E5B877',
  dim: 'rgba(246, 242, 233, 0.5)',
  scrim: 'rgba(8, 9, 11, 0.88)',
} as const;

export const lightTheme = {
  isDark: false,
  colors: lightColors,
  spacing,
  radii,
  fonts,
  shadow: '0 24px 80px rgba(68, 48, 38, 0.12)',
} as const;

export const darkTheme = {
  isDark: true,
  colors: darkColors,
  spacing,
  radii,
  fonts,
  shadow: '0 28px 90px rgba(0, 0, 0, 0.48)',
} as const;

export type AppTheme = typeof lightTheme | typeof darkTheme;
