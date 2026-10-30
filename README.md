# Sunday Basket

A meal-planning and grocery-ordering app for one household. Plan what you'll eat
over the next seven days, photograph what's already in the kitchen, and get a
shopping list that accounts for both.

Currently running as a Claude Artifact at
https://claude.ai/artifact/NigNCtcpGyPrFzXFoYQkj4. This repo is where it moves
to, so it can reach the outside world.

## What it does today

- **Week** — a rolling seven days from today, lunch and dinner per day. Meals
  come from the library; leftovers can be recorded without buying anything.
  Standing weekly consumption lives here too, with per-week overrides that
  expire on their own.
- **Meals** — the recipe library, the standing-item baselines, and the snack
  roster. Ingredient names autocomplete against everything already in use.
- **Kitchen** — what's on hand. Photograph the fridge or pantry and a vision
  model proposes a list to correct, or add items by hand.
- **List** — meals + standing items + picked snacks, minus what's in the
  kitchen, grouped by store. Each ingredient carries its own store and an
  optional saved product link.

Recipes import by pasting text or photographing them.

## Architecture

One file, `index.html`. No build step, no dependencies, no framework. Fonts come
from Google Fonts; everything else is inline.

The only thing that needs replacing to self-host is the `Store` object near the
top of the script. It exposes `all / get / put / del / onChange / init` over
whatever backing store is available, and today resolves to either the Artifact
`db` capability (shared, realtime, cross-device) or `localStorage`
(per-device). Point it at an HTTP API and nothing above it changes.

### Collections

| Collection | Key | Shape |
|---|---|---|
| `meals` | generated id | `{name, ingredients: [{name, qty, unit, store?}]}` |
| `plan` | ISO date (`2026-11-04`) | `{lunch: [ref], dinner: [ref]}` |
| `staples` | generated id | `{name, qty, unit}` — qty is **consumed** per week, not ordered |
| `adjust` | ingredient slug | `{name, qty, until}` — one-week override, ignored once `until` passes |
| `snacks` | generated id | `{name, qty, unit}` — the roster |
| `picks` | `"snacks"` | `{ids: [snackId], until}` — this week's picks, expire like `adjust` |
| `pantry` | generated id | `{name, qty, unit, guess}` — what's on hand |
| `items` | ingredient slug | `{name, store, url}` — store + product link, per ingredient |

A `plan` slot holds either a meal id or the string `leftovers:<name>`.
Leftovers deliberately contribute nothing to the shopping list.

`items` is the join between an ingredient and where it's bought. Ingredient
names are matched loosely (case-insensitive, plural-tolerant) via `nameKey()`,
which is why the editors autocomplete against names already in use — a
near-duplicate name silently gets its own store and its own product link.

## Where this is going

Everything on one VPS: the app, the API, the database, and the ordering agent.

```
  index.html          the app, served statically
  server/             Node: API + static serving
  server/db.sqlite    one file, backed up by copying it
  server/api/claude   proxies vision calls, holds the Anthropic key
  agent/              Playwright: builds carts, stops before checkout
```

Caddy terminates TLS in front; systemd restarts on boot and on crash.
Deploys are `git pull && npm install && systemctl restart groceries`.

### Two things break when it leaves the Artifact

1. **Shared storage.** Without the `db` capability the app falls back to
   `localStorage`, which never syncs between devices. Needs the API behind
   `Store`.
2. **Model access.** The pantry scan and recipe import call Claude through the
   Artifact runtime, billed to the viewer's own account. Self-hosted they need
   an Anthropic API key, which cannot live in the browser — hence the proxy
   endpoint.

Until both exist the hosted copy is a downgrade. Keep using the Artifact as the
live app and cut over at parity.

### Why a server at all

Everything remaining on the roadmap needs outbound network, which an Artifact
can never have:

- **Purchase-history import** from Jewel-Osco and Amazon, to fill `items` with
  real products and prices instead of entering them by hand.
- **Cart building.** No public ordering API exists for either Jewel-Osco
  (Albertsons runs those endpoints internally) or Whole Foods (Amazon). The
  realistic path is a browser-automation agent that fills a cart and stops
  before checkout for a human to review.
- **NYT Cooking import by URL.** Recipe pages embed `schema.org/Recipe`
  JSON-LD, so parsing is exact once fetched — but the content is paywalled, so
  it needs a stored session cookie that will expire periodically.
- **Scheduled runs** — build the cart every Sunday evening.

### Known risk: the agent's IP

Retail anti-bot systems classify inbound IPs by owning ASN, and essentially no
legitimate grocery traffic originates from a hosting provider. Running the
agent from the VPS may draw CAPTCHAs or account flags that the same agent
running from a residential connection would not.

This is untested, and one household logging in weekly is very low volume. If it
does become a problem the fix is contained: route only the agent's browser
traffic through a WireGuard tunnel to a device at home, so it exits on a
residential IP. Nothing else moves.

## Running it

Open `index.html` in a browser — that's the whole app. Data goes to
`localStorage` when the Artifact runtime isn't present.

To test from a phone on the same network, serve the directory and visit the
machine's LAN address rather than `localhost`:

```
python3 -m http.server 3000 --bind 0.0.0.0
```

Note that `http://` on a LAN address is not a secure context, so the clipboard
API is unavailable and the Copy button falls back to the older selection
method. Everything else behaves normally.
