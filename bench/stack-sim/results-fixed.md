stack-sim · seeds=10 · FIXED (revive-on-revise) · world={"entities":20,"sessions":40,"observationsPerSession":8,"drift":0.06,"noiseNotesPerSession":2,"queriesPerSession":6,"agents":1,"sharedPage":false}

### S1 · Layer ladder (mid agent, 60 facts, 40 sessions)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| 0 no memory | **0.0%** ±0.0 | 0.0% | 0.0% | 100.0% (100.0%) | 0 | 0 | 59.7 | 0 |
| 1 notes (Trove today) | **49.0%** ±4.6 | 11.2% | 5.9% | 33.9% (29.0%) | 276 | 0 | 7.6 | 209 |
| 2 + transcripts (cited) | **49.0%** ±4.6 | 11.2% | 5.9% | 33.9% (29.0%) | 267 | 0 | 7.6 | 209 |
| 3 + dreaming | **59.4%** ±4.6 | 4.8% | 4.7% | 31.2% (29.3%) | 251 | 480 | 5.5 | 176 |
| 4 + injected index | **76.3%** ±2.8 | 6.7% | 6.0% | 11.0% (8.5%) | 372 | 480 | 5.1 | 185 |
| 5 + entity pages (+search) | **80.2%** ±2.0 | 4.9% | 2.7% | 12.2% (9.6%) | 440 | 471 | 6.0 | 153 |
| · index only (no dream) | **61.5%** ±5.4 | 14.1% | 7.8% | 16.6% (10.4%) | 394 | 0 | 8.0 | 209 |

### S1b · Dream components (mid agent)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| notes, no dream | **49.0%** ±4.6 | 11.2% | 5.9% | 33.9% (29.0%) | 276 | 0 | 7.6 | 209 |
| verify vs transcripts | **55.1%** ±3.3 | 7.0% | 4.3% | 33.5% (28.7%) | 267 | 160 | 5.0 | 208 |
| + merge duplicates | **56.9%** ±4.0 | 5.2% | 4.8% | 33.1% (28.5%) | 256 | 472 | 6.1 | 213 |
| + gap fill | **59.4%** ±4.4 | 4.8% | 5.2% | 30.7% (28.9%) | 255 | 474 | 4.4 | 213 |
| + retire noise (all) | **59.0%** ±4.9 | 5.1% | 4.5% | 31.4% (29.5%) | 250 | 474 | 5.0 | 174 |
| verify + gap fill (no merge) | **58.6%** ±2.8 | 7.2% | 4.5% | 29.7% (28.0%) | 269 | 160 | 4.1 | 211 |

### S1c · Revising a superseded note: marker survives (today) vs expires (fixed)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| weak · notes · today | **19.7%** ±3.3 | 8.1% | 5.9% | 66.4% (59.8%) | 158 | 0 | 18.1 | 213 |
| weak · full stack · today | **52.3%** ±4.6 | 9.0% | 6.3% | 32.5% (26.4%) | 307 | 493 | 9.6 | 187 |
| weak · notes · fixed | **19.7%** ±3.3 | 8.2% | 5.9% | 66.2% (59.6%) | 159 | 0 | 18.5 | 213 |
| weak · full stack · fixed | **54.9%** ±3.7 | 8.9% | 6.3% | 29.9% (25.2%) | 315 | 486 | 7.5 | 186 |
| mid · notes · today | **47.5%** ±4.0 | 11.9% | 6.1% | 34.4% (29.5%) | 275 | 0 | 8.0 | 213 |
| mid · full stack · today | **69.8%** ±4.5 | 6.8% | 6.0% | 17.4% (8.7%) | 363 | 475 | 4.8 | 181 |
| mid · notes · fixed | **49.0%** ±4.6 | 11.2% | 5.9% | 33.9% (29.0%) | 276 | 0 | 7.6 | 209 |
| mid · full stack · fixed | **75.6%** ±2.6 | 6.3% | 6.0% | 12.0% (9.5%) | 367 | 471 | 5.2 | 180 |
| strong · notes · today | **77.8%** ±3.2 | 8.0% | 2.8% | 11.4% (10.3%) | 346 | 0 | 2.5 | 180 |
| strong · full stack · today | **82.2%** ±3.5 | 2.4% | 2.0% | 13.3% (3.0%) | 383 | 333 | 2.0 | 150 |
| strong · notes · fixed | **80.8%** ±2.7 | 5.4% | 2.8% | 11.0% (9.7%) | 349 | 0 | 2.9 | 181 |
| strong · full stack · fixed | **91.5%** ±1.8 | 2.4% | 2.5% | 3.6% (3.0%) | 390 | 331 | 2.1 | 150 |

