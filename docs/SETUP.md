# Setting up First Class Parlays

This guide assumes you have never written a line of code. Every step tells you
what you are doing, why, where to go, exactly what to type, and what you should
see afterwards. Nothing here requires you to understand the code.

If a step doesn't produce the result described, stop there and ask — don't
carry on, because later steps build on earlier ones.

---

## What you are building

First Class Parlays is two programs that talk to each other:

| Part | What it does | Where it runs |
|---|---|---|
| **The database** | Remembers everything: members, picks, tickets, history | A PostgreSQL server |
| **The API** | The brains. Enforces the rules, talks to the database | A small server program |
| **The web app** | What everyone sees on their phone | Their phone's browser |

The API and the web app both come from this one folder of code.

---

## Part 1 — Get it running on your own computer first

Do this before putting it on the internet. It costs nothing and proves
everything works.

### Step 1.1 — Install Node.js

**What you're doing:** installing the program that runs the app.

1. Go to **https://nodejs.org**
2. Click the big green button that says **LTS** (it will have a version number
   like "22.x.x LTS"). Do not pick the "Current" one.
3. Open the file that downloads and click **Continue / Next** through the
   installer, accepting all the defaults.
4. When it finishes, open a terminal:
   - **Mac:** press `Cmd + Space`, type `Terminal`, press Enter.
   - **Windows:** press the Windows key, type `PowerShell`, press Enter.
5. Type this and press Enter:
   ```
   node --version
   ```

**What you should see:** a version number starting with `v20`, `v22` or higher,
such as `v22.11.0`. If you see "command not found", the install didn't finish —
restart your computer and try step 5 again.

### Step 1.2 — Install PostgreSQL (the database)

**What you're doing:** installing the filing cabinet that stores everything.

1. Go to **https://www.postgresql.org/download/**
2. Click your operating system (macOS or Windows) and follow the installer.
3. **Important:** during the install it asks you to choose a password for the
   `postgres` user. Write this password down somewhere safe — you need it in a
   moment. Accept every other default, including port `5432`.
4. When it finishes, open your terminal and type:
   ```
   psql --version
   ```

**What you should see:** something like `psql (PostgreSQL) 16.2`.

> **Mac shortcut:** if you'd rather not use the installer, **Postgres.app** from
> https://postgresapp.com is simpler — download it, drag it to Applications,
> open it, and click **Initialize**.

### Step 1.3 — Create the database

**What you're doing:** making an empty filing cabinet called `fcp` for the app
to use.

In your terminal, type this one line and press Enter:

```
createdb fcp
```

**What you should see:** nothing at all. In the terminal, silence means
success. If it says `database "fcp" already exists`, that's fine too — it's
already there.

If it says `command not found: createdb`, your computer can't find PostgreSQL
yet. On Mac with Postgres.app, open the app, click the settings gear, choose
**Configure PATH**, then close and reopen your terminal.

### Step 1.4 — Download the app and install its parts

**What you're doing:** getting the code and letting it fetch the free
open-source pieces it depends on.

In your terminal, go to the folder where you keep the code, then type:

```
npm install
```

**What you should see:** a few minutes of scrolling text, ending with a line
like `added 400 packages in 45s`. Warnings in yellow are normal and safe to
ignore. Red `ERR!` lines are not — stop and ask if you see those.

### Step 1.5 — Write your settings file

**What you're doing:** telling the app where the database is and giving it two
secret passwords it uses to keep everyone signed in securely.

1. First, make two long random secrets. Type this line and press Enter:

   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   **What you should see:** a long line of random letters and numbers. Copy it.
   Run the same command a second time to get a different one, and copy that too.
   You now have two secrets.

2. Create the settings file. Type:

   ```
   cp .env.example apps/api/.env
   ```

3. Open `apps/api/.env` in any text editor (TextEdit on Mac, Notepad on
   Windows) and fill in these lines:

   ```
   DATABASE_URL="postgresql://postgres:YOUR_POSTGRES_PASSWORD@localhost:5432/fcp?schema=public"
   JWT_ACCESS_SECRET="paste your first random secret here"
   JWT_REFRESH_SECRET="paste your second random secret here"
   ```

   Replace `YOUR_POSTGRES_PASSWORD` with the password you wrote down in step
   1.2. Keep the quote marks.

4. Save the file and close the editor.

> **Never share this file or put it online.** It contains the keys to your app.

### Step 1.6 — Build the tables

**What you're doing:** creating the labelled drawers inside the filing cabinet.

```
npm run db:push
```

**What you should see:** `Your database is now in sync with your Prisma schema.`

### Step 1.7 — Add the roster and the NFL teams

**What you're doing:** creating the ten member accounts and the 32 NFL teams.

```
npm run db:seed
```

**What you should see:**

```
  32 NFL teams ready.
  10 member accounts ready (temporary password: ChangeMe!2026).
  Odds guideline set to -200 .. +200.
  26 award definitions ready.
  3 canonical historical corrections recorded.
Seed complete.
```

