# Architecture

A local-first personal-finance agent with permission tiers. Everything runs in the browser;
one stateless relay function holds the model API key and forwards already-redacted requests.

Requirement ids (ING-1, ACT-3, LED-2, …) refer to `docs/PRD.md`.

## Module map

| Path               | Responsibility                                                                                | Requirement     |
| ------------------ | --------------------------------------------------------------------------------------------- | --------------- |
| `src/domain`       | Types, Zod schemas for the entities, integer-rupiah money helpers, ISO date helpers           | PRD §8, NFR-1   |
| `src/storage`      | Dexie database, read-only repositories, the restricted ledger write API, the seed loader      | ING-5, LED-3    |
| `src/ledger`       | Pure functions: balance per account, free cash, safe-to-spend                                 | LED-1, LED-2    |
| `src/forecast`     | Pure functions: 90-day projection, runway, what-if scenarios, spending alerts                 | FC-1 … FC-4     |
| `src/importers`    | Statement CSV parser with line-numbered errors, PDF text reader, categoriser, injection flags | ING-1 … ING-3   |
| `src/policy`       | Rule-based clause extractor, coverage and comparison engine, policy store                     | POL-1 … POL-5   |
| `src/actions`      | Action registry, tier engine, guardrails, provenance, approval tokens, executor, settings     | ACT-1 … ACT-7   |
| `src/audit`        | Append-only SHA-256 hash chain, JSON export, verify function and CLI                          | AUD-1 … AUD-3   |
| `src/gate`         | Redactor and outbound gate; every model request passes through it                             | PRV-1, PRV-2    |
| `src/agent`        | Tools, tool-calling loop, reply checks, the rule-based model and the relay adapter            | CHAT-1 … CHAT-4 |
| `src/ui`           | One page: balances, runway, policy coverage, chat, approvals, audit log, privacy, settings    | DASH-1, ING-4   |
| `src/acceptance`   | The PRD's task scripts, interaction checks and security tests, and the recorded run           | PRD §12         |
| `src/testing`      | The whole application wired on fake-indexeddb, for tests                                      | PRD §12         |
| `scripts/seed`     | Deterministic generator for the ledger, the statements and the policy PDFs                    | PRD §8          |
| `scripts/evidence` | Writes `evidence/`: results table, audit log export, chat transcript, outbound requests       | PRD §13         |
| `relay`            | One Hono function that adds the API key, translates to the provider format and forwards       | PRD §9          |
| `tools`            | The ledger write boundary checker shared by CI and the test suite                             | LED-3           |
| `fixtures`         | CSV, policy PDF, adversarial, ledger, forecast and edge fixtures                              | PRD §8          |

## The action flow

```
model / UI form / chat
        │  (only ever a proposal)
        ▼
  propose(action, params, provenance)
        │
        ├─ 1. registry lookup          unknown action  → refused, logged      (ACT-1)
        ├─ 2. tier                     T0/T1           → refused, no side effect (ACT-2)
        ├─ 3. param schema             invalid params  → refused, logged
        ├─ 4. provenance               untrusted text setting action/amount/
        │                              target account  → refused, logged      (PRD §6)
        ├─ 5. feature flag             T3 with SIM_T3 off → refused, logged   (ACT-4)
        ├─ 6. guardrails               any rule fails  → refused, logged      (ACT-5)
        ├─ 7. approval queue           5 already waiting → refused, logged
        ▼
   pending proposal  ── hash covers action, tier, params, provenance, diff,
        │                guardrails, expiry, idempotency key, createdAt
        │
        │  UI renders the approval card, which asks for a one-time token
        │  bound to proposalHash
        ▼
   approve(proposalId, token, pin?)
        ├─ proposal must be pending
        ├─ proposal must not be expired
        ├─ T3 requires the step-up PIN (checked before the token is spent)
        └─ token must be unused, match the proposal and match the hash
        ▼
   execute(proposalId)
        ├─ status must be 'approved'  → nothing changes before approval (ACT-3)
        ├─ params re-validated        → blocked if the stored params are unusable
        ├─ guardrails re-checked      → blocked, logged if the ledger moved (ACT-5)
        ├─ staleness check            → blocked, logged                     (ST8)
        │                               (a statement import is exempt: it is the refresh)
        ├─ idempotency key            → blocked if that intent already ran
        └─ apply the effect through the ONLY ledger writer
        ▼
   audit entry 'executed'  →  ledger change is visible
```

Undo is the same flow with `action: "undo"`: it proposes, needs approval, and writes a new
audit entry (`event: "undone"`). Nothing is ever deleted from the audit log (AUD-2).

### The actions

