/*
 * engine.js — the INTERACTIVE half of the Zero Edge Casino desktop port (DESKTOP-ONLY glue, editable).
 *
 * The donor's covenant/txn logic lives in ~/Projects/Ideas/universal-casino/mds/index.html, interleaved with the
 * browser DOM. This file lifts those functions with the MDS.cmd COMMAND STRINGS copied CHAR-FOR-CHAR (the covenant
 * is fund-critical — the state-port order, storestate flags, sign keys and payout split are reproduced exactly),
 * and replaces the DOM/localStorage/SFX wrappers with node-style `cb(err, result)` callbacks the orchestrator
 * drives over IPC. It runs in the SAME vm context as service.js behind the SAME MDS shim, so a bet secret written
 * here by createBet is the exact preimage service.js reads to auto-reveal, and MY_KEYS is shared.
 *
 * It does NOT call MDS.init (service.js owns the event handler). It exposes `global.CASINO`. Several small helpers
 * (getState/miniNum/isMyKey/extractResponse/setStates/SCRIPT_ADDR/MY_KEYS) are also declared by service.js; the
 * two run in one shared context with identical implementations (service.js loads last, last-wins — harmless).
 */

var SCRIPT_ADDR = "0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F";
var TIMEOUT_BLOCKS = 1500;
var PRESETS = {
  flip: { name: "Coin Flip", range: 2, payout: 2, labels: ["Heads", "Tails"] },
  dice: { name: "Dice", range: 6, payout: 6, labels: ["1", "2", "3", "4", "5", "6"] },
  roulette: { name: "Roulette", range: 36, payout: 36, labels: null }
};

var MY_PUBKEY = "", MY_HEX_ADDR = "", MY_ADDR = "", MY_KEYS = {};
var READY = false;
var SEQ = 0;
function tag() { return Date.now() + "_" + (++SEQ); }   // unique local txn-builder id (never on-chain)

// ---- shared helpers (identical to service.js's copies; safe in the shared context) ----
function getState(coin, port) {
  if (!coin.state) return "";
  for (var i = 0; i < coin.state.length; i++) { if (coin.state[i].port === port || coin.state[i].port == port) return coin.state[i].data; }
  return "";
}
function miniNum(v) { return parseFloat(parseFloat(v).toFixed(8)); }
function isMyKey(pubkey) { return MY_KEYS[pubkey] === true; }
function extractResponse(res) {
  if (!res || !res.response) return null;
  var r = res.response;
  if (typeof r === "string") return r;
  if (r.random) return r.random; if (r.hash) return r.hash; if (r.output) return r.output; if (r.value) return r.value;
  var keys = Object.keys(r);
  for (var i = 0; i < keys.length; i++) { if (typeof r[keys[i]] === "string" && r[keys[i]].indexOf("0x") === 0) return r[keys[i]]; }
  return null;
}
function setStates(txid, states, idx, callback) {
  if (idx >= states.length) { callback(); return; }
  MDS.cmd("txnstate id:" + txid + " port:" + states[idx][0] + " value:" + states[idx][1], function () { setStates(txid, states, idx + 1, callback); });
}
function gameType(range) {
  if (range == 2) return { name: "Coin Flip", icon: "✦" };
  if (range == 6) return { name: "Dice", icon: "⚀" };
  if (range == 36) return { name: "Roulette", icon: "◉" };
  return { name: "Custom (" + range + ")", icon: "✳" };
}
function pickLabel(range, pick) {
  if (range == 2) return parseInt(pick) === 0 ? "Heads" : "Tails";
  return "" + (parseInt(pick) + 1);
}

