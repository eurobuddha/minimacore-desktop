# Review — minimaCore Desktop 0.16.87

**PandaPools engine parity: serial signing gate, SQL CoinLock, `$OADR` funding exclusion.**

No new user-facing feature. This release brings the Desktop copy of the PandaPools engine back into
byte-equality with the `pandapools-mds` MiniDapp it is copied from, and adds the machinery that keeps it
there. It is a prerequisite for the restore auto-withdraw work, which increases concurrent-signing
pressure by design and must not land on an ungated engine.

## Why this was necessary

`main/pandapools/*.js` is copied verbatim from the MDS MiniDapp. Twelve of the fourteen files were
byte-identical; **`poolmgr.js` and `service.js` had drifted ~200 lines each, with Desktop behind.** The
Desktop copies pre-dated the MDS 0.6.2x fund-safety hardening, so Desktop was missing:

- the **serial signing gate** (`SIGN_QUEUE` / `submitSign` / `gated`) — native 0.9.22 serialises every
  build→sign→post chain because Minima signatures are stateful one-time leaves;
- the **MiniDapp-wide signing lock** (`pp_signlock`) that serialises the page context against the
  background service context, which the in-memory queue alone cannot do;
- the **SQL CoinLock** (`pp_coinlocks`) and the lock-aware funding selection;
- the **`$OADR` funding exclusion** in five places.

Two transactions signing one key both read the same counter and sign the **same Winternitz leaf over
different data**, which discloses that leaf's private key. `CHANGELOG.md` (0.9.22) records this confirmed
in the wild: *"7 of 64 default keys on a live node flagged `RE-USED ×2`"*. Desktop is the surface where
this is most likely: one 12 s block poller drives `Book.scan`, the `service.js` NEWBLOCK worker, the
pending-sign resume and the verify pass in **one vm context over one sqlite file**.

Funding from `$OADR` is a related defect: `$OADR` is `RETURN SIGNEDBY($OPK)`, so selecting an owner coin
as funding makes `txnsign publickey:auto` sign with `$OPK` and then `ownerSignPost` sign with it again —
two leaves consumed for one action.

## Hunk classification — the claim this release rests on

Every hunk of both diffs was classified before anything was copied. The `PLATFORM` bucket had to come out
**empty**; a single entry there would have meant the fix belonged in the shim, not in the engine file.

| File | Hunk | Class | What it is |
|---|---|---|---|
| `poolmgr.js` | `37,39` | MDS-ADDED-SAFETY | `SIGN_QUEUE`, watchdog and sign-lock TTL constants |
| | `66,145` | MDS-ADDED-SAFETY | serial signing gate + `pp_signlock` acquire/touch/release |
| | `248,261` | MDS-ADDED-SAFETY | `buildAndPost` wrapped in `submitSign` + global lock + heartbeat |
| | `271,311` | MDS-ADDED-SAFETY | `pp_coinlocks` CoinLock (`lockTable`/`lockedMap`/`reserveLocks`) |
| | `323,325` | MDS-ADDED-SAFETY | `selectCoinsAttempt` reservation-retry wrapper |
| | `331,355` | DESKTOP-STALE | old funding selection with no `lockedMap` / no reservation |
| | `420`, `447`, `509`, `544`, `618` | DESKTOP-STALE | `excl` omitted `p.oadr` — five sites |
| `service.js` | `3,6` | COMMENT | header reflow only |
| | `45,47` | MDS-ADDED-SAFETY | service-side lock constants |
| | `451,584` | MDS-ADDED-SAFETY | service-side CoinLock, global sign lock, watchdog |
| | `625,626`, `708,709` | DESKTOP-STALE | old raw `coins relevant:true` best-coin pick, `$OADR` not excluded |
| | `641,643`, `732,734` | DESKTOP-STALE | old inline post chain, pre-`submitSignSvc` |

**`PLATFORM`: 0 hunks.** Both files call only `MDS.cmd` / `MDS.sql`, which `loader.js` and `sqlshim.js`
already supply. So byte-equality is the correct rule, and both files joined the parity set.

## Two traps in the catch-up itself