| Action             | Tier | What approving it does                                 | Undo                         |
| ------------------ | ---- | ------------------------------------------------------ | ---------------------------- |
| `earmark.create`   | T2   | Sets money aside under a label, with a review date     | Releases it                  |
| `earmark.update`   | T2   | Changes the label, amount or review date of an earmark | Restores the previous values |
| `earmark.delete`   | T2   | Releases an earmark                                    | Restores it                  |
| `statement.import` | T2   | Adds the rows of a statement CSV as transactions       | Removes exactly those rows   |
| `transaction.add`  | T2   | Adds one transaction typed in chat                     | Removes it                   |
| `undo`             | T2   | Reverses the named executed action                     | Not reversible itself        |
| `transfer`         | T3   | Simulated move between two of the user's own accounts  | A reversing pair of rows     |

The T0 and T1 names (`get_summary`, `get_runway`, `run_scenario`, `get_spending`,
`list_policies`, `get_coverage`, `compare_policies`, `draft_reminder`) are in the same registry
so that every tool has a tier, but they are never proposed: they read or produce text.

A proposal waits at most 15 minutes; after that it is marked expired and logged, and its token
is useless. At most five proposals may wait at once: a sixth is refused until the user decides
on the existing cards, so neither a model nor a user can bury a risky card in a pile.

Proposals that cannot lower safe-to-spend (releasing or lowering an earmark, undoing the
creation of one) are low-risk and, when there are two or more, share one card
(`src/actions/risk.ts`). Grouping is layout only: "Approve all" approves each proposal with its
own token, and each is re-checked and logged on its own.

Guardrails run twice on purpose: once when the proposal is built, and again immediately before
the effect is applied. An approval is for a specific state of the ledger, so if the ledger moved
between approval and execution (another earmark was executed, a transfer used up the daily cap)
the proposal is refused and logged instead of being applied on stale arithmetic.

### Why the model cannot approve

- `src/agent` receives a `ProposalPort` with exactly one method, `propose`.
- `src/agent` is forbidden from importing `actions/approvals`, `actions/executor` or
  `storage/ledger-writes`; `tools/check-ledger-writes.mjs` fails the build if it does.
- An approval token is issued only by the UI component that renders the approval card, and
  it is bound to the proposal hash, so a changed proposal cannot be approved with an old token.

## Core algorithms

All of these are pure functions over plain data in integer rupiah. The model never runs them
and never does arithmetic of its own; it reads their results.

### Ledger (`src/ledger/engine.ts`)

```
balance(account) = openingBalance + sum(transactions of that account)
free cash        = sum(balances) - sum(active earmarks)
safe to spend    = free cash - sum(obligations whose next due date is within 30 days)
```

Recurring obligations repeat from their original due date, so the day of month never drifts
(a rent due on the 31st is due on 28 February, then on 31 March).

### Forecast (`src/forecast/index.ts`)

Day `d` of the projection, for `d = 0 … 90`:

```
balance(d)   = starting balance
             + invoices expected on or before day d
             - obligation occurrences on or before day d
             - floor(typical spend x d / 90)
             - scenario expense, if dated on or before day d
free cash(d) = balance(d) - active earmarks
```

- **Invoices** are expected on their due date. An invoice that is already overdue has no known
  payment date, so it is left out and listed as left out; it is never counted as money that
  will arrive, in the base case or in a scenario.
- **Typical spend** is the total of day-to-day outflows over the last 90 days (everything that
  is not income, a fixed cost already modelled as an obligation, a one-off or a transfer
  between own accounts). It is spread with `floor`, so no fraction of a rupiah appears and the
  90-day total is exact.
- **Runway** (FC-2) is the first day free cash is below zero, searched up to 730 days; beyond
  that it is reported as "more than 730 days". Months are days / 30, to one decimal.
- **Scenarios** (FC-3) shift named invoices by N days and/or add a one-off expense, then
  recompute. Besides the runway, a scenario reports the _pinch_: the lowest free cash between
  today and the day the late money arrives, with and without the scenario. A delay that lands
  before free cash runs out leaves the runway unchanged and still makes those weeks tighter;
  the pinch is where that shows.
- **Labels** (FC-4): every result carries its scenario, its inputs and its as-of date.
- **Alerts** (ACT-6): negative safe-to-spend, a projected shortfall, overdue invoices left
  out, typical 30-day spending above safe-to-spend, and earmarks past their review date. All
  are derived from the snapshot and the forecast, so an earmark moves them.

`fixtures/forecast/hand-worked.json` holds a ledger small enough to work by hand; the tests
check the engine against it to the rupiah.

### Policy extraction (`src/policy/extractor.ts`)

pdf.js returns the text of each page. The extractor then:

1. reads the header (name, insurer, type, policy number, insured, address) and keeps the
   personal fields for the redactor;
2. splits each page at `Clause N.` into clauses, each with its page, number, title and text;
3. treats a clause as a benefit when it says what the insurer pays ("We pay…"), and reads from
   it the limit ("up to a limit of Rp …"), the co-payment or deductible, the waiting period
   and the clause-level exclusions;
4. scores confidence: a clause whose limit cannot be read scores 0.3, one with no statement
   about the co-payment or the waiting period scores 0.6. Below 0.7 the item is shown as the
   raw clause, never as a summary (POL-5);
5. records any sentence that reads like an instruction as an injection signal (ST2). The
   sentence stays in the stored clause, so the user can see it, and is cut out of any copy
   that goes to the model.

A document with no numbered clauses is rejected. Nothing is guessed, and no model is involved,
so the same file always gives the same items and the policy view works offline.

### Coverage (`src/policy/coverage.ts`)

For a named event, the engine picks the benefit whose title shares the most words with the
event (using a small table of synonyms), then:

```
cost            = the user's estimate, or the reference cost for the event (a stated assumption)
in waiting      = waiting days > 0 and (start date unknown or as-of < start + waiting days)
policy pays     = 0 if in waiting, else min(limit, max(0, cost - co-payment))
out of pocket   = cost - policy pays                                   (POL-2)
shortfall       = max(0, out of pocket - free cash)                    (POL-3)
suggested reserve = the co-payment: the part that is certain
```

With no matching benefit the result is "can't confirm", with the clause that shares the most
words with the question, or the general exclusions when none does (I3). A comparison (POL-4)
lays the same extracted fields side by side for two policies on the criteria the user names;
it has no column for which is preferable, and any reply that uses ranking words is replaced.

## The agent loop (`src/agent`)

```
user message (+ optional pasted text)
        │
        ├─ pasted, or reads like an instruction?  → wrapped as <untrusted_data>, the turn is
        │                                            logged, and every proposal made in it
        │                                            carries untrusted provenance (so: refused)
        ▼
   model.complete(history, tools)  ── through gate.send(): redact, record, maybe block
        │
        ├─ tool calls → tools.invoke(name, args)
        │       T0 / T1 tool      runs, returns data
        │       T2 / T3 tool      calls propose(); returns a pending proposal or a refusal
        │       unknown name      goes to propose(), which refuses and logs it (ACT-1)
        │   results are appended to the history; loop, at most 6 rounds
        ▼
   final reply
        ├─ every number of two or more digits must appear in a tool result or in something
        │   the user typed, or the reply is withheld                              (CHAT-1)
        └─ in a turn that used a policy tool, ranking words replace the reply      (POL-4)
```

The reply is short text. The tables and figures the user sees under it are rendered by the
interface from the tool results, not from the model's words.

Two model adapters implement `ModelAdapter`. The default, `mock-model.ts`, is rule-based: it
classifies the request, asks for tools and words the results, with no network. `relay-model.ts`
posts the redacted request to the relay for a hosted model. The orchestrator, the tools and the
checks are the same for both.

## Ledger write boundary (LED-3)

`src/storage/ledger-writes.ts` is the only module that writes the ledger tables
(`accounts`, `transactions`, `invoices`, `obligations`, `earmarks`). Two importers are
allowed:

1. `src/actions/executor.ts` - every ledger change made at runtime.
2. `src/storage/bootstrap.ts` - the one-off "Load seed data" load, used by the demo and tests.

Anything else fails `npm run lint:boundary` and `src/storage/ledger-write-boundary.test.ts`,
and the ESLint `no-restricted-imports` rule blocks it in the editor too.

The checker works at statement level, so a write split over several lines
(`db.earmarks` on one line, `.modify(...)` on the next) is caught as well. It also enforces
that nothing under `src/agent/` imports `approvals`, `executor` or `ledger-writes`, and it has
negative tests that prove it detects each of those violations.

### The one bootstrap exception

`loadSeedData` replaces the whole local database: the ledger, the proposals, the settings and
the audit log. That is a bootstrap operation for the demo, not an action:

- it is not in the action registry, so no proposal, tool call or chat message can reach it;
- it is only reachable from the "Load seed data / Reset to seed data" button in the UI;
- the button says what it does, and the ledger write allowlist lists this file explicitly.

The AUD-2 guarantee - undo is a new entry, never a deletion - holds for everything that happens
inside the running system. A full local reset is a different, deliberate operation.

## Consistency between the ledger and the audit log

