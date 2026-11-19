# Phase 3 brief — Dexicon

Owner's rules for this phase:
- The PUBLIC Dexicon goes in, never DexiconPro (private, the owner's own). Dexicon replaces the Pools and AtomiX tabs.
- "I want it to look exactly like Dexicon in PandaPools [in Pandamonium]", not the existing desktop screens.
- Dexicon is a protocol; apps are its clients. Never write "the Dexicon app" in UI text.
- Existing users' AtomiX swaps in flight and PandaPools pools carry over with zero loss.
- No manual swap cancel button. Amounts truncated, never rounded. MEXC is the only price source (fallback: the MEXC
  ticker via CoinGecko, never another exchange). No wash trading: a user's order must never fill against their own
  order or their own pool.

Read `docs/PHASE1_SHELL_BRIEF.md` first (references, 1 dp = 1 px, rules).

## The reference

Dexicon as it runs inside Pandamonium 2.2.53 (Dexicon v0.3.60), full screen, no shell bars.

- Wide (Fold, PRIVATE: read, never copy into the repo, never quote contents):
  `/private/tmp/claude-501/-Users-eurobuddha-Projects-minima-apks-atomix/dd82a83f-8ce7-44ae-b064-e65a49b8dd87/scratchpad/fold/`
  `08-dex-mxusd-swap-s.png`, `09-dex-mxusd-market-s.png`, `10-dex-mxusd-otc-s.png`, `14-dex-pools-s.png`,
  `15-dex-pools-pools-s.png`, `16-dex-pools-mylp-s.png`, `17-dex-pools-wallet-s.png`, `18-dex-pools-activity-s.png`,
  `19-dex-exchange-s.png`, `20-dex-ex-orders-s.png`, `21-dex-ex-history-s.png`, `22-dex-activity-s.png`,
  `23-dex-assets-s.png`, `24-dex-settings-s.png`
- Phone-size, in the repo: `docs/reference/pandamonium-2.2.52/light-10…` to `light-37…` and `dark-10`, `dark-20`,
  `dark-30` (Dexicon's own light theme is `light-35`, `-36`, `-37`).
- Source of the screens: `/Users/eurobuddha/Projects/minima/apks/dexicon` (0.3.62; `Design.java`, `MainActivity.java`,
  the room and tab classes) and its snapshot in Pandamonium `/Users/eurobuddha/Projects/minima/apks/base/integrated/dexicon`.
  Fonts: Inter and JetBrains Mono. Palette: `Design.java` (night `#0B0D12` / `#12151C` / `#1B1F28`, orange
  `#F7931A`, MxUSD green `#26A17B`), with its own light theme behind the sun button.

Structure (see `19-dex-exchange-s.png`): header "◆ DEXICON", version pill, theme button, ✕ (back to the tabs);
a status strip ("PAIRED") with the block number, and in the MxUSD room the ⇄ currency pill; three room pills
① MxUSD, ② Pools, ③ Exchange; the room's screen; a bottom icon tab bar that changes per room:
- ① MxUSD: Swap, Market, OTC, Activity, Assets, Settings
- ② Pools: Swap, Pools, My LP, Wallet, Activity
- ③ Exchange: Trade, Orders, History, Activity, Assets, Settings
Each room remembers its last tab. Dexicon opens on ① in MxUSD mode, unless a MINIMA-market swap or maker is live.

## Engines (never redrawn, never edited)

| Room | Engine | Data | State today |
|---|---|---|---|
| ① MxUSD | `main/atomix.js` + `main/atomix/` (atomix-mds, verbatim) | `userData/atomix.sqlite` | running in the desktop |
| ② Pools | `main/pandapools.js` + `main/pandapools/` (pandapools-mds, verbatim) | `userData/pandapools.sqlite` | running in the desktop |
| ③ Exchange | NEW: `mds/dexicon` engine (`lib/`, `resting/`, `crypto/`, `vendor/`, `service.js`) run in a vm | `userData/dexicon/dexicon.sqlite` | to be added |

Zero-loss migration is by construction: rooms ① and ② use the SAME engines and the SAME data files in place. Nothing
is re-keyed or handed over. Prove it with a test that boots the glue against a copy of a populated store.

For ③, reuse DexiconPro's host, which already runs this engine: `/Users/eurobuddha/Projects/minima/desktop/dexiconpro/`
`main/dexicon/loader.js`, `main/dexicon.js`, `main/dexicon/service.desktop.js`, `main/rooms.js` (the `dxroom://`
protocol and the command allow-list), `renderer/dexicon/mds.js`, `scripts/dexicon-parity-check.sh`. Vendor the engine
from `/Users/eurobuddha/Projects/minima/mds/dexicon` at its current HEAD (0.0.89; record the commit) with a parity
script and a committed digest manifest (CI has no donor repos: see `scripts/pandapools-parity-manifest.cjs`).

DexiconPro-only parts that must NOT come across:
- the injected MEXC feed (`PandaPrice`) and `DX_GATE`, PAUSE ALL / NUKE, the Mandate;
- `dexSql` refusing writes to `maker_state`, `mm_*`, `mxusd_tokenid`; `room.dex` refusing `MAKER_*` packets;
- the `mds.js` style hiding the maker view and ladder card;
- `service.desktop.js` not loading `lib/autocross.js` (the public build loads it);
- two AtomiX hosts at once (the public build keeps ONE engine with the ⇄ switch);
- `RELAY_HOSTS` hard-coded: the public build's allow-list is the user's relay list plus discovered relays, https only.

Keep from DexiconPro: the MDS page's own AtomiX "doors" stay hidden and their engine is never started. Room ① is
the real AtomiX on the same ETH key; a second settlement engine on that key would collide.

Signing: every node command already passes the one process-wide queue under `rpcCall` (`main/noderun.js`). The new
engine must use `rpcCall` and nothing else.

## Screens

The reference is the Android Dexicon. For each screen decide, by capturing it in the dev preview beside its Fold
capture: if the hosted MiniDapp view (③) already matches the Android screen, host it and drive it from the native
chrome (the page files stay verbatim; `mds.js` is the only file that differs); where it does not match, reproduce
the Android screen in HTML over the engine's read model and commands. Rooms ① and ② have no MiniDapp page in
Dexicon, so they are reproduced from the Android screens over the existing desktop engine glue
(`window.mcd` AtomiX and Pools calls). The chrome (header, strip, room pills, bottom bar) is native in all cases.

Every function the standalone AtomiX and PandaPools screens have must be present: both trade directions, slippage,
maker / market with chart and tap-to-take, OTC, the halt rescue card, CSV export (column names unchanged: another
tool parses them), Check now, consolidate, wallet send, pool create in four steps with the forced backup, restore
and recovery. Do a written feature-by-feature parity audit against the existing desktop AtomiX and Pools panels
BEFORE removing them; the old panels go only when the audit shows nothing lost.

## Order of work

- 3a Engine: vendor the Dexicon engine, host it, wire `dxroom://`, tests, parity manifest. No UI beyond what is
  needed to prove it boots. Verify how auto-cross avoids the user's own orders and own pools; if it does not, stop.
- 3b Chrome and ③ Exchange.
- 3c ① MxUSD.
- 3d ② Pools.
- 3e Parity audit, removal of the old AtomiX and Pools panels, the Quit warning for swaps and pool operations in
  flight (and a truthful "could not check" when an engine has not started), the Shutdown warning tightened the same
  way, and the reported mismatch between `main/atomix/lib/maker.js` and its donor explained.

## Rules

- Do not edit files under `main/atomix/`, `main/pandapools/`, or the vendored Dexicon engine.
- Nothing in this phase may be tried against a real node or real funds. Engine tests use mock runners; the owner
  tests on the dev node afterwards.
- Identifiers in full. The dollar token is MxUSD everywhere the desktop writes text (vendored engine text is left).