### S2 · weak agent

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| weak · notes | **19.7%** ±3.3 | 8.2% | 5.9% | 66.2% (59.6%) | 159 | 0 | 18.5 | 213 |
| weak · + index | **37.8%** ±5.9 | 14.5% | 10.3% | 37.4% (24.7%) | 341 | 0 | 16.9 | 213 |
| weak · + transcripts + dream | **29.8%** ±3.4 | 4.3% | 3.7% | 62.2% (59.7%) | 145 | 490 | 9.5 | 175 |
| weak · full stack | **53.7%** ±2.5 | 9.3% | 6.5% | 30.5% (25.8%) | 313 | 489 | 8.3 | 186 |

### S2 · mid agent

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| mid · notes | **49.0%** ±4.6 | 11.2% | 5.9% | 33.9% (29.0%) | 276 | 0 | 7.6 | 209 |
| mid · + index | **61.5%** ±5.4 | 14.1% | 7.8% | 16.6% (10.4%) | 394 | 0 | 8.0 | 209 |
| mid · + transcripts + dream | **58.8%** ±4.5 | 4.8% | 4.6% | 31.8% (29.8%) | 249 | 480 | 5.0 | 175 |
| mid · full stack | **76.9%** ±3.8 | 6.2% | 6.1% | 10.8% (8.5%) | 372 | 470 | 5.2 | 180 |

### S2 · strong agent

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| strong · notes | **80.8%** ±2.7 | 5.4% | 2.8% | 11.0% (9.7%) | 349 | 0 | 2.9 | 181 |
| strong · + index | **87.0%** ±2.8 | 6.0% | 2.8% | 4.1% (2.8%) | 422 | 0 | 3.0 | 181 |
| strong · + transcripts + dream | **84.7%** ±2.0 | 2.3% | 2.7% | 10.3% (9.8%) | 320 | 329 | 2.1 | 150 |
| strong · full stack | **91.3%** ±1.7 | 2.5% | 2.5% | 3.6% (3.0%) | 390 | 331 | 2.2 | 150 |

### S3 · Dream priority at budget 5 (verify only — no merge / gap-fill)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| random · budget 5 | **49.9%** ±4.6 | 10.6% | 5.4% | 34.1% (29.1%) | 265 | 40 | 5.9 | 174 |
| activation · budget 5 | **50.0%** ±4.8 | 10.5% | 5.5% | 34.0% (29.1%) | 265 | 40 | 7.1 | 174 |
| volatility · budget 5 | **50.9%** ±4.2 | 9.1% | 5.7% | 34.3% (29.2%) | 264 | 40 | 6.0 | 174 |
| recent-reads · budget 5 | **51.5%** ±4.7 | 8.9% | 5.5% | 34.0% (29.0%) | 266 | 40 | 5.7 | 174 |

### S3 · Dream priority at budget 20 (verify only — no merge / gap-fill)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| random · budget 20 | **54.0%** ±3.5 | 8.3% | 3.9% | 33.8% (28.8%) | 266 | 160 | 3.2 | 174 |
| activation · budget 20 | **53.5%** ±3.7 | 7.7% | 4.6% | 34.2% (28.9%) | 265 | 160 | 4.5 | 174 |
| volatility · budget 20 | **55.2%** ±3.2 | 6.8% | 4.3% | 33.7% (28.7%) | 266 | 160 | 4.6 | 174 |
| recent-reads · budget 20 | **55.5%** ±4.7 | 6.9% | 3.9% | 33.7% (28.6%) | 266 | 160 | 4.0 | 173 |

### S3 · Dream priority at budget Infinity (verify only — no merge / gap-fill)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| random · budget Infinity | **59.8%** ±2.8 | 4.0% | 2.3% | 33.8% (28.7%) | 266 | 698 | 0.3 | 173 |
| activation · budget Infinity | **60.3%** ±2.8 | 3.8% | 2.1% | 33.8% (28.6%) | 266 | 698 | 0.3 | 174 |
| volatility · budget Infinity | **60.3%** ±3.3 | 3.9% | 2.0% | 33.8% (28.6%) | 266 | 698 | 0.3 | 174 |
| recent-reads · budget Infinity | **60.4%** ±3.0 | 3.8% | 2.1% | 33.8% (28.6%) | 266 | 698 | 0.3 | 174 |

