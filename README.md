# Last Place Lager's First Class Parlays

A private, mobile-first web app (installable as a PWA) for one group of ten
friends who build a single ten-leg NFL parlay each week.

**New here? Start with [docs/SETUP.md](docs/SETUP.md)** — it's written for
someone with no programming background and tells you exactly what to click.

---

## What it does

A normal member only ever does three things: **research a wager, select it, and
lock it.** Everything else is automatic.

| Tab | What's there |
|---|---|
| **Home** | What is my pick this week, and where does the group stand |
| **Picks** | Eligible games, Sports Bet Montana offerings, research, locking |
| **Parlay** | All ten selections and the official ticket status |
| **The Sweat** | Live tracking of the week's parlay |
| **Stats** | Standings, profiles, awards, group analytics, full history |
| **Admin** | Readiness, board reader, ticket, history, settings |

## What it does not do

It **cannot place a wager**. It never touches money, never asks for a Sports Bet
Montana password, and is not a sportsbook. The parlay manager places the real
bet by hand and uploads the ticket, which then becomes the group's authoritative
record.

It also never invents data. If a source isn't connected, the screen says
**DATA CURRENTLY UNAVAILABLE**.

---

## The rules that matter

**One matchup per member, first lock wins.** Locking any wager from
Bills @ Dolphins reserves that entire game — spread, total, every prop, all of
it. There's no pick order. This is enforced by a unique constraint in
PostgreSQL, not by the interface, so two simultaneous taps can never both
succeed.

**Locked odds are permanent.** The price you locked, the price on the board now,
the price on the official ticket, and the final result are four separate
records. Movement changes one of them and never the others.

**The odds guideline is a guideline.** Outside -200 to +200 you get a warning
and a **SELECT ANYWAY** button. It has never blocked a pick.

**The board reader is deliberately slow.** One request at a time, 10-30 seconds
apart, a hard request budget, and an immediate stop at any sign it isn't
welcome. A 20-30 minute scan is the intended behaviour.

**Corrections are permanent.** Fix a historical record once and no future
re-import can undo it.

---

## Quick start

```bash
npm install
cp .env.example apps/api/.env     # then fill in DATABASE_URL and the two secrets
npm run db:push
npm run db:seed
npm run import:history -- data/Last_Place_Lagers_First_Class_Parlays.xlsx --apply
npm run dev:api                   # terminal 1
npm run dev:web                   # terminal 2  ->  http://localhost:5173
```

Sign in as `Austin` / `ChangeMe!2026`.

## Tests

```bash
npm test
```

174 tests. `apps/api/src/test/acceptance.test.ts` is the specification's own
acceptance checklist, written out in order — ten members racing for one game,
the reader refusing to be rushed, ticket odds changing, the official freeze, and
the historical import landing on exactly 260 picks.

## Layout

```
packages/shared/   odds maths, grading, canonical historical rules
apps/api/          Fastify + Prisma + PostgreSQL
apps/web/          React PWA, mobile-first
docs/              SETUP.md (plain English) and ARCHITECTURE.md
data/              the group's historical workbook
```

---

21+. Private to the group. Not affiliated with Sports Bet Montana.
If gambling stops being entertainment, call or text **1-800-522-4700**.
