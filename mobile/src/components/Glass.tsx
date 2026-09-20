import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { GlassContainer, GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';

/**
 * Liquid Glass, with somewhere to stand when there is none.
 *
 * `GlassView` is `UIGlassEffect`, which exists from iOS 26. This app's deployment target
 * is 17.0, so on a phone a year older the effect is simply absent and `expo-glass-effect`
 * renders a plain `View` — transparent, over a live camera feed, which means invisible
 * controls rather than ugly ones. Everything here therefore carries its own translucent
 * fallback and only hands the drawing to the system when the system can actually do it.
 *
 * Evaluated once: the answer depends on the OS and the SDK the binary was compiled
 * against, neither of which changes while the app is running.
 */
export const liquidGlass = isLiquidGlassAvailable();

/**
 * The iOS 17-25 stand-in, and the floor under the real thing.
 *
 * Dark and fairly opaque. Glass over a live camera feed is only as readable as whatever
 * the camera happens to be pointed at, and a bright wall behind a caption turns light
 * text into nothing. A pale panel looks better in a screenshot and is unreadable in a
 * sunlit room, which is where this app is used.
 */
const fallback: ViewStyle = {
  backgroundColor: 'rgba(7,13,21,0.82)',
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: 'rgba(255,255,255,0.18)',
};

/**
 * Darkens real glass for the same reason.
 *
 * `UIGlassEffect` adapts to what is behind it, but it adapts towards the BACKDROP, not
 * towards the text on top — so a caption over a white wall ends up light-on-light. A
 * tint costs none of the material's depth and guarantees the floor.
 */
export const GLASS_TINT = 'rgba(6,12,20,0.5)';

/** A glass slab. Used for anything that is read rather than pressed. */
export function GlassPanel({
  children,
  style,
  tintColor,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  tintColor?: string;
}) {
  if (!liquidGlass) return <View style={[fallback, style]}>{children}</View>;
  return (
    <GlassView glassEffectStyle="regular" tintColor={tintColor ?? GLASS_TINT} style={style}>
      {children}
    </GlassView>
  );
}

/**
 * A round glass button.
 *
 * `isInteractive` is what makes the glass respond to the press — it flexes, brightens and
 * catches a specular highlight the way system glass does. Set here rather than left to
 * each caller to remember, because without it the control is a static disc and every bit
 * of the material's point is lost.
 *
 * Nothing is painted on top of it. A hand-drawn streak and edge line were tried and
 * removed: `UIGlassEffect` already lights its own edges, and two translucent rectangles
 * imitating that on top of a material that is doing it properly reads as a sticker on a
 * window.
 */
export function GlassCircle({
  size,
  onPress,
  onLongPress,
  disabled,
  tintColor,
  accessibilityLabel,
  children,
}: {
  size: number;
  onPress: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  tintColor?: string;
  accessibilityLabel: string;
  children: ReactNode;
}) {
  const shape: ViewStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  };
  const content = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      // Fills the glass rather than sitting inside it, so the whole disc is the target.
      style={({ pressed }) => [
        StyleSheet.absoluteFill,
        { alignItems: 'center', justifyContent: 'center' },
        // The system animates its own press state; only the fallback needs this.
        !liquidGlass && pressed ? { opacity: 0.6 } : null,
        disabled ? { opacity: 0.4 } : null,
      ]}
    >
      {children}
    </Pressable>
  );
  if (!liquidGlass) return <View style={[shape, fallback]}>{content}</View>;
  return (
    <GlassView glassEffectStyle="regular" isInteractive tintColor={tintColor ?? GLASS_TINT} style={shape}>
      {content}
    </GlassView>
  );
}

/** A glass pill with a word on it. The only text button the app has left. */
export function GlassPill({
  label,
  onPress,
  disabled,
  tone = 'normal',
  size = 'normal',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'normal' | 'quiet';
  /**
   * `large` is the one call to action on a screen; `wide` is the secondary directly
   * under it — the same width so the two read as one column, but slimmer, because a
   * second button of equal weight means neither is the answer.
   */
  size?: 'normal' | 'large' | 'wide';
}) {
  const full = size === 'large' || size === 'wide';
  const big = size === 'large';
  const radius = big ? 32 : size === 'wide' ? 22 : 24;
  const shape: ViewStyle = {
    borderRadius: radius,
    overflow: 'hidden',
    minWidth: full ? 240 : 96,
    alignSelf: full ? 'stretch' : 'auto',
  };
  const body = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          paddingVertical: big ? 19 : size === 'wide' ? 11 : 13,
          paddingHorizontal: big ? 32 : 22,
          alignItems: 'center',
        },
        !liquidGlass && pressed ? { opacity: 0.6 } : null,
        disabled ? { opacity: 0.4 } : null,
      ]}
    >
      <Text
        style={{
          color: tone === 'quiet' ? '#cfddea' : '#f6fafe',
          fontSize: big ? 19 : size === 'wide' ? 15 : 16,
          fontWeight: tone === 'quiet' ? '500' : '600',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
  if (!liquidGlass) return <View style={[shape, fallback]}>{body}</View>;
  return (
    <GlassView glassEffectStyle="regular" isInteractive tintColor={GLASS_TINT} style={shape}>
      {body}
    </GlassView>
  );
}

/**
 * Groups glass so it behaves as one material.
 *
 * Two discs this close would each refract independently and read as two unrelated
 * controls; inside a container within `spacing` they merge and separate as one piece of
 * glass when they move. Degrades to a plain row, which is what the fallback wants anyway.
 */
export function GlassCluster({
  children,
  spacing = 20,
  style,
}: {
  children: ReactNode;
  spacing?: number;
  style?: StyleProp<ViewStyle>;
}) {
  if (!liquidGlass) return <View style={[{ flexDirection: 'row' }, style]}>{children}</View>;
  return (
    <GlassContainer spacing={spacing} style={[{ flexDirection: 'row' }, style]}>
      {children}
    </GlassContainer>
  );
}
