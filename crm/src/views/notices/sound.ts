'use client';

import { broadcastLeader, HEARTBEAT_INTERVAL_MS, leaderStrategy, readLastPlayed, SOUND_CHANNEL_NAME, SOUND_LOCK_NAME, writeLastPlayed } from '@/modules/notices/sound-policy';

/*
 * The browser adapter for notice sounds (contract 9.4); the decisions are
 * track C's pure sound-policy. Tones are generated with Web Audio (no audio
 * files). Audio starts locked: a click on "Test sound" (or anywhere, after a
 * reload) resumes the AudioContext. Only one tab plays: the holder of the Web
 * Lock, or without Web Locks the tab elected by a BroadcastChannel heartbeat.
 * The shared last-played time lives in localStorage (every access wrapped).
 */

let ctx: AudioContext | null = null;
let leader = false;
let started = false;

function audioContextClass(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** True when audio can play now (the context exists and is running). */
export function audioUnlocked(): boolean {
  return ctx !== null && ctx.state === 'running';
}

/** Call from a click: creates or resumes the AudioContext. */
export async function unlockAudio(): Promise<boolean> {
  const C = audioContextClass();
  if (!C) return false;
  try {
    ctx ??= new C();
    if (ctx.state !== 'running') await ctx.resume();
    return ctx.state === 'running';
  } catch {
    return false;
  }
}

export function isSoundLeader(): boolean {
  return leader;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function lastPlayedAt(): number | null {
  return readLastPlayed(storage());
}

/** Become the one tab that plays sounds, when possible (idempotent). */
export function startSoundLeader(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  const strategy = leaderStrategy({ webLocks: !!locks?.request, broadcastChannel: typeof BroadcastChannel !== 'undefined' });
  if (strategy === 'solo') {
    leader = true;
    return;
  }
  if (strategy === 'locks') {
    const tryLock = () => {
      void locks!
        .request(SOUND_LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (!lock) return null;
          leader = true;
          // Held for the life of the tab; released by the browser when the tab closes.
          return new Promise<void>(() => {});
        })
        .then(() => {
          if (!leader) window.setTimeout(tryLock, 5_000);
        })
        .catch(() => {});
    };
    tryLock();
    return;
  }
  const selfId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const beats = new Map<string, number>();
  try {
    const ch = new BroadcastChannel(SOUND_CHANNEL_NAME);
    ch.onmessage = (e: MessageEvent<unknown>) => {
      if (typeof e.data === 'string') beats.set(e.data, Date.now());
    };
    const beat = () => {
      ch.postMessage(selfId);
      leader = broadcastLeader(selfId, beats, Date.now());
    };
    beat();
    window.setInterval(beat, HEARTBEAT_INTERVAL_MS);
  } catch {
    leader = true;
  }
}

/** Plays one tone now (the caller already applied the policy) and records the time for every tab. */
export function playTone(tone: 'urgent' | 'normal'): boolean {
  if (!ctx || ctx.state !== 'running') return false;
  try {
    const notes = tone === 'urgent' ? [880, 660, 880] : [660];
    const step = tone === 'urgent' ? 0.16 : 0.22;
    notes.forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = tone === 'urgent' ? 'square' : 'sine';
      osc.frequency.value = freq;
      const t0 = ctx!.currentTime + i * step;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(tone === 'urgent' ? 0.12 : 0.08, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + step - 0.02);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t0);
      osc.stop(t0 + step);
    });
    writeLastPlayed(storage(), Date.now());
    return true;
  } catch {
    return false;
  }
}
