#!/usr/bin/env python3
"""
Regenerates the one-euro filter tuning table quoted in Deixis/Pointing.swift.

    python3 tools/tune_pointing.py

The filter constants are TUNED, not derived, exactly like the scorer weights.
This exists so that the next person to touch them changes a number, re-runs
this, and sees what it cost — rather than reasoning about cutoff frequencies
from first principles and shipping a crosshair that lags the sweep.

Mirrors OneEuroFilter.apply in Swift. If you change the filter, change this too,
or the table in the doc comment starts lying.

Two signals, both at the 12Hz the hand tracker actually runs at:
  STILL  a fingertip held steady under +-0.01-viewport white noise (~0.7 deg).
         What matters is frame-to-frame shake, so the metric is the RMS of
         successive differences, not the overall spread.
  SWEEP  a fingertip crossing 1.5 viewport-widths per second, which is roughly
         a fast "put it over THERE". What matters is lag, reported in degrees
         because that is the unit Scorer.Weights.angularSigmaDeg is in.
"""
import math

HZ = 12.0
N = 80
FOV_DEG = 68.0
NOISE_AMPLITUDE = 0.01      # viewport fraction
SWEEP_SPEED = 1.5           # viewport widths per second


def one_euro(samples, times, min_cutoff, beta, d_cutoff=1.0):
    def alpha(cutoff, dt):
        tau = 1 / (2 * math.pi * cutoff)
        return 1 / (1 + tau / dt)

    out, x_prev, d_prev, t_prev = [], None, 0.0, None
    for x, t in zip(samples, times):
        if x_prev is None:
            out.append(x)
            x_prev, t_prev = x, t
            continue
        dt = t - t_prev
        d_hat = d_prev + alpha(d_cutoff, dt) * ((x - x_prev) / dt - d_prev)
        d_prev = d_hat
        y = x_prev + alpha(min_cutoff + beta * abs(d_hat), dt) * (x - x_prev)
        out.append(y)
        x_prev, t_prev = y, t
    return out


def white_noise(n, amplitude):
    """The same LCG the Swift test uses, so both see identical noise."""
    state = 0x9E3779B97F4A7C15
    values = []
    for _ in range(n):
        state = (state * 6364136223846793005 + 1442695040888963407) % (1 << 64)
        values.append(((state >> 11) / float(1 << 53) - 0.5) * 2 * amplitude)
    return values


def jitter_rms(xs):
    d = [xs[i] - xs[i - 1] for i in range(1, len(xs))]
    return (sum(v * v for v in d) / len(d)) ** 0.5


def viewport_to_degrees(fraction):
    return math.degrees(math.atan(2 * fraction * math.tan(math.radians(FOV_DEG) / 2)))


def main():
    times = [i / HZ for i in range(N)]
    noise = white_noise(N, NOISE_AMPLITUDE)
    still = [0.5 + n for n in noise]
    truth = [0.1 + SWEEP_SPEED * t for t in times]
    sweep = [v + n for v, n in zip(truth, noise)]

    print(f"  {'minCutoff':>9} {'beta':>5} | {'jitter kept':>11} | {'sweep lag':>9}")
    print("  " + "-" * 42)
    for min_cutoff in (0.6, 0.8, 1.0, 1.5):
        for beta in (0.5, 1.0, 1.5, 3.0):
            kept = jitter_rms(one_euro(still, times, min_cutoff, beta)) / jitter_rms(still)
            out = one_euro(sweep, times, min_cutoff, beta)
            lag = max(abs(out[i] - truth[i]) for i in range(N // 2, N))
            mark = "  <- default" if (min_cutoff, beta) == (0.8, 3.0) else ""
            print(f"  {min_cutoff:>9} {beta:>5} | {kept:>10.1%}  | "
                  f"{viewport_to_degrees(lag):>6.2f} deg{mark}")


if __name__ == "__main__":
    main()
