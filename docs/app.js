"use strict";
const select = (selector) => document.querySelector(selector);
const catalogKey = "eungmo-beta:catalog:v1";
const recordPrefix = "eungmo-beta:entry:";
const lastVisitKey = "eungmo-beta:checked:v1";
const localFallback = new Map();
const unsavedKeys = new Set();
let storageWarning = false;
let catalog = { version: 1, updatedAt: "", events: [] };
let records = new Map();
let activeId = null;
let request = null;
let problem = "";
let fetchState = "loading";
let lastSuccess = "";
const filters = { discover: "open", entries: "all", results: "all" };
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => typeof s === "string" && dayPattern.test(s);
const textValue = (v) => typeof v === "string" ? v.trim() : "";
const shortDate = (s) => validDate(s) ? Number(s.slice(5, 7)) + "월 " + Number(s.slice(8)) + "일" : "미정";
const compactDate = (s) => validDate(s) ? Number(s.slice(5, 7)) + "." + Number(s.slice(8)) : "미정";
function kstMoment(instant = new Date()) {
  return new Date(instant.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 19);
}
function checkedAtLabel(stamp) {
  if (!stamp) return "확인 전";
  const instant = new Date(stamp);
  if (!Number.isFinite(instant.getTime())) return "미정";
  const value = kstMoment(instant);
  return compactDate(value.slice(0, 10)) + " " + value.slice(11, 16);
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
}
function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
function read(key) {
  if (unsavedKeys.has(key)) return localFallback.get(key) ?? null;
  try {
    const value = localStorage.getItem(key);
    return value === null ? null : JSON.parse(value);
  } catch { return localFallback.get(key) ?? null; }
}
function write(key, value) {
  if (value === null) localFallback.delete(key); else localFallback.set(key, value);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    unsavedKeys.delete(key);
  } catch { unsavedKeys.add(key); storageWarning = true; }
}
function cleanEvent(e) {
  if (!e || typeof e !== "object" || typeof e.id !== "string" || !e.id.trim() ||
      !textValue(e.title) || !validDate(e.deadline) || !httpsUrl(e.sourceUrl)) return null;
  const event = {id:e.id.trim()};
  for (const key of ["title","organizer","prize","entryMethod","rules","deadlineTime","announcementMethod"]) {
    event[key] = Array.isArray(e[key]) ? e[key].map(textValue).filter(Boolean).join(" · ") : textValue(e[key]);
  }
  for (const key of ["startDate","deadline","drawDate","announcementDate","claimDeadline","verifiedAt"]) event[key] = validDate(e[key]) ? e[key] : null;
  for (const key of ["sourceUrl","entryUrl","announcementUrl","resultUrl"]) event[key] = httpsUrl(e[key]);
  return event;
}
function cleanCatalog(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.events) || !data.updatedAt || !Number.isFinite(Date.parse(data.updatedAt))) return null;
  const events = data.events.map(cleanEvent);
  if (events.some((e) => !e) || new Set(events.map((e) => e.id)).size !== events.length) return null;
  return { version: 1, updatedAt: data.updatedAt, events };
}
function readRecords() {
  const keys = new Set(localFallback.keys());
  try {
    for (let i = 0; i < localStorage.length; i++) keys.add(localStorage.key(i));
  } catch { storageWarning = true; }
  records = new Map();
  for (const key of keys) {
    if (!key || !key.startsWith(recordPrefix)) continue;
    const r = read(key);
    if (!r || !["pending","won","lost"].includes(r.status)) continue;
    const event = cleanEvent(r.event);
    if (event && event.id === key.slice(recordPrefix.length)) records.set(event.id, { ...r, event });
  }
}
function getEvent(id) { return catalog.events.find((e) => e.id === id) || records.get(id)?.event; }
function period(e, moment = kstMoment()) {
  const today = moment.slice(0, 10), time = moment.slice(11);
  if (e.startDate && today < e.startDate) return "next";
  if (today !== e.deadline) return today > e.deadline ? "closed" : "open";
  const deadline = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(e.deadlineTime);
  if (deadline && time > deadline[1].padStart(2,"0")+":"+deadline[2]+":"+(deadline[3]||"59")) return "closed";
  return "open";
}
function deadlineLabel(e) {
  const p = period(e);
  if (p === "next") return compactDate(e.startDate) + " 시작";
  if (p === "closed") return "접수 마감";
  const suffix = e.deadlineTime ? " " + e.deadlineTime : "";
  return (e.deadline === kstMoment().slice(0,10) ? "오늘" : compactDate(e.deadline)) + suffix + " 마감";
}
function resultInfo(e) {
  const today = kstMoment().slice(0, 10);
  if (e.resultUrl) return { label:"발표문 게시", group:"check", help:"주최 측의 발표문을 열어 내 결과를 확인하세요." };
  const individual = /개별|문자|DM|메일|전화|알림톡/i.test(e.announcementMethod);
  if (!e.announcementDate) return { label:individual ? "개별 안내 · 날짜 미정" : "발표일 미정", group:"wait", help:e.announcementMethod || "주최 측이 발표일을 안내하면 갱신해요." };
  if (today < e.announcementDate) return {label:compactDate(e.announcementDate)+" 발표 예정",group:"wait",help:e.announcementMethod || "발표 예정일을 기다리고 있어요."};
  if (individual) return {label:"개별 안내 확인",group:"check",help:e.announcementMethod};
  if (e.announcementUrl) return {label:today===e.announcementDate?"오늘 발표 예정":"발표 확인처 열기",group:"check",help:"발표 예정일이 되었어요. 주최 측 발표 확인처에서 공지를 확인하세요."};
  return {label:today === e.announcementDate ? "오늘 발표 예정" : "발표문 확인 중",group:"wait",help:"주최 측 공지에 발표문이 올라왔는지 확인하고 있어요."};
}
const statusLabel = (r) => !r ? "미응모" : r.status==="won" ? (r.claimed ? "수령 완료" : "당첨") : r.status==="lost" ? "미당첨" : "결과 미확인";
function resultAction(e) {
  const r=records.get(e.id);
  if (r?.status==="won" && !r.claimed) return {rank:0,label:"경품 수령 확인",detail:e.claimDeadline ? compactDate(e.claimDeadline)+" 수령 신청 마감" : "수령 상태를 기록할 수 있어요."};
  if (r?.status==="pending" && resultInfo(e).group==="check") {
    const info=resultInfo(e);
    const label=e.resultUrl?"공식 발표문 확인":info.label==="개별 안내 확인"?info.label:"발표 확인처 열기";
    return {rank:e.resultUrl?1:2,label,detail:info.help};
  }
  return null;
}
function byDate(a,b) { return a.deadline.localeCompare(b.deadline) || a.title.localeCompare(b.title,"ko"); }
function currentRoute() { return ["entries","results"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "discover"; }
const glyph = {
  arrow:'<path d="M4 12h15m-6-6 6 6-6 6"/>',
  ext:'<path d="M8 6h10v10M18 6 6 18"/>',
  ticket:'<path d="M3 7h18v3.5a2 2 0 0 0 0 3V17H3v-3.5a2 2 0 0 0 0-3zM8 8.5v2m0 3v2"/>',
  mail:'<rect x="3.5" y="6" width="17" height="13" rx="2.3"/><path d="m4 7 8 5.8L20 7"/>'
};
const icon = (id) => '<svg viewBox="0 0 24 24" aria-hidden="true">'+glyph[id]+'</svg>';
const personalNote = "응모·당첨 기록은 이 기기의 브라우저에만 저장돼요. 브라우저 데이터를 지우면 함께 삭제돼요.";
const privateCard = '<aside class="privacy-card"><strong>내 기기에 저장해요</strong>'+personalNote+'</aside>';
function row(e, tail, detail=e.prize, hot=false) {
  return `<button type="button" class="row" data-event="${escapeHtml(e.id)}"><span class="row-copy"><span class="org">${escapeHtml(e.organizer)}</span><strong class="entry-name">${escapeHtml(e.title)}</strong><span class="prize">${escapeHtml(detail)}</span></span><span class="row-end ${hot?"active-label":""}">${escapeHtml(tail)}</span></button>`;
}
function ticket(e, section, detail, action, personal=false) {
  return `<button type="button" data-event="${escapeHtml(e.id)}" class="ticket"><span class="ticket-top"><span>${escapeHtml(section)}</span>${icon(personal?"mail":"ticket")}</span><strong>${escapeHtml(e.title)}</strong><span class="reward">${escapeHtml(detail)}</span><span class="ticket-act">${escapeHtml(action)}${icon("arrow")}</span></button>`;
}
function filterbar(route, choices) {
  return '<div class="filters" aria-label="목록 필터">'+choices.map(([value,label])=>`<button type="button" data-filter="${value}" aria-pressed="${filters[route]===value}">${label}</button>`).join("")+'</div>';
}
function empty(text) { return '<p class="empty">'+escapeHtml(text)+'</p>'; }
function panel(title, count, content) {
  return `<section class="panel"><div class="sec-head"><h2>${title}</h2><span class="count">${count}건</span></div>${content}</section>`;
}
function feature(open, mine) {
  const pending=mine.map(e=>({e,a:resultAction(e)})).filter(v=>v.a).sort((a,b)=>a.a.rank-b.a.rank || byDate(a.e,b.e));
  if(pending.length){const {e,a}=pending[0];return ticket(e,a.label,a.detail,"내 기록 열기",true);}
  if(open.length) return ticket(open[0], "가장 가까운 마감 · "+deadlineLabel(open[0]), open[0].prize, "응모 조건 보기");
  return '<div class="ticket"><span class="ticket-top">접수 현황</span><strong>진행 중인 행사가 없어요</strong><span class="reward">마감된 행사의 결과는 계속 확인할 수 있어요.</span></div>';
}
function screen() {
  const route=currentRoute();
  const all=catalog.events, mine=Array.from(records.keys()).map(getEvent).filter(Boolean);
  const open=all.filter(e=>period(e)==="open").sort(byDate);
  const title={discover:"응모 둘러보기",entries:"내 응모",results:"내 결과 확인함"}[route];
  let subtitle,content;
  if(route==="discover") {
    subtitle=catalog.updatedAt?"공고 업데이트 "+checkedAtLabel(catalog.updatedAt)+" · 한국시간":"주최 측 공고의 경품과 참여 조건";
    const mode=filters.discover;
    const list=(mode==="all"?[...all]:all.filter(e=>period(e)===mode)).sort((a,b)=>mode==="closed"?byDate(b,a):byDate(a,b));
    content=panel("응모 공고",list.length,filterbar(route,[["open","진행 중"],["closed","마감"],["all","전체"]])+
      (list.map(e=>row(e,deadlineLabel(e), e.prize, period(e)==="open" && e.deadline===kstMoment().slice(0,10))).join("") || empty(fetchState==="loading"?"공고를 불러오는 중이에요.":"이 조건에 맞는 공고가 없어요.")));
  } else if(route==="entries"){
    subtitle="직접 응모했다고 표시한 행사 "+mine.length+"건";
    const list=mine.filter(e=>filters.entries==="all"||records.get(e.id).status===filters.entries).sort((a,b)=>(records.get(b.id).appliedAt||"").localeCompare(records.get(a.id).appliedAt||""));
    content=panel("응모 기록",list.length,filterbar(route,[["all","전체"],["pending","미확인"],["won","당첨"],["lost","미당첨"]])+
      (list.map(e=>row(e,statusLabel(records.get(e.id)),resultInfo(e).label,records.get(e.id).status==="won")).join("")||empty("이 상태의 기록이 없어요. 행사 참여를 마치고 ‘응모했어요’를 누르면 여기에 모여요.")));
  }else{
    subtitle="주최 측 발표와 내가 확인한 당첨 결과";
    const order=(e)=>resultAction(e)?.rank ?? (records.get(e.id).status==="pending"?3:4);
    const group=(e)=>records.get(e.id).status!=="pending"?"done":resultInfo(e).group;
    const list=mine.filter(e=>filters.results==="all"||group(e)===filters.results).sort((a,b)=>order(a)-order(b)||(a.announcementDate||"9999").localeCompare(b.announcementDate||"9999"));
    content=panel("발표 및 수령",list.length,filterbar(route,[["all","전체"],["check","확인할 발표"],["wait","발표 대기"],["done","확인 완료"]])+
      (list.map(e=>{const r=records.get(e.id);return row(e,r.status==="pending"?resultInfo(e).label:statusLabel(r),r.status==="won"&&!r.claimed&&e.claimDeadline?"수령 신청 마감 "+shortDate(e.claimDeadline):e.announcementMethod||"발표 방식 미정",!!resultAction(e));}).join("") || empty("여기에 표시할 결과가 없어요. 응모를 기록하면 발표 일정과 확인할 곳을 알려드려요.")));
  }
  document.title=title+" · 응모수첩";
  document.querySelectorAll("[data-route]").forEach(a=>{if(a.dataset.route===route)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current");});
  const warning=problem?'<p class="notice" role="alert">'+escapeHtml(problem)+'</p>':"";
  const storageMessage=storageWarning?'<p class="notice" role="alert">브라우저 저장 공간을 사용할 수 없어 일부 기록은 이 화면을 닫으면 사라질 수 있어요.</p>':"";
  select("#main").innerHTML=`<h1>${title}</h1><p class="subtitle">${escapeHtml(subtitle)}</p>${warning}${storageMessage}<div class="columns"><div class="side">${feature(open,mine)}${privateCard}</div>${content}</div><p class="private mobile-note">${personalNote}</p>`;
}
function outbound(url,label,primary=false) {
  return url ? `<a class="action ${primary?"primary":""}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}${icon("ext")}</a>` : "";
}
function markButton(state,label,selected=false,primary=false) {
  return `<button type="button" class="action ${selected?"current":""} ${primary?"primary":""}" data-mark="${state}"${selected?' aria-pressed="true"':''}>${label}</button>`;
}
function details() {
  const e=getEvent(activeId),dlg=select("#detail");if(!e){if(dlg.open)dlg.close();return;}
  const rec=records.get(e.id),info=resultInfo(e);
  const attrs=[["경품",e.prize],["참여 방법",e.entryMethod],["접수 마감",shortDate(e.deadline)+(e.deadlineTime?" "+e.deadlineTime:"")],["추첨 예정일",shortDate(e.drawDate)],["발표 예정일",shortDate(e.announcementDate)],["발표 방식",e.announcementMethod||"미정"]];
  if(e.claimDeadline)attrs.push(["수령 신청 마감",shortDate(e.claimDeadline)]);
  const actions=[];
  if(period(e)==="open")actions.push(outbound(e.entryUrl||e.sourceUrl,"주최 측 응모처",true));
  if(e.resultUrl)actions.push(outbound(e.resultUrl,"공식 발표문 보기",true));
  if(!e.resultUrl && e.announcementUrl)actions.push(outbound(e.announcementUrl,"발표 확인처"));
  if(!rec)actions.push(markButton("applied","응모했어요"));
  const resultBtns=rec?[markButton("pending","미확인",rec.status==="pending"),markButton("won","당첨",rec.status==="won"),markButton("lost","미당첨",rec.status==="lost")].join(""):"";
  const claim=rec?.status==="won"?markButton(rec.claimed?"unclaim":"claim",rec.claimed?"수령 완료 취소":"수령 완료로 기록"):"";
  select("#detail-body").innerHTML=`<div class="detail-head"><span class="org">${escapeHtml(e.organizer)}</span><button type="button" class="close" data-close>닫기</button></div>
    <h2 id="detail-title">${escapeHtml(e.title)}</h2><p class="description">${escapeHtml(e.rules)}</p>
    <dl class="spec">${attrs.filter(x=>x[1]).map(([k,v])=>`<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl>
    <p class="notice-box"><strong>${escapeHtml(info.label)}</strong><br>${escapeHtml(info.help)}</p>
    <div class="actions">${actions.join("")}</div>
    ${rec?`<h3 class="recordhead">내가 확인한 결과 · ${escapeHtml(statusLabel(rec))}</h3><div class="actions">${resultBtns}${claim}</div><button class="quiet-action" type="button" data-mark="remove">응모 기록 취소</button>`:""}
    <div class="minorline"><a class="source" href="${escapeHtml(e.sourceUrl)}" target="_blank" rel="noopener noreferrer">주최 측 공고 원문 ↗</a><span class="org">자료 확인 ${escapeHtml(shortDate(e.verifiedAt))}</span></div>`;
}
function updateScreen() {
  const focus=document.activeElement;
  const eventFocus=focus?.getAttribute("data-event"), markFocus=focus?.getAttribute("data-mark");
  screen();
  if(select("#detail").open)details();
  if(eventFocus && !select("#detail").open) Array.from(document.querySelectorAll("[data-event]")).find(b=>b.dataset.event===eventFocus)?.focus({preventScroll:true});
  if(markFocus && select("#detail").open) Array.from(document.querySelectorAll("[data-mark]")).find(b=>b.dataset.mark===markFocus)?.focus({preventScroll:true});
}
function storeStatus(action) {
  const e=getEvent(activeId);if(!e)return;
  const old=records.get(activeId);
  if(action==="remove") write(recordPrefix+e.id,null);
  else if(action==="applied"||old){
    const status=action==="applied"?"pending":["won","lost","pending"].includes(action)?action:old.status;
    const claimed=status==="won"&&(action==="claim" || (action!=="unclaim" && old?.claimed===true));
    write(recordPrefix+e.id,{event:e,appliedAt:old?.appliedAt||new Date().toISOString(),status,claimed});
  }
  readRecords();updateScreen();
  announce(action==="remove"?"이 기기에서 응모 기록을 지웠어요.":"이 기기에 기록했어요.");
}
let toastTimer;
function announce(message){clearTimeout(toastTimer);select("#status").textContent=message;toastTimer=setTimeout(()=>select("#status").textContent="",2500);}
async function refresh(manual=false) {
  if(request)return request;
  const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),12000);
  select("[data-refresh]").disabled=true;
  request=(async()=>{
    try {
      const url=new URL("./events.json",document.baseURI);
      url.searchParams.set("t",Math.floor(Date.now()/60000));
      const response=await fetch(url,{cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",signal:controller.signal});
      if(!response.ok)throw Error("network");
      const next=cleanCatalog(await response.json());if(!next)throw Error("catalog");
      const changed=JSON.stringify(next)!==JSON.stringify(catalog);
      catalog=next;write(catalogKey,next);lastSuccess=new Date().toISOString();write(lastVisitKey,lastSuccess);
      readRecords();fetchState="ok";problem="";
      if(manual) announce(changed?"새 공고 내용을 반영했어요.":"최신 공고예요.");
    } catch {
      fetchState="error";
      problem=lastSuccess?"공고를 갱신하지 못했어요. 마지막으로 받아온 자료("+checkedAtLabel(lastSuccess)+")를 표시해요.":"공고를 불러오지 못했어요. 연결을 확인한 뒤 ‘공고 갱신’을 눌러 주세요.";
    } finally {
      clearTimeout(timeout);request=null;select("[data-refresh]").disabled=false;updateScreen();
    }
  })();
  return request;
}
document.addEventListener("click",(evt)=>{
  const btn=evt.target.closest("button");if(!btn)return;
  if(btn.hasAttribute("data-refresh")){refresh(true);return;}
  if(btn.hasAttribute("data-event")){activeId=btn.dataset.event;details();select("#detail").showModal();select("#detail").scrollTop=0;return;}
  if(btn.hasAttribute("data-filter")){filters[currentRoute()]=btn.dataset.filter;screen();Array.from(document.querySelectorAll("[data-filter]")).find(b=>b.dataset.filter===btn.dataset.filter)?.focus({preventScroll:true});return;}
  if(btn.hasAttribute("data-close"))select("#detail").close();
  if(btn.hasAttribute("data-mark"))storeStatus(btn.dataset.mark);
});
select("#detail").addEventListener("close",()=>{const last=activeId;activeId=null;Array.from(document.querySelectorAll("[data-event]")).find(b=>b.dataset.event===last)?.focus({preventScroll:true});});
window.addEventListener("hashchange",()=>{if(select("#detail").open) select("#detail").close();screen();window.scrollTo(0,0);select("#main").focus({preventScroll:true});});
window.addEventListener("storage",(e)=>{if(e.key===null || e.key.startsWith(recordPrefix)){readRecords();updateScreen();}});
document.addEventListener("visibilitychange",()=>{if(!document.hidden) refresh();});
window.addEventListener("pageshow",e=>{if(e.persisted)refresh();});
setInterval(()=>{if(!document.hidden)refresh();},60000);
catalog=cleanCatalog(read(catalogKey))||catalog;
lastSuccess=read(lastVisitKey)||"";
readRecords();screen();refresh();
