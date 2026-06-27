"use client";

export type NotificationSoundTone = "chime" | "bell" | "pop" | "alert";

export type NotificationSoundSettings = {
  enabled: boolean;
  volume: number;
  tone: NotificationSoundTone;
};

export const notificationToneOptions: { value: NotificationSoundTone; label: string }[] = [
  { value: "chime", label: "清脆提示音" },
  { value: "bell", label: "铃声" },
  { value: "pop", label: "短促提示音" },
  { value: "alert", label: "明显提醒音" },
];

const STORAGE_KEY = "coolfix.crm.notification.sound";

const defaultSettings: NotificationSoundSettings = {
  enabled: true,
  volume: 0.7,
  tone: "chime",
};

const tonePatterns: Record<NotificationSoundTone, { frequency: number; duration: number; delay: number }[]> = {
  chime: [
    { frequency: 880, duration: 0.12, delay: 0 },
    { frequency: 1174, duration: 0.16, delay: 0.12 },
  ],
  bell: [
    { frequency: 659, duration: 0.18, delay: 0 },
    { frequency: 988, duration: 0.28, delay: 0.16 },
  ],
  pop: [
    { frequency: 740, duration: 0.08, delay: 0 },
  ],
  alert: [
    { frequency: 932, duration: 0.1, delay: 0 },
    { frequency: 932, duration: 0.1, delay: 0.18 },
    { frequency: 740, duration: 0.14, delay: 0.36 },
  ],
};

export function getNotificationSoundSettings(): NotificationSoundSettings {
  if (typeof window === "undefined") return defaultSettings;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<NotificationSoundSettings>;
    return normalizeSettings(parsed);
  } catch {
    return defaultSettings;
  }
}

export function saveNotificationSoundSettings(settings: NotificationSoundSettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSettings(settings)));
}

export function shouldPlayNotificationSound(event: { message?: { direction?: string | null } }) {
  const direction = event.message?.direction;
  return !direction || direction === "inbound";
}

export function playNewMessageSound(options?: { force?: boolean; settings?: NotificationSoundSettings }) {
  if (typeof window === "undefined") return;
  const settings = normalizeSettings(options?.settings ?? getNotificationSoundSettings());
  if (!options?.force && !settings.enabled) return;

  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;

  const context = new AudioContextCtor();
  const start = context.currentTime + 0.01;
  const master = context.createGain();
  master.gain.setValueAtTime(Math.max(0.0001, settings.volume * 0.18), start);
  master.connect(context.destination);

  for (const note of tonePatterns[settings.tone]) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const noteStart = start + note.delay;
    const noteEnd = noteStart + note.duration;

    oscillator.type = settings.tone === "pop" ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(note.frequency, noteStart);
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(1, noteStart + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(noteStart);
    oscillator.stop(noteEnd + 0.02);
  }

  const totalDuration = Math.max(...tonePatterns[settings.tone].map((note) => note.delay + note.duration));
  window.setTimeout(() => void context.close().catch(() => undefined), Math.ceil((totalDuration + 0.3) * 1000));
}

function normalizeSettings(settings: Partial<NotificationSoundSettings>): NotificationSoundSettings {
  const tone = notificationToneOptions.some((item) => item.value === settings.tone) ? settings.tone as NotificationSoundTone : defaultSettings.tone;
  const volume = typeof settings.volume === "number" && Number.isFinite(settings.volume)
    ? Math.min(1, Math.max(0, settings.volume))
    : defaultSettings.volume;
  return {
    enabled: settings.enabled !== false,
    volume,
    tone,
  };
}
