# Kanji Desk

An unofficial review and lesson app for WaniKani that runs in any browser, with the features you would otherwise add with userscripts built in. It uses your own WaniKani API token and talks to the WaniKani API directly. There is no server and no account.

**Use it here:** https://daiwa-scholars-two-thousand-twenty-vibe.github.io/kanji-desk/

A copy can also run on Vercel, for networks that block GitHub (see [Hosting on Vercel](#hosting-on-vercel)).

Kanji Desk is not made by, or linked to, WaniKani or Tofugu. Item content (meanings, readings, mnemonics, sentences, audio) comes from the WaniKani API with your token and belongs to Tofugu. None of it is stored in this repo.

## Getting started

1. On WaniKani, open **Settings → API Tokens** (https://www.wanikani.com/settings/personal_access_tokens).
2. Make a new token. Tick the permissions to **start assignments** and **create reviews**. Nothing else is needed.
3. Open Kanji Desk, paste the token and press **Connect**. The first download takes a minute or two; after that only changes are fetched.

**Test mode is on at first.** Answers are checked but nothing is sent to WaniKani, so you can try it on real items safely. Items you answer stay due and come back on WaniKani and your phone. Turn test mode off in Settings once the answer checking looks right to you.

There is also a demo with made-up items (the **Try the demo first** button). It never sends anything anywhere.

## What it does

| Feature | Like |
|---|---|
| Reviews and lessons, with WaniKani's answer rules: your synonyms, accepted and blocked meanings, small typos forgiven on longer words, a shake (not a miss) for a kanji's other reading or for Japanese typed into the meaning box | the site |
| **Retype, mark right, mark wrong** before moving on. An item is only sent once both halves are final | Double-Check |
| **Review order and filters**: shuffled, lower or higher levels first, current level first, lowest or highest SRS stage first, radicals then kanji then vocabulary, most overdue first, waiting longest first. Include or leave out radicals, kanji, vocabulary. Cap the session at 10, 20, 30, 50 or 100 | Reorder Omega |
| Meaning first, reading first or random. **Both halves back to back.** Items in play at once (1 to 20) | Reorder Omega |
| **Wrap up**: finish the items in play and stop | the site |
| **Lightning mode**: moves on by itself after a right answer | Flaming Durtles |
| **Looks similar**: WaniKani's visually similar kanji | similar-kanji scripts |
| **Shares radicals**: other kanji built from the same radicals, most shared first, with the shared radicals named | radical-relation scripts |
| Item info: meanings, readings (on'yomi, kun'yomi, nanori), mnemonics, hints, your notes, context sentences, audio, the radicals or kanji inside, the kanji or words it is used in, your streaks. Every related item opens in a sheet | the site |
| New SRS stage shown as each item finishes | the site |
| **Lesson caps**: an Apprentice cap and a lessons-per-day cap (counts lessons started on any device). Lesson order: WaniKani's, kanji first, or shuffled. Batch size 3 to 10 | Flaming Durtles |
| **Extra practice** (nothing sent): recent mistakes on this device, and leeches from your WaniKani stats | Leech Trainer, extra study |
| Next 24 hours forecast, level progress, SRS counts, search by kanji, kana, romaji or English | the dashboard |
| **Offline**: answers made offline are kept and sent, with the time you really answered, when you are back online. Installable on a phone or desktop | Flaming Durtles |
| Light and dark themes | |

Keys in a session: **Enter** answers and moves on · **Backspace** retypes · **+** / **−** marks right or wrong · **F** item info · **J** audio. In lessons: **← →** move · **Enter** next · **J** audio · **Q** quiz.

## How it talks to WaniKani

- The WaniKani API v2 answers browsers on any site (`Access-Control-Allow-Origin: *`), so the page calls `https://api.wanikani.com/v2` straight from your browser with `Authorization: Bearer <token>`.
- It downloads subjects, assignments, review statistics and study materials once, keeps them in IndexedDB, and later asks only for what changed (`updated_after`).
- A finished review is `POST /v2/reviews` with the miss counts for meaning and reading. A finished lesson quiz is `PUT /v2/assignments/<id>/start`. Both go through an outbox, sent in order. If WaniKani refuses one (for example, the item was already reviewed on another device), it is dropped and shown on the home screen.
- Before a session it syncs if the last sync was more than a minute ago, so items you did on your phone do not come back.

## Your token

- It stays in this browser's local storage (key `kanjidesk.token.v1`) and is only ever sent to `api.wanikani.com`.
- **Sign out and clear this device** in Settings deletes the token and every cached item from the browser.
- Pages on the same `github.io` address share one browser storage, so any other page you host there could read the token. Revoke it in WaniKani's settings if you lose a device or stop using the app.

## Hosting on Vercel

GitHub Pages is the main home, but some networks (a work laptop, for one) block every GitHub address. The same repo deploys to Vercel as it is, with no build step and no settings to change:

1. In Vercel, **Add New → Project**, import this repo, keep every default and press **Deploy**.
2. Every push to `main` then updates both copies.

No relay is needed: the page only talks to `api.wanikani.com` and `files.wanikani.com`, never to GitHub. Browser storage is per web address, so the Vercel copy starts empty: paste your token there once.

## Running it yourself

There is no build step. Serve the folder (IndexedDB and offline mode need `http://localhost` or https, not `file://`):

```bash
python3 -m http.server 8791
```

```bash
node --test tests/*.mjs     # answer checking, sessions, queues and the API client
```

Use the `tests/*.mjs` glob. On Node 26, `node --test tests/` runs 0 tests and still exits 0, so it looks like a pass.

After changing any file the offline cache serves, bump `SHELL` in `sw.js` so phones pick the change up even when they open the app offline first.

| Path | What it is |
|---|---|
| `js/check.js` | Answer checking: meanings, readings, typo tolerance, shakes (pure functions, tested) |
| `js/session.js` | One quiz session: queue, retype and mark, wrap-up, back-to-back, miss counts (pure, tested) |
| `js/items.js` | Due reviews, lessons, orders and filters, caps, forecast, level progress, similar kanji, shared radicals, leeches, search (pure, tested) |
| `js/wk.js` | The API client, sync and outbox (tested with a fake `fetch`) |
| `js/store.js` | IndexedDB cache, or memory for the demo |
| `js/demo.js` | The made-up demo items, also used by the tests |
| `js/app.js` | The screens |
| `sw.js` | Offline support |
| `vendor/wanakana.min.js` | WanaKana 5.3.1 (MIT) for romaji-to-kana typing |
| `tests/` | `test_check.mjs`, `test_session.mjs`, `test_items.mjs`, `test_wk.mjs` |

## Notes

- WaniKani's rules for third-party apps: token login only, no "WaniKani" in the app's name, no copying the site's look, no profit from its content, and respect for the subscription's level limit. Kanji Desk follows them: free accounts only see levels 1 to 3.
- The answer checker follows WaniKani's known rules but is not WaniKani's own code. If it ever marks something differently from the site, use **Mark right** or **Mark wrong**, and open an issue with the item and what you typed.