// ---- secrets (in-memory cache + keychain-backed MDS.keypair) ----
// FUND-SAFETY (C1): the commit preimage MUST be durably persisted BEFORE the on-chain send that commits to it — a
// lost preimage strands the pot to the counterparty's 1500-block timeout claim. So we don't just fire-and-forget:
// we require MDS.keypair.set to report success AND read the value back from durable storage before proceeding. On
// any failure cb(err) so createBet/takeBet ABORT before sending. cb(null) only when the secret is provably stored.
var SECRET_CACHE = {};
function saveSecret(key, value, cb) {
  SECRET_CACHE[key] = value;
  MDS.keypair.set(key, value, function (r) {
    if (!r || r.status !== true) { cb("could not save the bet secret — aborting to protect your funds"); return; }
    MDS.keypair.get(key, function (g) {
      if (g && g.value === value) cb(null);
      else cb("bet secret did not persist — aborting to protect your funds");
    });
  });
}
function getSecret(key, cb) {
  if (SECRET_CACHE[key]) { cb({ value: SECRET_CACHE[key] }); return; }
  MDS.keypair.get(key, function (r) { if (r && r.value) { SECRET_CACHE[key] = r.value; cb({ value: r.value }); } else { cb({ value: null }); } });
}

// ---- funding-coin selection (donor findCoins) — desktop guard: on a shared node the wallet can hold anyone-can-spend
// beacon dust (no key → strands txnsign:auto with a KeyRow NPE). A cheap length prefilter drops short sentinels, then
// each candidate is verified wallet-SIGNABLE via `checkaddress → {simple:true}` (the same reliable test sendpin uses)
// before it is selected — a 66-char anyone-can-spend coin passes the length filter but must never be a funding input. ----
function findCoins(tokenid, minAmount, excludeCoinid, callback) {
  if (typeof excludeCoinid === "function") { callback = excludeCoinid; excludeCoinid = null; }
  MDS.cmd("coins relevant:true sendable:true tokenid:" + tokenid, function (res) {
    if (!res.status || !res.response || res.response.length === 0) { callback(null); return; }
    var pool = res.response.filter(function (c) { return !c.state || c.state.length === 0; });
    pool = pool.filter(function (c) { return String(c.address || "").length >= 60; });   // cheap prefilter: drop short sentinels
    if (excludeCoinid) pool = pool.filter(function (c) { return c.coinid !== excludeCoinid; });
    pool.sort(function (a, b) { return parseFloat(b.amount) - parseFloat(a.amount); });   // largest first → fewest inputs / fewest checks
    var needed = parseFloat(minAmount), selected = [], sum = 0, i = 0;
    (function next() {
      if (sum >= needed) { callback({ coins: selected, total: sum }); return; }
      if (i >= pool.length) { callback(null); return; }   // ran out of signable coins before covering the bet
      var c = pool[i++];
      MDS.cmd("checkaddress address:" + c.address, function (chk) {
        if (chk && chk.response && chk.response.simple) { selected.push(c); sum += parseFloat(c.amount); }
        next();
      });
    })();
  });
}
function addMultipleInputs(txid, coins, idx, callback) {
  if (idx >= coins.length) { callback(true); return; }
  MDS.cmd("txninput id:" + txid + " coinid:" + coins[idx].coinid, function (res) { if (!res.status) { callback(false); return; } addMultipleInputs(txid, coins, idx + 1, callback); });
}

