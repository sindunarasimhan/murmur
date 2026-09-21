import Feather from '@expo/vector-icons/Feather';
import { useState, type ComponentProps } from 'react';
import { Pressable, type PressableProps } from 'react-native';

import type { AppTheme } from '@/design/tokens';

type FeatherName = ComponentProps<typeof Feather>['name'];

type MurmurIconButtonProps = Omit<PressableProps, 'children'> & {
  icon: FeatherName;
  label: string;
  theme: AppTheme;
  size?: number;
  iconSize?: number;
  emphasis?: 'quiet' | 'solid' | 'warm';
};

export function MurmurIconButton({
  icon,
  label,
  theme,
  size = 48,
  iconSize = 20,
  emphasis = 'quiet',
  disabled,
  style,
  onBlur,
  onFocus,
  ...pressableProps
}: MurmurIconButtonProps) {
  const [focused, setFocused] = useState(false);
  const backgroundColor =
    emphasis === 'solid'
      ? theme.colors.ink
      : emphasis === 'warm'
        ? theme.colors.coral
        : 'rgba(255,255,255,0.055)';
  const foreground = emphasis === 'quiet' ? theme.colors.ink : theme.colors.canvas;

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={8}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      style={(state) => [
        {
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: size / 2,
          borderWidth: focused ? 2 : emphasis === 'quiet' ? 1 : 0,
          borderColor: focused ? theme.colors.coral : theme.colors.line,
          backgroundColor,
          boxShadow: focused ? `0 0 0 3px ${theme.colors.coralWash}` : undefined,
          opacity: disabled ? 0.34 : state.pressed ? 0.68 : 1,
          transform: [{ scale: state.pressed ? 0.96 : 1 }],
        },
        typeof style === 'function' ? style(state) : style,
      ]}
      {...pressableProps}
    >
      <Feather name={icon} size={iconSize} color={foreground} />
    </Pressable>
  );
}
