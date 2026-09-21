import Feather from '@expo/vector-icons/Feather';
import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, Text, View } from 'react-native';

import type { AppTheme } from '@/design/tokens';
import type { InquiryCategory } from '@/domain/voice-intent';
import type { ListeningMode } from '@/features/listening/player-stage';
import type { ExplorationTurn } from '@/features/listening/use-listening-session';

type VoiceSessionPanelProps = {
  compact: boolean;
  mode: ListeningMode;
  transcriptText: string;
  response?: string;
  responseCategory?: InquiryCategory;
  responseProvider?: 'local' | 'openai';
  activityMessage?: string;
  turns: readonly ExplorationTurn[];
  recordingDurationMillis: number;
  onSubmit: (text: string) => void;
  onAskByVoice: () => void;
  onCancel: () => void;
  onReturn: () => void;
  theme: AppTheme;
};

const prompts = [
  { label: 'Skip ad', value: 'Skip this ad' },
  { label: 'Clarify', value: 'What does that mean?' },
  { label: 'Check the numbers', value: 'Do those numbers add up?' },
  { label: 'Challenge it', value: 'Make the strongest case against that argument.' },
  { label: 'Go deeper', value: 'What does this imply about society and values?' },
] as const;

function panelTitle(mode: ListeningMode): string {
  if (mode === 'listening') return 'What are you thinking?';
  if (mode === 'processing') return 'Holding your place…';
  if (mode === 'speaking') return 'Murmur is responding';
  if (mode === 'error') return 'I kept your place.';
  return 'The thread is open.';
}