// ---- identity + keys (donor loadIdentity, localStorage layer dropped; cached in keychain-backed keypair) ----
function loadIdentity(cb) {
  if (MY_PUBKEY && MY_HEX_ADDR) { cb(); return; }
  MDS.keypair.get("casino_pubkey", function (kres) {
    if (kres && kres.value && String(kres.value).length > 10) {
      MY_PUBKEY = kres.value;
      MDS.keypair.get("casino_hexaddr", function (k2) {
        MY_HEX_ADDR = (k2 && k2.value) ? k2.value : "";
        MDS.keypair.get("casino_miniaddr", function (k3) {
          MY_ADDR = (k3 && k3.value) ? k3.value : MY_HEX_ADDR;
          if (MY_PUBKEY && MY_HEX_ADDR) { cb(); return; }
          fetchAndStoreIdentity(cb);
        });
      });
      return;
    }
    fetchAndStoreIdentity(cb);
  });
}
function fetchAndStoreIdentity(cb) {
  MDS.cmd("getaddress", function (res) {
    if (!res.status || !res.response) { cb(); return; }
    MY_PUBKEY = res.response.publickey; MY_HEX_ADDR = res.response.address; MY_ADDR = res.response.miniaddress;
    MDS.keypair.set("casino_pubkey", MY_PUBKEY, function () { MDS.keypair.set("casino_hexaddr", MY_HEX_ADDR, function () { MDS.keypair.set("casino_miniaddr", MY_ADDR, function () { cb(); }); }); });
  });
}
function loadWalletKeys(cb) {
  MDS.cmd("keys", function (res) {
    try { if (res && res.status && res.response) { var list = res.response.keys || res.response; if (Array.isArray(list)) { for (var i = 0; i < list.length; i++) { var pk = list[i].publickey || list[i]; if (pk && typeof pk === "string") MY_KEYS[pk] = true; } } } } catch (e) {}
    if (MY_PUBKEY) MY_KEYS[MY_PUBKEY] = true;
    if (cb) cb();
  });
}
function ensureReady(cb) {
  if (READY) { cb(); return; }
  loadIdentity(function () { loadWalletKeys(function () { READY = true; cb(); }); });
}

// ---- history record (dedup by coinid; mirrors service.js recordServiceResult, from either role's view) ----
function recordResult(coinid, range, playerpick, result, playerWins, isHouse, bet, payout, totalAmt) {
  var iWon = (playerWins && !isHouse) || (!playerWins && isHouse);
  var profit;
  if (iWon) { profit = isHouse ? parseFloat(bet) : miniNum(parseFloat(bet) * payout - parseFloat(bet)); }
  else { profit = isHouse ? miniNum(parseFloat(bet) * (payout - 1)) : parseFloat(bet); }
  var entry = { coinid: coinid, role: isHouse ? "House" : "Player", game: gameType(range).name, range: range, pickLabel: pickLabel(range, playerpick), resultLabel: pickLabel(range, result), profit: profit, won: iWon, bet: bet, amount: totalAmt, txid: coinid, time: Date.now() };
  MDS.keypair.get("casino_history", function (h) {
    var hist = []; try { if (h && h.value) hist = JSON.parse(h.value); } catch (e) {}
    if (hist.some(function (rb) { return rb.coinid === coinid; })) return;
    hist.unshift(entry); if (hist.length > 50) hist.pop();
    MDS.keypair.set("casino_history", JSON.stringify(hist));
  });
}

// ============================ read model ============================
function coinsAtContract(cb) {
  MDS.cmd("coins address:" + SCRIPT_ADDR, function (res) { cb((res && res.status && res.response) ? res.response : []); });
}
function openBets(cb) {
  ensureReady(function () {
    coinsAtContract(function (coins) {
      var out = [];
      coins.forEach(function (c) {
        if ((parseInt(getState(c, 6)) || 0) !== 0) return;               // phase 0 only
        if (isMyKey(getState(c, 0))) return;                              // can't take your own open bet
        var range = parseInt(getState(c, 3)) || 2;
        out.push({ coinid: c.coinid, range: range, payout: parseInt(getState(c, 4)) || range, bet: getState(c, 5), amount: c.amount, game: gameType(range).name, housePk: getState(c, 0), age: parseInt(c.age) || 0, timeout: parseInt(getState(c, 7)) || 0 });
      });
      cb(null, out);
    });
  });
}
function myBets(cb) {
  ensureReady(function () {
    coinsAtContract(function (coins) {
      var out = [];
      coins.forEach(function (c) {
        var amHouse = isMyKey(getState(c, 0)), amPlayer = isMyKey(getState(c, 8));
        if (!amHouse && !amPlayer) return;
        var phase = parseInt(getState(c, 6)) || 0, range = parseInt(getState(c, 3)) || 2;
        var timeout = parseInt(getState(c, 7)) || 0, age = parseInt(c.age) || 0;
        out.push({ coinid: c.coinid, phase: phase, role: amHouse && !amPlayer ? "House" : (amPlayer && !amHouse ? "Player" : "Self"), amHouse: amHouse, amPlayer: amPlayer, range: range, payout: parseInt(getState(c, 4)) || range, bet: getState(c, 5), amount: c.amount, pick: getState(c, 11), game: gameType(range).name, age: age, timeout: timeout, expired: timeout > 0 && age > timeout });
      });
      cb(null, out);
    });
  });
}
function history(cb) {
  MDS.keypair.get("casino_history", function (r) {
    var h = []; try { if (r && r.value) h = JSON.parse(r.value); } catch (e) {}
    cb(null, Array.isArray(h) ? h : []);
  });
}
function balance(cb) {
  MDS.cmd("balance", function (res) { var s = "0"; if (res && res.status && res.response && res.response.length > 0) s = String(res.response[0].sendable); cb(null, s); });
}

