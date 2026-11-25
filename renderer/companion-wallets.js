"use strict";
const NFT_MODES=Object.freeze({collection:"Collection",quick:"Quick send",control:"Coin control",merge:"Consolidate",bulk:"Distribute"});
let companionPage = 0;
let minimaProfile = null;
let minimaIndex = 0;
let minimaTab = "Balance";

function leaveCompanionWallet() {
  companionPage++;
  el("minimaWalletBody").replaceChildren();
  el("nftWalletBody").replaceChildren();
  minimaTab = "Balance";
}
function companionCard(title, content) {
  return wwCard(`<h1 class="ww-h1">${esc(title)}</h1>${content}`);
}
function companionError(error) { return esc(MainSaid.say(ipcError(error))); }
function companionTabs(names, selected) {
  return `<div class="ww-tabs">${names.map(name => `<button class="ww-tab ${name === selected ? "ww-tab--on" : ""}" data-wallet-tab="${esc(name)}">${th(name)}</button>`).join("")}</div>`;
}
async function renderMinimaWallet() {
  const page = ++companionPage, body = el("minimaWalletBody");
  const live = () => activeView === "minimawallet" && page === companionPage;
  body.innerHTML = companionCard("minimaWallet", `<p role="status">${running ? th("Loading…") : th("Waiting for the node…")}</p>`);
  if (!running) return;
  let wallet;
  try { wallet = await api.mwOpen(minimaProfile, minimaIndex); } catch (error) {
    if (live()) {
      body.innerHTML = companionCard("minimaWallet", `<p role="alert">${companionError(error)}</p><button class="ww-btn">${th("Retry")}</button>`);
      body.querySelector("button").onclick = renderMinimaWallet;
    }
    return;
  }
  if (!live()) return;
  minimaProfile = wallet.id;
  const count = wallet.mode === "classic" ? 64 : 32;
  const summary = `<p>${wallet.source === "node" ? th("Set up from the node seed") : th("Manually imported seed")} · ${wallet.mode === "classic" ? th("Classic keys") : th("Block-based keys")}</p>
    <label for="mwIndex">${th("Wallet address")}</label> <select id="mwIndex" class="ww-in">${Array.from({length:count}, (_,i) => `<option value="${i}"${i === wallet.index ? " selected" : ""}>${i+1} / ${count}</option>`).join("")}</select>`;
  let content = "";
  if (minimaTab === "Balance") {
    content = `<p class="ww-addr">${esc(wallet.miniaddress)}</p>${wallet.balances.map(b => `<div class="ww-drow"><span>${esc(wwName(b))}</span><b>${esc(b.confirmed)}</b></div>`).join("") || `<p>${th("No tokens at this address.")}</p>`}
      <button id="mwAll" class="ww-btn">${th("Balances across all addresses")}</button><button id="mwRefresh" class="ww-btn">${th("Refresh")}</button><button id="mwReset" class="ww-link">${th("Reset minimaWallet")}</button>`;
  } else if (minimaTab === "Receive") {
    content = `<p class="ww-addr">${esc(wallet.miniaddress)}</p><button class="ww-btn" id="mwCopy">${th("Copy")}</button>`;
  } else if (wallet.owned) {
    content = `<p>${th("This node owns the signing key. Use the Wallet tab to send.")}</p><button id="mwNative" class="ww-btn">${th("Open Wallet")}</button>`;
  } else {
    content = `<div id="mwPayment" role="status">${th("Checking the chain…")}</div>`;
  }
  body.innerHTML = companionCard("minimaWallet", summary + companionTabs(["Balance","Receive","Send"],minimaTab) + (minimaTab==="Balance"?'<p class="ww-fine">'+th("Opening Send looks up your public key at eurobuddha.com.")+'</p>':"") + content);
  body.querySelectorAll("[data-wallet-tab]").forEach(b => b.onclick = () => { minimaTab = b.dataset.walletTab; renderMinimaWallet(); });
  el("mwIndex").onchange = e => { minimaIndex = Number(e.target.value); renderMinimaWallet(); };
  if (el("mwAll")) el("mwAll").onclick = async () => {
    const button = el("mwAll"); button.disabled = true; button.textContent = t("Loading…");
    try {
      const rows = await api.mwPortfolio(wallet.id);
      if (!live()) return;
      body.innerHTML = companionCard("minimaWallet", '<h2>' + th("Balances across all addresses") + '</h2>' +
        (rows.map(row => `<article class="card"><p class="ww-addr">${esc(row.address)}</p>${row.balances.map(b => `<div class="ww-drow"><span>${esc(wwName(b))}</span><b>${esc(b.confirmed)}</b></div>`).join("")}<button class="ww-link" data-wallet-index="${row.index}">${th("Open Wallet")}</button></article>`).join("") || th("No tokens at this address.")) +
        '<button id="mwBack" class="ww-btn">' + th("Back") + '</button>');
      el("mwBack").onclick = renderMinimaWallet;
      body.querySelectorAll("[data-wallet-index]").forEach(b => b.onclick = () => { minimaIndex = Number(b.dataset.walletIndex); renderMinimaWallet(); });
    } catch (error) { if (live()) { toast(ipcError(error),"err"); button.disabled = false; button.textContent = t("Balances across all addresses"); } }
  };
  if (el("mwRefresh")) el("mwRefresh").onclick = renderMinimaWallet;
  if (el("mwReset")) el("mwReset").onclick = () => minimaReset(wallet, body);
  if (el("mwCopy")) el("mwCopy").onclick = () => copy(wallet.miniaddress);
  if (el("mwNative")) el("mwNative").onclick = () => selectTab("balances");
  if (el("mwPayment")) await minimaPayment(wallet, live);
}