export function VoiceSessionPanel({
  compact,
  mode,
  transcriptText,
  response,
  responseCategory,
  responseProvider,
  activityMessage,
  turns,
  recordingDurationMillis,
  onSubmit,
  onAskByVoice,
  onCancel,
  onReturn,
  theme,
}: VoiceSessionPanelProps) {
  const listening = mode === 'listening';
  const processing = mode === 'processing';
  const showingAnswer = mode === 'speaking' || mode === 'exploring' || mode === 'error';
  const seconds = Math.floor(recordingDurationMillis / 1000);
  const statusLabel = listening
    ? 'VOICE CAPTURE'
    : responseCategory
      ? `MURMUR${mode === 'speaking' ? ' VOICE' : ''} · ${responseCategory.toUpperCase()}`
      : 'MURMUR · EPISODE CONTEXT';
  const priorTurns = turns.slice(0, -1);

  return (
    <View
      style={{
        overflow: 'hidden',
        borderRadius: compact ? 28 : 34,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(178,155,255,0.28)',
        backgroundColor: '#15131D',
      }}
    >
      <LinearGradient
        colors={['rgba(106,76,158,0.28)', 'rgba(21,19,29,0.92)', 'rgba(12,13,16,0.98)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ position: 'absolute', inset: 0 }}
      />

      <View style={{ gap: 22, padding: compact ? 20 : 28 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 18,
          }}
        >
          <View style={{ flex: 1, gap: 7 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: listening ? '#E9A267' : '#B29BFF',
                }}
              />
              <Text
                accessibilityLiveRegion="polite"
                style={{
                  color: '#BDAEF4',
                  fontFamily: theme.fonts.semibold,
                  fontSize: 9,
                  letterSpacing: 1.55,
                }}
              >
                {statusLabel}
              </Text>
              {listening ? (
                <Text
                  style={{
                    color: '#BDAEF4',
                    fontFamily: theme.fonts.semibold,
                    fontSize: 9,
                    letterSpacing: 1.1,
                  }}
                >
                  · {seconds}s
                </Text>
              ) : null}
            </View>
            <Text
              accessibilityRole="header"
              style={{
                color: theme.colors.ink,
                fontFamily: theme.fonts.display,
                fontSize: compact ? 32 : 38,
                lineHeight: compact ? 35 : 41,
                letterSpacing: -0.7,
              }}
            >
              {panelTitle(mode)}
            </Text>
          </View>

          <Pressable
            accessibilityLabel="Close voice interaction"
            accessibilityRole="button"
            onPress={onCancel}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 22,
              borderWidth: 1,
              borderColor: theme.colors.line,
              opacity: pressed ? 0.55 : 1,
            })}
          >
            <Feather name="x" size={18} color={theme.colors.ink} />
          </Pressable>
        </View>

        {listening ? (
          <Text
            accessibilityLabel="What Murmur heard"
            accessibilityLiveRegion="polite"
            ellipsizeMode="head"
            numberOfLines={2}
            style={{
              minHeight: compact ? 88 : 104,
              padding: 0,
              color: transcriptText ? theme.colors.ink : theme.colors.subtle,
              fontFamily: theme.fonts.display,
              fontSize: compact ? 24 : 28,
              lineHeight: compact ? 31 : 36,
              textAlign: 'center',
            }}
          >
            {transcriptText || 'Listening…'}
          </Text>
        ) : null}

        {processing ? (
          <View style={{ gap: 13 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 5, height: 32 }}>
              {[15, 26, 20, 31, 18, 24, 13].map((height, index) => (
                <View
                  key={`${height}-${index}`}
                  style={{
                    width: 4,
                    height,
                    borderRadius: 2,
                    backgroundColor: index % 2 ? '#B29BFF' : theme.colors.coral,
                    opacity: 0.68,
                  }}
                />
              ))}
            </View>
            <Text style={{ color: theme.colors.muted, fontFamily: theme.fonts.body, fontSize: 13 }}>
              {activityMessage ??
                'Reading the nearby transcript and keeping the episode timestamp attached.'}
            </Text>
          </View>
        ) : null}

        {!listening && transcriptText ? (
          <View
            accessibilityLiveRegion="polite"
            style={{
              gap: 5,
              paddingBottom: 14,
              borderBottomWidth: 1,
              borderBottomColor: 'rgba(189,174,244,0.16)',
            }}
          >
            <Text
              style={{
                color: '#BDAEF4',
                fontFamily: theme.fonts.semibold,
                fontSize: 9,
                letterSpacing: 1.4,
              }}
            >
              YOU
            </Text>
            <Text
              selectable
              style={{
                color: theme.colors.ink,
                fontFamily: theme.fonts.body,
                fontSize: 13,
                lineHeight: 20,
              }}
            >
              {transcriptText}
            </Text>
          </View>
        ) : null}

        {showingAnswer && response ? (
          <View style={{ gap: 18 }}>
            {priorTurns.length ? (
              <View style={{ gap: 12 }}>
                {priorTurns.map((turn) => (
                  <View
                    key={turn.id}
                    style={{
                      gap: 6,
                      paddingBottom: 12,
                      borderBottomWidth: 1,
                      borderBottomColor: 'rgba(189,174,244,0.14)',
                    }}
                  >
                    <Text
                      numberOfLines={2}
                      style={{
                        color: '#D4C8FF',
                        fontFamily: theme.fonts.semibold,
                        fontSize: 10,
                        lineHeight: 16,
                      }}
                    >
                      YOU · {turn.question}
                    </Text>
                    <Text
                      numberOfLines={3}
                      style={{
                        color: theme.colors.muted,
                        fontFamily: theme.fonts.body,
                        fontSize: 11,
                        lineHeight: 18,
                      }}
                    >
                      {turn.answer}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            <Text
              selectable
              style={{
                maxWidth: 860,
                color: theme.colors.ink,
                fontFamily: theme.fonts.body,
                fontSize: compact ? 15 : 16,
                lineHeight: compact ? 24 : 27,
              }}
            >
              {response}
            </Text>

            {mode !== 'error' ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {prompts.slice(2).map((prompt) => (
                  <Pressable
                    key={prompt.label}
                    accessibilityRole="button"
                    onPress={() => onSubmit(prompt.value)}
                    style={({ pressed }) => ({
                      paddingHorizontal: 13,
                      minHeight: 44,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: 'rgba(189,174,244,0.22)',
                      opacity: pressed ? 0.58 : 1,
                    })}
                  >
                    <Text
                      style={{ color: '#D4C8FF', fontFamily: theme.fonts.medium, fontSize: 11 }}
                    >
                      {prompt.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              <Pressable
                accessibilityLabel="Ask another question by voice"
                accessibilityRole="button"
                onPress={onAskByVoice}
                style={({ pressed }) => ({
                  minHeight: 48,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingHorizontal: 16,
                  borderRadius: 23,
                  borderWidth: 1,
                  borderColor: theme.colors.line,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Feather name="mic" size={15} color={theme.colors.ink} />
                <Text style={{ color: theme.colors.ink, fontFamily: theme.fonts.semibold, fontSize: 10 }}>
                  ASK BY VOICE
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Return to episode"
                accessibilityRole="button"
                onPress={onReturn}
                style={({ pressed }) => ({
                  minHeight: 48,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingHorizontal: 17,
                  borderRadius: 23,
                  backgroundColor: theme.colors.ink,
                  opacity: pressed ? 0.68 : 1,
                })}
              >
                <Feather name="play" size={14} color={theme.colors.canvas} />
                <Text
                  style={{ color: theme.colors.canvas, fontFamily: theme.fonts.semibold, fontSize: 10 }}
                >
                  RETURN TO EPISODE
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        <Text style={{ color: theme.colors.subtle, fontFamily: theme.fonts.medium, fontSize: 10 }}>
          {responseProvider === 'openai'
            ? 'MURMUR RESPONSE · GROUNDED IN THIS EPISODE'
            : responseProvider === 'local'
              ? 'MURMUR PREVIEW · THIS EPISODE ONLY'
              : 'THE EPISODE STAYS PAUSED WHILE YOU EXPLORE'}
        </Text>
      </View>
    </View>
  );
}