// ============================ actions (donor txn functions — command strings verbatim) ============================

// House creates a phase-0 bet: stake bet*(payout-1) to the contract; secret kept off-chain (keychain).
function createBet(presetId, betAmount, cb) {
  ensureReady(function () {
    if (!MY_PUBKEY || !MY_HEX_ADDR) { cb("Identity not loaded"); return; }
    var p = PRESETS[presetId]; if (!p) { cb("Unknown game"); return; }
    var rawBet = parseFloat(betAmount);
    if (!rawBet || rawBet <= 0 || isNaN(rawBet)) { cb("Enter a valid bet amount"); return; }
    var bet = parseFloat(rawBet.toFixed(2)), stake = miniNum(bet * (p.payout - 1)); if (stake <= 0) stake = bet;
    MDS.cmd("random", function (rres) {
      var secret = extractResponse(rres); if (!secret) { cb("Random failed"); return; }
      MDS.cmd("hash data:" + secret, function (hres) {
        var commit = extractResponse(hres); if (!commit) { cb("Hash failed"); return; }
        saveSecret("casino_secret_for_" + commit, secret, function (serr) {
          if (serr) { cb(serr); return; }   // preimage not durable → do NOT lock funds
          var stateObj = '{"0":"' + MY_PUBKEY + '","1":"' + MY_HEX_ADDR + '","2":"' + commit + '","3":"' + p.range + '","4":"' + p.payout + '","5":"' + bet + '","6":"0","7":"' + TIMEOUT_BLOCKS + '"}';
          var cmd = "send amount:" + stake + " address:" + SCRIPT_ADDR + " state:" + stateObj;
          MDS.cmd(cmd, function (sres) {
            if (sres && sres.status) cb(null, { ok: true, game: p.name, bet: bet, stake: stake, odds: (p.payout - 1) });
            else cb((sres && sres.error) || "Send failed");
          });
        });
      });
    });
  });
}

