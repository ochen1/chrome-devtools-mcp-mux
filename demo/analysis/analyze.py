#!/usr/bin/env python3
"""Parse per-frame scene scores, histogram them, and report candidate thresholds."""
import re
import sys
from collections import Counter

frames = []
cur = None
with open('/tmp/motion/scores.txt') as f:
    for line in f:
        m = re.match(r'frame:(\d+)\s+pts:\S+\s+pts_time:([\d.eE+-]+)', line)
        if m:
            cur = {'n': int(m.group(1)), 't': float(m.group(2))}
            continue
        m = re.match(r'lavfi\.scene_score=([\d.eE+-]+)', line)
        if m and cur is not None:
            cur['s'] = float(m.group(1))
            frames.append(cur)
            cur = None

print(f"total frames: {len(frames)}")
print(f"duration: {frames[-1]['t']:.2f}s")
scores = [f['s'] for f in frames]
print(f"score range: min={min(scores):.6f}  max={max(scores):.6f}  mean={sum(scores)/len(scores):.6f}")

# Log-ish bucket histogram
edges = [0, 1e-6, 1e-5, 1e-4, 1e-3, 3e-3, 1e-2, 3e-2, 1e-1, 3e-1, 1.0]
labels = []
counts = [0] * (len(edges) - 1)
for s in scores:
    for i in range(len(edges) - 1):
        if s < edges[i + 1]:
            counts[i] += 1
            break
    else:
        counts[-1] += 1

print("\nscore histogram (log-scale buckets)")
print(f"{'bucket':<22} {'count':>6}  {'%':>6}  bar")
for i, c in enumerate(counts):
    lo, hi = edges[i], edges[i + 1]
    pct = 100 * c / len(scores)
    bar = '#' * int(pct * 1.5)
    print(f"[{lo:<10.6f}, {hi:<8.6f}) {c:>6}  {pct:>5.1f}%  {bar}")

# Now look at idle runs at several thresholds
def runs(scores, thresh, fps=15, min_dur=0.5):
    """Find maximal runs of scores < thresh of length >= min_dur seconds."""
    runs = []
    start = None
    for i, s in enumerate(scores):
        if s < thresh:
            if start is None:
                start = i
        else:
            if start is not None:
                n = i - start
                if n / fps >= min_dur:
                    runs.append((start, i - 1, n))
                start = None
    if start is not None:
        n = len(scores) - start
        if n / fps >= min_dur:
            runs.append((start, len(scores) - 1, n))
    return runs

print("\nidle-run summary at various thresholds (runs ≥ 0.5s):")
print(f"{'thresh':<10} {'runs':>6} {'total frames':>14} {'total sec':>10} {'% of video':>12}")
for th in [1e-6, 5e-6, 1e-5, 3e-5, 1e-4, 3e-4, 1e-3]:
    rs = runs(scores, th)
    tot = sum(n for _, _, n in rs)
    print(f"{th:<10.0e} {len(rs):>6} {tot:>14} {tot/15:>10.1f} {100*tot/len(scores):>11.1f}%")
