# Architecture

## Shape of the system

```
                       ┌──────────────────────────────┐
   phone browser ────► │  apps/web  (React PWA)       │
   future iOS app ──┐  │  installable, offline shell  │
   future Android ──┤  └──────────────┬───────────────┘
                    │                 │  HTTPS + bearer token
                    └─────────────────┤
                                      ▼
                       ┌──────────────────────────────┐
                       │  apps/api  (Fastify)         │
                       │  all rules live here         │
                       └──────┬───────────────┬───────┘
                              │               │
              ┌───────────────▼───┐   ┌───────▼──────────────────┐
              │  PostgreSQL       │   │  providers/ (interfaces) │
              │  the only truth   │   │  SBM reader, schedule,   │
              └───────────────────┘   │  live, stats, injuries,  │
                                      │  weather, news, AI, OCR  │
                                      └──────────────────────────┘

              packages/shared — odds maths, grading, canonical
              historical rules. Used by API and web alike.
```

### Why it's shaped this way

**Nothing important lives in the browser.** Every rule — who may lock what, who
owns a matchup, what counts as the same wager, how average odds are computed —
is enforced on the server. The web app is a view. That is what makes the same
backend serve a future iOS or Android client without change (spec §92).

**Authentication is a bearer token, not a cookie.** A native app can hold a
token; it cannot easily hold a browser cookie. Refresh tokens are stored only
as hashes and rotate on every use.

**External services sit behind interfaces.** `providers/types.ts` defines what
the app needs; `providers/registry.ts` decides who supplies it. An unconfigured
provider returns `DATA_UNAVAILABLE`, which the interface renders as
**DATA CURRENTLY UNAVAILABLE**. Swapping the Sports Bet Montana page reader for
an official feed later is a change to one file.

---

## The one constraint that matters most

Two members must never reserve the same NFL game. This is not enforced by the
interface, and not by a read-then-write check in application code — both of
those leave a window where two requests can pass at once.

It is enforced by the database:

```prisma
model MatchupReservation {
  nflWeekId String
  nflGameId String
  userId    String
  @@unique([nflWeekId, nflGameId])   // ← the whole rule
  @@unique([nflWeekId, userId])      // one matchup per member per week
}
```

`lockPick()` opens a transaction and simply tries to `INSERT`. Postgres admits
exactly one; the loser gets a unique-violation, which becomes:

> This matchup was just reserved by another member. Please choose another game.

`picks.test.ts` fires ten concurrent locks at one game and asserts that exactly
one survives.

---

## Data that must never be confused

These are stored separately and on purpose (spec §86):

| Column | Meaning | Who may change it |
|---|---|---|
| `Pick.lockedAmericanOdds` | The price when the member locked | Nobody, ever |
| `Market.americanOdds` | What the board says right now | The reader |
| `OfficialTicketLeg.americanOdds` | What was actually wagered | The ticket |
| `OfficialTicketLeg.result` | What happened | Grading, or an admin with a reason |
| `HistoricalPick.*` | The imported record | Only an approved correction |

A price moving after a lock changes exactly one of these columns. That is the
whole point of keeping them apart.

---

## The board reader

Everything about `services/readerRun.ts` is designed to produce *less* traffic:

- **One request at a time.** Never concurrent.
- **10-30 seconds between requests.** A full slate takes 20-30 minutes, which
  is the target, not a regression.
- **A hard request budget.** The run stops rather than exceed it, and reports
  `STOPPED_BUDGET` — a normal outcome, not a failure.
- **Conditional requests.** ETag / Last-Modified mean an unchanged page costs a
  304 and nothing else.
- **A narrowing scope.** Once all ten members are locked, only the ten locked
  events are read at all.
- **Immediate surrender.** A 429, 403 or 503 stops the run, respects
  `Retry-After`, and opens the circuit breaker. No retries, no rotation, no
  disguises.
- **Backoff that only grows.** 15 minutes doubling to a 6-hour cap.