### S4 · Dream cadence (budget 20/dream)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| dream every 1 | **63.1%** ±5.9 | 2.8% | 3.8% | 30.3% (29.3%) | 247 | 2191 | 3.0 | 169 |
| dream every 3 | **61.9%** ±4.2 | 4.4% | 3.7% | 30.0% (28.3%) | 252 | 739 | 5.4 | 174 |
| dream every 5 | **58.9%** ±4.5 | 4.9% | 4.7% | 31.5% (29.5%) | 250 | 483 | 4.9 | 176 |
| dream every 10 | **55.5%** ±4.2 | 6.3% | 5.4% | 32.8% (29.6%) | 254 | 252 | 4.8 | 179 |
| dream every 20 | **53.6%** ±4.3 | 8.2% | 5.6% | 32.6% (28.8%) | 264 | 143 | 5.6 | 185 |

### S5 · Over-saving (0 redundant notes/session)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| noise 0 · notes | **49.7%** ±4.7 | 10.3% | 6.0% | 34.0% (29.3%) | 255 | 0 | 8.9 | 130 |
| noise 0 · dream, keep noise | **59.5%** ±3.5 | 5.3% | 4.4% | 30.7% (28.8%) | 229 | 472 | 5.5 | 133 |
| noise 0 · dream, retire noise | **59.8%** ±3.9 | 5.1% | 4.4% | 30.8% (28.8%) | 230 | 473 | 5.5 | 132 |

### S5 · Over-saving (5 redundant notes/session)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| noise 5 · notes | **47.8%** ±4.3 | 11.5% | 5.3% | 35.4% (30.1%) | 283 | 0 | 7.6 | 331 |
| noise 5 · dream, keep noise | **56.5%** ±3.2 | 5.1% | 4.5% | 33.9% (31.2%) | 258 | 463 | 4.1 | 331 |
| noise 5 · dream, retire noise | **56.4%** ±3.7 | 5.3% | 4.8% | 33.5% (31.0%) | 257 | 468 | 4.7 | 235 |

### S5 · Over-saving (20 redundant notes/session)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| noise 20 · notes | **47.3%** ±4.0 | 11.8% | 4.7% | 36.3% (28.8%) | 306 | 0 | 7.0 | 935 |
| noise 20 · dream, keep noise | **57.0%** ±3.0 | 4.2% | 3.5% | 35.3% (30.3%) | 279 | 477 | 3.6 | 934 |
| noise 20 · dream, retire noise | **59.2%** ±2.8 | 4.4% | 3.3% | 33.2% (30.1%) | 277 | 482 | 4.0 | 394 |

### S6 · Concurrent writers (perfect reader isolates the write path)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| 1 agents · shared entity page | **56.0%** ±4.4 | 3.2% | 5.7% | 35.1% (30.1%) | 309 | 0 | 8.9 | 0 |
| 1 agents · atoms | **49.7%** ±4.7 | 10.3% | 6.0% | 34.0% (29.3%) | 255 | 0 | 8.9 | 130 |
| 2 agents · shared entity page | **46.2%** ±4.5 | 5.8% | 5.2% | 42.8% (30.1%) | 296 | 0 | 18.9 | 0 |
| 2 agents · atoms | **49.7%** ±4.7 | 10.3% | 6.0% | 34.0% (29.3%) | 255 | 0 | 8.9 | 130 |
| 4 agents · shared entity page | **37.1%** ±3.8 | 5.1% | 3.7% | 54.2% (30.1%) | 272 | 0 | 27.0 | 0 |
| 4 agents · atoms | **49.7%** ±4.7 | 10.3% | 6.0% | 34.0% (29.3%) | 255 | 0 | 8.9 | 130 |

### S7 · Entity pages vs search (dream every 5)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| search only · dream/5 | **58.8%** ±4.4 | 4.7% | 4.7% | 31.8% (29.9%) | 249 | 478 | 5.3 | 174 |
| pages only · dream/5 | **61.0%** ±3.3 | 6.8% | 1.3% | 31.0% (28.7%) | 59 | 480 | 3.8 | 152 |
| pages + search · dream/5 | **63.1%** ±3.2 | 3.6% | 1.9% | 31.4% (29.3%) | 306 | 481 | 4.2 | 155 |

### S7 · Entity pages vs search (dream every 15)

| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |
|---|---|---|---|---|---|---|---|---|
| search only · dream/15 | **55.1%** ±4.3 | 7.4% | 5.7% | 31.8% (28.3%) | 262 | 117 | 6.7 | 193 |
| pages only · dream/15 | **54.3%** ±4.1 | 11.5% | 3.0% | 31.3% (27.7%) | 118 | 116 | 6.6 | 176 |
| pages + search · dream/15 | **58.7%** ±3.7 | 6.0% | 3.7% | 31.7% (28.0%) | 296 | 116 | 7.1 | 191 |