The executor writes the ledger first and then appends the audit entry. If the append fails it
compensates (releases the new earmark, restores the released one, or removes the two
simulated transfer rows) and rethrows, so a ledger change can never exist without an audit
entry.

The audit chain is serialised in-process, so concurrent appends cannot fork it. Two hashes are
computed per entry: `payloadHash` covers the business payload, and `hash` covers the entry
itself plus `prevHash`. Executions are serialised too, so two concurrent executions cannot both
pass the same daily-cap check and both write.

**Residual risk:** the chain proves that no entry was changed or removed _between_ two entries.
It cannot prove that the last entries were not truncated, because there is no external anchor
for the head hash. Exporting the log and verifying it with `npm run verify:audit` is the
practical control; a timestamped head hash published elsewhere would close the gap.

## Money

`Money` is a branded integer type (`src/domain/money.ts`). A plain `number` is not assignable
where money is expected, and `z.number().int()` rejects both floats and unsafe integers, so
floating-point arithmetic on an amount is a type error rather than a review comment. All
arithmetic goes through `addMoney`, `subMoney`, `sumMoney`, `minMoney` and friends.

## Determinism

- All dates are read in UTC (`src/domain/time.ts`).
- The seed generator is a seeded PRNG with no clock and no platform randomness.
  `npm run seed` is byte-for-byte reproducible and the manifest records the dataset hash.
- Services take an injected `Clock`. The demo anchors that clock to 09:00 Jakarta time on the
  seed's as-of date and lets it run from there, so the numbers on screen are reproducible, log
  entries are in order, proposals expire, and a ledger left alone for a day goes stale.
- The policy PDFs are written by a small dependency-free PDF writer with no dates or ids in
  them, so they too are byte-for-byte reproducible.
- The rule-based model adapter is deterministic. The extractor and the coverage engine use no
  model at all.

## Privacy

`gate.send()` is the only way out of the browser. It redacts names, account and policy
numbers, NIK, phone numbers, email addresses and known postal addresses, records the request
(payload after redaction, and a **masked** form of each removed value) for the privacy panel,
honours a block decision, and only then calls the transport. The relay stores and logs nothing
except, in memory and for one minute, the times of recent requests per client address, which
it needs for its rate limit, and the service worker never caches `/api/` responses.

What the model can receive is bounded by the tools: the user's message, aggregates from the
ledger (balances, totals, open invoices, earmarks), the benefit table of a policy, and the text
of the clauses cited in an answer. It never receives transaction rows or a whole document. With
the default rule-based model the gate's transport is a stub, so even that stays in the browser;
the privacy panel then shows what a hosted model would have been sent.

Chat is off until the consent screen is accepted (PDP Law, PRD §10). pdf.js and its worker are
bundled and served from the site's own origin, so the content security policy still allows
nothing but `'self'`.

## Deliberate additions to the PRD

Recorded here because they are the places the code goes beyond, or away from, the letter of
the PRD:

| Addition or difference                                  | Why                                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Transaction.source` accepts `'action'`                 | Simulated transfers need to be distinguishable from CSV and chat rows                                     |
| `AuditEntry` gains `seq`, `action`, `detail` and `hash` | Chain ordering, refusal reasons and execution evidence                                                    |
| `Settings.id` is the literal `'app'`                    | Dexie needs a primary key for the single settings row                                                     |
| `Proposal` gains `createdAt`                            | Ordering and evidence; `status` is excluded from the hash                                                 |
| `Policy` gains `startDate`                              | Waiting periods count from the start of cover                                                             |
| A `policyDocuments` table (clauses and header fields)   | Every claim must link to source text (POL-1); the redactor needs the identifiers                          |
| Redactions gain the kind `address`                      | The PRD lists addresses among what is removed                                                             |
| Transfer guardrail `amount <= source account balance`   | A simulated transfer must not overdraw the source account                                                 |
| Actions `statement.import` and `transaction.add`        | LED-3: importing a statement and adding a row are ledger changes, so they need a tier, a card and an undo |
| Action `earmark.update`                                 | ACT-5 says create, edit and delete                                                                        |
| Tool `get_spending`                                     | The correction check (I2, "No, I meant last month") needs a question with a period                        |
| A cap of five waiting proposals, and expiry on read     | Approval fatigue (PRD §10)                                                                                |
| The policy extractor is rule-based, not a model call    | Works with no model, deterministic, and no number comes from a model                                      |
| Overdue invoices are excluded from every forecast       | Their payment date is unknown; counting them would overstate the runway                                   |
| English and Bahasa Indonesia interface labels           | PRD stretch item; replies and the audit log stay in English                                               |
| Settings and privacy panels in the UI                   | ST6 needs a PIN-protected settings screen; PRV-1 is a Must                                                |