Everyone's starting password is `ChangeMe!2026`. **Austin is the
administrator.** Everyone should change their password after their first sign
in.

### Step 1.8 — Load the group's history

**What you're doing:** moving the spreadsheet's 260 picks into the database.

First look at what it *would* do, without changing anything:

```
npm run import:history -- data/Last_Place_Lagers_First_Class_Parlays.xlsx
```

**What you should see:**

```
Seasons found ............ 2024, 2025
Unique picks found ....... 260
Duplicates excluded ...... 150
Users matched ............ 10
Week Offs ................ 2024 W12, 2025 W15
Corrections applied ...... 3
Scores restored .......... 19

Expected cleaned baseline: 260 unique picks — MATCHED ✓

Preview only. Nothing was written.
```

If it says **MATCHED ✓**, run it again with `--apply` on the end to actually
save it:

```
npm run import:history -- data/Last_Place_Lagers_First_Class_Parlays.xlsx --apply
```

**What you should see:** `Imported. 260 picks written.`

### Step 1.9 — Start it up

**What you're doing:** turning both programs on.

Open **two** terminal windows. In the first, type:

```
npm run dev:api
```

**What you should see:** `First Class Parlays API listening on http://localhost:8080`
Leave this window open — closing it turns the app off.

In the second window, type:

```
npm run dev:web
```

**What you should see:** a line with `Local: http://localhost:5173/`

### Step 1.10 — Sign in

Open your web browser and go to **http://localhost:5173**

**What you should see:** a dark sign-in screen with a football at the top. Sign
in as `Austin` with password `ChangeMe!2026`.

You're running First Class Parlays. Tap through the five tabs at the bottom.
**Stats** already has all 260 historical picks in it.

---

## Part 2 — What is and isn't connected yet

The app deliberately shows **DATA CURRENTLY UNAVAILABLE** wherever a data source
hasn't been connected. It will never make up odds, statistics or news to fill a
gap.

Sign in as Austin and go to **Admin → Settings** to see exactly which sources
are connected.

| Source | What you lose without it | How to connect |
|---|---|---|
| Sports Bet Montana board reader | The odds members pick from | Part 3 below |
| NFL schedule | Each week's games appear automatically | Set `NFL_SCHEDULE_API_KEY` |
| Live scores & stats | The Sweat and automatic grading | Set `NFL_LIVE_API_KEY` |
| Player statistics | Hit rates and matchup research | Set `NFL_STATS_API_KEY` |
| Injuries | Injury notes in research | Set `INJURY_API_KEY` |
| Weather | Forecasts for outdoor games | Set `WEATHER_API_KEY` |
| News | Wager-specific news | Set `NEWS_API_KEY` |
| AI research | Case For / Case Against write-ups | Set `ANTHROPIC_API_KEY` |
| Ticket reading (OCR) | Reads the ticket photo for you | Set `OCR_PROVIDER` and `OCR_API_KEY` |

**Everything still works without them.** You can add games by hand (Admin →
add a game), enter odds by hand (Admin → manual market entry), and type the
ten ticket legs in yourself. Anything entered by hand is clearly labelled as
such so it's never confused with a live reading.

### Adding a key later

Open `apps/api/.env`, put the key between the quote marks on the matching line,
save, then stop the API (click its terminal window and press `Ctrl + C`) and
start it again with `npm run dev:api`. The Admin → Settings page will show it
as **Connected**.

---

## Part 3 — Connecting Sports Bet Montana (do this last)

> **Before you do anything here:** you told me the group has authorization to
> read Sports Bet Montana's publicly displayed board. Get that in writing, and
> ask them two questions:
>
> 1. What address should the reader use?
> 2. Is there a request rate they want us to stay under?
>
> **If they give you a rate limit, use theirs — it overrides everything below.**

The reader is built to be the politest possible visitor. It makes **one request
at a time**, waits **10-30 seconds between each one**, stops dead when it hits a
request budget, and shuts itself down at the first sign it isn't welcome. A full
scan taking **20-30 minutes is the intended behaviour**, not a problem.

To switch it on, open `apps/api/.env` and set:

```
SBM_BOARD_BASE_URL="the address they gave you"
SBM_READER_ENABLED="true"
SBM_USER_AGENT="FirstClassParlays/1.0 (private group tool; contact: your-real-email@example.com)"
```

Put your real email in that last line — it's how they reach you if the reader
ever causes a problem.

Restart the API, then go to **Admin → Reader** and press **RUN A SCAN NOW**.

**What you should see:** the page shows a scan in progress with a note like
"Reading event 3 of 14", the elapsed minutes climbing, and requests used against
the budget. When it finishes, the status reads **HEALTHY** and the duration
will be in the twenties of minutes. That is correct.

### If something goes wrong

The reader looks after itself. If Sports Bet Montana signals that it wants less
traffic, the reader **stops immediately**, waits out the requested cooldown, and
shows **PAUSED FOR SAFETY** on the Admin → Reader page. Repeated problems make
it wait *longer* each time, never shorter. It will never retry aggressively,
never disguise itself, and never try to work around a limit.

