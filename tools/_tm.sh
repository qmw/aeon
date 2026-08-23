#!/bin/bash
node tools/metrics.mjs "$1" 60,120,240,160:far 380,380,240,160:mid 700,700,240,160:near 470,150,240,160:farmid 1050,720,220,150:nearR 250,480,240,160:sandmid 2>&1 | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('crushed',d['crushedPct'],'blown',d['blownPct'])
for r in d['regions']: print(f\"{r['name']:9s} mean{r['mean']:6.1f} sat{r['sat']:6.3f} HF{r['HF_rms']:6.2f} MID{r['MID_rms']:6.2f} M/H{r['MID_over_HF']:5.2f}\")"