function minimaReset(wallet, body) {
  const page = ++companionPage;
  body.innerHTML = companionCard("minimaWallet", `<form id="mwReplace"><p>${th("Keep the old seed and its key uses before replacing this wallet. This changes only minimaWallet.")}</p>
    <label for="mwSeed">${th("New seed phrase")}</label><input class="ww-in" id="mwSeed" type="password" required minlength="16" maxlength="1024" autocomplete="off" spellcheck="false">
    <label for="mwMode">${th("Key mode")}</label><select class="ww-in" id="mwMode"><option value="classic">${th("Classic keys")}</option><option value="block">${th("Block-based keys")}</option></select>
    <button class="ww-btn" type="submit">${th("Use this seed")}</button></form>
    <button id="mwFromNode" class="ww-link">${th("Use node seed and classic keys")}</button><button id="mwCancel" class="ww-link">${th("Cancel")}</button>`);
  const apply = async source => {
    const options = source === "node" ? {source} : {source, mode:el("mwMode").value, seed:el("mwSeed").value};
    if (!await showConfirm(t("Reset minimaWallet"), t("Replace the current minimaWallet profile? Keep its seed to recover its funds."), t("Replace"), true) || page !== companionPage) return;
    el("mwSeed").value = "";
    try {
      const id = await api.mwReplace(wallet.id, options);
      minimaProfile = id; minimaIndex = 0; minimaTab = "Balance";
      if (page === companionPage) renderMinimaWallet();
    } catch (error) { if (page === companionPage) toast(ipcError(error), "err"); }
  };
  el("mwReplace").onsubmit = e => { e.preventDefault(); apply("manual"); };
  el("mwFromNode").onclick = () => apply("node");
  el("mwCancel").onclick = renderMinimaWallet;
}