// Player takes a phase-0 bet (phase 0→1): add the bet to the pot, write player pubkey/addr/commit/pick.
function takeBet(coinid, pick, cb) {
  ensureReady(function () {
    if (!MY_PUBKEY || !MY_HEX_ADDR) { cb("Identity not loaded"); return; }
    coinsAtContract(function (coins) {
      var coin = coins.find(function (c) { return c.coinid === coinid; });
      if (!coin) { cb("Bet not found (already taken?)"); return; }
      if ((parseInt(getState(coin, 6)) || 0) !== 0) { cb("Bet no longer open"); return; }
      var bet = getState(coin, 5), total = miniNum(parseFloat(coin.amount) + parseFloat(bet));
      var range = parseInt(getState(coin, 3)) || 2;
      pick = parseInt(pick) || 0; if (pick < 0 || pick >= range) { cb("Invalid pick"); return; }
      var txid = "take_" + tag();
      MDS.cmd("random", function (rres) {
        var secret = extractResponse(rres); if (!secret) { cb("Random failed"); return; }
        MDS.cmd("hash data:" + secret, function (hres) {
          var commit = extractResponse(hres); if (!commit) { cb("Hash failed"); return; }
          saveSecret("casino_psecret_for_" + commit, secret, function (serr) {
            if (serr) { cb(serr); return; }   // preimage not durable → do NOT commit the take
            findCoins("0x00", parseFloat(bet), coinid, function (result) {
              if (!result) { cb("Insufficient Minima (need " + bet + ")"); return; }
              MDS.cmd("txncreate id:" + txid, function (r0) {
                if (!r0.status) { cb("txncreate failed"); return; }
                MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function (r1) {
                  if (!r1.status) { MDS.cmd("txndelete id:" + txid); cb("contract input failed"); return; }
                  addMultipleInputs(txid, result.coins, 0, function (ok) {
                    if (!ok) { MDS.cmd("txndelete id:" + txid); cb("fund input failed"); return; }
                    MDS.cmd("txnoutput id:" + txid + " amount:" + total + " address:" + SCRIPT_ADDR + " storestate:true", function (r3) {
                      if (!r3.status) { MDS.cmd("txndelete id:" + txid); cb("output failed"); return; }
                      var change = miniNum(result.total - parseFloat(bet));
                      var afterChange = function () {
                        var states = [[0, getState(coin, 0)], [1, getState(coin, 1)], [2, getState(coin, 2)], [3, getState(coin, 3)], [4, getState(coin, 4)], [5, getState(coin, 5)], [6, "1"], [7, getState(coin, 7)], [8, MY_PUBKEY], [9, MY_HEX_ADDR], [10, commit], [11, "" + pick]];
                        setStates(txid, states, 0, function () {
                          MDS.cmd("txnsign id:" + txid + " publickey:auto", function (rs) {
                            if (!rs.status) { MDS.cmd("txndelete id:" + txid); cb("Sign failed: " + (rs && rs.error || "")); return; }
                            MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function (resArr) {
                              var rp = Array.isArray(resArr) ? resArr[resArr.length - 1] : resArr;
                              if (rp && rp.status) cb(null, { ok: true, game: gameType(range).name, pick: pick, pickLabel: pickLabel(range, pick), bet: bet });
                              else { MDS.cmd("txndelete id:" + txid); cb("Post failed: " + (rp ? rp.error : "")); }
                            });
                          });
                        });
                      };
                      if (change > 0.000001) { MDS.cmd("txnoutput id:" + txid + " amount:" + change + " address:" + MY_HEX_ADDR + " storestate:false", function (rc) { if (!rc.status) { MDS.cmd("txndelete id:" + txid); cb("change output failed"); return; } afterChange(); }); }
                      else { afterChange(); }
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

// House manual-reveal (phase 1→2) — a fallback; service.js normally does this automatically each block.
function manualReveal(coinid, cb) {
  ensureReady(function () {
    coinsAtContract(function (coins) {
      var coin = coins.find(function (c) { return c.coinid === coinid; });
      if (!coin) { cb("Bet not found"); return; }
      var betCommit = getState(coin, 2);
      getSecret("casino_secret_for_" + betCommit, function (sres) {
        if (!sres.value) { cb("House secret not found"); return; }
        var housesecret = sres.value, txid = "reveal_" + tag();
        MDS.cmd("txncreate id:" + txid, function (r0) {
          if (!r0.status) { cb("txncreate failed"); return; }
          MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function (r1) {
            if (!r1.status) { MDS.cmd("txndelete id:" + txid); cb("input failed"); return; }
            MDS.cmd("txnoutput id:" + txid + " amount:" + coin.amount + " address:" + SCRIPT_ADDR + " storestate:true", function (r2) {
              if (!r2.status) { MDS.cmd("txndelete id:" + txid); cb("output failed"); return; }
              var states = [[0, getState(coin, 0)], [1, getState(coin, 1)], [2, getState(coin, 2)], [3, getState(coin, 3)], [4, getState(coin, 4)], [5, getState(coin, 5)], [6, "2"], [7, getState(coin, 7)], [8, getState(coin, 8)], [9, getState(coin, 9)], [10, getState(coin, 10)], [11, getState(coin, 11)], [12, housesecret]];
              setStates(txid, states, 0, function () {
                MDS.cmd("txnsign id:" + txid + " publickey:" + getState(coin, 0), function (rs) {
                  if (!rs.status) { MDS.cmd("txndelete id:" + txid); cb("Sign failed"); return; }
                  MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function (resArr) {
                    var rp = Array.isArray(resArr) ? resArr[resArr.length - 1] : resArr;
                    if (rp && rp.status) cb(null, { ok: true });
                    else { MDS.cmd("txndelete id:" + txid); cb("Reveal failed"); }
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

// Player manual-resolve (phase 2→payout) — a fallback; service.js normally does this automatically each block.
function manualResolve(coinid, cb) {
  ensureReady(function () {
    coinsAtContract(function (coins) {
      var coin = coins.find(function (c) { return c.coinid === coinid; });
      if (!coin) { cb("Bet not found"); return; }
      var playerCommit = getState(coin, 10);
      getSecret("casino_psecret_for_" + playerCommit, function (sres) {
        if (!sres.value) { cb("Player secret not found"); return; }
        var playersecret = sres.value, housesecret = getState(coin, 12);
        var bet = getState(coin, 5), payout = parseInt(getState(coin, 4)), range = parseInt(getState(coin, 3)), playerpick = parseInt(getState(coin, 11));
        var winnings = miniNum(parseFloat(bet) * payout), totalAmt = parseFloat(coin.amount);
        var houseaddr = getState(coin, 1), playeraddr = getState(coin, 9);
        var combined = housesecret + playersecret.substring(2);
        MDS.cmd("hash data:" + combined, function (hres) {
          var hash = extractResponse(hres); if (!hash) { cb("Hash failed"); return; }
          var num = parseInt(hash.substring(2, 10), 16), result = num % range, playerWins = (result === playerpick);
          var txid = "resolve_" + tag();
          MDS.cmd("txncreate id:" + txid, function (r0) {
            if (!r0.status) { cb("txncreate failed"); return; }
            MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function (r1) {
              if (!r1.status) { MDS.cmd("txndelete id:" + txid); cb("input failed"); return; }
              var afterOutputs = function () {
                MDS.cmd("txnstate id:" + txid + " port:13 value:" + playersecret, function () {
                  MDS.cmd("txnsign id:" + txid + " publickey:" + getState(coin, 8), function (rs) {
                    if (!rs.status) { MDS.cmd("txndelete id:" + txid); cb("Sign failed"); return; }
                    MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function (resArr) {
                      var rp = Array.isArray(resArr) ? resArr[resArr.length - 1] : resArr;
                      if (rp && rp.status) {
                        var isHouse = isMyKey(getState(coin, 0));
                        recordResult(coinid, range, playerpick, result, playerWins, isHouse, bet, payout, totalAmt);
                        cb(null, { ok: true, playerWins: playerWins, result: result, pick: playerpick, range: range, isHouse: isHouse });
                      } else { MDS.cmd("txndelete id:" + txid); cb("Resolve failed: " + (rp ? rp.error : "")); }
                    });
                  });
                });
              };
              if (playerWins) {
                MDS.cmd("txnoutput id:" + txid + " amount:" + winnings + " address:" + playeraddr + " storestate:false", function (ro1) {
                  if (!ro1.status) { MDS.cmd("txndelete id:" + txid); cb("payout output failed"); return; }
                  var remainder = miniNum(totalAmt - winnings);
                  if (remainder > 0.00001) { MDS.cmd("txnoutput id:" + txid + " amount:" + remainder + " address:" + houseaddr + " storestate:false", function (ro2) { if (!ro2.status) { MDS.cmd("txndelete id:" + txid); cb("remainder failed"); return; } afterOutputs(); }); }
                  else { afterOutputs(); }
                });
              } else {
                MDS.cmd("txnoutput id:" + txid + " amount:" + totalAmt + " address:" + houseaddr + " storestate:false", function (ro1) {
                  if (!ro1.status) { MDS.cmd("txndelete id:" + txid); cb("payout output failed"); return; }
                  afterOutputs();
                });
              }
            });
          });
        });
      });
    });
  });
}

// House cancels an untaken phase-0 bet (funds back to the house).
function cancelBet(coinid, cb) {
  ensureReady(function () {
    coinsAtContract(function (coins) {
      var coin = coins.find(function (c) { return c.coinid === coinid; });
      if (!coin) { cb("Bet not found"); return; }
      if ((parseInt(getState(coin, 6)) || 0) !== 0) { cb("Only an untaken bet can be cancelled"); return; }
      if (!isMyKey(getState(coin, 0))) { cb("Not your bet"); return; }
      var txid = "cancel_" + tag();
      MDS.cmd("txncreate id:" + txid, function (r0) {
        if (!r0.status) { cb("txncreate failed"); return; }
        MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function (r1) {
          if (!r1.status) { MDS.cmd("txndelete id:" + txid); cb("input failed"); return; }
          MDS.cmd("txnoutput id:" + txid + " amount:" + coin.amount + " address:" + MY_HEX_ADDR + " storestate:false", function (r2) {
            if (!r2.status) { MDS.cmd("txndelete id:" + txid); cb("output failed"); return; }
            MDS.cmd("txnsign id:" + txid + " publickey:" + getState(coin, 0), function (rs) {
              if (!rs.status) { MDS.cmd("txndelete id:" + txid); cb("Sign failed"); return; }
              MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function (resArr) {
                var rp = Array.isArray(resArr) ? resArr[resArr.length - 1] : resArr;
                if (rp && rp.status) cb(null, { ok: true, amount: coin.amount });
                else { MDS.cmd("txndelete id:" + txid); cb("Cancel failed"); }
              });
            });
          });
        });
      });
    });
  });
}

// Reclaim a stalled bet after its 1500-block timeout (phase 1 → player reclaims; phase 2 → house reclaims).
function claimTimeout(coinid, cb) {
  ensureReady(function () {
    coinsAtContract(function (coins) {
      var coin = coins.find(function (c) { return c.coinid === coinid; });
      if (!coin) { cb("Bet not found"); return; }
      var phase = parseInt(getState(coin, 6)) || 0;
      var signKey = phase === 1 ? getState(coin, 8) : getState(coin, 0);
      if (!isMyKey(signKey)) { cb("You can't claim this bet"); return; }
      var timeout = parseInt(getState(coin, 7)) || 0, age = parseInt(coin.age) || 0;
      if (!(timeout > 0 && age > timeout)) { cb("Not yet timed out (" + age + "/" + timeout + " blocks)"); return; }
      var txid = "timeout_" + tag();
      MDS.cmd("txncreate id:" + txid, function (r0) {
        if (!r0.status) { cb("txncreate failed"); return; }
        MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function (r1) {
          if (!r1.status) { MDS.cmd("txndelete id:" + txid); cb("input failed"); return; }
          MDS.cmd("txnoutput id:" + txid + " amount:" + coin.amount + " address:" + MY_HEX_ADDR + " storestate:false", function (r2) {
            if (!r2.status) { MDS.cmd("txndelete id:" + txid); cb("output failed"); return; }
            MDS.cmd("txnsign id:" + txid + " publickey:" + signKey, function (rs) {
              if (!rs.status) { MDS.cmd("txndelete id:" + txid); cb("Sign failed"); return; }
              MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function (resArr) {
                var rp = Array.isArray(resArr) ? resArr[resArr.length - 1] : resArr;
                if (rp && rp.status) cb(null, { ok: true, amount: coin.amount });
                else { MDS.cmd("txndelete id:" + txid); cb("Claim failed"); }
              });
            });
          });
        });
      });
    });
  });
}

global.CASINO = {
  ensureReady: ensureReady,
  status: function () { return { ready: READY, pubkey: MY_PUBKEY, address: MY_HEX_ADDR, keys: Object.keys(MY_KEYS).length, contract: SCRIPT_ADDR }; },
  openBets: openBets, myBets: myBets, history: history, balance: balance,
  createBet: createBet, takeBet: takeBet, cancelBet: cancelBet,
  manualReveal: manualReveal, manualResolve: manualResolve, claimTimeout: claimTimeout
};