**Failure never destroys data.** A failed request is a failed request, not a
market removal. A selection is only marked unavailable after the page parsed
successfully and the selection was confirmed absent twice in a row. A parse that
returns zero markets is recorded as a parse error, never as an emptied board.

---

## The ticket image route

The uploaded ticket photo is the only member-supplied file the app stores and
later serves back, so both ends treat it as hostile.

**On upload.** The browser's declared Content-Type is ignored. The real type is
read from the file's leading bytes and must be JPEG, PNG, WebP, GIF or HEIC.
SVG and PDF are refused because both can carry script, which would become
stored cross-site scripting on the API's own origin. The name on disk is built
from the week id, the clock and the sniffed type — nothing the uploader chose
reaches the filesystem.

**On read**, `GET /api/tickets/:ticketId/image` applies five guards in order:

1. **Signed in.** The route sits behind `requireAuth`; it is never public.
2. **Authorised.** Members may view a ticket once the parlay is `CONFIRMED`, at
   which point it is the group's official record. Before that it is the parlay
   manager's working material and only an administrator may see it. A member
   asking for an unconfirmed ticket gets a 404, not a 403, so the route cannot
   be used to discover which weeks have a ticket waiting.
3. **No caller-supplied path.** The file is located from the ticket row, and the
   resolved path is proven to sit inside the upload directory — a check that
   also rejects a sibling directory sharing the same prefix.
4. **No caller-supplied type.** The Content-Type is re-derived from the bytes on
   disk every time, never from the stored label.
5. **Inert delivery.** `nosniff`, a `default-src 'none'; sandbox` policy, and
   `private, no-store` so a ticket never rests in a shared cache.

`routes/ticketImage.test.ts` probes it the way an attacker would: anonymous and
forged tokens, wrong role, disguised HTML, SVG and PDF, and stored paths that
try to leave the upload directory.

---

## Schedule, live scores and the background clock

NFL games and live scores come from **ESPN's free public endpoints** — no key,
no account, no monthly fee. They are also **undocumented and unofficial**, so
`providers/espn.ts` is written on the assumption that they will change:

- Every parser is total. A null in the events array, an unknown status, a
  column that was renamed — each is skipped, never guessed at. A payload it
  cannot read becomes `DATA_UNAVAILABLE`, so a shape change degrades the app
  into honest emptiness rather than wrong numbers.
- An empty slate is reported as unavailable rather than as "the NFL scheduled
  no games", because the former is overwhelmingly more likely.
- `npm run check:espn` prints exactly what came back and whether the app can
  read it — the one command to run when something looks wrong.
- It sits behind `ScheduleProvider` and `LiveScoreProvider`, so swapping in a
  paid feed later is a change to that file and the registry.

`services/scheduler.ts` is the background clock:

| Job | Interval | Guard |
|---|---|---|
| Board reader | hourly | Also obeys its own circuit breaker and request budget; skipped once the ticket is confirmed |
| Live scores | 2 minutes | Only while a game is in progress or within 30 minutes of kickoff |
| Locked-pick monitoring | 10 minutes | Purely local; no external requests |
| Next-week setup | 6 hours | Never touches a week an administrator declared off |

No job can overlap itself, so a 25-minute scan is never joined by the next
hour's. A job that throws is logged and skipped rather than taking the process
down. `FCP_SCHEDULER=off` disables all of it, which is what tests and one-off
scripts run with.

---

## Market identity

`selectionKeyOf()` builds an identity from event + category + market + subject +
side + **line**, and deliberately excludes the price:

- `Josh Allen | Rushing Yards | 25+ | -175` and the same at `-205` → **same
  selection, repriced**. A snapshot is archived; the member is alerted if the
  move is material.
- `25+` and `30+` → **different selections**. The app will never substitute one
  for the other, even when a locked selection disappears.

History is only written when something meaningful changed. An identical read
just advances `lastVerifiedAt`.

---

## Average odds