async function minimaPayment(wallet, live) {
  const form = el("mwPayment");
  if (wwUnknown(wallet.address)) {
    form.innerHTML = `<p>${th("Check History and your balance before trying this payment again.")}</p><button class="ww-btn">${th("I've checked: let me send again")}</button>`;
    form.querySelector("button").onclick = () => { wwUnknown(wallet.address,false); renderMinimaWallet(); };
    return;
  }
  let audit;
  try { audit = await api.mwAudit(wallet.id, wallet.index); } catch (error) {
    if (live()) {
      form.innerHTML = `<p>${companionError(error)}</p><button class="ww-btn">${th("Retry")}</button>`;
      form.querySelector("button").onclick = renderMinimaWallet;
    }
    return;
  }
  if (!live()) return;
  if (audit.minimum > audit.last) { form.textContent = t("The archive estimate or saved count exceeds the signing limit. Sending is disabled."); return; }
  const tokens = wallet.balances.length ? wallet.balances : [{name:"Minima",tokenid:"0x00"}];
  form.innerHTML = `<form id="mwSendForm"><label for="mwToken">${th("Token")}</label><select class="ww-in" id="mwToken">${tokens.map(b=>`<option value="${esc(b.tokenid)}">${esc(wwName(b))}</option>`).join("")}</select>
    <label for="mwTo">${th("Recipient address")}</label><input class="ww-in" id="mwTo" required autocomplete="off">
    <label for="mwAmount">${th("Amount")}</label><input class="ww-in" id="mwAmount" required inputmode="decimal">
    <div class="ww-safe ww-safe--warn"><label for="mwUses">${th("Confirm key uses for this payment")}</label>
    <p>${th("Reusing a signing position puts funds at risk. The archive can miss skipped uses and signatures made elsewhere. If another wallet records a higher next use for this key, enter that number.")}</p>
    <p>${esc(t("Archive estimate: {chain}. Saved next use: {local}.", audit))} ${wallet.mode === "block" ? esc(t("Current block: {height}.",audit)) : ""} ${esc(t("Enter a number from {minimum} to {last}.",audit))}</p>
    <input class="ww-in" id="mwUses" required inputmode="numeric" autocomplete="off"></div><button id="mwPay" class="ww-btn" disabled>${th("Send")}</button></form>`;
  const valid = () => AppsAct.ww.validUses(el("mwUses").value, audit.minimum, audit.last);
  el("mwUses").oninput = () => el("mwPay").disabled = !valid();
  el("mwSendForm").onsubmit = async e => {
    e.preventDefault(); if (!valid()) return;
    const payment = { keyuses:el("mwUses").value, amount:el("mwAmount").value.trim(), to:el("mwTo").value.trim(), tokenid:el("mwToken").value };
    const invalid = AppsAct.ww.problem(payment); if (invalid) { toast(invalid,"err"); return; }
    const review = [payment.amount, payment.tokenid, payment.to, t("Key uses") + " " + payment.keyuses].join("\n");
    if (!await showConfirm(t("Confirm payment"), review, t("Send"), true) || !live()) return;
    form.textContent = t("Sending…");
    try {
      const result = await api.mwSend(wallet.id, wallet.index, payment);
      if (result.ambiguous) wwUnknown(wallet.address,true);
      toast(result.ok ? t("Payment submitted") : MainSaid.say(result.message), result.ok ? "ok" : "err");
    } catch (error) { toast(ipcError(error),"err"); }
    if (live()) renderMinimaWallet();
  };
}
let nftSnapshot = null;
function nftPicture(coin) {
  if (coin.collection && coin.edition) {
    const embedded = coin.state?.find(port => Number(port.port) === 1)?.data;
    const meta = typeof coin.token.name === "object" ? coin.token.name : {};
    const asset = /^\[[A-Za-z0-9+/=]+\]$/.test(embedded || "") ? embedded.slice(1,-1)
      : meta.mode === "url" && meta.base ? String(meta.base) + coin.edition + (meta.ext || ".png") : "";
    if (asset) {
      const icon = TOK.resolveIcon(asset);
      if (icon.data) return `<img class="tok-icon tok-icon--lg" src="${esc(icon.data)}" alt="">`;
      if (icon.remote) return `<img class="tok-icon tok-icon--lg" data-edition-image="${esc(icon.remote)}" src="${esc(TOK.identiconDataUri(coin.tokenid))}" alt="">`;
    }
  }
  return tokIconHtml(coin.tokenid,coin.token,true);
}
function loadEditionImages(body) {
  enhanceTokenIcons(body);
  for (const img of body.querySelectorAll("[data-edition-image]")) {
    api.tokenIcon(img.dataset.editionImage).then(data => { if (img.isConnected && typeof data === "string" && data.startsWith("data:image/")) img.src = data; }).catch(()=>{});
  }
}
async function renderNftWallet() {
  const page = ++companionPage, body = el("nftWalletBody");
  const live = () => activeView === "nftwallet" && page === companionPage;
  if (!running) { nftSnapshot = null; body.innerHTML = companionCard("NFTwallet",th("Waiting for the node…")); return; }
  body.dataset.design=localStorage.getItem("nftwallet.design") || "current";
  if (!body.firstChild) body.innerHTML = companionCard("NFTwallet",th("Loading…"));
  try {
    const coins = await api.nftList();
    if (!live()) return;
    const snapshot = JSON.stringify(coins);
    if (body.querySelector("#nftGallery") && snapshot === nftSnapshot) return;
    nftSnapshot = snapshot;
    const groups = new Map();
    for (const coin of coins) {
      if (!groups.has(coin.tokenid)) groups.set(coin.tokenid, []);
      groups.get(coin.tokenid).push(coin);
    }
    const previousSearch=body.querySelector("#nfGallerySearch")?.value || "";
    const favouritesOnly=body.querySelector("#nfFavourites")?.checked || false;
    body.innerHTML = companionCard("NFTwallet", `<p>${th("NFTs owned by the main node wallet")}</p>
      <div class="ww-tabs"><button id="nftMint" class="ww-tab">${th("Mint")}</button><button id="nftTools" class="ww-tab">${th("Coin control")}</button><button id="nftReceive" class="ww-tab">${th("Receive")}</button><button id="nftHistory" class="ww-tab">${th("History")}</button><button id="nftBalances" class="ww-tab">${th("Balances")}</button></div>
      <label for="nfDesign">${th("Theme")}</label><select id="nfDesign" class="ww-in"><option value="current">${th("Dark")}</option><option value="clean">${th("Light")}</option><option value="originalDark">${th("Original · Dark")}</option><option value="originalLight">${th("Original · Light")}</option></select>
      ${nftField("Search","nfGallerySearch")}<label><input id="nfFavourites" type="checkbox"> ${th("Favourites")}</label><div id="nftGallery"></div>`);
    el("nfDesign").value=body.dataset.design;
    el("nfDesign").onchange=e=>{body.dataset.design=e.target.value;localStorage.setItem("nftwallet.design",body.dataset.design);};
    const prefs=nftPreferences(coins[0]?.wallet || "empty");
    el("nfGallerySearch").value=previousSearch;el("nfFavourites").checked=favouritesOnly;
    function draw() {
      const q=el("nfGallerySearch").value.toLowerCase(), favourites=prefs.set("favourites");
      const sections=[];
      for(const items of groups.values()) {
        const first=items[0],name=TOK.tokenName(first.token,first.tokenid);
        const visible=items.filter(c=>(!el("nfFavourites").checked || favourites.has(c.coinid)) && [name,c.tokenid,c.coinid,"#"+(c.edition||"")].join(" ").toLowerCase().includes(q));
        if(!visible.length)continue;
        sections.push(`<article class="card">${nftPicture(first)} <b>${esc(name)}</b><div class="ww-id">${esc(first.tokenid)}</div>
          ${visible.sort((a,b)=>Number(a.edition||0)-Number(b.edition||0)).map(c=>`<div>${c.edition?nftPicture(c):""}<button class="ww-link" data-nft-coin="${esc(c.coinid)}">${c.collection ? c.edition ? "#"+esc(c.edition):th("Unstamped"):esc(c.amount)+" · "+th("Details")}</button>
          <button class="ww-link" aria-label="${th("Favourites")}" aria-pressed="${favourites.has(c.coinid)}" data-star="${esc(c.coinid)}">${favourites.has(c.coinid)?"★":"☆"}</button></div>`).join("")}
          ${first.collection?`<button class="ww-link" data-collect="${esc(first.tokenid)}">${th("Send collection")}</button><button class="ww-link" data-bury="${esc(first.tokenid)}" ${items.some(c=>c.pending || c.age<3)?"disabled":""}>${th("Bury collection")}</button>`:""}</article>`);
      }
      el("nftGallery").innerHTML=sections.join("") || `<p>${th("No NFTs in this wallet.")}</p>`;
      body.querySelectorAll("[data-nft-coin]").forEach(b=>b.onclick=()=>nftDetail(coins.find(c=>c.coinid===b.dataset.nftCoin)));
      body.querySelectorAll("[data-star]").forEach(b=>b.onclick=()=>{prefs.toggle("favourites",b.dataset.star);draw();});
      body.querySelectorAll("[data-collect]").forEach(b=>b.onclick=async()=>{
        const items=groups.get(b.dataset.collect).filter(c=>c.edition),first=items[0];
        if(!first)return;
        const to=await showPrompt(t("Recipient address"),"",t("Enter recipient address (Mx or 0x)"));
        if(!to || !b.isConnected || !await showConfirm(t("Confirm transfer"),[to,first.tokenid,...items.map(c=>c.coinid)].join("\n"),t("Transfer"),true) || !b.isConnected)return;
        b.disabled=true;
        try{for(const c of items){const r=await api.nftTransfer(c.coinid,to.trim(),first.wallet);if(!r.txpowid)throw Error(t("Check History and your balance before trying this payment again."));}
          toast(t("Transfer submitted. Check History for confirmation."));
        }catch(e){toast(ipcError(e),"err");}finally{if(b.isConnected)renderNftWallet();}
      });
      body.querySelectorAll("[data-bury]").forEach(b=>b.onclick=async()=>{
        const items=groups.get(b.dataset.bury),first=items[0],name=TOK.tokenName(first.token,first.tokenid);
        const typed=await showPrompt(t("Bury collection"),"",t("Type the collection name to permanently bury every owned edition.")+" "+name);
        if(typed!==name || !b.isConnected)return;
        if(!await showConfirm(t("Bury collection"),[name,first.tokenid,...items.map(c=>c.coinid)].join("\n"),t("Bury permanently"),true) || !b.isConnected)return;
        b.disabled=true;
        try{const result=await api.nftBuryCollection(first.wallet,first.tokenid,items.map(c=>c.coinid));toast(t("Submitted {n} of {total}",{n:result.submitted,total:result.total}));}
        catch(e){toast(ipcError(e),"err");}finally{if(b.isConnected)renderNftWallet();}
      });
      loadEditionImages(body);
    }
    el("nfGallerySearch").oninput=draw;el("nfFavourites").onchange=draw;draw();
    el("nftMint").onclick = nftMintScreen;
    el("nftTools").onclick = nftCoinScreen;
    el("nftReceive").onclick = nftReceiveScreen;
    el("nftHistory").onclick = () => selectTab("history");
    el("nftBalances").onclick = nftBalancesScreen;
    loadEditionImages(body);
  } catch (error) {
    if (live()) { nftSnapshot = null; body.innerHTML = companionCard("NFTwallet", `<p role="alert">${companionError(error)}</p><button class="ww-btn">${th("Retry")}</button>`); body.querySelector("button").onclick = renderNftWallet; }
  }
}
function nftDetail(c) {
  const body = el("nftWalletBody"), page = ++companionPage;
  const title = TOK.tokenName(c.token,c.tokenid) + (c.edition ? " #" + c.edition : "");
  body.innerHTML = companionCard("NFTwallet", `<div id="nftDetails">${nftPicture(c)}<h2>${esc(title)}</h2><p class="ww-id">${esc(c.coinid)}</p><p class="ww-addr">${esc(c.address)}</p>
    <p>${th("Amount")} · ${esc(c.amount)}</p>${c.state.map(row=>`<div class="ww-drow"><span>${esc(String(row.port))}</span><span class="ww-id">${esc(String(row.data))}</span></div>`).join("")}
    ${c.pending ? `<p>${th("Transfer submitted. Check History for confirmation.")}</p>` : ""}
    <button class="ww-btn" id="nftTransfer" ${c.pending || c.age<3 || (c.collection && !c.edition) ? "disabled" : ""}>${th("Transfer")}</button>
    <button class="ww-link" id="nftBury" ${c.pending || c.age<3 ? "disabled" : ""}>${th("Bury permanently")}</button><button class="ww-link" id="nftBack">${th("Back")}</button></div>`);
  loadEditionImages(body);
  el("nftBack").onclick = renderNftWallet;
  const transfer = async bury => {
    const to = bury ? "0xABA005476D2B3CD7F251B9783E64C124C9670BB358695F04D91B2057BB64CB49" : await showPrompt(t("Recipient address"),"",t("Enter recipient address (Mx or 0x)"));
    if (!to || page !== companionPage) return;
    if (!await showConfirm(bury ? t("Bury this NFT permanently?") : t("Confirm transfer"), [title, c.amount, c.tokenid, c.coinid, to].join("\n"),bury ? t("Bury permanently") : t("Transfer"),true) || page !== companionPage) return;
    el("nftTransfer").disabled = true;
    try {
      const res = await api.nftTransfer(c.coinid,to.trim(),c.wallet);
      toast(res.txpowid ? t("Transfer submitted. Check History for confirmation.") : t("Check History and your balance before trying this payment again."),res.txpowid ? "ok" : "err",res.txpowid);
    } catch (error) { toast(ipcError(error),"err"); }
    if (page === companionPage) renderNftWallet();
  };
  el("nftTransfer").onclick = () => transfer(false);
  el("nftBury").onclick = () => transfer(true);
}
async function nftImage(file, limit) {
  if (!file) return "";
  if (!file.type.startsWith("image/") || file.size > 24*1024*1024) throw Error("Choose an image smaller than 24 MB.");
  const bitmap=await createImageBitmap(file);
  try {
    const canvas=document.createElement("canvas");
    for (const edge of [768,512,320,256,160,96,64,32]) {
      const scale=Math.min(1,edge/Math.max(bitmap.width,bitmap.height));
      canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height);
      for (const q of [0.86,0.68,0.45]) {
        const data=canvas.toDataURL("image/jpeg",q).split(",")[1];
        if (data.length<=limit) return data;
      }
    }
    throw Error("Image exceeds its on-chain size budget.");
  } finally {bitmap.close();}
}
function nftField(label,id,attrs="") {
  return `<label class="ww-label" for="${id}">${th(label)}</label><input class="ww-in" id="${id}" ${attrs}>`;
}
async function nftMintScreen() {
  const page=++companionPage,body=el("nftWalletBody");
  body.innerHTML=companionCard("NFTwallet", `<div id="nftDetails">${th("Loading…")}</div>`);
  let state;
  try {state=await api.nftJobs();} catch(e) {if(page===companionPage) toast(ipcError(e),"err");return;}
  if (page!==companionPage)return;
  const display = kind => {
    const collection=kind===NFT_MODES.collection, token=kind==="Token";
    body.innerHTML=companionCard("NFTwallet",`<div id="nftDetails"><h2>${th("Mint")}</h2>${companionTabs(["Token","NFT","Collection"],kind)}
      <form id="nfMintForm">${nftField("Name","nfName",'required maxlength="128"')}${nftField("Description","nfDesc",'maxlength="1024"')}
      ${nftField(collection ? "Collection size" : "Supply","nfSize",collection?'type="number" value="2" min="2" max="20" required':'inputmode="numeric" value="1" required')}
      ${token?nftField("Decimals","nfDecimals",'type="number" min="0" max="16" value="0"')+nftField("Ticker","nfTicker")+nftField("Additional metadata (JSON)","nfExtra",'placeholder="{}"'):""}
      ${nftField("Image URL","nfIconUrl")}${nftField("Or choose an image","nfIcon",'type="file" accept="image/*"')}
      ${nftField("Validation URL","nfValidate")}${nftField("Website","nfWebsite")}
      ${collection?`<label for="nfImagesMode">${th("Edition artwork")}</label><select class="ww-in" id="nfImagesMode"><option value="url">${th("Image URLs")}</option><option value="embed">${th("Embedded images")}</option></select>
      <div id="nfUrls">${nftField("Base URL","nfBase")}${nftField("File extension","nfExt",'value=".png"')}</div><div id="nfFiles" hidden>${nftField("Edition images, in order","nfImages",'type="file" accept="image/*" multiple')}</div>`:
      nftField("Burn","nfBurn",'value="0" inputmode="decimal"') + (token?`<label><input type="checkbox" id="nfSign" checked> ${th("Sign with creator key")}</label>`:"")}
      <button class="ww-btn">${th("Review mint")}</button></form><h2>${th("Mint activity")}</h2>
      ${state.collections.map(r=>`<p>${esc(r.name)} · ${esc(r.phase)} · ${Number(r.stamped)} / ${Number(r.size)} ${esc(r.error || "")}</p>${!["DONE","BURIED","BURY"].includes(r.phase)?`<div><button class="ww-link" data-job="${r.id}" data-action="${r.phase==="STOPPED"?"resume":"stop"}">${r.phase==="STOPPED"?th("Resume"):th("Pause")}</button>
        ${r.createstuck?`<button class="ww-link" data-job="${r.id}" data-action="retry">${th("Retry creation")}</button>`:""}
        ${r.mode==="embed" && r.editable?.length?`<select id="nfEdition${r.id}">${r.editable.map(i=>`<option>${Number(i)}</option>`).join("")}</select><input type="file" accept="image/*" id="nfImage${r.id}"><button class="ww-link" data-job="${r.id}" data-action="image">${th("Save edition image")}</button>`:""}</div>`:""}`).join("")}
      ${state.payments.filter(r=>["NFT","Token"].includes(r.kind)).slice(-12).reverse().map(r=>`<p>${esc(r.name)} · ${esc(r.status)}</p>`).join("")}
      <button id="nfCheck" class="ww-link">${th("Refresh")}</button><button id="nfBack" class="ww-link">${th("Back")}</button></div>`);
    body.querySelectorAll("[data-wallet-tab]").forEach(b=>b.onclick=()=>display(b.dataset.walletTab));
    if(collection) el("nfImagesMode").onchange=()=>{el("nfUrls").hidden=el("nfImagesMode").value!=="url";el("nfFiles").hidden=!el("nfUrls").hidden;};
    body.querySelectorAll("[data-job]").forEach(b=>b.onclick=async()=>{
      const job=Number(b.dataset.job),action=b.dataset.action;
      try{
        if(action==="retry" && !await showConfirm(t("Retry creation"),t("If the first creation later confirms, both collections will exist and both will cost funds."),t("Retry"),true)) return;
        const opts=action==="image"?{index:Number(el("nfEdition"+job).value),image:await nftImage(el("nfImage"+job).files[0],8000)}:{};
        if(!b.isConnected)return;
        await api.nftRecover(state.id,job,action,opts);
        if(b.isConnected)nftMintScreen();
      }catch(e){toast(ipcError(e),"err");}
    });
    el("nfCheck").onclick=nftMintScreen;el("nfBack").onclick=renderNftWallet;
    const form=el("nfMintForm");
    form.onsubmit=async e=>{
      e.preventDefault();const button=form.querySelector("button");button.disabled=true;
      try{
        const val=id=>el(id)?.value.trim() || "";
        const opts={kind,name:val("nfName"),amount:val("nfSize"),size:Number(val("nfSize")),description:val("nfDesc"),decimals:Number(val("nfDecimals")),ticker:val("nfTicker"),burn:val("nfBurn")||"0",mode:val("nfImagesMode"),base:val("nfBase"),ext:val("nfExt"),external:val("nfWebsite"),webvalidate:val("nfValidate"),sign:!!el("nfSign")?.checked,extra:JSON.parse(val("nfExtra")||"{}")};
        const files=Array.from(el("nfImages")?.files || []);
        const iconUrl=val("nfIconUrl");
        opts.icon=await nftImage(el("nfIcon").files[0],collection?6000:16000) || iconUrl;
        opts.images=[];if(opts.mode==="embed") for(const f of files) opts.images.push(await nftImage(f,8000));
        if (!form.isConnected) return;
        const review=[kind,opts.name,opts.amount+" × "+opts.name,t("Decimals")+" "+opts.decimals,t("Burn")+" "+opts.burn,opts.description,opts.webvalidate,opts.external,opts.ticker,JSON.stringify(opts.extra),opts.base,opts.images.length?String(opts.images.length)+" "+t("Embedded images"):""].filter(Boolean).join("\n");
        if (!await showConfirm(t("Confirm mint"),review,t("Mint"),true) || !form.isConnected) return;
        await api.nftMint(state.id,opts);
        if(page===companionPage) nftMintScreen();
      } catch(error){toast(ipcError(error),"err");} finally {if(form.isConnected)button.disabled=false;}
    };
  };
  display("NFT");
}
async function nftCoinScreen() {
  const page=++companionPage, body=el("nftWalletBody");
  body.innerHTML=companionCard("NFTwallet",`<div id="nftDetails" role="status">${th("Loading…")}</div>`);
  try {
    const jobs=await api.nftJobs(), rows=await api.nftCoins();
    if (page!==companionPage) return;
    const tokenNames=new Map([["0x00","Minima"]]);
    rows.forEach(c=>{ if(c.tokenid!=="0x00") tokenNames.set(c.tokenid,TOK.tokenName(c.token,c.tokenid)); });
    let token="0x00";
    function display(mode) {
      const available=rows.filter(c=>c.tokenid===token), manual=mode===NFT_MODES.control||mode===NFT_MODES.merge, bulk=mode===NFT_MODES.bulk;
      body.innerHTML=companionCard("NFTwallet",`<div id="nftDetails">${companionTabs(["Quick send","Coin control","Consolidate","Distribute"],mode)}
        <form id="nfPayment"><label for="nfToken">${th("Token")}</label><select class="ww-in" id="nfToken">${[...tokenNames].map(([id,name])=>`<option value="${esc(id)}" ${id===token?"selected":""}>${esc(name)} · ${esc(id)}</option>`).join("")}</select>
        ${available.map(c=>`<details><summary>${manual?`<input type="checkbox" value="${esc(c.coinid)}" data-input ${c.eligible?"":"disabled"}>`:""} ${esc(c.tokenamount || c.amount)} · ${esc(c.coinid.slice(0,14))}…</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(c,null,2))}</pre></details>`).join("")}
        ${bulk?`<label for="nfTo">${th("Recipient addresses, one per line")}</label><textarea class="ww-in" id="nfTo" required></textarea>`:mode===NFT_MODES.merge?"":nftField("Recipient address","nfTo","required")}
        ${mode===NFT_MODES.merge?"":nftField(bulk?"Amount per recipient":"Amount","nfAmount",'inputmode="decimal" required')}
        ${mode===NFT_MODES.quick?nftField("Split outputs","nfSplit",'type="number" min="1" max="20" value="1" required')+nftField("Burn (Minima, optional)","nfFee",'inputmode="decimal" placeholder="0"'):""}
        ${!bulk && mode!==NFT_MODES.merge?'<button type="button" class="ww-link" id="nfScan">'+th("Scan QR")+'</button>':""}
        ${manual?nftField("Change address (optional)","nfChange"):""}
        <button class="ww-btn">${th("Review")}</button></form>
        ${jobs.distributions.map(j=>`<p>${th("Distribute")} · ${esc(j.status)} · ${Number(j.next)} / ${Number(j.recipients.length)} ${esc(j.error||"")} ${["paused","waiting","ready"].includes(j.status)?`<button type="button" class="ww-link" data-dist="${esc(j.id)}" data-act="${j.status==="paused"?"resume":"stop"}">${j.status==="paused"?th("Resume"):th("Pause")}</button>`:""}</p>`).join("")}
        <button class="ww-link" id="nfRefresh">${th("Refresh")}</button><button class="ww-link" id="nfBack">${th("Back")}</button></div>`);
      body.querySelectorAll("[data-wallet-tab]").forEach(b=>b.onclick=()=>display(b.dataset.walletTab));
      el("nfToken").onchange=e=>{token=e.target.value;display(mode);};
      body.querySelectorAll("[data-dist]").forEach(b=>b.onclick=async()=>{
        try{await api.nftRecover(jobs.id,b.dataset.dist,b.dataset.act);if(b.isConnected)nftCoinScreen();}
        catch(e){toast(ipcError(e),"err");}
      });
      el("nfRefresh").onclick=nftCoinScreen; el("nfBack").onclick=renderNftWallet;
      if(el("nfScan"))el("nfScan").onclick=async()=>{const field=el("nfTo"),value=await scanQR(t("Recipient address"));if(field.isConnected && value)field.value=value;};
      el("nfPayment").onsubmit=async e=>{
        e.preventDefault();
        const form=e.currentTarget, button=e.submitter || form.querySelector("button:last-child");button.disabled=true;
        try {
          const inputs=[...form.querySelectorAll("[data-input]:checked")].map(c=>c.value);
          const to=el("nfTo")?.value.trim() || "", amount=el("nfAmount")?.value.trim() || "";
          const change=el("nfChange")?.value.trim() || "", split=Number(el("nfSplit")?.value||1);
          const recipients=bulk?to.split(/\r?\n/).map(s=>s.trim()).filter(Boolean):[];
          if(mode===NFT_MODES.merge && !inputs.length){await consolidateToken(token,tokenNames.get(token));return;}
          if(manual && inputs.length<(mode===NFT_MODES.merge?2:1))throw Error("Choose spendable inputs.");
          let opts={tokenid:token,outputs:[{address:to,amount}]};
          if(mode===NFT_MODES.quick){opts.split=split;opts.burn=el("nfFee").value.trim() || "0";}
          if(manual) Object.assign(opts,{inputs,change});
          if(mode===NFT_MODES.merge)opts.consolidate=true;
          if(bulk)opts={tokenid:token,per:amount,recipients};
          const breakdown=[];
          if(manual) {
            const selected=rows.filter(c=>inputs.includes(c.coinid));
            const total=selected.reduce((sum,c)=>decAdd(sum,c.tokenamount || c.amount),"0");
            const target=change || (await cmd("getaddress")).address;
            if(!form.isConnected)return;
            opts.change=target;
            if(mode===NFT_MODES.merge)breakdown.push(t("Consolidate"),total,target);
            else{
              if(!/^\d+(?:\.\d+)?$/.test(amount) || absCmp(amount,total)>0)throw Error(t("Insufficient spendable funds"));
              breakdown.push(t("Change amount"),decSub(total,amount),target);
            }
          }
          if(bulk)breakdown.push(t("Total"),recipients.reduce(sum=>decAdd(sum,amount),"0"));
          const review=[t(mode),tokenNames.get(token),token,amount,to,...breakdown,...inputs,opts.burn?t("Burn")+" "+opts.burn+" Minima":"",mode===NFT_MODES.quick?t("Split outputs")+" "+split:""].filter(Boolean).join("\n");
          if (!await showConfirm(t("Confirm payment"),review,t("Confirm"),true) || !form.isConnected)return;
          const result=bulk?await api.nftDistribute(jobs.id,opts):await api.nftPay(jobs.id,opts);
          toast(bulk?t("Distribution queued"):result.status==="submitted"?t("Payment submitted"):t("Check History and your balance before trying this payment again."));
          if(page===companionPage)nftCoinScreen();
        } catch(error){toast(ipcError(error),"err");} finally{if(form.isConnected)button.disabled=false;}
      };
    }
    display("Quick send");
  } catch(e) {
    if(page===companionPage){body.innerHTML=companionCard("NFTwallet",`<p role="alert">${companionError(e)}</p><button class="ww-btn">${th("Back")}</button>`);body.querySelector("button").onclick=renderNftWallet;}
  }
}
function nftPreferences(id) {
  const key="nftwallet.preferences."+id;
  let data={};
  try{data=JSON.parse(localStorage.getItem(key)||"{}");}catch{}
  const set=field=>new Set(Array.isArray(data[field])?data[field]:[]);
  return {set,toggle(field,value){const values=set(field);if(values.has(value))values.delete(value);else values.add(value);data[field]=[...values];localStorage.setItem(key,JSON.stringify(data));}};
}
async function nftReceiveScreen() {
  const page=++companionPage,body=el("nftWalletBody");
  body.innerHTML=companionCard("NFTwallet",`<div id="nftDetails">${th("Loading…")}</div>`);
  try {
    const [scripts,keys]=await Promise.all([cmd("scripts"),cmd("keys action:list")]);
    if(page!==companionPage)return;
    const owned=new Set(keys.keys.map(k=>k.publickey));
    const addrs=scripts.filter(s=>s.default || (s.simple && owned.has(s.publickey)));
    if(!addrs.length)throw Error("No wallet addresses available.");
    const show=async idx=>{
      const a=addrs[idx], raw=await cmd("checkaddress address:"+a.address);
      if(page!==companionPage)return;
      const qr=qrcode(0,"M");qr.addData(a.miniaddress);qr.make();
      body.innerHTML=companionCard("NFTwallet",`<div id="nftDetails"><h2>${th("Receive")}</h2><button id="nfCopy" class="ww-link">${qr.createImgTag(4,12)}</button>
        <p class="ww-addr">${esc(a.miniaddress)}</p><p class="ww-addr">${esc(a.address)}</p><details><summary>${th("Address check")}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(raw,null,2))}</pre></details>
        <label for="nfPool">${th("Wallet address")}</label><select class="ww-in" id="nfPool">${addrs.map((v,i)=>`<option value="${i}" ${idx===i?"selected":""}>${i+1} · ${esc(v.miniaddress)}</option>`).join("")}</select>
        <button class="ww-link" id="nfBack">${th("Back")}</button></div>`);
      el("nfCopy").onclick=()=>copy(a.miniaddress);el("nfPool").onchange=e=>show(Number(e.target.value)).catch(x=>toast(ipcError(x),"err"));el("nfBack").onclick=renderNftWallet;
    };
    await show(0);
  } catch(error){if(page===companionPage)body.innerHTML=companionCard("NFTwallet",companionError(error));}
}
async function nftBalancesScreen() {
  const page=++companionPage,body=el("nftWalletBody");
  body.innerHTML=companionCard("NFTwallet",`<div id="nftDetails">${th("Loading…")}</div>`);
  try{
    const {id}=await api.nftJobs(), items=await cmd("balance");
    if(page!==companionPage)return;
    const prefs=nftPreferences(id);
    body.innerHTML=companionCard("NFTwallet",`<div id="nftDetails"><h2>${th("Balances")}</h2>${nftField("Search","nfFind")}<label><input type="checkbox" id="nfHidden"> ${th("Show hidden tokens")}</label><div id="nfRows"></div><button class="ww-link" id="nfBack">${th("Back")}</button></div>`);
    const render=()=>{
      const q=el("nfFind").value.toLowerCase(),hidden=prefs.set("hidden");
      el("nfRows").innerHTML=items.map((row,i)=>{
        const tid=row.tokenid,name=wwName(row);
        if(!(name+" "+tid).toLowerCase().includes(q)||hidden.has(tid)&&!el("nfHidden").checked)return "";
        return `<article class="card">${tokIconHtml(tid,row.token,true)} <b>${esc(name)}</b><div class="ww-id">${esc(tid)}</div>
          <p>${th("Confirmed")} ${esc(row.confirmed)} · ${th("Unconfirmed")} ${esc(row.unconfirmed)} · ${th("Sendable")} ${esc(row.sendable)}</p>
          <button class="ww-link" data-detail="${i}">${th("Details")}</button><button class="ww-link" data-hide="${i}">${hidden.has(tid)?th("Show"):th("Hide")}</button></article>`;
      }).join("");
      body.querySelectorAll("[data-detail]").forEach(b=>b.onclick=()=>showTokenDetail(items[Number(b.dataset.detail)]));
      body.querySelectorAll("[data-hide]").forEach(b=>b.onclick=()=>{prefs.toggle("hidden",items[Number(b.dataset.hide)].tokenid);render();});
      enhanceTokenIcons(body);
    };
    el("nfBack").onclick=renderNftWallet;el("nfFind").oninput=render;el("nfHidden").onchange=render;render();
  }catch(e){if(page===companionPage)body.innerHTML=companionCard("NFTwallet",companionError(e));}
}
