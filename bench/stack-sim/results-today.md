stack-sim · seeds=10 · world={"entities":20,"sessions":40,"observationsPerSession":8,"drift":0.06,"noiseNotesPerSession":2,"queriesPerSession":6,"agents":1,"sharedPage":false}

### S1 · Layer ladder (mid agent, 60 facts, 40 sessions)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| 0 no memory | **0.0%** ±0.0 | 0.0% | 0.0% | 100.0% (100.0%) | 0 | 0 | 59.7 | 0 |
| 1 notes (Trove today) | **47.5%** ±4.0 | 11.9% | 6.1% | 34.4% (29.5%) | 275 | 0 | 8.0 | 213 |
| 2 + transcripts (cited) | **47.4%** ±4.1 | 12.0% | 6.2% | 34.4% (29.5%) | 265 | 0 | 7.9 | 213 |
| 3 + dreaming | **54.1%** ±5.4 | 4.9% | 4.6% | 36.3% (29.0%) | 246 | 478 | 4.9 | 175 |
| 4 + injected index | **69.9%** ±2.6 | 6.6% | 6.0% | 17.5% (8.2%) | 365 | 467 | 4.3 | 179 |
| 5 + entity pages (+search) | **79.9%** ±2.4 | 5.7% | 2.6% | 11.8% (9.0%) | 438 | 480 | 4.1 | 155 |
| · index only (no dream) | **59.5%** ±5.0 | 16.0% | 8.2% | 16.3% (10.2%) | 396 | 0 | 7.1 | 212 |

### S1b · Dream components (mid agent)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| notes, no dream | **47.5%** ±4.0 | 11.9% | 6.1% | 34.4% (29.5%) | 275 | 0 | 8.0 | 213 |
| verify vs transcripts | **54.0%** ±2.9 | 7.3% | 4.3% | 34.4% (29.5%) | 265 | 160 | 6.1 | 213 |
| + merge duplicates | **52.0%** ±4.9 | 4.5% | 4.0% | 39.6% (29.0%) | 250 | 464 | 5.2 | 211 |
| + gap fill | **54.5%** ±3.4 | 4.5% | 4.8% | 36.2% (28.8%) | 249 | 480 | 4.4 | 214 |
| + retire noise (all) | **54.0%** ±5.0 | 4.5% | 4.4% | 37.1% (29.4%) | 245 | 478 | 4.3 | 177 |
| verify + gap fill (no merge) | **58.1%** ±3.4 | 7.3% | 4.5% | 30.2% (28.4%) | 267 | 160 | 4.7 | 213 |

### S1c · Revising a superseded note: marker survives (today) vs expires (fixed)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| weak · notes · today | **19.7%** ±3.3 | 8.1% | 5.9% | 66.4% (59.8%) | 158 | 0 | 18.1 | 213 |
| weak · full stack · today | **52.8%** ±4.1 | 8.7% | 6.5% | 32.1% (25.8%) | 309 | 491 | 10.8 | 187 |
| weak · notes · fixed | **19.7%** ±3.3 | 8.2% | 5.9% | 66.2% (59.6%) | 159 | 0 | 18.5 | 213 |
| weak · full stack · fixed | **54.1%** ±1.7 | 9.8% | 6.3% | 29.8% (25.2%) | 315 | 486 | 8.7 | 184 |
| mid · notes · today | **47.5%** ±4.0 | 11.9% | 6.1% | 34.4% (29.5%) | 275 | 0 | 8.0 | 213 |
| mid · full stack · today | **70.5%** ±3.9 | 6.5% | 5.5% | 17.4% (8.6%) | 363 | 472 | 5.1 | 181 |
| mid · notes · fixed | **49.0%** ±4.6 | 11.2% | 5.9% | 33.9% (29.0%) | 276 | 0 | 7.6 | 209 |
| mid · full stack · fixed | **76.4%** ±1.9 | 6.6% | 5.8% | 11.2% (8.8%) | 370 | 475 | 5.1 | 183 |
| strong · notes · today | **77.8%** ±3.2 | 8.0% | 2.8% | 11.4% (10.3%) | 346 | 0 | 2.5 | 180 |
| strong · full stack · today | **81.6%** ±4.2 | 2.4% | 2.2% | 13.8% (3.3%) | 382 | 337 | 1.7 | 152 |
| strong · notes · fixed | **80.8%** ±2.7 | 5.4% | 2.8% | 11.0% (9.7%) | 349 | 0 | 2.9 | 181 |
| strong · full stack · fixed | **91.3%** ±2.0 | 2.4% | 2.5% | 3.8% (3.3%) | 389 | 329 | 2.2 | 149 |