The group's spreadsheet established the method, so the app matches it exactly
(spec §65): convert each American price to decimal, average the decimals,
convert back. Raw American prices are never averaged, because `-110` and `+110`
are not symmetric in probability space.

`averageAmericanOdds()` in `packages/shared` is the only implementation, and
`stats.test.ts` pins it to the workbook's own computed cells:

| Bettor | Workbook avg odds | Workbook $10 P/L |
|---|---|---|
| Austin | -119.826417 | 9.969587307 |
| Carson | -130.8393487 | 33.88045097 |
| Clayton | -123.8106534 | -26.29181994 |

The app reproduces all three to six decimal places.

---

## Correction memory

An administrator should never have to make the same spreadsheet fix twice
(spec §83).

`HistoricalCorrection` rows are keyed by **stable coordinates** — season, week,
bettor, field — rather than by a database id, so they survive a full re-import
that regenerates every row. On import, an `APPROVED` correction always beats the
raw cell, and any disagreement is written to `ImportConflict` for audit rather
than resolved silently in either direction.

Three corrections ship as `canonical` (§82), and the 19 Excel date-mangled
scores are recorded as corrections the first time they're restored.

---

## The historical workbook

The canonical cleanup, encoded in `packages/shared/src/historicalRules.ts`:

| Rule | Result |
|---|---|
| Ignore the `2026` sheet (a formatting template) | 0 picks |
| The `2025` sheet | 150 picks |
| `All Time` before the week numbering restarts | 110 picks (2024) |
| `All Time` after the restart (a duplicate of 2025) | excluded, 150 rows |
| **Total** | **260 unique picks** |

Excel had reinterpreted 19 score cells like `21-6` as dates (`2025-06-21`). The
mangling is exactly reversible — Excel read `D-M` as day-month — so the original
text is recovered as `${day}-${month}`. All 19 were verified to stay consistent
with their recorded W/L.

### Week Offs

**2024 W12** and **2025 W15** are genuinely empty in the source and are recorded
as Week Offs — an intentional status, never an 0-0 record.

**2024 Week 6 was played.** The original specification listed it as a Week Off,
but the workbook holds ten real picks for it and the accepted totals (110 for
2024, 260 overall) require them. The group reviewed the disagreement and
confirmed the week was played, so it is now recorded in
`RESOLVED_WEEK_OFF_DECISIONS` and treated as an ordinary settled week.

That record is what makes the decision permanent: `isConfirmedPlayed(2024, 6)`
returns true, and `applyImport` refuses to mark a confirmed-played week as a
Week Off no matter what a future source file looks like. The question cannot be
reopened by a re-import or by someone re-reading §81.

---

## Layout

```
packages/shared/       odds maths, grading, market identity, historical rules
apps/api/
  prisma/schema.prisma the full data model, designed for every phase up front
  src/lib/             config, database, auth, audit, settings
  src/providers/       interfaces + registry + the SBM board reader
  src/services/        picks, weeks, reader, monitor, tickets, live, stats, import
  src/routes/          auth, member, admin
  src/test/            fixtures + the §97 acceptance checklist
apps/web/src/
  pages/               Home, Picks, Parlay, Sweat, Stats, Admin, Login, Legal
  components/          shared interface pieces
  lib/                 API client, formatting
```

## Tests

252 in total, run in CI against a real PostgreSQL service container.

- `packages/shared` — 76 pure-logic tests: odds maths, grading, guideline,
  market identity, all 19 score restorations, the settled Week Off decisions.
- `apps/api` — 176 tests against a real PostgreSQL database, including
  `src/test/acceptance.test.ts`, which is spec §97 written out in order, and
  `src/routes/ticketImage.test.ts`, which probes the one file-serving route the
  way an attacker would, and `src/providers/espn.test.ts`, which pins the ESPN
  parsers against recorded payloads so a shape change is caught here rather
  than on a Sunday.

CI also re-runs the historical import against the real workbook and fails if it
stops landing on exactly 260 unique picks.
