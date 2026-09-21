export function formatDuration(seconds: number | undefined): string {
  if (!Number.isFinite(seconds) || !seconds || seconds < 0) return '0:00';

  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export function dateLabel(value: string | undefined): string {
  if (!value) return 'RECENT EPISODE';

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'RECENT EPISODE';

  return parsed
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    .toUpperCase();
}

export function greetingForNow(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning.';
  if (hour < 18) return 'Good afternoon.';
  return 'Good evening.';
}
