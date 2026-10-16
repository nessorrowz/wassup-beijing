# Live-model results

Run on 2026-10-15 with `node scripts/live-bench/run.mjs --runs 3 glm-5.3-flash deepseek-v4-pro-0813 qwen3.8-flash kimi-k3 deepseek-v4.1-flash`.
Provider endpoint: `https://hyper.charm.land/v1/chat/completions`. The app was built with `VITE_MODEL=relay` and every message went through the redaction gate and the relay.

Each run starts from a fresh browser with the demo persona and the health policy loaded. A check fails on a wrong card, a missing tool call, a reply the verifier withheld, or an error.

## Summary

| Model | Runs fully passed | Checks passed | Average reply (s) | Slowest reply (s) | Replies over 8 s | Credits used |
| --- | --- | --- | --- | --- | --- | --- |
| glm-5.3-flash | 2/3 | 59/60 | 4.2 | 13.4 | 2/54 | 1 |
| deepseek-v4-pro-0813 | 2/3 | 59/60 | 7.8 | 19.4 | 18/54 | 4 |
| qwen3.8-flash | 1/3 | 58/60 | 8.5 | 19.3 | 25/54 | 1 |
| kimi-k3 | 3/3 | 60/60 | 14.6 | 86.3 | 37/54 | 13 |
| deepseek-v4.1-flash | 1/3 | 56/60 | 5.4 | 18.5 | 8/54 | 1 |

## Failed checks

- glm-5.3-flash, run 2, S3: AGENT Yes, your **Sehat Prima Health Policy** (PT Asuransi Contoh Nusantara) covers inpatient hospital care: - **Limit:** 60,000,000 - **Deductible:** 3,000,000
- deepseek-v4-pro-0813, run 2, S2: AGENT I can't confirm some of the figures I was about to give, so I have left them out. The cards below show only numbers that came from your ledger and your do
- qwen3.8-flash, run 1, S4: AGENT I can't confirm some of the figures I was about to give, so I have left them out. The cards below show only numbers that came from your ledger and your do
- qwen3.8-flash, run 2, I2b: AGENT I can't confirm some of the figures I was about to give, so I have left them out. The cards below show only numbers that came from your ledger and your do
- deepseek-v4.1-flash, run 1, S6: AGENT Not done · undo: refused by guardrails: the referenced action was executed and is reversible: audit entry p_372e592a5056d947 is not an executed action, so
- deepseek-v4.1-flash, run 1, S6-state: Rp 7.987.506 -> Rp 4.987.506
- deepseek-v4.1-flash, run 3, S6: AGENT Nothing to undo — the earmark was never executed. The undo tool refused: audit entry p_eade2e50d5e7b287 is not an executed action, so there is nothing to 
- deepseek-v4.1-flash, run 3, S6-state: Rp 7.987.506 -> Rp 4.987.506
