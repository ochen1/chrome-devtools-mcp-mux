#!/usr/bin/env python3
"""Generate an ffmpeg -filter_complex from the plan."""
import json

with open('/tmp/motion/plan.json') as f:
    plan = json.load(f)

lines = []
# Split input into N copies
n = len(plan)
labels_in = [f'v{i}' for i in range(n)]
split = '[0:v]split=' + str(n) + ''.join(f'[{lab}]' for lab in labels_in)
lines.append(split)

# For each segment: trim + setpts (with speed factor)
labels_out = []
for i, p in enumerate(plan):
    lab_in = labels_in[i]
    lab_out = f'o{i}'
    labels_out.append(lab_out)
    speed = p['speed']
    # trim uses [start,end) in seconds. Use setpts to normalize + rescale.
    if speed == 1.0:
        lines.append(
            f"[{lab_in}]trim=start={p['start_t']:.4f}:end={p['end_t']:.4f},"
            f"setpts=PTS-STARTPTS[{lab_out}]"
        )
    else:
        factor = 1.0 / speed  # speed>1 ⇒ factor<1 ⇒ shorter output
        lines.append(
            f"[{lab_in}]trim=start={p['start_t']:.4f}:end={p['end_t']:.4f},"
            f"setpts=(PTS-STARTPTS)*{factor:.6f}[{lab_out}]"
        )

# Concat all segments
inputs = ''.join(f'[{lab}]' for lab in labels_out)
lines.append(f"{inputs}concat=n={n}:v=1:a=0[outv]")

fg = ';\n'.join(lines)
with open('/tmp/motion/filter.txt', 'w') as f:
    f.write(fg)
print(f"filter_complex written: {len(lines)} chains, {n} segments")
print(f"→ /tmp/motion/filter.txt")