### S2 · weak agent

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| weak · notes | **19.7%** ±3.3 | 8.1% | 5.9% | 66.4% (59.8%) | 158 | 0 | 18.1 | 213 |
| weak · + index | **37.8%** ±5.8 | 14.8% | 10.3% | 37.1% (24.5%) | 341 | 0 | 16.5 | 213 |
| weak · + transcripts + dream | **27.6%** ±2.4 | 4.5% | 4.0% | 63.8% (60.5%) | 140 | 488 | 10.0 | 172 |
| weak · full stack | **52.8%** ±4.2 | 8.4% | 6.3% | 32.6% (26.2%) | 307 | 494 | 9.6 | 188 |

### S2 · mid agent

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| mid · notes | **47.5%** ±4.0 | 11.9% | 6.1% | 34.4% (29.5%) | 275 | 0 | 8.0 | 213 |
| mid · + index | **59.5%** ±5.0 | 16.0% | 8.2% | 16.3% (10.2%) | 396 | 0 | 7.1 | 212 |
| mid · + transcripts + dream | **53.0%** ±4.8 | 4.7% | 4.5% | 37.9% (29.8%) | 242 | 478 | 4.8 | 176 |
| mid · full stack | **69.4%** ±3.5 | 6.6% | 5.5% | 18.5% (8.8%) | 364 | 473 | 4.7 | 180 |

### S2 · strong agent

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| strong · notes | **77.8%** ±3.2 | 8.0% | 2.8% | 11.4% (10.3%) | 346 | 0 | 2.5 | 180 |
| strong · + index | **83.9%** ±3.0 | 8.8% | 3.0% | 4.3% (3.0%) | 419 | 0 | 2.9 | 181 |
| strong · + transcripts + dream | **76.9%** ±2.5 | 2.0% | 1.8% | 19.3% (10.5%) | 314 | 323 | 1.4 | 146 |
| strong · full stack | **82.1%** ±4.5 | 2.3% | 2.0% | 13.6% (3.1%) | 383 | 332 | 2.2 | 151 |

### S3 · Dream priority at budget 5 (verify only — no merge / gap-fill)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| random · budget 5 | **48.8%** ±4.3 | 11.8% | 5.4% | 34.0% (29.0%) | 265 | 40 | 6.4 | 174 |
| activation · budget 5 | **49.2%** ±4.2 | 11.4% | 5.4% | 34.0% (29.0%) | 265 | 40 | 6.6 | 174 |
| volatility · budget 5 | **50.3%** ±3.8 | 10.0% | 5.7% | 34.0% (29.1%) | 265 | 40 | 6.7 | 174 |
| recent-reads · budget 5 | **50.1%** ±3.8 | 10.3% | 5.6% | 34.0% (29.1%) | 265 | 40 | 6.3 | 174 |

### S3 · Dream priority at budget 20 (verify only — no merge / gap-fill)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| random · budget 20 | **53.7%** ±3.6 | 8.7% | 3.7% | 34.0% (29.0%) | 265 | 160 | 4.1 | 174 |
| activation · budget 20 | **52.6%** ±4.3 | 9.0% | 4.3% | 34.0% (29.0%) | 265 | 160 | 4.6 | 174 |
| volatility · budget 20 | **54.6%** ±3.3 | 7.3% | 4.1% | 34.0% (29.1%) | 264 | 160 | 5.6 | 174 |
| recent-reads · budget 20 | **54.4%** ±3.8 | 7.7% | 3.9% | 34.0% (29.1%) | 264 | 160 | 4.3 | 174 |

### S3 · Dream priority at budget Infinity (verify only — no merge / gap-fill)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| random · budget Infinity | **59.2%** ±3.6 | 4.4% | 2.4% | 34.0% (29.1%) | 264 | 700 | 0.7 | 174 |
| activation · budget Infinity | **59.6%** ±3.6 | 4.3% | 2.1% | 34.0% (29.1%) | 264 | 700 | 0.6 | 174 |
| volatility · budget Infinity | **59.7%** ±3.5 | 4.0% | 2.3% | 34.0% (29.1%) | 264 | 700 | 0.6 | 174 |
| recent-reads · budget Infinity | **59.8%** ±3.3 | 4.1% | 2.1% | 34.0% (29.1%) | 264 | 700 | 0.6 | 174 |

