# Phase 2 brief — core screens (exact Pandamonium)

Owner's rule: exactly the same look and feel as current Pandamonium, pixel perfect; screens expand to the window.
The phone app is the specification. Read `docs/PHASE1_SHELL_BRIEF.md` first: its References, unit rule (1 dp = 1 px)
and Rules sections apply here unchanged.

Extra references for this phase:
- Fold (wide, 2.2.53, PRIVATE: never copy into the repo, never quote contents):
  `/private/tmp/claude-501/-Users-eurobuddha-Projects-minima-apks-atomix/dd82a83f-8ce7-44ae-b064-e65a49b8dd87/scratchpad/fold/`
  `01-wallet-s.png`, `02-history-s.png`, `05-node-s.png`
- Phone-size, in the repo: `docs/reference/pandamonium-2.2.52/` — `light-01-wallet.png`,
  `light-01b-wallet-balance-expanded.png`, `light-02-wallet-token-dialog.png`, `light-03-receive.png`,
  `light-04-send.png`, `light-40-history.png`, `light-53-startup-params.png`, `light-53b-startup-params-scroll1.png`,
  `light-54-backup-hub.png`, `light-54b-backup-create.png`, `light-00a-language-picker.png`,
  `light-00b-launcher.png`, `light-00d-confirm-seed-empty.png`, and the `dark-` twins.
- Source: `/Users/eurobuddha/Projects/minima/apks/base/app/src/main/`
  - Wallet: `java/com/eurobuddha/minimacore/main/views/balance/` (BalanceView, BalanceAdapter, WalletReorderAdapter,
    TokenOrder, coins/CoinsDialog, coins/CoinDetailDialog), `res/layout/view_wallet_balance.xml`,
    `view_balance_row.xml`, `dialog_wallet_coins.xml`, `view_coin_row.xml`, `dialog_coin_detail.xml`
  - Receive: `views/receive/`, `res/layout/view_wallet_receive.xml`, `activity_receive.xml`
  - Send: `views/send/`, `res/layout/view_wallet_send.xml`, `activity_send.xml`, `send_spinner_item.xml`
  - History: `/Users/eurobuddha/Projects/minima/apks/base/integrated/history/` (and `apks/history` 0.3.18)
  - Startup Params: `main/ParamsActivity.java`, `main/StartupMode.java`, `res/layout/params_activity.xml`
  - Backup: `main/backup/`, `res/layout/backup_hub.xml`, `backup_create.xml`, `backup_restore.xml`, `vault_keys.xml`
  - First run: `launcher/` (LauncherActivity, newwallet/, restore/), `main/SeedEntry.java`,
    `res/layout/launcher_activity.xml`, `newwallet_activity.xml`, `restorewallet_activity.xml`, `seed_sync.xml`
  - Strings: `res/values/strings.xml` (use the phone's wording exactly)

## 2a. Wallet, Receive, Send

- Wallet: "Total balance" header with the expand chevron and its breakdown, as the phone; Send and Receive buttons;
  "TOKENS"; each row is icon (with the validated badge), name, amount, and the phone's one-line breakdown
  ("4 coins", "locked 20 · 20 coins"). Nothing else on the row. Rows drag to reorder (Minima pinned), order saved.
  Tapping a row opens the coins dialog; a coin opens the coin detail with the full coin id and token id, copyable.
- Split and Consolidate are desktop additions the owner wants kept. They move OFF the rows into the token's coins
  dialog as two buttons, with their existing forms and safety checks unchanged.
- Receive: "Scan to receive", QR, the full address, Copy, and the phone's "Get Address" behaviour: it must use
  `getaddress` (the current default address), NOT `newaddress` (the desktop today mints a new key on every press;
  that is the defect). Keep the desktop's address label field only if it does not change the layout.
- Send: the phone's order and wording: Token, Sendable, Amount with Max, To, "Send Funds". The phone's Scan button
  has no desktop equivalent: leave it out. Keep every existing desktop safety check (address validation, the review
  step, the send PIN / confirm, the injection guard on pasted addresses). No change to how the send is built.
- Amounts are truncated, never rounded. Identifiers are never shortened.

## 2b. History

Reproduce the phone's History tab over the existing `history.sqlite` and normalisation logic (do not migrate or
rewrite the store). Add what the phone has and the desktop lacks: Export JSON, Import / merge history, "Hide foreign
contract activity", and the per-row chain-inclusion state ("Checking chain inclusion…" / "Unverified"). Keep the
desktop's direction/token filter only if the phone has an equivalent place for it; otherwise put it in the same
overflow as the phone's options.

## 2c. Startup Params, Backup & Recovery, first run, key mode

- Startup Params: the phone's screen (server, MegaMMR, RPC and password copy, auto-resync, Keets, extra params; Save
  and Save & restart), fed by the existing `renderer/params.js` manifest and reconfigure logic.
- Backup & Recovery: the phone's hub (create backup, restore from file, private keys / vault, resync, chat backup)
  over the existing desktop backup functions. Mail backup has no phone row: place it after chat backup.
- First run: the phone's launcher (language, Startup, New wallet / Restore), the 24-word seed screen, the
  confirm-entry screen, restore with guided word entry. Reuse the desktop's existing wizard logic underneath.
- Key mode (owner decision D1): NEW wallets use block-as-key-uses; EXISTING wallets keep classic keys and are never
  switched. The mode is fixed when the wallet is created and stored with the install; an install with existing node
  data and no stored mode is classic. The Classic mode switch appears only before a wallet exists (first run /
  Startup), as in Pandamonium. Restore from seed asks which mode the seed was used in, in plain words, because the
  same 24 words give different keys in each mode. This item depends on the node-jar proof
  (`docs/JAR_PROOF.md`, written separately): do not ship a jar change without it.
- Settings (desktop-only items: updates, open at login, diagnostics, labels): restyle with the shell tokens; remove
  the second command box that duplicates Terminal.

## Rules

- No change to any money path beyond the Receive `getaddress` fix above. Do not edit engine files.
- Every screen checked in the dev preview against its reference, light and dark, at 932x704 and 1440x900.
- No dead controls. What cannot work yet is left out and listed in the report.
