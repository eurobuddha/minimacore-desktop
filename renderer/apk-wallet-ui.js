"use strict";
// Translate Android layout primitives. All text, order, grouping and dimensions originate in res/layout.
function apkText(value) {
  if(!value?.startsWith("@string/"))return value || "";
  const variants=WALLET_STRINGS[value.slice(8)];
  return variants?.[I18N.lang()] || variants?.en || "";
}
function apkLayout(name) {
  const colors={bg:"bg",card:"card",card2:"field",input:"field",text:"text",subtext:"dim",accent:"accent",divider:"border"};
  function render([type,a,children]) {
    const id=a.id?.split("/").pop() || "";
    const tag=type==="EditText"?"input":type==="Button" || /(?:Toggle|Btn|ScrollLeft|ScrollRight)$/.test(id)?"button":type==="TextView"?"span":"div";
    const e=document.createElement(tag);
    if(id)e.id=id;
    e.className="apk-"+type;
    e.hidden=a.visibility==="gone" || a.visibility==="invisible";
    const style=e.style;
    const px=v=>/^\d+(?:dp|sp)$/.test(v || "")?parseInt(v,10)+"px":"";
    if(type==="LinearLayout"){style.display="flex";style.flexDirection=a.orientation==="vertical"?"column":"row";}
    if(a.layout_weight)style.flexGrow=a.layout_weight;
    if(a.layout_width==="match_parent")style.width="100%";
    if(px(a.layout_width) && a.layout_width!=="0dp")style.width=px(a.layout_width);
    if(px(a.layout_height) && a.layout_height!=="0dp")style.minHeight=px(a.layout_height);
    for(const [k,v] of Object.entries({padding:"padding",paddingStart:"paddingLeft",paddingEnd:"paddingRight",paddingTop:"paddingTop",paddingBottom:"paddingBottom",layout_marginTop:"marginTop",layout_marginBottom:"marginBottom",layout_marginStart:"marginLeft",layout_marginEnd:"marginRight",minHeight:"minHeight",minWidth:"minWidth",textSize:"fontSize"}))if(px(a[k]))style[v]=px(a[k]);
    if(a.textStyle?.includes("bold"))style.fontWeight="700";
    if(a.letterSpacing)style.letterSpacing=a.letterSpacing+"em";
    if(a.gravity?.includes("center")){if(type==="LinearLayout")style.alignItems="center";else style.textAlign="center";}
    for(const [attr,css] of [["background","backgroundColor"],["backgroundTint","backgroundColor"],["textColor","color"]]){
      const token=a[attr]?.split("_ux_")[1];
      if(colors[token])style[css]="var(--nf-"+colors[token]+")";
    }
    if(tag==="input"){
      e.value=apkText(a.text);e.placeholder=apkText(a.hint);e.setAttribute("aria-label",e.placeholder || id);
      if(a.inputType?.includes("number"))e.inputMode="decimal";
    }else if(a.text)e.textContent=apkText(a.text);
    if(tag==="button")e.type="button";
    children.forEach(c=>e.append(render(c)));
    return e;
  }
  return render(WALLET_LAYOUTS[name]);
}
function apkTabs(host,names,selected,choose) {
  host.classList.add("apk-tabs");
  host.setAttribute("role","tablist");
  for(const name of names) {
    const b=document.createElement("button");b.type="button";b.textContent=t(name);
    b.setAttribute("role","tab");b.setAttribute("aria-selected",String(name===selected));
    b.onclick=()=>choose(name);host.append(b);
  }
}
function apkQr(host,address) {
  const qr=qrcode(0,"M");qr.addData(address);qr.make();
  host.innerHTML=qr.createImgTag(4,12);
  host.querySelector("img").alt=t("Receive QR code");
  host.onclick=()=>copy(address);
}

