#!/usr/bin/env python3
"""
Pick an idle-vs-active threshold from the histogram, merge runs separated by
sub-threshold 'flicker' gaps (cursor blinks etc.), and produce a plan:
  - list of (segment_start_t, segment_end_t, kind, speed_factor)
Where kind is 'keep' (original speed) or 'squeeze' (speed up idle→0.5s).

The final output is a JSON plan consumed by build_filter.py.
"""
import json
import re

FPS = 15
FRAME_DT = 1.0 / FPS

# A frame is "still" if scene score is below this. Chosen from the histogram:
# the bimodal split, plus a pad for H.264 compression jitter.
IDLE_THRESH = 1e-4

# We require >=0.5s of continuous idle to squeeze.
MIN_IDLE_SEC = 0.5
# Idle windows get collapsed to this duration.
TARGET_IDLE_SEC = 0.5
# Two idle runs separated by a sub-GLUE activity flicker (≤0.2s of non-idle
# frames where the flicker's scene_score never exceeds FLICKER_MAX) are fused.
GLUE_ACTIVE_MAX_SEC = 0.2
FLICKER_MAX = 3e-3

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

N = len(frames)
print(f"frames: {N}, duration: {frames[-1]['t']:.2f}s")

# First pass: flag each frame as idle or active
idle = [f['s'] < IDLE_THRESH for f in frames]

# Second pass: glue adjacent idle runs whose between-gap is a short flicker
# (all frames in the gap below FLICKER_MAX, duration <= GLUE_ACTIVE_MAX_SEC).
def glue(idle, frames):
    out = idle[:]
    i = 0
    while i < len(out):
        if out[i]:
            j = i
            while j < len(out) and out[j]:
                j += 1
            # run [i, j) is idle; now scan ahead for next idle start
            k = j
            while k < len(out) and not out[k]:
                k += 1
            if k < len(out):
                gap_len = k - j
                if gap_len * FRAME_DT <= GLUE_ACTIVE_MAX_SEC and \
                   all(frames[m]['s'] < FLICKER_MAX for m in range(j, k)):
                    for m in range(j, k):
                        out[m] = True
                    # restart scan at i (may glue further)
                    continue
            i = k
        else:
            i += 1
    return out

idle = glue(idle, frames)

# Third pass: collect runs, squeeze only runs >= MIN_IDLE_SEC
runs = []  # list of (start_idx, end_idx_exclusive, is_idle)
i = 0
while i < N:
    j = i
    while j < N and idle[j] == idle[i]:
        j += 1
    runs.append((i, j, idle[i]))
    i = j

# Build plan: each run becomes a segment.
# Active runs: kind=keep, factor=1.0.
# Idle runs of len >= MIN_IDLE_SEC: kind=squeeze, collapsed to TARGET_IDLE_SEC.
# Idle runs shorter: kind=keep (not worth speeding).
plan = []
kept_in = 0.0
kept_out = 0.0
for a, b, is_idle in runs:
    t0 = a * FRAME_DT
    t1 = b * FRAME_DT  # end is exclusive; next frame starts at b*FRAME_DT
    dur_in = t1 - t0
    if dur_in <= 0:
        continue
    if is_idle and dur_in >= MIN_IDLE_SEC:
        dur_out = TARGET_IDLE_SEC
        speed = dur_in / dur_out
        plan.append({
            'kind': 'squeeze',
            'start_frame': a, 'end_frame': b,
            'start_t': t0, 'end_t': t1,
            'dur_in': dur_in, 'dur_out': dur_out,
            'speed': speed,
        })
    else:
        plan.append({
            'kind': 'keep',
            'start_frame': a, 'end_frame': b,
            'start_t': t0, 'end_t': t1,
            'dur_in': dur_in, 'dur_out': dur_in,
            'speed': 1.0,
        })
    kept_in += dur_in
    kept_out += plan[-1]['dur_out']

print(f"\nsegments: {len(plan)}  (squeeze={sum(1 for p in plan if p['kind']=='squeeze')}, keep={sum(1 for p in plan if p['kind']=='keep')})")
print(f"total input:  {kept_in:.2f}s")
print(f"total output: {kept_out:.2f}s  ({100*kept_out/kept_in:.1f}% of input)")

print("\nfirst 10 and last 5 segments:")
for p in plan[:10] + [None] + plan[-5:]:
    if p is None:
        print('  ...')
        continue
    print(f"  [{p['start_t']:>6.2f}–{p['end_t']:>6.2f}] {p['kind']:<7} in={p['dur_in']:.2f}s out={p['dur_out']:.2f}s  speed×{p['speed']:.1f}")

with open('/tmp/motion/plan.json', 'w') as f:
    json.dump(plan, f, indent=2)
print(f"\nplan → /tmp/motion/plan.json")
