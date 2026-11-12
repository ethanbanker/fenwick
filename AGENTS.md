# Fenwick

An autonomous cat lives in a neon town. World and brain are two processes sharing
`data/`; `.env`, `config.json` and `data/` are live on the box and must survive a
deploy.

## Rules that outrank convenience

- **Everything he makes must be visible in the town.** A creation is not a record,
  a log line or a page on another route. If he writes it, it must physically stand
  at a tile in the world and be drawn in **both** viewers: the first-person town (`/`,
  `src/viewer/walk.js`) and the map (`/map`, `src/viewer/app.js`). Any change that
  adds a kind, field or state to creations updates both renderers in the same change.
  A kind the viewer does not know must still render as something, never nothing.
- **No creation may be invisible by omission.** Do not cap creations off the wire while
  leaving them in `data/`. If a limit is needed, make it high enough that his town can
  actually be seen, and say what the limit is.
- **His body and effects must be shown, not just simulated.** Needs, mood, inventory and
  what he made belong on the HUD (`src/viewer/walk.html`, `src/viewer/index.html`) and on
  `/mind`, not only in `/api/state`.
- **He asks for ideas; he does not write the object.** `make` produces a brief in
  `data/ideas/pending/`, with a reserved tile and target path, and an outside builder
  (Freebuff on the server) executes it. Never make him emit HTML inside a decision
  reply, and never let the idea queue write into `data/workshop` itself. An idea is
  done only when its target file exists.
- **The action vocabulary stays closed.** He chooses from `availableActions`; never let
  the model invent an effect. New behaviours get a declared kind or action with explicit
  effects and caps.
- **Building must not cancel the needs loop.** A fixture can soften hunger, fatigue or
  unease a little; it never replaces eating, sleeping or being a cat.

## Working here

- Node only, no npm dependencies, no local model hosting, zero cost.
- Verify with `node --check` on every edited file plus the relevant
  `.freebuff/*-check.ts` harness; pass the same check inside CT 103 after deploy.
- Never print API keys; never overwrite live `.env`, `config.json` or `data/` on deploy.