**1. `loader.js` did not expose `setInterval`/`clearInterval` to the vm sandbox.** `poolmgr.js`
`buildAndPost` calls `setInterval` **unconditionally** for the sign-lock heartbeat, so a plain copy would
have thrown `ReferenceError: setInterval is not defined` on every create / deposit / close / migrate /
swap. `service.js` guards with `typeof`, which here is *worse*: it would have held the lock with no
heartbeat and let `SIGN_LOCK_TTL_MS` reap a live lock mid-chain, silently. Fixed in the shim, which is
where runtime differences belong. `scripts/pandapools-signgate.test.cjs` asserts the sandbox provides
both, so this cannot regress. The existing lifecycle test never caught it because it stubs
`setInterval:()=>1` in its own outer sandbox.

**2. The new gate races the glue's own 200 s `withTimeout`.** Serialising chains moves the wait somewhere
the caller's timeout cannot see: an action can now sit **queued inside the engine** past its own timeout,
after the UI has already said "timed out — retry", and then post. The retry double-posts against the same
coins and both attempts sign. Fixed in `main/pandapools.js` with a glue-level serial queue that stamps a
deadline **before** enqueueing: a slot that comes up after its caller gave up is dropped without the
engine ever being entered. The engine's gate still matters — it is what serialises us against
`service.js`'s background keep-fresh and re-announce, which never come through the glue.

## Keeping it byte-identical

Parity was previously checked over 12 files with two substring spot-checks on `poolmgr.js`/`service.js`,
by hand only — not wired into `package.json` or CI.

- `scripts/pandapools-parity-check.cjs` — now **14 files**, spot-checks removed as redundant, and it
  **hard-fails when the donor tree is absent** instead of throwing an unhelpful `ENOENT` or passing
  vacuously.
- `scripts/pandapools-parity-manifest.cjs` + `pandapools-parity.manifest.json` — new. CI cannot see the
  donor (separate repo, not checked out), so CI verifies a committed sha256 digest manifest instead. The
  manifest changes **only** via `--update`, and `--update` refuses to run when the engine differs from the
  donor — so it cannot launder local drift into an approved digest.
- Wired into `package.json` (`test:pandapools`, `test:pandapools-parity`, `test:pandapools-manifest`) and
  into `desktop-build.yml` **before** the build step, on all three matrix legs — which also catches
  Windows/Linux line-ending corruption. `.gitattributes` pins `main/pandapools/*.js` as `-text`.

## Validation

- `npm run test:pandapools` — **31 pass, 0 fail** (24 pre-existing recovery + lifecycle tests, unchanged
  and still green against the new engine; 7 new sign-gate tests).
- `npm run test:pandapools-parity` — 14 byte-identical engine files, plus the existing renderer assertions.
- `npm run test:rpc` (2), `npm run test:parlons` (7) — unaffected, green.
- **Falsifiability checked:** with `poolmgr.js`, `service.js` and `loader.js` reverted to their pre-0.16.87
  state, 4 of the 7 new tests fail (sandbox timers, gate presence, close serialisation, `$OADR`
  exclusion). The two lock-primitive tests pass either way because they exercise the sqlite shim directly,
  which was never the broken part. The manifest gate was likewise confirmed to reject a one-line edit to a
  copied engine file, and `--update` to refuse it.

New tests in `scripts/pandapools-signgate.test.cjs`:

1. the vm sandbox provides `setInterval`/`clearInterval` to the engine
2. the engine carries the serial signing gate and the SQL CoinLock
3. `pp_signlock` primary-key contention returns `status:false` through the Desktop sql shim
4. `pp_coinlocks` primary-key contention prevents two selections reserving one coin
5. two concurrent closes serialise — the second chain never starts before the first posts
6. a fund action abandoned while queued is dropped before the engine is entered
7. funding selection never picks a coin at the pool owner payout address

## Not done here

- Live-node smoke test (create / deposit / close plus a deliberate concurrent attempt, confirming
  `pp_signlock` serialises and `pp_coinlocks` reserves) — required before release.
- Signed, notarized, stapled Mac DMG and the three-platform feed rows — the release step.
- No PandaPools feature work. Restore auto-withdraw, the forced verified backup at creation, the split
  signing-block messages, the backup dry-run, stranding notifications and full identifiers all follow in
  their own versions, native first.
