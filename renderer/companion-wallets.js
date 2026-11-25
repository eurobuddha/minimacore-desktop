"use strict";
const NFT_COLLECTION="Collection";
const walletViewers=new Set();
let companionPage = 0;
let minimaProfile = null;
let minimaIndex = 0;
let minimaTab = "Balance";

function leaveCompanionWallet() {
  companionPage++;
  for(const close of walletViewers)close();
  nftRestoreHistory(); nftTab="Balances"; nftAdvanced=false; nftSelected.clear(); minimaIndex=0;
  el("minimaWalletBody").replaceChildren();
  el("nftWalletBody").replaceChildren();
  minimaTab = "Balance";
}
function companionCard(title, content) {
  return `<div class="apk-panel">${content}</div>`;
}
function companionError(error) { return esc(MainSaid.say(ipcError(error))); }
function companionTabs(names, selected) {
  return `<div class="ww-tabs">${names.map(name => `<button class="ww-tab ${name === selected ? "ww-tab--on" : ""}" data-wallet-tab="${esc(name)}">${th(name)}</button>`).join("")}</div>`;
}
const apkWord=key=>apkText("@string/l10n_"+key);
const minimaSections=["Balances","Send","Receive","History","NFTs","Settings"];
async function renderMinimaWallet(){
  const page=++companionPage,host=el("minimaWalletBody");
  host.className="apk-wallet";host.dataset.design=localStorage.getItem("minimawallet.design")||"current";
  host.innerHTML=`<header class="apk-brand"><div><b>Minima Wallet</b><small>${esc(apkWord("wallet_self_custodial"))}</small></div><span id="mwBlock">#—</span></header><div id="mwTabs"></div><div id="mwPane" class="apk-panel" role="tabpanel"></div>`;
  const pane=el("mwPane");
  if(!running){pane.textContent=t("Waiting for the node…");return;}
  pane.textContent=t("Loading…");
  try{
    const wallet=await api.mwHome(minimaProfile);
    if(page!==companionPage)return;
    minimaProfile=wallet.id;
    cmd("block").then(r=>{if(pane.isConnected)el("mwBlock").textContent="#"+r.block;}).catch(()=>{});
    function tab(name){
      minimaTab=name;
      const tabs=el("mwTabs");tabs.replaceChildren();apkTabs(tabs,minimaSections,name,tab);
      const content=document.createElement("div");pane.replaceChildren(content);
      const goNative=()=>{content.innerHTML=`<p>${th("This node owns the signing key. Use the Wallet tab to send.")}</p><button>${th("Open Wallet")}</button>`;content.querySelector("button").onclick=()=>selectTab("balances");};
      if(name==="Balances"){
        content.append(apkLayout("pm_wallet_view_balances"));
        const list=el("pm_wallet_balancesContainer");
        for(const asset of wallet.balances){
          const b=document.createElement("button");b.className="apk-balance";
          b.innerHTML=tokIconHtml(asset.tokenid,asset.token)+`<span><b>${esc(nftName(asset))}</b><small>${esc(apkWord("wallet_coin_count").replace("%1$s",String(asset.count)))}</small></span><strong>${esc(asset.amount)}</strong>`;
          b.onclick=()=>{const d=openDlg("mwAsset",nftName(asset),`<b>${esc(asset.amount)}</b><p class="apk-wrap">${esc(asset.tokenid)}</p>`+wallet.coins.filter(c=>c.tokenid===asset.tokenid).map(c=>`<p class="apk-wrap">${esc(c.amount)} · ${esc(c.address)}<br>${esc(c.coinid)}</p>`).join(""),`<button id="mwAssetSend">${th("Send")}</button>`);el("mwAssetSend").onclick=()=>{d.close();tab("Send");if(el("mwToken"))el("mwToken").value=asset.tokenid;};};list.append(b);
        }
        enhanceTokenIcons(list);const refresh=document.createElement("button");refresh.textContent=t("Refresh");refresh.onclick=renderMinimaWallet;content.append(refresh);
      }else if(name==="Receive"){
        content.append(apkLayout("pm_wallet_view_receive"));
        const show=()=>{const a=wallet.addresses[minimaIndex%wallet.addresses.length];el("pm_wallet_rcvAddress").textContent=a;apkQr(el("pm_wallet_rcvQr"),a);el("pm_wallet_rcvCopy").onclick=()=>copy(a);};
        el("pm_wallet_rcvRefresh").onclick=()=>{minimaIndex++;show();};show();
      }else if(name==="NFTs"){
        const items=wallet.coins.filter(c=>c.tokenid!=="0x00"&&Number(c.token?.decimals||0)===0);
        const groups=new Map();
        for(const coin of items){if(!groups.has(coin.tokenid))groups.set(coin.tokenid,[]);groups.get(coin.tokenid).push(coin);}
        content.innerHTML=groups.size?"":th("No NFTs in this wallet.");
        function start(coins){if(wallet.owned)goNative();else minimaPayment(wallet,content,false,goNative,coins);}
        for(const coins of groups.values()){
          const g=document.createElement("details"),asset=coins[0];g.className="apk-asset";
          g.innerHTML=`<summary>${tokIconHtml(asset.tokenid,asset.token,true)} <b>${esc(nftName(asset))}</b> · ${coins.length}</summary>
            <button data-all>${th("Send collection")}</button>`+coins.map((c,i)=>`<details><summary>${esc(c.amount)} · ${esc(c.coinid)}</summary><small>${esc(c.address)}</small><pre>${esc(JSON.stringify(c.state,null,2))}</pre><button data-item="${i}">${th("Transfer")}</button></details>`).join("");
          g.querySelector("[data-all]").onclick=()=>start(coins);
          g.querySelectorAll("[data-item]").forEach(b=>b.onclick=()=>start([coins[Number(b.dataset.item)]]));content.append(g);
        }enhanceTokenIcons(content);
      }else if(name==="History"){minimaHistory(wallet,content);}
      else if(name==="Send"){if(wallet.owned)goNative();else minimaPayment(wallet,content,false,goNative);}
      else{
        content.innerHTML=`<h2>${esc(apkWord("wallet_security"))}</h2><p>${wallet.mode==="classic"?th("Classic keys"):th("Block-based keys")} · ${wallet.source==="node"?th("Set up from the node seed"):th("Manually imported seed")}</p>
          <h2>${esc(apkWord("sweep_title"))}</h2><button id="mwSweep">${esc(apkWord("sweep_settings"))}</button><p>${esc(apkWord("sweep_help"))}</p><h2>${esc(apkWord("wallet_seed_backup_heading"))}</h2><button id="mwReset">${th("Reset minimaWallet")}</button><h2>${esc(apkWord("wallet_design"))}</h2><button id="mwStyle">${esc(apkWord("wallet_toggle_theme"))}</button>`;
        el("mwStyle").onclick=()=>{host.dataset.design=host.dataset.design==="current"?"originalLight":"current";localStorage.setItem("minimawallet.design",host.dataset.design);};
        el("mwSweep").onclick=()=>wallet.owned?goNative():minimaPayment(wallet,content,true,goNative);
        el("mwReset").onclick=()=>minimaReset(wallet,content);
      }
    }
    tab(minimaSections.includes(minimaTab)?minimaTab:"Balances");
  }catch(e){if(pane.isConnected){pane.innerHTML=`<p role="alert">${companionError(e)}</p><button>${th("Retry")}</button>`;pane.querySelector("button").onclick=renderMinimaWallet;}}
}
function minimaHistory(wallet,host){
  const owned=new Set(wallet.addresses),seen=new Set();
  host.innerHTML=`<div class="apk-receipts"></div><div class="apk-chain"></div><button>${esc(apkWord("wallet_load_older"))}</button>`;
  const receipts=host.firstElementChild,rows=host.children[1],older=host.lastElementChild;
  receipts.innerHTML=wallet.history.map(r=>`<p class="apk-wrap">${esc(new Date(r.time).toLocaleString())} · ${esc(r.amount)} · ${esc(r.status)}<small>${esc(r.txpowid||r.to)}</small></p>`).join("");
  let offset=0;
  async function read(){
    older.disabled=true;
    try{
      const page=await cmd("history relevant:true max:16 offset:"+offset);
      if(!host.isConnected)return;
      for(const tx of page.txpows){
        const txn=tx.body?.txn||{},a=(txn.inputs||[]).map(coinLite).filter(c=>owned.has(c.address)),b=(txn.outputs||[]).map(coinLite).filter(c=>owned.has(c.address));
        if((!a.length&&!b.length)||seen.has(tx.txpowid))continue;
        seen.add(tx.txpowid);
        const row=document.createElement("details"),net=signedNet(a,b);
        row.innerHTML=`<summary>${esc(new Date(Number(tx.header.timemilli)).toLocaleString())} · ${Object.entries(net).map(([id,n])=>esc(n)+" "+esc(nftName(wallet.balances.find(v=>v.tokenid===id)||{tokenid:id}))).join(" · ")}</summary><p class="apk-wrap">${esc(tx.txpowid)}</p>`;rows.append(row);
      }
      offset+=page.txpows.length;older.hidden=page.txpows.length<16;
      if(!seen.size&&older.hidden&&!wallet.history.length)rows.textContent=t("No transactions yet.");
    }catch(e){if(host.isConnected)toast(ipcError(e),"err");}finally{older.disabled=false;}
  }
  older.onclick=read;read();
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
    if (!await showConfirm(t("Reset minimaWallet"), t("Replace the current minimaWallet profile? Keep its seed to recover its funds."), t("Replace"), true) || page !== companionPage || !body.isConnected || !el("mwSeed")) return;
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

function minimaPayment(wallet,host,sweep,native,items=null){
  const label=sweep?apkWord("sweep_title"):items?t("Transfer"):t("Send");
  host.innerHTML=`<form class="apk-form"><h2>${esc(label)}</h2>${items?`<b>${esc(nftName(items[0]))}</b><small>${items.map(c=>esc(c.coinid)).join("<br>")}</small>`:sweep?"":`<label>${th("Token")}<select id="mwToken">${wallet.balances.map(b=>`<option value="${esc(b.tokenid)}">${esc(nftName(b))} · ${esc(b.amount)}</option>`).join("")}</select></label>`}
    <label>${esc(sweep?apkWord("sweep_destination"):t("Recipient address"))}<input id="mwTo" autocomplete="off" required value="${sweep?esc(wallet.destination):""}"></label>
    ${sweep||items?"":`<label>${th("Amount")}<input required id="mwAmount" inputmode="decimal"></label>`}
    <p>${th("Opening Send looks up your public key at eurobuddha.com.")}</p><button type="submit">${th("Review")}</button></form>`;
  const form=host.querySelector("form");
  form.onsubmit=async e=>{
    e.preventDefault();const submit=form.querySelector("button");submit.disabled=true;
    const request=sweep?{kind:"sweep"}:items?{kind:"items",tokenid:items[0].tokenid,coinids:items.map(c=>c.coinid)}:{kind:"send",tokenid:el("mwToken").value,amount:el("mwAmount").value.trim()};request.to=el("mwTo").value.trim();
    try{
      const review=await api.mwReview(wallet.id,request);
      if(!form.isConnected)return;
      if(review.handoff){native();return;}
      host.innerHTML=`<form class="apk-form"><h2>${esc(label)}</h2><p class="apk-wrap">${esc(review.to)}</p>
        ${review.totals.map(b=>`<div class="apk-reviewed"><strong>${esc(b.amount)} ${esc(nftName(wallet.balances.find(a=>a.tokenid===b.tokenid)||b))}</strong><small>${esc(b.tokenid)}</small></div>`).join("")}
        <p>${esc(sweep?apkWord("sweep_description").replace("%1$s",String(review.transactions)):t("Confirm payment"))}</p>${review.coinids?.length?`<small>${review.coinids.map(esc).join("<br>")}</small>`:""}${review.skipped?.length?`<p>${esc(apkWord("sweep_remaining"))} · ${esc(String(review.skipped))}</p>`:""}
        <h3>${th("Confirm key uses for this payment")}</h3><p>${th("Reusing a signing position puts funds at risk. The archive can miss skipped uses and signatures made elsewhere. If another wallet records a higher next use for this key, enter that number.")}</p>
        ${review.keys.map(k=>`<label class="apk-reviewed">${th("Key uses")} · ${k.index+1}<small>${esc(k.miniaddress)}</small><small>${esc(t("Archive estimate: {chain}. Saved next use: {local}.",k))}</small><small data-range></small><input data-key="${k.index}" required inputmode="numeric" autocomplete="off"></label>`).join("")}
        ${sweep?`<label>${esc(apkWord("sweep_repeat_address"))}<input required id="mwRepeat" autocomplete="off"></label>`:""}
        <button type="submit" disabled>${esc(label)}</button><button type="button">${th("Back")}</button></form>`;
      const checker=host.querySelector("form"),confirm=checker.querySelector("button");
      const typed=()=>Object.fromEntries([...checker.querySelectorAll("[data-key]")].map(i=>[i.dataset.key,i.value.trim()]));
      function valid(){
        const entries=typed();let next=0,ok=true;
        review.keys.forEach((k,i)=>{const min=Math.max(next,k.minimum),last=k.last-k.count+1,value=entries[k.index];
          checker.querySelectorAll("[data-range]")[i].textContent=t("Enter a number from {minimum} to {last}.",{minimum:min,last});
          const good=AppsAct.ww.validUses(value,min,last);ok=ok&&good;
          if(wallet.mode==="block")next=(good?Number(value):min)+k.count;
        });
        return ok&&(!sweep||el("mwRepeat").value.trim()===review.to);
      }
      const back=checker.querySelector('[type="button"]');back.onclick=()=>minimaPayment(wallet,host,sweep,native,items);
      checker.oninput=()=>{confirm.disabled=!valid();};valid();
      checker.onsubmit=async ev=>{
        ev.preventDefault();if(!valid())return;
        confirm.disabled=back.disabled=true;const uses=typed(),confirmation=sweep?el("mwRepeat").value.trim():"";
        try{
          if(!await showConfirm(label,[...review.totals.map(b=>b.amount+" "+b.tokenid),review.to].join("\n"),label,true)||!checker.isConnected)return;
          const r=await api.mwExecute(wallet.id,{ticket:review.ticket,uses,confirmation});
          if(!checker.isConnected)return;
          host.innerHTML=`<p role="status">${esc(t("Submitted {n} of {total}",{n:r.submitted,total:r.total}))}</p><p>${esc(r.error||"")}</p>${r.unknown?`<p>${th("Check History and your balance before trying this payment again.")}</p>`:""}<button>${th("Balances")}</button>`;
          host.querySelector("button").onclick=()=>{minimaTab="Balances";renderMinimaWallet();};
        }catch(err){if(checker.isConnected)toast(ipcError(err),"err");}finally{if(checker.isConnected){confirm.disabled=!valid();back.disabled=false;}}
      };
    }catch(err){if(form.isConnected)toast(ipcError(err),"err");}finally{if(form.isConnected)submit.disabled=false;}
  };
}

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
async function nftGalleryScreen() {
  const page=++companionPage, body=nf("pager");
  const live=()=>page===companionPage && body.isConnected;
  try {
    const coins=await api.nftList();
    if(!live())return;
    const groups = new Map();
    for (const coin of coins) {
      if (!groups.has(coin.tokenid)) groups.set(coin.tokenid, []);
      groups.get(coin.tokenid).push(coin);
    }
    body.replaceChildren(apkLayout("pm_nftwallet_view_gallery"));
    let favouritesOnly=false,collection=null;
    nf("galleryHeader").innerHTML=`<div class="apk-tabs"><button id="nfCollected">${esc(apkWord("nft_gallery_collected"))}</button><button id="nfFavourites">${esc(apkWord("nft_gallery_favourites"))}</button></div>`+nftField("Search","nfGallerySearch")+`<button id="nfCloseCollection" hidden>${th("Back")}</button>`;
    nf("galleryGrid").innerHTML='<div id="nftGallery"></div>';
    const prefs=nftPreferences(nftOwner);
    function draw() {
      const q=el("nfGallerySearch").value.toLowerCase(), favourites=prefs.set("favourites");
      el("nfFavourites").setAttribute("aria-selected",String(favouritesOnly));
      el("nfCollected").setAttribute("aria-selected",String(!favouritesOnly));
      el("nfCloseCollection").hidden=!collection;
      const sections=[];
      for(const items of groups.values()) {
        const first=items[0],name=TOK.tokenName(first.token,first.tokenid);
        if(collection && first.tokenid!==collection)continue;
        const visible=items.filter(c=>(!favouritesOnly || favourites.has(c.coinid)||favourites.has(c.tokenid)) && [name,c.tokenid,c.coinid,"#"+(c.edition||"")].join(" ").toLowerCase().includes(q));
        if(!visible.length)continue;
        if(first.collection && !collection && !favouritesOnly){
          sections.push(`<article class="card"><button class="apk-cover" data-gallery-open="${esc(first.tokenid)}">${nftPicture(first)}<b>${esc(name)}</b><small>${th("Collection")} · ${items.length}</small></button><button data-star="${esc(first.tokenid)}" aria-label="${th("Favourites")}">${favourites.has(first.tokenid)?"★":"☆"}</button></article>`);continue;
        }
        if(first.collection && collection)sections.push(`<article class="apk-collection"><b>${esc(name)}</b><div><button data-collect="${esc(first.tokenid)}">${th("Send collection")}</button><button data-bury="${esc(first.tokenid)}" ${items.some(c=>c.pending||c.age<3)?"disabled":""}>${th("Bury collection")}</button></div></article>`);
        for(const c of visible.sort((a,b)=>Number(a.edition||0)-Number(b.edition||0))){
          const title=name+(c.edition?" #"+c.edition:"");
          sections.push(`<article class="apk-gallery-tile"><button class="apk-cover" data-view="${esc(c.coinid)}">${nftPicture(c)}<b>${esc(title)}</b></button>
            <div><button aria-label="${th("Favourites")}" aria-pressed="${favourites.has(c.coinid)}" data-star="${esc(c.coinid)}">${favourites.has(c.coinid)?"★":"☆"}</button><button data-nft-coin="${esc(c.coinid)}">${th("Details")}</button></div></article>`);
        }
      }
      el("nftGallery").innerHTML=sections.join("") || `<p>${th("No NFTs in this wallet.")}</p>`;
      body.querySelectorAll("[data-gallery-open]").forEach(b=>b.onclick=()=>{collection=b.dataset.galleryOpen;draw();});
      body.querySelectorAll("[data-nft-coin]").forEach(b=>b.onclick=()=>nftDetail(coins.find(c=>c.coinid===b.dataset.nftCoin)));
      const tiles=[...body.querySelectorAll("[data-view]")];
      function view(i){
        const tile=tiles[i],img=tile?.querySelector("img");if(!img)return;
        const viewer=imageLightbox(img.currentSrc||img.src,tile.textContent,walletViewers);
        if(!viewer)return;
        const controls=document.createElement("div");controls.className="apk-image-actions";viewer.root.append(controls);
        for(const [text,enabled,act] of [["‹",i>0,()=>view(i-1)],[t("Details"),true,()=>nftDetail(coins.find(c=>c.coinid===tile.dataset.view))],["›",i+1<tiles.length,()=>view(i+1)]]){
          const b=document.createElement("button");b.textContent=text;b.disabled=!enabled;b.onclick=()=>{viewer.close();act();};controls.append(b);
        }
      }
      tiles.forEach((b,i)=>b.onclick=()=>view(i));
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
    el("nfGallerySearch").oninput=draw;
    el("nfFavourites").onclick=()=>{favouritesOnly=true;collection=null;draw();};el("nfCollected").onclick=()=>{favouritesOnly=false;collection=null;draw();};
    el("nfCloseCollection").onclick=()=>{collection=null;draw();};draw();
    loadEditionImages(body);
  } catch (error) {
    if (live()) { body.innerHTML = companionCard("NFTwallet", `<p role="alert">${companionError(error)}</p><button class="ww-btn">${th("Retry")}</button>`); body.querySelector("button").onclick = renderNftWallet; }
  }
}
function nftDetail(c) {
  const body = nf("pager"), page = ++companionPage;
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
  const page=++companionPage,body=nf("pager");
  body.innerHTML=companionCard("NFTwallet", `<div id="nftDetails">${th("Loading…")}</div>`);
  let state;
  try {state=await api.nftJobs();} catch(e) {if(page===companionPage) toast(ipcError(e),"err");return;}
  if (page!==companionPage)return;
  const display = kind => {
    const collection=kind===NFT_COLLECTION, token=kind==="Token";
    body.innerHTML=companionCard("NFTwallet",`<div id="nftDetails"><h2>${th("Mint")}</h2>${companionTabs(["Token","NFT","Collection"],kind)}
      <form id="nfMintForm">${nftField("Name","nfName",'required maxlength="128"')}${nftField("Description","nfDesc",'maxlength="1024"')}
      ${nftField(collection ? "Collection size" : "Supply","nfSize",collection?'type="number" value="2" min="2" max="20" required':'inputmode="numeric" value="1" required')}
      ${token?nftField("Decimals","nfDecimals",'type="number" min="0" max="16" value="0"')+nftField("Ticker","nfTicker")+nftField("Additional metadata (JSON)","nfExtra",'placeholder="{}"'):""}
      ${kind==="NFT"?nftField("Creator","nfCreator",'maxlength="128"'):""}${nftField("Image URL","nfIconUrl")}${nftField("Or choose an image","nfIcon",'type="file" accept="image/*"')}
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
        const opts={kind,name:val("nfName"),creator:val("nfCreator"),amount:val("nfSize"),size:Number(val("nfSize")),description:val("nfDesc"),decimals:Number(val("nfDecimals")),ticker:val("nfTicker"),burn:val("nfBurn")||"0",mode:val("nfImagesMode"),base:val("nfBase"),ext:val("nfExt"),external:val("nfWebsite"),webvalidate:val("nfValidate"),sign:!!el("nfSign")?.checked,extra:JSON.parse(val("nfExtra")||"{}")};
        const files=Array.from(el("nfImages")?.files || []);
        const iconUrl=val("nfIconUrl");
        opts.icon=await nftImage(el("nfIcon").files[0],collection?6000:16000) || iconUrl;
        opts.images=[];if(opts.mode==="embed") for(const f of files) opts.images.push(await nftImage(f,8000));
        if (!form.isConnected) return;
        const review=[kind,opts.name,opts.amount+" × "+opts.name,t("Decimals")+" "+opts.decimals,t("Burn")+" "+opts.burn,opts.description,opts.creator,opts.webvalidate,opts.external,opts.ticker,JSON.stringify(opts.extra),opts.base,opts.images.length?String(opts.images.length)+" "+t("Embedded images"):""].filter(Boolean).join("\n");
        if (!await showConfirm(t("Confirm mint"),review,t("Mint"),true) || !form.isConnected) return;
        await api.nftMint(state.id,opts);
        if(page===companionPage) nftMintScreen();
      } catch(error){toast(ipcError(error),"err");} finally {if(form.isConnected)button.disabled=false;}
    };
  };
  body.replaceChildren(apkLayout("pm_nftwallet_view_mint"));
  const hub=nf("mintRoot");
  for(const [kind,title,about] of [["Token",t("Token"),"nft_mint_hub_token"],["NFT","NFT","nft_mint_hub_nft"],["Collection",apkWord("nft_mint_state_collection"),"nft_mint_hub_state"]]){
    const b=document.createElement("button");b.className="apk-balance";b.innerHTML=`<span><b>${esc(title)}</b><small>${esc(apkWord(about))}</small></span> ›`;b.onclick=()=>display(kind);hub.append(b);
  }
  for(const job of state.collections){const b=document.createElement("button");b.className="apk-balance";b.textContent=job.name+" · "+job.phase+" · "+job.stamped+"/"+job.size;b.onclick=()=>display("Collection");hub.append(b);}
}
const nf = id => el("pm_nftwallet_"+id);
const nftSections = ["Balances","Gallery","Mint","Send","Receive","Coins","History"];
let nftTab = "Balances", nftAdvanced = false, nftToken = "0x00", nftOwner = "";
const nftSelected = new Set(), nftCollapsed = new Set();
function companionBlock(height){
  if(!height)return;
  const inNft=activeView==="nftwallet",label=inNft?nf("blockNo"):el("mwBlock");
  if(!label || label.textContent==="#"+height)return;
  label.textContent="#"+height;
  if(inNft && nftTab==="Balances")nf("pager")?.refreshWalletBalances?.().catch(e=>toast(ipcError(e),"err"));
  if(inNft && nftTab==="History" && el("nftHistorySlot"))histSync({older:false});
}
function nftRestoreHistory() {
  const slot=el("nftHistorySlot");
  if(slot)el("view-history").append(...slot.childNodes);
}
function nftPage(name) {
  nftRestoreHistory();
  nftTab=name;
  renderNftWallet();
}
async function renderNftWallet() {
  const page=++companionPage, host=el("nftWalletBody");
  nftRestoreHistory();
  host.classList.add("apk-wallet");
  host.dataset.design=localStorage.getItem("nftwallet.design") || "current";
  host.replaceChildren(apkLayout("pm_nftwallet_activity_main"));
  const pane=nf("pager");
  apkTabs(nf("tabs"),nftSections,nftTab,nftPage);
  nf("tabs").querySelector('[aria-selected=true]')?.scrollIntoView({block:"nearest",inline:"nearest"});
  const styles=["current","clean","originalDark","originalLight"];
  nf("designToggle").onclick=()=>{host.dataset.design=host.dataset.design==="current"?"clean":"current";localStorage.setItem("nftwallet.design",host.dataset.design);};
  nf("settingsBtn").setAttribute("aria-label",t("Settings"));
  nf("settingsBtn").onclick=()=>nftPage("Settings");
  if(!running){pane.textContent=t("Waiting for the node…");return;}
  pane.textContent=t("Loading…");
  cmd("block").then(s=>{if(pane.isConnected)nf("blockNo").textContent="#"+(s.chain?.block ?? s.block ?? "—");}).catch(()=>{});
  try {
    const jobs=await api.nftJobs();
    if(page!==companionPage)return;
    if(jobs.id!==nftOwner){nftOwner=jobs.id;nftSelected.clear();nftCollapsed.clear();nftAdvanced=false;nftToken="0x00";}
    if(nftTab==="Gallery")return await nftGalleryScreen();
    if(nftTab==="Balances")return await nftBalancesScreen();
    if(nftTab==="Mint")return await nftMintScreen();
    if(nftTab==="Receive")return await nftReceiveScreen();
    if(nftTab==="History"){
      pane.innerHTML='<div id="nftHistorySlot"></div>';el("nftHistorySlot").append(...el("view-history").childNodes);return await renderHistory();
    }
    if(nftTab==="Settings"){
      const prefs=nftPreferences(jobs.id);
      const hidden=prefs.set("hidden");
      pane.innerHTML=`<div class="apk-panel"><h2>${th("Settings")}</h2><label>${th("Theme")}<select id="nfTheme">${styles.map((key,i)=>`<option value="${key}">${th(["Dark","Light","Original · Dark","Original · Light"][i])}</option>`).join("")}</select></label>
        <label>${esc(apkWord("nft_wallet_decimal_places"))}<select id="nfPrecision">${[2,4,8,-1].map(i=>`<option value="${i}">${esc(i===-1?apkWord("nft_wallet_full_precision"):apkWord("nft_wallet_precision_places").replace("%1$s",i))}</option>`).join("")}</select></label>
        <p>${esc(apkWord("nft_wallet_decimal_help"))}</p><h3>${esc(apkWord("nft_wallet_hidden_tokens"))}</h3>
        ${[...hidden].map(tid=>`<p class="apk-wrap">${esc(tid)} <button data-unhide="${esc(tid)}">${esc(apkWord("nft_wallet_unhide"))}</button></p>`).join("")||esc(apkWord("nft_wallet_none_hidden"))}
        <h3>${th("Node")}</h3><p>${esc(apkWord("nft_wallet_connected"))}</p><p id="nfAbout"></p></div>`;
      const v=await api.appVersion();
      if(!pane.isConnected)return;
      el("nfAbout").textContent=apkWord("nft_wallet_about").replace("%1$s",String(v)).replaceAll("\\n"," ");
      el("nfTheme").value=host.dataset.design;
      el("nfTheme").onchange=e=>{host.dataset.design=e.target.value;localStorage.setItem("nftwallet.design",host.dataset.design);};
      el("nfPrecision").value=localStorage.getItem("nftwallet.decimals")||"4";
      el("nfPrecision").onchange=e=>localStorage.setItem("nftwallet.decimals",e.target.value);
      pane.querySelectorAll("[data-unhide]").forEach(b=>b.onclick=()=>{prefs.toggle("hidden",b.dataset.unhide);b.parentNode.remove();});
      return;
    }
    const rows=await api.nftCoins();
    if(page!==companionPage)return;
    const available=new Set(rows.filter(c=>c.eligible).map(c=>c.coinid));
    for(const id of nftSelected)if(!available.has(id))nftSelected.delete(id);
    if(nftTab==="Coins")await nftCoinScreen(jobs,rows,pane);
    else nftSendScreen(jobs,rows,pane);
  }catch(error){if(pane.isConnected)pane.textContent=MainSaid.say(ipcError(error));}
}
function nftDisplay(value){
  const raw=localStorage.getItem("nftwallet.decimals")||"4",places=Number(raw);
  return summaryAmount(value,[2,4,8].includes(places)?places:44,true);
}
function nftAmount(c){return c.tokenid==="0x00"?c.amount:c.tokenamount;}
function nftTotal(coins){return coins.reduce((n,c)=>decAdd(n,nftAmount(c)),"0");}
function nftName(c){return c?.tokenid && c.tokenid!=="0x00"?TOK.tokenName(c.token,c.tokenid):"Minima";}
function nftSendScreen(jobs,rows,pane){
  pane.replaceChildren(apkLayout("pm_nftwallet_view_send"));
  const selected=rows.filter(c=>nftSelected.has(c.coinid));
  const tokens=new Map([["0x00","Minima"]]);for(const c of rows)tokens.set(c.tokenid,nftName(c));
  if(!tokens.has(nftToken))nftToken="0x00";
  const address=nf("sendAddress"),amount=nf("sendAmount"),burn=nf("sendBurn"),split=nf("sendSplit");
  const quick=nf("modeQuickBtn"),advanced=nf("modeCoinsBtn");
  const token=()=>nftAdvanced?selected[0]?.tokenid:nftToken;
  const total=()=>nftAdvanced?nftTotal(selected):nftTotal(rows.filter(c=>c.eligible&&c.tokenid===nftToken));
  function mode(manual){
    nftAdvanced=manual;
    quick.setAttribute("aria-pressed",String(!manual));advanced.setAttribute("aria-pressed",String(manual));
    nf("sendFromBlock").hidden=nf("sendChangeBlock").hidden=!manual;
    nf("sendTokenBlock").hidden=nf("sendSplitBlock").hidden=manual;
    nf("sendTokenLabel").textContent=tokens.get(nftToken)+" ▾";
    nf("sendTokenBal").textContent=nftDisplay(total());
    nf("sendFromList").innerHTML=(manual?selected:[]).map(c=>`<div class="apk-selected">${esc(nftAmount(c))} ${esc(nftName(c))}<small>${esc(c.coinid)}</small></div>`).join("")+`<button id="nfChoose">${th("Coins")}</button>`;
    el("nfChoose").onclick=()=>nftPage("Coins");
    nf("previewBtn").disabled=manual&&!selected.length;
  }
  quick.onclick=()=>mode(false);advanced.onclick=()=>mode(true);mode(nftAdvanced);
  const picker=nf("sendTokenRow");picker.tabIndex=0;picker.setAttribute("role","button");
  picker.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();picker.click();}};
  picker.onclick=()=>showActionSheet(t("Token"),[...tokens].map(([id,name])=>({label:name+" · "+nftTotal(rows.filter(c=>c.eligible&&c.tokenid===id)),onclick(){nftToken=id;mode(false);}})));
  nf("scanBtn").onclick=async()=>{const scanned=await scanQR(t("Recipient address"));if(scanned&&address.isConnected)address.value=scanned;};
  nf("maxBtn").onclick=()=>{const fee=burn.value.trim();amount.value=token()==="0x00" && /^\d+(\.\d+)?$/.test(fee) && absCmp(total(),fee)>=0?decSub(total(),fee):total();};
  nf("nextBtn").onclick=async()=>{const a=await cmd("getaddress");if(pane.isConnected)nf("sendChange").value=a.miniaddress;};
  const preview=nf("previewBtn");
  preview.onclick=async()=>{
    preview.disabled=true;
    try{
      const dest=address.value.trim(),value=amount.value.trim(),fee=burn.value.trim()||"0",n=Number(split.value||1);
      if(!/^(Mx|0x)[a-z0-9]+$/i.test(dest)||!/^\d+(?:\.\d+)?$/.test(value)||absCmp(value,"0")<=0)throw Error(t("Enter recipient address (Mx or 0x)")+" · "+t("Amount"));
      if(!/^\d+(?:\.\d+)?$/.test(fee)||absCmp(token()==="0x00"?decAdd(value,fee):value,total())>0)throw Error(t("Insufficient spendable funds"));
      if(!nftAdvanced&&(!Number.isInteger(n)||n<1||n>20))throw Error(t("Split outputs")+" · 1–20");
      const opts={tokenid:token(),outputs:[{address:dest,amount:value}],burn:fee};
      if(nftAdvanced){opts.inputs=selected.map(c=>c.coinid);opts.change=nf("sendChange").value.trim() || (await cmd("getaddress")).miniaddress;}
      else opts.split=n;
      if(!preview.isConnected)return;
      const review=[value+" "+tokens.get(token()),dest,token(),opts.inputs?.join("\n"),opts.change,opts.split?t("Split outputs")+" "+opts.split:"",t("Burn")+" "+fee+" Minima"].filter(Boolean).join("\n");
      if(!await showConfirm(t("Confirm payment"),review,t("Send"),true)||!preview.isConnected)return;
      const result=await api.nftPay(jobs.id,opts);
      toast(result.status==="submitted"?t("Payment submitted"):t("Check History and your balance before trying this payment again."));
      if(preview.isConnected){nftSelected.clear();nftAdvanced=false;nftPage("History");}
    }catch(e){toast(ipcError(e),"err");}finally{if(preview.isConnected)preview.disabled=false;}
  };
}
async function nftCoinScreen(jobs,rows,pane){
  const [scripts,tracked]=await Promise.all([cmd("scripts"),cmd("coins relevant:true simplestate:false")]);
  if(!pane.isConnected)return;
  const byId=new Map(rows.map(c=>[c.coinid,c]));
  const groups=new Map();
  for(const c of [...rows,...tracked.filter(c=>!byId.has(c.coinid))]){
    if(!groups.has(c.address))groups.set(c.address,{name:c.miniaddress||c.address,coins:[]});
    groups.get(c.address).coins.push(c);
  }
  for(const s of scripts)if(s.default&&!groups.has(s.address))groups.set(s.address,{name:s.miniaddress||s.address,coins:[]});
  pane.replaceChildren(apkLayout("pm_nftwallet_view_wallet"));
  const host=nf("walletContainer");
  function selected(){return rows.filter(c=>nftSelected.has(c.coinid));}
  function status(){
    const sel=selected();
    nf("selCount").textContent=t("Selected")+" · "+sel.length;
    nf("selTotal").textContent=sel.length?nftDisplay(nftTotal(sel))+" "+nftName(sel[0]):"";
    nf("clearBtn").disabled=nf("sendBtn").disabled=!sel.length;
  }
  for(const [hex,g] of groups){
    const group=document.createElement("details");group.className="apk-address";group.open=g.coins.length>0&&!nftCollapsed.has(hex);
    const summary=document.createElement("summary");summary.textContent=g.name;
    const meta=document.createElement("small");const own=rows.some(c=>c.address===hex)||scripts.some(s=>s.address===hex&&s.default);
    meta.textContent=[own?"":apkWord("utxo_contract"),apkWord("wallet_coin_count").replace("%1$s",g.coins.length),nftDisplay(nftTotal(g.coins.filter(c=>c.tokenid==="0x00")))+" Minima"].filter(Boolean).join(" · ");
    summary.append(meta);if(!own)group.classList.add("apk-contract");
    group.append(summary);group.ontoggle=()=>{if(group.open)nftCollapsed.delete(hex);else nftCollapsed.add(hex);};
    for(const c of g.coins){
      const row=document.createElement("div");row.className="apk-coin";
      row.innerHTML=`<input type="checkbox" aria-label="${esc(c.coinid)}" ${c.eligible?"":"disabled"}><details><summary><b>${esc(nftDisplay(nftAmount(c)))} ${esc(nftName(c))}</b><small>${esc(c.coinid)}</small></summary><pre></pre><button>${th("Copy")}</button></details>`;
      row.querySelector("details").ontoggle=e=>{if(e.target.open)row.querySelector("pre").textContent=JSON.stringify(c,null,2);};
      const check=row.querySelector("input");check.checked=nftSelected.has(c.coinid);
      check.onchange=()=>{if(check.checked&&selected().some(x=>x.tokenid!==c.tokenid)){check.checked=false;toast(t("Choose one token"),"err");return;}if(check.checked)nftSelected.add(c.coinid);else nftSelected.delete(c.coinid);status();};
      row.querySelector("button").onclick=()=>copy(c.coinid);group.append(row);
    }
    host.append(group);
  }
  nf("clearBtn").onclick=()=>{nftSelected.clear();host.querySelectorAll("input:checked").forEach(c=>c.checked=false);status();};
  nf("sendBtn").onclick=()=>{nftAdvanced=true;nftPage("Send");};
  nf("toolsBtn").onclick=()=>nftCoinTools(jobs,selected(),pane);
  for(const job of jobs.distributions){const line=document.createElement("p");line.textContent=t("Distribute")+" · "+job.status+" · "+job.next+"/"+job.recipients.length;host.prepend(line);
    if(["paused","waiting","ready"].includes(job.status)){const b=document.createElement("button");b.textContent=t(job.status==="paused"?"Resume":"Pause");line.append(b);b.onclick=async()=>{try{await api.nftRecover(jobs.id,job.id,job.status==="paused"?"resume":"stop");if(pane.isConnected)nftPage("Coins");}catch(e){toast(ipcError(e),"err");}};}}
  status();
}
function nftCoinTools(jobs,sel,pane){
  const inputs=sel.map(c=>c.coinid),tokenid=sel[0]?.tokenid || "0x00",total=nftTotal(sel);
  const items=Object.entries({split:"Split outputs",merge:"Consolidate",bulk:"Distribute",untrack:"Untrack"}).map(([tool,label])=>({label:t(label),async onclick(){
    try{
      if(!sel.length && tool==="merge"){await consolidateToken(tokenid,nftName(sel[0]));return;}
      if(!sel.length)throw Error(t("Choose spendable inputs."));
      let opts={inputs,tokenid},details=[];
      if(tool==="split" || tool==="bulk"){
        const bulk=tool==="bulk",max=bulk?56:15;
        const raw=await showPrompt(t(label),bulk?"20":"4",apkWord(bulk?"utxo_address_number":"utxo_coin_number"));
        if(raw===null)return;
        const count=Number(raw);
        if(!/^\d+$/.test(raw)||count<2||count>max)throw Error(apkWord(bulk?"utxo_address_range":"utxo_coin_range"));
        let each;
        if(bulk){
          each=await showPrompt(t("Amount per recipient"),"","0.0");if(each===null)return;
          if(!/^\d+(?:\.\d+)?$/.test(each)||absCmp(each,"0")===0)throw Error(t("Amount per recipient"));
        }else{
          const scale=tokenid==="0x00"?11:Number(sel[0].token?.decimals??11);
          if(!Number.isInteger(scale)||scale<0||scale>44)throw Error(t("Decimals"));
          const [whole,fraction=""]=total.split(".");
          const units=BigInt(whole+fraction.padEnd(scale,"0").slice(0,scale))/BigInt(count);
          if(!units)throw Error(apkWord("utxo_small_split").replace("%1$d",String(count)));
          const digits=String(units).padStart(scale+1,"0");
          each=scale?digits.slice(0,-scale)+"."+digits.slice(-scale):digits;
        }
        const allocated=Array.from({length:count}).reduce(n=>decAdd(n,each),"0");
        if(absCmp(allocated,total)>0)throw Error(t("Insufficient spendable funds"));
        const recipients=[];
        for(let i=0;i<count;i++){if(!pane.isConnected)return;const a=await cmd("getaddress");recipients.push(a.miniaddress);}
        if(bulk){Object.assign(opts,{recipients,per:each});details=[allocated+" "+nftName(sel[0]),...recipients.map(a=>each+" · "+a)];}
        else{
          opts.outputs=recipients.map((address,i)=>({address,amount:i===count-1?decAdd(each,decSub(total,allocated)):each}));
          details=opts.outputs.map(o=>o.amount+" · "+o.address);
        }
      }else if(tool==="merge"){
        if(sel.length<2)throw Error(apkWord("utxo_select_merge"));
        opts.change=(await cmd("getaddress")).miniaddress;opts.consolidate=true;details=[opts.change];
      }
      if(!pane.isConnected||!await showConfirm(t(label),[total+" "+nftName(sel[0]),...details,...inputs].join("\n"),t("Confirm"),true)||!pane.isConnected)return;
      if(tool==="bulk")await api.nftDistribute(jobs.id,opts);
      else if(tool==="untrack"){for(const id of inputs){if(!/^0x[0-9a-f]{64}$/i.test(id))throw Error("Invalid coin ID");await cmd("cointrack enable:false coinid:"+id);}}
      else await api.nftPay(jobs.id,opts);
      nftSelected.clear();if(pane.isConnected)nftPage("Coins");
    }catch(e){toast(ipcError(e),"err");}
  }}));
  showActionSheet(t("Tools"),items);
}
function nftPreferences(id) {
  const key="nftwallet.preferences."+id;
  let data={};
  try{data=JSON.parse(localStorage.getItem(key)||"{}");}catch{}
  const set=field=>new Set(Array.isArray(data[field])?data[field]:[]);
  return {set,toggle(field,value){const values=set(field);if(values.has(value))values.delete(value);else values.add(value);data[field]=[...values];localStorage.setItem(key,JSON.stringify(data));}};
}
async function nftReceiveScreen(){
  const pane=nf("pager"),[scripts,keys]=await Promise.all([cmd("scripts"),cmd("keys action:list")]);
  if(!pane.isConnected)return;
  const owned=new Set(keys.keys.map(k=>k.publickey));
  const addresses=scripts.filter(s=>s.default || s.simple&&owned.has(s.publickey));
  pane.replaceChildren(apkLayout("pm_nftwallet_view_receive"));
  if(!addresses.length){nf("rcvAddress").textContent=t("No wallet addresses available.");return;}
  const pool=nf("rcvList");
  function show(index){
    const a=addresses[index];
    apkQr(nf("rcvQr"),a.miniaddress);
    nf("rcvAddress").textContent=a.miniaddress;
    nf("rcvCopy").onclick=()=>copy(a.miniaddress);nf("rcvRefresh").onclick=()=>show((index+1)%addresses.length);
    nf("rcvSafety").hidden=false;nf("rcvSafety").textContent=a.address;
    nf("rcvSafety").onclick=async()=>{try{const r=await cmd("checkaddress address:"+a.address);if(pane.isConnected)openDlg("nftAddressCheck",t("Address check"),"<pre>"+esc(JSON.stringify(r,null,2))+"</pre>","");}catch(e){toast(ipcError(e),"err");}};
    for(const [i,b] of [...pool.children].entries())b.setAttribute("aria-pressed",String(i===index));
  }
  for(const [i,a] of addresses.entries()){const b=document.createElement("button");b.textContent=a.miniaddress;b.onclick=()=>show(i);pool.append(b);}
  show(0);
}
async function nftBalancesScreen() {
  const page=++companionPage,body=nf("pager");
  body.innerHTML=companionCard("NFTwallet",`<div id="nftDetails">${th("Loading…")}</div>`);
  try{
    const id=nftOwner;let items=await cmd("balance");
    if(page!==companionPage)return;
    const prefs=nftPreferences(id);
    body.replaceChildren(apkLayout("pm_nftwallet_view_balances"));
    const search=nf("balSearch"),list=nf("balancesContainer");
    const render=()=>{
      const q=search.value.toLowerCase(),hidden=prefs.set("hidden");
      list.innerHTML=items.map((row,i)=>{
        const tid=row.tokenid,name=wwName(row);
        if(!(name+" "+tid).toLowerCase().includes(q)||hidden.has(tid))return "";
        const sendable=row.sendable||"0",locked=decSub(row.confirmed||"0",sendable);
        const split=[[apkWord("utxo_sendable_caps"),sendable],[t("Confirmed"),row.confirmed],[t("Unconfirmed"),row.unconfirmed]];
        if(!locked.startsWith("-")&&absCmp(locked,"0")>0)split.push([apkWord("utxo_locked_caps"),locked]);
        return `<button class="apk-token-card" data-detail="${i}"><span class="apk-token-top">${tokIconHtml(tid,row.token)}<b>${esc(name)}</b><span><strong>${esc(nftDisplay(sendable))}</strong><small>${esc(apkWord("wallet_coin_count").replace("%1$s",row.coins||0))}</small></span></span>
          ${split.map(([label,n])=>`<span class="apk-split"><small>${esc(label)}</small><span>${esc(nftDisplay(n))}</span></span>`).join("")}</button>`;
      }).join("");
      body.querySelectorAll("[data-detail]").forEach(b=>b.onclick=()=>{const row=items[Number(b.dataset.detail)];
        showTokenDetail(row,{receive:()=>nftPage("Receive"),send:()=>{nftToken=row.tokenid;nftAdvanced=false;nftPage("Send");},hide:()=>{prefs.toggle("hidden",row.tokenid);render();}});});
      enhanceTokenIcons(body);
    };
    let refreshing=false;
    body.refreshWalletBalances=async()=>{
      if(refreshing)return;refreshing=true;
      try{const fresh=await cmd("balance");if(body.isConnected && JSON.stringify(items)!==JSON.stringify(fresh)){items=fresh;render();}}
      finally{refreshing=false;}
    };
    search.oninput=render;render();
  }catch(e){if(page===companionPage)body.innerHTML=companionCard("NFTwallet",companionError(e));}
}
