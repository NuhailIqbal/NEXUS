import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Play, Pause, Download, Loader2, AudioLines } from "lucide-react";
import { cn } from "@/lib/utils";

export type CallAudioPlayerHandle = {
  /** Seek to an absolute position (seconds) and start playing. */
  seek: (seconds: number) => void;
};

type Props = {
  src: string | null | undefined;
  /** Fires continuously with the current playback position (seconds). */
  onTimeUpdate?: (seconds: number) => void;
  className?: string;
};

const fmt = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

// Deterministic, speech-like envelope so the waveform looks organic (bursts +
// quiet gaps) and is stable for a given recording — no audio decoding needed,
// which keeps it robust for cross-origin / authenticated recording URLs.
const useBars = (src: string | null | undefined, count = 100) =>
  useMemo(() => {
    let x = (src || "seed").split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 2147483647, 7) || 1;
    const rnd = () => {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      return (x % 100000) / 100000;
    };
    const bars: number[] = [];
    let env = 0.5;
    for (let i = 0; i < count; i++) {
      const silence = rnd() < 0.07;
      env = env * 0.65 + rnd() * 0.55; // smoothed amplitude envelope
      let v = silence ? 0.06 + rnd() * 0.08 : 0.18 + env * 0.82;
      v *= 0.55 + 0.45 * Math.abs(Math.sin(i * 0.8)); // fine oscillation
      bars.push(Math.max(0.05, Math.min(1, v)));
    }
    return bars;
  }, [src, count]);

const SPEEDS = [1, 1.5, 2];

const CallAudioPlayer = forwardRef<CallAudioPlayerHandle, Props>(({ src, onTimeUpdate, className }, ref) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [ready, setReady] = useState(false);
  const [errored, setErrored] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const bars = useBars(src);

  useImperativeHandle(ref, () => ({
    seek: (seconds: number) => {
      const a = audioRef.current;
      if (!a || !isFinite(seconds)) return;
      a.currentTime = Math.max(0, seconds);
      setCurrent(a.currentTime);
      a.play().then(() => setPlaying(true)).catch(() => {});
    },
  }));

  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
    setReady(false);
    setErrored(false);
    setSpeedIdx(0);
  }, [src]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) a.pause();
    else a.play().then(() => setPlaying(true)).catch(() => setErrored(true));
  };

  const seekToFraction = (frac: number) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const t = Math.min(duration, Math.max(0, frac * duration));
    a.currentTime = t;
    setCurrent(t);
  };

  const cycleSpeed = () => {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
  };

  const progress = duration ? current / duration : 0;

  // Evenly spaced time ruler ticks (like VAPI's 0 / 5 / 10 markers).
  const ticks = useMemo(() => {
    if (!duration || !isFinite(duration)) return [];
    const n = 5;
    return Array.from({ length: n + 1 }, (_, i) => (duration * i) / n);
  }, [duration]);

  if (!src) {
    return (
      <div className={cn("flex items-center gap-2 rounded-xl border border-border bg-muted/20 px-4 py-6 text-sm text-muted-foreground", className)}>
        <AudioLines className="h-4 w-4" /> No recording available for this call.
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border border-border bg-muted/20 p-4", className)}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => { setDuration(e.currentTarget.duration || 0); setReady(true); }}
        onTimeUpdate={(e) => { const t = e.currentTarget.currentTime; setCurrent(t); onTimeUpdate?.(t); }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setErrored(true)}
      />

      {/* Header row: label + elapsed/total */}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recording</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{fmt(current)} / {fmt(duration)}</span>
      </div>

      {/* Waveform */}
      <div
        className="group relative h-20 w-full cursor-pointer"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          seekToFraction((e.clientX - rect.left) / rect.width);
        }}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
      >
        <div className="flex h-full items-center gap-[2px]">
          {bars.map((h, i) => {
            const played = i / bars.length <= progress;
            return (
              <span
                key={i}
                className={cn(
                  "flex-1 rounded-full transition-colors",
                  played ? "bg-primary" : "bg-muted-foreground/25 group-hover:bg-muted-foreground/40"
                )}
                style={{ height: `${Math.round(h * 100)}%` }}
              />
            );
          })}
        </div>
        {/* Playhead */}
        {duration > 0 && (
          <div
            className="pointer-events-none absolute top-1 bottom-1 w-0.5 rounded-full bg-primary shadow-[0_0_6px_hsl(var(--primary))]"
            style={{ left: `${Math.min(100, progress * 100)}%` }}
          />
        )}
      </div>

      {/* Time ruler */}
      {ticks.length > 0 && (
        <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {ticks.map((t, i) => <span key={i}>{fmt(t)}</span>)}
        </div>
      )}

      {/* Controls */}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          disabled={errored}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition hover:opacity-90 disabled:opacity-40"
          aria-label={playing ? "Pause" : "Play"}
        >
          {!ready && !errored ? <Loader2 className="h-5 w-5 animate-spin" /> : playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 translate-x-0.5" />}
        </button>

        <button
          type="button"
          onClick={cycleSpeed}
          className="shrink-0 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground"
          title="Playback speed"
        >
          {SPEEDS[speedIdx]}x
        </button>

        <div className="flex-1" />

        <a
          href={src}
          download
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
          title="Download recording"
        >
          <Download className="h-4 w-4" /> Audio
        </a>
      </div>

      {errored && (
        <p className="mt-2 text-xs text-destructive">
          Couldn&apos;t load the recording here.{" "}
          <a href={src} target="_blank" rel="noreferrer" className="underline">Open it in a new tab</a>.
        </p>
      )}
    </div>
  );
});

CallAudioPlayer.displayName = "CallAudioPlayer";
export default CallAudioPlayer;
