
(function(){
'use strict';
const CFG = {
  monitorInterval: 75*1000,
  monitorIntervalLowBW: 4*1000,
  checkUpdateInterval: 10*60*1000,
  updateAttemptMinIntervalMs: 5*60*1000,
  dnsServers: [
    ["1.1.1.1","1.0.0.1","v4"],
    ["9.9.9.9","149.112.112.112","v4"],
    ["8.8.8.8","8.8.4.4","v4"],
    ["94.140.14.14","94.140.15.15","v4"],
    ["2606:4700:4700::1111","2606:4700:4700::1001","v6"],
    ["2001:4860:4860::8888","2001:4860:4860::8844","v6"],
    ["2620:119:35::35","2620:119:53::53","v6"]
  ],
  dnsPrefetchList: ["youtube.com","i.ytimg.com","googlevideo.com","netflix.com","instagram.com","facebook.com","speed.cloudflare.com"],
  telegramMinIntervalMs: 60*1000,
  actionCooldownMs: 3*60*1000,
  maxActionsPerHour: 8,
  reconnectionBackoff: [1500,4000,9000,20000],
  serverPrewarmEndpointHostSuffix: ".ping.av",
  serverPrewarmCandidates: 6,
  bestServerComputeInterval: 10*60*1000,
  metricHistoryMax: 10,
  predictiveThresholds: { pingRiseRate: 20, downDropRate: 0.3, historySamples: 5 },
  monitorRandomJitter: 3000,
  mtuCandidates: [1500,1400,1350,1200],
  appVersionUrl: '/app-version.json',
  assetsToWarm: ["/","/index.html"]
};
const STATE = {
  lastTelegramSent: 0,
  lastUpdateAttempt: 0,
  lastUpdateCheck: 0,
  metricHistory: {},
  bestBackupServer: null,
  lastBestCompute: 0,
  actionHistory: {},
  actionsThisHour: 0,
  lastActionHour: new Date().getHours(),
  reconnectionAttempts: 0,
  lastHealthSent: 0,
  lastUserActivity: Date.now(),
  autolog: [],
  dnsCacheUntil: 0,
  isAutoConnecting: false,
  circuitOpenUntil: 0
};
function nativeCall(name, method='execute', ...args){
  try{
    const obj = window[name];
    if(!obj) return undefined;
    if(typeof obj[method] === 'function') return obj[method].apply(obj,args);
    if(typeof obj === 'function') return obj.apply(null,args);
  }catch(e){}
  return undefined;
}
function now(){ return Date.now(); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function readPing(){
  const n = nativeCall('DtGetPingResult');
  if(typeof n === 'number') return n;
  const el = document.getElementById('pingResultValue');
  if(el) return parseInt((el.innerText||'').replace(/[^\d]/g,''),10)||-1;
  return -1;
}
function readDownloadMbps(){
  const bytes = nativeCall('DtGetNetworkDownloadBytes');
  if(typeof bytes === 'number') return Math.round(bytes/(1024*1024)*10)/10;
  const el = document.getElementById('downloadSpeedDisplay');
  if(el) return parseFloat(String(el.innerText).replace(/[^\d\.]/g,''))||0;
  return 0;
}
function readUploadMbps(){
  const bytes = nativeCall('DtGetNetworkUploadBytes');
  if(typeof bytes === 'number') return Math.round(bytes/(1024*1024)*10)/10;
  const el = document.getElementById('uploadSpeedDisplay');
  if(el) return parseFloat(String(el.innerText).replace(/[^\d\.]/g,''))||0;
  return 0;
}
function getTotalDownloadedBytes(){ const v = nativeCall('DtGetNetworkDownloadBytes'); return typeof v === 'number' ? v : null; }
function getTotalUploadedBytes(){ const v = nativeCall('DtGetNetworkUploadBytes'); return typeof v === 'number' ? v : null; }
function getLocalConfigVersion(){ const v = nativeCall('DtGetLocalConfigVersion'); return typeof v === 'string' ? v : null; }
function getNetworkName(){
  const n = nativeCall('DtGetNetworkName');
  if(n) return n;
  const nd = nativeCall('DtGetNetworkData');
  if(nd && nd.type_name) return nd.type_name;
  return (navigator.connection && navigator.connection.effectiveType) || 'unknown';
}
function getLocalIP(){ return nativeCall('DtGetLocalIP') || '0.0.0.0'; }
function getVpnState(){ return nativeCall('DtGetVpnState') || 'DISCONNECTED'; }
function getDeviceId(){ return nativeCall('DtGetDeviceID') || ''; }
function getUsername(){
  try{
    if(typeof window.DtUsername === 'object' && typeof window.DtUsername.get === 'function') return window.DtUsername.get() || '';
  }catch(e){}
  const el = document.getElementById('username');
  if(el) return el.value || el.innerText || '';
  return localStorage.getItem('username') || '';
}
function getCurrentServerName(){
  try{
    const cfg = nativeCall('DtGetDefaultConfig');
    if(cfg && typeof cfg === 'object') return cfg.name || cfg.title || cfg.plan || null;
  }catch(e){}
  const el = document.querySelector('.server-title-stats, .server-name-accordion, .server-title, #currentPlanNamePanel');
  if(el) return (el.innerText||'').trim();
  return null;
}
async function getSelectedServerInfo(){
  try{
    var cfg = null;
    if(typeof window.DtGetDefaultConfig === 'object' && typeof window.DtGetDefaultConfig.execute === 'function'){
      cfg = window.DtGetDefaultConfig.execute();
      if(cfg){
        const id = cfg.id || cfg.configId || null;
        const name = cfg.name || cfg.title || cfg.plan || null;
        if(name) return { id, name: String(name).trim(), category: cfg.category || null, raw: cfg };
      }
    }
  }catch(e){}
  try{
    if(typeof window.DtGetConfigs === 'object' && typeof window.DtGetConfigs.execute === 'function'){
      const cats = window.DtGetConfigs.execute() || [];
      for(const cat of cats){
        if(!cat || !Array.isArray(cat.items)) continue;
        for(const item of cat.items){
          if(!item) continue;
          if(item.active===true || item.selected===true || item.isActive===true) return { id: item.id||item.configId||null, name: String(item.name||item.title||'').trim(), category: cat.name||cat.title||null, raw: item };
        }
      }
      if(cfg && (cfg.id || cfg.configId)){
        for(const cat of cats){
          if(!cat || !Array.isArray(cat.items)) continue;
          for(const item of cat.items){
            if(!item) continue;
            if(item.id === cfg.id || item.configId === cfg.configId) return { id: item.id||item.configId||null, name: String(item.name||item.title||'').trim(), category: cat.name||cat.title||null, raw: item };
          }
        }
      }
    }
  }catch(e){}
  const selectors = ['[data-server-raw]','[data-server]','.server-item.active','.server-item.selected','.server-title-stats','.server-name-accordion','.server-title','.server-name'];
  for(const sel of selectors){
    try{
      const el = document.querySelector(sel);
      if(!el) continue;
      const name = (el.getAttribute && (el.getAttribute('data-server-raw')||el.getAttribute('data-server')) ) || el.innerText || '';
      let category = null;
      try{
        const parent = el.closest('.server-group, .category, .accordion-section, .servers-category, .panel');
        if(parent){
          const header = parent.querySelector('.category-title, .server-group-title, .accordion-title, .panel-title, h3, h4');
          if(header) category = (header.innerText||'').trim();
        }
      }catch(e){}
      return { id: null, name: String(name).trim(), category: category, rawDom: (el.outerHTML||'') };
    }catch(e){ continue; }
  }
  return { id: null, name: null, category: null, raw: null };
}
function formatBytes(b){
  if(b===null||b===undefined) return 'â€”';
  if(b<1024) return b+' B';
  if(b<1024*1024) return Math.round(b/1024)+' KB';
  if(b<1024*1024*1024) return Math.round(b/(1024*1024)*10)/10+' MB';
  return Math.round(b/(1024*1024*1024)*10)/10+' GB';
}
const TELEGRAM = window.AVSUPER_TELEGRAM || {};
TELEGRAM.minIntervalMs = TELEGRAM.minIntervalMs || CFG.telegramMinIntervalMs;
const tgQueue = [];
let tgSending = false;
async function sendTelegramRaw(text){
  try{
    if(!TELEGRAM.token || !TELEGRAM.chatId) return false;
    const nowTs = now();
    const minInterval = (TELEGRAM.minIntervalMs || CFG.telegramMinIntervalMs);
    const elapsed = nowTs - (STATE.lastTelegramSent || 0);
    if(elapsed < minInterval){
      const wait = minInterval - elapsed + 200;
      await sleep(wait);
    }
    const resp = await fetch('https://api.telegram.org/bot'+TELEGRAM.token+'/sendMessage',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: TELEGRAM.chatId, text, parse_mode: 'HTML' })
    });
    STATE.lastTelegramSent = now();
    return resp && resp.ok;
  }catch(e){ return false; }
}
function sendTelegram(msg){
  try{
    tgQueue.push(msg);
    if(!tgSending) processTgQueue();
  }catch(e){}
}
async function processTgQueue(){
  tgSending = true;
  while(tgQueue.length){
    const m = tgQueue.shift();
    const ok = await sendTelegramRaw(m);
    if(!ok){
      tgQueue.unshift(m);
      await sleep(2000);
    }else{
      await sleep(400);
    }
  }
  tgSending = false;
}
async function buildTelegramMessage(type='RelatÃ³rio', details='-'){
  try{
    const user = getUsername() || 'â€”';
    const serverInfo = await getSelectedServerInfo();
    const server = serverInfo && serverInfo.name ? (serverInfo.category ? serverInfo.category + ' â†’ ' + serverInfo.name : serverInfo.name) : (getCurrentServerName() || 'â€”');
    const ip = getLocalIP() || 'â€”';
    const ping = readPing();
    const down = readDownloadMbps();
    const up = readUploadMbps();
    const net = getNetworkName();
    const cfgVersion = getLocalConfigVersion() || 'â€”';
    const totalDownBytes = getTotalDownloadedBytes();
    const totalUpBytes = getTotalUploadedBytes();
    const qualityScore = (() => {
      const pingScore = (ping<=0||ping===-1)?0:Math.max(0,1-Math.min(ping,1000)/600);
      const downScore = Math.min(1,(down/20));
      const upScore = Math.min(1,(up/5));
      const raw = (pingScore*0.5 + downScore*0.35 + upScore*0.15);
      return Math.max(1,Math.min(10,Math.round(raw*9)+1));
    })();
    const ts = new Date().toISOString();
    const msg = [
      'ðŸ“¡ <b>'+String(type)+'</b>',
      '<b>Hora:</b> '+ts,
      '<b>UsuÃ¡rio:</b> '+user,
      '<b>Servidor:</b> '+server,
      '<b>IP:</b> '+ip,
      '<b>Rede:</b> '+net,
      '<b>Ping:</b> '+(ping===-1?'-':(ping+' ms')),
      '<b>Download (instant):</b> '+down+' Mbps',
      '<b>Upload (instant):</b> '+up+' Mbps',
      '<b>Total baixado (bytes):</b> '+formatBytes(totalDownBytes),
      '<b>Total enviado (bytes):</b> '+formatBytes(totalUpBytes),
      '<b>VersÃ£o config local:</b> '+cfgVersion,
      '<b>Qualidade (1-10):</b> '+qualityScore,
      '<b>Detalhes:</b> '+(details||'-')
    ].join('\n');
    return msg;
  }catch(e){
    return 'Erro montando mensagem: '+(e&&e.message?e.message:e);
  }
}
let ACTION_LOCK = false;
async function withActionLock(fn){
  if(ACTION_LOCK) return false;
  ACTION_LOCK = true;
  try{ const out = await fn(); ACTION_LOCK = false; return out; }catch(e){ ACTION_LOCK = false; return false; }
}
async function rotateDns(serverName){
  return withActionLock(async ()=>{
    try{
      if(now() < (STATE.dnsCacheUntil||0)) return false;
      for(const [p,s,k] of CFG.dnsServers){
        try{
          if(typeof window.DtSetDns === 'object' && typeof window.DtSetDns.execute === 'function'){ window.DtSetDns.execute(p,s,k); }
          else if(typeof window.dtSetDns === 'function'){ window.dtSetDns(p,s,k); }
        }catch(e){}
        await sleep(CFG.actionCooldownMs + Math.floor(Math.random()*600));
        const ping = readPing(), down = readDownloadMbps();
        if(ping > -1 && down > 0){
          STATE.dnsCacheUntil = now() + CFG.actionCooldownMs;
          STATE.actionHistory[serverName] = STATE.actionHistory[serverName] || {};
          STATE.actionHistory[serverName].lastDns = now();
          STATE.autolog = (STATE.autolog||[]);
          STATE.autolog.unshift({ t: new Date().toISOString(), m: 'DNS aplicado '+p+'/'+s+' ('+k+')' });
          if(STATE.autolog.length>300) STATE.autolog.length = 300;
          const msg = await buildTelegramMessage('DNS Alterado', p+'/'+s+' ('+k+') para '+(serverName||'unknown'));
          sendTelegram(msg);
          return true;
        }
      }
      STATE.dnsCacheUntil = now() + 60000;
      return false;
    }catch(e){ return false; }
  });
}
async function mtuAdjust(){
  return withActionLock(async ()=>{
    try{
      const originalMTU = 1500;
      for(const mtu of (CFG.mtuCandidates||[1500,1400,1350,1200])){
        try{
          if(typeof window.DtSetMTU === 'object' && typeof window.DtSetMTU.execute === 'function'){ window.DtSetMTU.execute(mtu); }
          else if(typeof window.dtSetMTU === 'function'){ window.dtSetMTU(mtu); }
        }catch(e){}
        await sleep(3000);
        const ping = readPing(), down = readDownloadMbps();
        if(ping > -1 && down > 0){
          STATE.actionHistory[getCurrentServerName()||'unknown'] = STATE.actionHistory[getCurrentServerName()||'unknown'] || {};
          STATE.actionHistory[getCurrentServerName()||'unknown'].lastMtu = now();
          STATE.autolog.unshift({ t: new Date().toISOString(), m: 'MTU ajustado '+mtu });
          if(STATE.autolog.length>300) STATE.autolog.length = 300;
          const msg = await buildTelegramMessage('Ajuste MTU', mtu+' aplicado');
          sendTelegram(msg);
          return true;
        }
      }
      try{
        if(typeof window.DtSetMTU === 'object' && typeof window.DtSetMTU.execute === 'function'){ window.DtSetMTU.execute(originalMTU); }
        else if(typeof window.dtSetMTU === 'function'){ window.dtSetMTU(originalMTU); }
      }catch(e){}
      return false;
    }catch(e){ return false; }
  });
}
async function prewarm(server){
  try{
    if(!server) return false;
    const host = String(server).toLowerCase().replace(/[\s\{\}\[\]\(\)]/g,'').replace(/[^a-z0-9\-]/g,'');
    const url = 'https://'+host+CFG.serverPrewarmEndpointHostSuffix+'/health';
    try{ await Promise.race([fetch(url,{cache:'no-store',mode:'no-cors'}), new Promise((_,r)=>setTimeout(()=>r('t'),1200))]); return true; }catch(e){ return false; }
  }catch(e){ return false; }
}
async function switchToServer(name){
  return withActionLock(async ()=>{
    try{
      if(!name) return false;
      STATE.autolog.unshift({ t: new Date().toISOString(), m: 'Solicitada troca para '+name });
      if(typeof window.DtSetConfig === 'object' && typeof window.DtSetConfig.execute === 'function'){
        try{
          const configs = nativeCall('DtGetConfigs') || [];
          for(const cat of configs){
            if(!cat || !Array.isArray(cat.items)) continue;
            for(const item of cat.items){
              if(!item) continue;
              const itemName = String(item.name||item.title||'').toLowerCase();
              if(item.id === name || item.configId === name || itemName === String(name||'').toLowerCase() || itemName.includes(String(name||'').toLowerCase())){
                try{ window.DtSetConfig.execute(item.id || item.configId || item.id); return true; }catch(e){}
              }
            }
          }
        }catch(e){}
      }
      try{
        const candidateEl = Array.from(document.querySelectorAll('[data-server-raw],[data-server]')).find(el=>{
          const dsr = el.getAttribute('data-server-raw')||el.getAttribute('data-server')||'';
          const text = (el.innerText||'')+'';
          return dsr===name || text.includes(name);
        });
        if(candidateEl){ try{ candidateEl.click(); return true; }catch(e){} }
      }catch(e){}
      return false;
    }catch(e){ return false; }
  });
}
async function shortlist(){
  const out = [];
  try{
    (JSON.parse(localStorage.getItem('av_last_good')||'[]')||[]).forEach(x=>{ if(!out.includes(x.n)) out.push(x.n); });
    const favs = JSON.parse(localStorage.getItem('av_favorites')||'[]') || [];
    favs.forEach(x=>{ if(!out.includes(x.n)) out.push(x.n); });
    document.querySelectorAll('.server-name-accordion, .server-title-stats, .server-title, .server-item, [data-server], .server-name').forEach(el=>{
      const t = (el.innerText||'').trim();
      if(t && !out.includes(t)) out.push(t);
    });
  }catch(e){}
  return Array.from(new Set(out)).slice(0,40);
}
async function testLatency(servers){
  const out = {};
  for(const server of servers.slice(0, CFG.serverPrewarmCandidates)){
    const host = server.toLowerCase().replace(/[\s\{\}\[\]\(\)]/g,'').replace(/[^a-z0-9\-]/g,'');
    const url = 'https://'+host+CFG.serverPrewarmEndpointHostSuffix+'/ping?ts='+Date.now();
    const t0 = performance.now();
    try{ await Promise.race([fetch(url,{cache:'no-store',mode:'no-cors'}), new Promise((_,r)=>setTimeout(()=>r('t'),1200))]); out[server] = Math.round(performance.now()-t0); }catch(e){ out[server] = Infinity; }
    await sleep(220);
  }
  return out;
}
async function chooseAndSwitchBest(){
  return withActionLock(async ()=>{
    try{
      const pool = await shortlist();
      if(!pool.length) return null;
      const lat = await testLatency(pool.slice(0,12));
      const ordered = Object.keys(lat).sort((a,b)=>(lat[a]||Infinity)-(lat[b]||Infinity));
      const best = ordered[0];
      if(best){
        await prewarm(best);
        await switchToServer(best);
        STATE.autolog.unshift({ t: new Date().toISOString(), m: 'Escolhido fallback por latÃªncia: '+best });
        const msg = await buildTelegramMessage('Escolha automÃ¡tica de servidor', 'Fallback -> '+best);
        sendTelegram(msg);
        return best;
      }
    }catch(e){}
    return null;
  });
}
function updateMetricHistory(name,ping,down,up){
  try{
    if(!name) return;
    STATE.metricHistory[name] = STATE.metricHistory[name] || [];
    STATE.metricHistory[name].push({ ping, down, up, ts: now() });
    if(STATE.metricHistory[name].length > CFG.metricHistoryMax) STATE.metricHistory[name] = STATE.metricHistory[name].slice(-CFG.metricHistoryMax);
    localStorage.setItem('av_metricHistory', JSON.stringify(STATE.metricHistory));
  }catch(e){}
}
function analyzeTrends(name){
  try{
    const h = STATE.metricHistory[name] || [];
    if(h.length < 2) return { pingRise: 0, downDrop: 0 };
    let pingRise = 0, downDrop = 0;
    for(let i=1;i<h.length;i++){
      if(h[i].ping>-1 && h[i-1].ping>-1) pingRise += (h[i].ping - h[i-1].ping);
      if(h[i-1].down>0) downDrop += (h[i-1].down - h[i].down)/h[i-1].down;
    }
    return { pingRise: pingRise/(h.length-1), downDrop: downDrop/(h.length-1) };
  }catch(e){ return { pingRise:0, downDrop:0 }; }
}
async function predictiveRemedy(name){
  try{
    const trends = analyzeTrends(name);
    if(trends.pingRise > CFG.predictiveThresholds.pingRiseRate || trends.downDrop > CFG.predictiveThresholds.downDropRate){
      STATE.autolog.unshift({ t: new Date().toISOString(), m: 'TendÃªncia de degradaÃ§Ã£o detectada em '+name });
      const msg = await buildTelegramMessage('PrevisÃ£o de Problema', 'TendÃªncia de degradaÃ§Ã£o em '+name);
      sendTelegram(msg);
      let remedied = await rotateDns(name);
      if(!remedied) remedied = await mtuAdjust();
      if(!remedied){ const best = await chooseAndSwitchBest(); if(best) STATE.autolog.unshift({ t: new Date().toISOString(), m: 'Switch preventivo para '+best }); }
      return true;
    }
  }catch(e){}
  return false;
}
function checkActionBudget(){
  const hour = new Date().getHours();
  if(hour !== STATE.lastActionHour){ STATE.lastActionHour = hour; STATE.actionsThisHour = 0; }
  if((STATE.actionsThisHour||0) >= CFG.maxActionsPerHour) return false;
  STATE.actionsThisHour = (STATE.actionsThisHour||0) + 1;
  return true;
}
async function smartAutoConnect(){
  if(STATE.isAutoConnecting) return;
  if(now() < (STATE.circuitOpenUntil||0)) return;
  STATE.isAutoConnecting = true;
  STATE.autolog.unshift({ t: new Date().toISOString(), m: 'Auto-connect iniciado' });
  const pool = (await shortlist()).slice(0,12);
  if(!pool.length){ STATE.isAutoConnecting = false; return; }
  const lat = await testLatency(pool);
  const scores = {};
  for(const s of pool){
    const hist = (STATE.metricHistory[s] && STATE.metricHistory[s].length) ? STATE.metricHistory[s].reduce((a,c)=>a+c.down,0)/STATE.metricHistory[s].length : 0;
    const p = lat[s] || Infinity;
    let score = 0;
    if(p !== Infinity) score += 10000/Math.max(1,p);
    score += hist*10;
    if(STATE.bestBackupServer === s) score *= 1.05;
    scores[s] = score;
  }
  const ordered = Object.keys(scores).sort((a,b)=>scores[b]-scores[a]);
  let attempts = 0;
  for(const candidate of ordered){
    if(attempts++ > 6) break;
    if(Date.now() - STATE.lastUserActivity < 3000) break;
    const warmed = await prewarm(candidate);
    if(!warmed) STATE.autolog.unshift({ t: new Date().toISOString(), m: 'PrÃ©-aquecimento falhou '+candidate });
    await switchToServer(candidate);
    const ok = await waitForCondition(()=> (getVpnState()==='CONNECTED') || (readPing()>-1 && readDownloadMbps()>0), 9000);
    if(ok){
      STATE.autolog.unshift({ t: new Date().toISOString(), m: 'Auto-connect: conectado em '+candidate });
      const msg = await buildTelegramMessage('Auto-Connect', 'Conectado em '+candidate);
      sendTelegram(msg);
      STATE.isAutoConnecting = false;
      return;
    }
  }
  STATE.circuitOpenUntil = now() + 30*1000;
  STATE.autolog.unshift({ t: new Date().toISOString(), m: 'Auto-connect nÃ£o obteve sucesso' });
  const msg = await buildTelegramMessage('Auto-Connect Falhou', 'Nenhum servidor com mÃ©tricas aceitÃ¡veis');
  sendTelegram(msg);
  STATE.isAutoConnecting = false;
}
function waitForCondition(fn, timeout=5000, interval=400){
  return new Promise(resolve=>{
    const start = Date.now();
    const id = setInterval(()=>{
      try{
        if(fn()){ clearInterval(id); resolve(true); }
        else if(Date.now()-start > timeout){ clearInterval(id); resolve(false); }
      }catch(e){ clearInterval(id); resolve(false); }
    }, interval);
  });
}
async function checkAndRecover(){
  try{
    const state = getVpnState();
    const ping = readPing(), down = readDownloadMbps(), up = readUploadMbps();
    const bad = (ping===-1 || ping>500 || down<0.5 || up<0.2);
    if(state !== 'CONNECTED' || bad){
      STATE.autolog.unshift({ t: new Date().toISOString(), m: 'RecuperaÃ§Ã£o: state='+state+' ping='+ping+' down='+down });
      STATE.reconnectionAttempts++;
      if(!checkActionBudget()) return;
      if(now() < (STATE.circuitOpenUntil||0)) return;
      if(state !== 'CONNECTED' && STATE.bestBackupServer && STATE.bestBackupServer !== getCurrentServerName()){
        await prewarm(STATE.bestBackupServer);
        await switchToServer(STATE.bestBackupServer);
        await sleep(1400);
        if(getVpnState() === 'CONNECTED'){
          STATE.autolog.unshift({ t: new Date().toISOString(), m: 'Reconectado via backup '+STATE.bestBackupServer });
          const msg = await buildTelegramMessage('Auto-Switch DesconexÃ£o', 'Troca automÃ¡tica para '+STATE.bestBackupServer);
          sendTelegram(msg);
          STATE.reconnectionAttempts = 0;
          return;
        }
      }
      if(STATE.reconnectionAttempts <= CFG.reconnectionBackoff.length){
        const delay = CFG.reconnectionBackoff[Math.min(STATE.reconnectionAttempts-1, CFG.reconnectionBackoff.length-1)];
        try{
          if(typeof window.DtExecuteVpnStart === 'object' && typeof window.DtExecuteVpnStart.execute === 'function'){ window.DtExecuteVpnStart.execute(); STATE.autolog.unshift({ t: new Date().toISOString(), m: 'Reiniciando VPN (API)' }); }
          else if(typeof window.dtStartVpn === 'function'){ window.dtStartVpn(); STATE.autolog.unshift({ t: new Date().toISOString(), m: 'Reiniciando VPN (global)' }); }
          else STATE.autolog.unshift({ t: new Date().toISOString(), m: 'ReinÃ­cio VPN solicitado (sem API)' });
        }catch(e){}
        await sleep(delay);
      }else{
        await rotateDns(getCurrentServerName() || 'unknown');
        await sleep(500);
        await mtuAdjust();
        const best = await chooseAndSwitchBest();
        if(best){ const msg = await buildTelegramMessage('RecuperaÃ§Ã£o AvanÃ§ada', 'DNS/MTU/Server -> '+best); sendTelegram(msg); }
        STATE.reconnectionAttempts = 0;
      }
    }else{
      STATE.reconnectionAttempts = 0;
    }
  }catch(e){}
}
async function computeBestBackup(){
  try{
    if(now() - (STATE.lastBestCompute||0) < CFG.bestServerComputeInterval) return;
    STATE.lastBestCompute = now();
    const ops = ['vivo','tim','claro'];
    const all = await shortlist();
    const pool = ops.flatMap(op=> all.filter(n=> (n||'').toLowerCase().includes(op)).slice(0,6));
    if(!pool.length) return;
    const lat = await testLatency(pool);
    const ordered = Object.keys(lat).sort((a,b)=> (lat[a]||Infinity)-(lat[b]||Infinity));
    const best = ordered[0];
    if(best && best !== getCurrentServerName()){ STATE.bestBackupServer = best; STATE.autolog.unshift({ t: new Date().toISOString(), m: 'Melhor backup computado: '+best }); const msg = await buildTelegramMessage('Backup Computado','Melhor servidor backup: '+best); sendTelegram(msg); }
  }catch(e){}
}
async function preCacheDomains(list){
  try{
    const head = document.head || document.documentElement;
    const uniq = Array.from(new Set(list)).slice(0,30);
    for(const host of uniq){
      if(!document.querySelector('link[data-pref="'+host+'"]')){
        const l1 = document.createElement('link'); l1.rel = 'dns-prefetch'; l1.href = '//'+host; l1.setAttribute('data-pref', host); head.appendChild(l1);
        const l2 = document.createElement('link'); l2.rel = 'preconnect'; l2.href = 'https://'+host; l2.crossOrigin = 'anonymous'; l2.setAttribute('data-pref', host); head.appendChild(l2);
      }
    }
    for(const host of uniq.slice(0,6)){ try{ await fetch('https://'+host+'/favicon.ico',{ method:'HEAD', cache:'no-store', mode:'no-cors' }); }catch(e){} }
  }catch(e){}
}
async function backgroundUpdateCheck(){
  try{
    const nowTs = now();
    if(nowTs - (STATE.lastUpdateCheck||0) < CFG.checkUpdateInterval) {}
    else { STATE.lastUpdateCheck = nowTs; try{ const r = await fetch((CFG.appVersionUrl||'/app-version.json')+'?t='+now(),{cache:'no-store'}); if(r.ok){ try{ await r.json(); }catch(e){} } }catch(e){} }
    try{
      const canCall = (now() - (STATE.lastUpdateAttempt||0)) > CFG.updateAttemptMinIntervalMs;
      if(canCall){
        if(typeof window.DtStartAppUpdate === 'object' && typeof window.DtStartAppUpdate.execute === 'function'){ try{ window.DtStartAppUpdate.execute(); STATE.lastUpdateAttempt = now(); const msg = await buildTelegramMessage('StartAppUpdate Executado','Comando DtStartAppUpdate.execute() invocado em background.'); sendTelegram(msg); }catch(e){} }
        else if(typeof window.DtStartAppUpdate === 'function'){ try{ window.DtStartAppUpdate(); STATE.lastUpdateAttempt = now(); const msg = await buildTelegramMessage('StartAppUpdate Executado (fallback)','Chamada DtStartAppUpdate() (fallback).'); sendTelegram(msg); }catch(e){} }
      }
    }catch(e){}
  }catch(e){}
}
async function autoHealCurrentServer(){
  try{
    if(!checkActionBudget()) return false;
    const current = getCurrentServerName();
    if(!current) return false;
    const ping = readPing(), down = readDownloadMbps(), up = readUploadMbps();
    const isBad = (ping===-1 || ping>500 || down<0.5 || up<0.2);
    if(!isBad) return false;
    STATE.autolog.unshift({ t: new Date().toISOString(), m: 'autoHeal: problema em '+current+' (ping='+ping+' down='+down+' up='+up+')' });
    if(STATE.bestBackupServer && STATE.bestBackupServer !== current){
      await prewarm(STATE.bestBackupServer);
      await switchToServer(STATE.bestBackupServer);
      await sleep(1200);
      const newPing = readPing(), newDown = readDownloadMbps();
      if(newPing > -1 && newDown > 0.2){ STATE.autolog.unshift({ t: new Date().toISOString(), m: 'autoHeal: sucesso via backup '+STATE.bestBackupServer }); const msg = await buildTelegramMessage('Auto-Switch Heal','Troca para backup '+STATE.bestBackupServer); sendTelegram(msg); return true; }
    }
    const pool = (await shortlist()).filter(n=>n && n!==current).slice(0,12);
    if(!pool.length) return false;
    const scores = {};
    for(const p of pool){
      const s = JSON.parse(localStorage.getItem('av_last_good')||'[]').find(x=>x.n===p);
      const avgPing = s && s.ps && s.samples ? (s.ps/s.samples) : Infinity;
      const avgDown = s && s.ds && s.samples ? (s.ds/s.samples) : 0;
      scores[p] = (avgPing===Infinity?0:10000/(avgPing||1)) + avgDown;
    }
    const ordered = pool.sort((a,b)=>(scores[b]||0)-(scores[a]||0));
    let attempts = 0;
    for(const candidate of ordered){
      if(attempts++ >= 3) break;
      await prewarm(candidate);
      await sleep(300);
      if(!checkActionBudget()) break;
      STATE.autolog.unshift({ t: new Date().toISOString(), m: 'autoHeal: tentando '+candidate });
      await switchToServer(candidate);
      await sleep(1200);
      const newPing = readPing(), newDown = readDownloadMbps();
      if(newPing > -1 && newDown > 0.2){ STATE.autolog.unshift({ t: new Date().toISOString(), m: 'autoHeal: sucesso '+current+' -> '+candidate }); const msg = await buildTelegramMessage('Auto-Switch','Servidor '+current+' substituÃ­do por '+candidate+'. Ping:'+newPing+'ms Down:'+newDown+'Mbps'); sendTelegram(msg); return true; }
      else STATE.autolog.unshift({ t: new Date().toISOString(), m: 'autoHeal: tentativa '+candidate+' nÃ£o funcionou (ping='+newPing+' down='+newDown+')' });
    }
    const lat = await testLatency(pool);
    const best = Object.keys(lat).sort((a,b)=>(lat[a]||Infinity)-(lat[b]||Infinity))[0];
    if(best && best !== current && checkActionBudget()){ STATE.autolog.unshift({ t: new Date().toISOString(), m: 'autoHeal: fallback escolhendo '+best }); await prewarm(best); await switchToServer(best); await sleep(1200); const np = readPing(), nd = readDownloadMbps(); const msg = await buildTelegramMessage('Auto-Switch','Fallback: '+current+' -> '+best+'. Ping:'+np+' Down:'+nd); sendTelegram(msg); return true; }
    STATE.autolog.unshift({ t: new Date().toISOString(), m: 'autoHeal: nÃ£o encontrou alternativa melhor' });
    return false;
  }catch(e){ STATE.autolog.unshift({ t: new Date().toISOString(), m: 'autoHeal erro: '+(e&&e.message?e.message:e) }); return false; }
}
async function periodic(){
  try{
    const curServer = getCurrentServerName() || 'unknown';
    const ping = readPing(), down = readDownloadMbps(), up = readUploadMbps();
    updateMetricHistory(curServer,ping,down,up);
    const net = getNetworkName();
    try{ await computeBestBackup(); }catch(e){}
    try{ await predictiveRemedy(curServer); }catch(e){}
    try{ if(now() > (STATE.dnsCacheUntil||0)) await rotateDns(curServer); }catch(e){}
    try{ await preCacheDomains(CFG.dnsPrefetchList); }catch(e){}
    try{ await backgroundUpdateCheck(); }catch(e){}
    try{ if((getVpnState()!=='CONNECTED') || ping===-1 || down<0.5) await checkAndRecover(); }catch(e){}
    try{ if(now() - (STATE.lastHealthSent||0) > 30*60*1000){ const msg = await buildTelegramMessage('RelatÃ³rio de SaÃºde'); sendTelegram(msg); STATE.lastHealthSent = now(); } }catch(e){}
    try{ await autoHealCurrentServer(); }catch(e){}
    STATE.autolog = (STATE.autolog||[]).slice(0,300);
  }catch(e){}
  const bw = (readDownloadMbps()+readUploadMbps())/2;
  const next = (bw < 0.2) ? CFG.monitorIntervalLowBW : CFG.monitorInterval;
  setTimeout(periodic, next + Math.floor(Math.random()*CFG.monitorRandomJitter));
}
function persistState(){
  try{
    localStorage.setItem('av_autolog', JSON.stringify(STATE.autolog || []));
    localStorage.setItem('av_metricHistory', JSON.stringify(STATE.metricHistory || {}));
    if(STATE.bestBackupServer) localStorage.setItem('av_best_backup', STATE.bestBackupServer);
  }catch(e){}
}
function restoreState(){
  try{
    const al = localStorage.getItem('av_autolog');
    if(al) STATE.autolog = JSON.parse(al);
    const mh = localStorage.getItem('av_metricHistory');
    if(mh) STATE.metricHistory = JSON.parse(mh);
    const bb = localStorage.getItem('av_best_backup');
    if(bb) STATE.bestBackupServer = bb;
  }catch(e){}
}
setInterval(()=>persistState(), 30*1000);
(function start(){
  try{
    restoreState();
    setTimeout(periodic, 1500 + Math.floor(Math.random()*1000));
    setTimeout(async ()=>{ try{ const initMsg = await buildTelegramMessage('AVSuper Silent Iniciado','Modo invisÃ­vel ativo. RelatÃ³rios serÃ£o enviados ao Telegram.'); sendTelegram(initMsg); }catch(e){} }, 4000);
  }catch(e){}
})();
window.AVSUPER_SILENT = {
  buildTelegramMessage, sendTelegram, rotateDns, mtuAdjust, prewarm, chooseAndSwitchBest, smartAutoConnect, computeBestBackup
};
})();
