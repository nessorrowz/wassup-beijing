# Live-model results

Run on 2026-10-16 with `node scripts/live-bench/run.mjs --runs 5 --pause 30 glm-5.3-flash`.
Provider endpoint: `https://hyper.charm.land/v1/chat/completions`. The app was built with `VITE_MODEL=relay` and every message went through the redaction gate and the relay.

Each run starts from a fresh browser with the demo persona and the health policy loaded. A check fails on a wrong card, a missing tool call, a reply the verifier withheld, or an error.

Credits used is the change in the provider balance across the runs. The balance can update late, so treat it as a lower bound.

## Summary

| Model | Runs fully passed | Checks passed | Average reply (s) | Slowest reply (s) | Replies over 8 s | Credits used |
| --- | --- | --- | --- | --- | --- | --- |
| glm-5.3-flash | 5/5 | 105/105 | 3.0 | 6.3 | 0/95 | 1 |

## Failed checks

None.