If it pauses and you've sorted out the cause, press **CLEAR SAFETY PAUSE**.

---

## Part 4 — Your week, step by step

### For a normal member

1. Open the app. The first thing on screen answers **"what is my pick this week?"**
2. Tap **MAKE A PICK** → pick a game → pick a wager.
3. Tap **RESEARCH** on any wager to look into it without leaving the app.
4. Tap **LOCK PICK** to reserve that NFL matchup for yourself.

That's the whole job. The app alerts you if anything important changes.

**About locking:** locking reserves the entire **matchup**, not just your wager.
If you lock anything from Bills @ Dolphins, nobody else can use that game —
no spread, no total, no prop, nothing. First to lock wins; there's no pick
order. You can unlock any time before the ticket is confirmed, which
immediately releases the game to everyone else.

### For the parlay manager (Austin)

1. **Monitor Admin → Readiness.** It shows all ten members with a tick, a
   warning or a red ❌ each. Anything marked ACTION REQUIRED needs sorting out
   before you place the bet.
2. **Place the actual wager yourself** at Sports Bet Montana. The app never
   does this and never can.
3. **Admin → Ticket → upload the photo** of the ticket.
   The photo appears on screen so you can check each leg against it.

4. **Press VERIFY AGAINST LOCKED PICKS.** The app compares every leg:
   - *Same wager, different price* → accepted automatically. Prices move; this
     is normal. Both prices are kept forever.
   - *Different threshold or different player* → flagged, and you must decide.
     The app will not quietly rewrite somebody's record.
5. **Press CONFIRM OFFICIAL PARLAY.** This freezes everyone's picks and starts
   live tracking.

After that the app handles the rest by itself: live tracking, grading,
standings, history, awards and the weekly recap.

---

## Part 5 — Putting it online so everyone can use it

Once it works on your computer, you need it somewhere that's always on.

**What you're doing:** renting a small computer on the internet to run the app
and the database.

The simplest option is **Railway** (https://railway.app) — roughly $5-10 a
month, and it handles the database for you.

1. Go to https://railway.app and sign up.
2. Click **New Project → Deploy from GitHub repo** and choose this repository.
3. Click **New → Database → Add PostgreSQL**. Railway creates the database and
   sets `DATABASE_URL` automatically — you don't have to type it.
4. Click your app service, then the **Variables** tab. Add each line from your
   `apps/api/.env` file **except** `DATABASE_URL` (Railway already did that
   one). Use the same long secrets you generated.
5. Add one more variable: `NODE_ENV` set to `production`.
6. Click the **Settings** tab, find **Generate Domain**, and click it.

**What you should see:** a web address like
`first-class-parlays.up.railway.app`. That's the link you send to the group.

7. Open that address, sign in as Austin, and run through step 1.8's import
   again from **Admin → History** by uploading the spreadsheet there.

### Getting it onto everyone's home screen

Send the group the link with these instructions:

- **iPhone:** open the link in **Safari** (it must be Safari), tap the share
  button (the square with an arrow), scroll down, tap **Add to Home Screen**,
  then **Add**.
- **Android:** open the link in **Chrome**, tap the three dots, tap
  **Add to Home screen**, then **Add**.

**What they should see:** a football icon on their home screen that opens
full-screen with no browser bars, like a real app.

---

## Part 6 — If something breaks

| What you see | What it means | What to do |
|---|---|---|
| `command not found` | Your computer can't find a program | Close the terminal, open a new one, try again |
| `ECONNREFUSED ... 5432` | The database isn't running | Start Postgres.app, or restart your computer |
| `Environment variable not found: DATABASE_URL` | The settings file is missing or misnamed | Check that `apps/api/.env` exists (note the dot) |
| `Port 8080 is already in use` | The app is already running | Find the other terminal window and press `Ctrl + C` |
| Sign-in says name and password don't match | Wrong name or password | Names are as listed in the roster; the starting password is `ChangeMe!2026` |
| A screen says DATA CURRENTLY UNAVAILABLE | That source isn't connected | See Part 2 — this is correct behaviour, not a bug |
| Ticket upload says "That file is not a photo" | The file isn't a real image, whatever its name says | Upload a JPEG, PNG, WebP, GIF or HEIC photo |
| Reader says PAUSED FOR SAFETY | Sports Bet Montana asked for less traffic | Leave it alone. It resumes by itself |

### Checking everything still works

```
npm test
```

**What you should see:** `Tests  206 passed`. This runs every rule in the app,
including the ten-people-lock-the-same-game test and the check that the
historical import still produces exactly 260 picks.

---

## What this app will never do

- Place a wager, or submit anything to Sports Bet Montana
- Take money, hold money or pay anybody out
- Ask for, store or use your Sports Bet Montana password
- Work around a sportsbook's location checks or traffic limits
- Invent odds, statistics, news or results to fill an empty screen

It is a private record-keeping and research tool for ten friends. One person
places the real bet, by hand, themselves.