### S4 · Dream cadence (budget 20/dream)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| dream every 1 | **55.7%** ±4.9 | 2.3% | 3.8% | 38.3% (29.5%) | 240 | 2128 | 3.3 | 168 |
| dream every 3 | **53.3%** ±4.4 | 4.8% | 3.6% | 38.3% (29.7%) | 241 | 729 | 4.7 | 175 |
| dream every 5 | **55.1%** ±5.4 | 5.3% | 4.5% | 35.0% (27.8%) | 250 | 487 | 5.2 | 180 |
| dream every 10 | **52.0%** ±3.6 | 6.3% | 5.2% | 36.5% (30.6%) | 247 | 255 | 4.2 | 180 |
| dream every 20 | **52.5%** ±2.6 | 9.3% | 6.2% | 32.0% (27.8%) | 266 | 144 | 5.3 | 188 |

### S5 · Over-saving (0 redundant notes/session)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| noise 0 · notes | **48.1%** ±2.9 | 11.6% | 6.2% | 34.1% (29.4%) | 254 | 0 | 7.5 | 129 |
| noise 0 · dream, keep noise | **54.1%** ±4.5 | 5.5% | 4.3% | 36.2% (29.5%) | 220 | 464 | 4.8 | 132 |
| noise 0 · dream, retire noise | **52.7%** ±2.8 | 5.6% | 4.6% | 37.1% (30.2%) | 218 | 469 | 4.7 | 133 |

### S5 · Over-saving (5 redundant notes/session)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| noise 5 · notes | **47.4%** ±5.1 | 11.8% | 5.1% | 35.7% (30.8%) | 280 | 0 | 7.6 | 331 |
| noise 5 · dream, keep noise | **52.7%** ±3.3 | 5.5% | 3.9% | 37.8% (29.3%) | 259 | 466 | 4.2 | 332 |
| noise 5 · dream, retire noise | **51.8%** ±3.0 | 5.5% | 3.7% | 38.9% (31.5%) | 249 | 470 | 4.6 | 236 |

### S5 · Over-saving (20 redundant notes/session)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| noise 20 · notes | **45.2%** ±4.0 | 12.2% | 5.0% | 37.6% (30.0%) | 300 | 0 | 6.8 | 932 |
| noise 20 · dream, keep noise | **51.7%** ±3.5 | 4.2% | 4.0% | 40.1% (30.3%) | 275 | 477 | 3.7 | 935 |
| noise 20 · dream, retire noise | **52.5%** ±3.8 | 4.0% | 4.3% | 39.3% (30.9%) | 269 | 476 | 4.8 | 393 |

### S6 · Concurrent writers (perfect reader isolates the write path)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| 1 agents · shared entity page | **56.0%** ±4.4 | 3.2% | 5.7% | 35.1% (30.1%) | 309 | 0 | 8.9 | 0 |
| 1 agents · atoms | **48.1%** ±2.9 | 11.6% | 6.2% | 34.1% (29.4%) | 254 | 0 | 7.5 | 129 |
| 2 agents · shared entity page | **46.2%** ±4.5 | 5.8% | 5.2% | 42.8% (30.1%) | 296 | 0 | 18.9 | 0 |
| 2 agents · atoms | **48.1%** ±2.9 | 11.6% | 6.2% | 34.1% (29.4%) | 254 | 0 | 7.5 | 129 |
| 4 agents · shared entity page | **37.1%** ±3.8 | 5.1% | 3.7% | 54.2% (30.1%) | 272 | 0 | 27.0 | 0 |
| 4 agents · atoms | **48.1%** ±2.9 | 11.6% | 6.2% | 34.1% (29.4%) | 254 | 0 | 7.5 | 129 |

### S7 · Entity pages vs search (dream every 5)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| search only · dream/5 | **54.4%** ±5.3 | 5.6% | 4.5% | 35.5% (27.9%) | 249 | 485 | 4.8 | 179 |
| pages only · dream/5 | **60.8%** ±3.0 | 6.7% | 1.3% | 31.2% (29.0%) | 58 | 478 | 4.2 | 152 |
| pages + search · dream/5 | **62.8%** ±2.6 | 4.2% | 1.9% | 31.1% (29.0%) | 305 | 484 | 5.4 | 156 |

### S7 · Entity pages vs search (dream every 15)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| search only · dream/15 | **53.1%** ±4.0 | 8.7% | 5.5% | 32.7% (27.6%) | 262 | 119 | 6.0 | 193 |
| pages only · dream/15 | **54.0%** ±3.8 | 11.7% | 2.8% | 31.5% (27.8%) | 118 | 116 | 7.5 | 176 |
| pages + search · dream/15 | **57.3%** ±3.8 | 7.7% | 3.3% | 31.7% (28.0%) | 293 | 119 | 6.0 | 193 |
