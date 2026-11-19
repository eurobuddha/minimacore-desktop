# Phase 1 brief — the shell (exact Pandamonium)

Owner's rule: "exactly the same look and feel as current Pandamonium. Pixel perfect." Screens expand to the window.
Do not invent layouts. Where this brief and the phone app disagree, the phone app wins; say so in your report.

## References (read these before writing code)

- Wide captures of the real app, 2.2.53, unfolded Fold, 2448x1848 px at 420 dpi (2.625 px per dp; so 932 x 704 dp).
  PRIVATE (real balances and mail): never copy them into the repo, never quote their contents.
  `/private/tmp/claude-501/-Users-eurobuddha-Projects-minima-apks-atomix/dd82a83f-8ce7-44ae-b064-e65a49b8dd87/scratchpad/fold/`
  `01-wallet-s.png`, `02-history-s.png`, `03-apps-s.png`, `04-chat-s.png`, `05-node-s.png`, `06-tray-s.png`,
  `07-overflow-s.png` (the `-s` files are 1500 px wide copies; the full-size files sit beside them).
- Phone-size captures, 2.2.52, light and dark: `docs/reference/pandamonium-2.2.52/` (see its `INDEX.md`).
- Source of truth for every value: `/Users/eurobuddha/Projects/minima/apks/base`
  - `app/src/main/res/values/{colors,dimens,type,styles,themes}.xml`, `values-night/colors.xml`
  - `app/src/main/res/layout/activity_main.xml`, `view_home.xml`, `view_apps.xml`, `view_apps_internal_row.xml`
  - `app/src/main/res/menu/optionsmenu.xml`, `app/src/main/res/drawable/` (tab icons: port each vector to inline SVG,
    path data unchanged), `app/src/main/res/font/` (Manrope)
  - `app/src/main/java/com/eurobuddha/minimacore/main/MainActivity.java`, `MainAdapter.java`
  - `app/src/pandamonium/java/com/eurobuddha/minimacore/integrated/PandamoniumHooks.java` (the tray: colours, rows,
    selected pill, reorder), `PandamoniumOrder.java`, `PandamoniumDestinations.java`
- Unit rule: 1 dp = 1 CSS px. 1 sp = 1 CSS px.

## What the shell is

Top to bottom, as in `01-wallet-s.png`:

1. Toolbar: tray button (three lines) at the left; "Minima Core" with "Pandamonium" beneath, centred; overflow
   button (three dots) at the right.
2. Tab strip, centred: Wallet, Dexicon, History, Apps, Chat, Node. Icon above label. The selected tab is Minima
   orange with a short orange underline. A hairline runs under the strip across the full width.
3. The screen for the selected tab, full window width.
4. Footer: green dot and "Last key block: N" at the left; "block @ time" at the right.

The tray (as in `06-tray-s.png`): header "Minima Core" / "Pandamonium"; one row per app with its round icon; the
selected row is the pale lime pill; "Language" pinned at the bottom; the node-mode line under it. Same colours in
light and dark. On desktop the tray PUSHES the screen aside (both stay usable, no dimming); closing it gives the
screen the full width back. Its open or closed state is remembered. Rows can be dragged into a new order (row 0,
Minima Core, is pinned) and the order is saved.

Tray rows, in this default order: Minima Core, MinimaMail, ETH Wallet, Future Cash Next, Minima Explorer,
Minima Vestr, Entropy, KeyUses, Minima Faucet, miniMall, Web Wallet, Parlons. Apps that do not exist on the desktop
yet (Future Cash Next, Minima Explorer, Entropy, KeyUses) are NOT listed until their phase builds them: no dead rows.
Minima Faucet may open the existing faucet card as its own screen.

Overflow menu (as in `07-overflow-s.png`), desktop subset in the phone's order: Logs, Terminal, Backup & Recovery,
Startup Params, Shutdown, Reset Minima, Language. Add "Settings" for the desktop-only settings that have no phone
home (updates, open at login, diagnostics). App Lock, Allow Screenshots and Battery are phone-only: leave them out.

An app opened from the tray shows under a host bar reading "Minima Core" / "Pandamonium" with the tray button, as
on the phone (see `docs/reference/pandamonium-2.2.52/light-71b-ethwallet-home.png`); the tab strip and footer are
hidden while an app is open, and "Minima Core" in the tray returns to the tabs.

## Mapping the existing desktop views (Phase 1 moves them; later phases rebuild them)

| Shell place | Existing view |
|---|---|
| Wallet tab | Balances. Receive and Send open from the Send / Receive buttons, not from tabs |
| Dexicon tab | Temporary holder for the existing AtomiX and Pools panels until Phase 3 |
| History tab | History |
| Apps tab | New: "Internal" list as in `03-apps-s.png`, one row per tray app with a Hide switch. No External sub-tab. Freeze comes in Phase 5 with the engines: leave it out, do not render a dead switch |
| Chat tab | Chat (Keets chat) |
| Node tab | Node, laid out as `05-node-s.png` |
| Tray apps | Mail, ETH Wallet, Vestr, miniMall, Web Wallet, Parlons, Faucet |
| Overflow | Logs, Terminal, Settings and the rest listed above |

## Rules

- Theme follows the system (`prefers-color-scheme`), as the phone does. Tokens from `colors.xml` and
  `values-night/colors.xml`, exact hex values. The light-theme toolbar title on the phone is nearly invisible (pale
  lime on white): do NOT copy that; use the normal text colour in light.
- Manrope everywhere in the shell; sizes and weights from `type.xml` / `styles.xml`. Sentence case, no uppercase
  tabs or buttons except where the phone has them ("TOKENS", "NODE" section labels).
- Integrated apps keep their own styles (`mail.css`, `chat.css`, `atomix-ui.css`): do not restyle them in this phase.
- No behaviour change to any money path. Do not edit `main/atomix/`, `main/pandapools/`, `main/casino/` engine files.
- Identifiers are never shortened. The dollar token is MxUSD. No em dashes in UI text.
- Keyboard: every tab, tray row and menu item reachable and operable by keyboard, visible focus ring.
- Narrow windows: the tray overlays (as on the phone) below 720 px wide; tabs never wrap.
