(function(){
'use strict';
var CFG = {
  monitorInterval: 75000,
  monitorIntervalLowBW: 4000,
  checkUpdateInterval: 600000,
  updateAttemptMinIntervalMs: 300000,
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
  telegramMinIntervalMs: 60000,
  telegramCriticalMinIntervalMs: 8000,
  actionCooldownMs: 180000,
  maxActionsPerHour: 8,
  reconnectionBackoff: [1500,4000,9000,20000],
  serverPrewarmEndpointHostSuffix: ".ping.av",
  serverPrewarmCandidates: 6,
  bestServerComputeInterval: 600000,
  metricHistoryMax: 20,
  predictiveThresholds: { pingRiseRate: 20, downDropRate: 0.3, historySamples: 5 },
  monitorRandomJitter: 3000,
  mtuCandidates: [1500,1420,1380,1300,1200],
  appVersionUrl: '/app-version.json',
  assetsToWarm: ["/","/index.html"],
  healthReportIntervalMs: 1800000,
  queueKey: 'av_telecom_queue_v1',
  metricHistoryKey: 'av_metric_history_v1',
  autologKey: 'av_autolog_v1',
  bestBackupKey: 'av_best_backup_v1'
};
var STATE = {
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
  circuitOpenUntil: 0,
  queue: []
};
function nativeCall(name, method){
  try{
    method = method || 'execute';
    var obj = window[name];
    if(!obj) return undefined;
    if(typeof obj[method] === 'function') return obj[method].apply(obj, Array.prototype.slice.call(arguments,2));
    if(typeof obj === 'function') return obj.apply(null, Array.prototype.slice.call(arguments,2));
  }catch(e){}
  return undefined;
}
function now(){ return Date.now(); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
function safeJsonParse(s,fallback){ try{ return JSON.parse(s||'null')||fallback; }catch(e){ return fallback; } }
function readPing(){
  var n = nativeCall('DtGetPingResult');
  if(typeof n === 'number') return n;
  var el = document.getElementById('pingResultValue');
  if(el) return parseInt((el.innerText||'').replace(/[^\d]/g,''),10)||-1;
  return -1;
}
function readDownloadMbps(){
  var bytes = nativeCall('DtGetNetworkDownloadBytes');
  if(typeof bytes === 'number') return Math.round(bytes/(1024*1024)*10)/10;
  var el = document.getElementById('downloadSpeedDisplay');
  if(el) return parseFloat(String(el.innerText).replace(/[^\d\.]/g,''))||0;
  return 0;
}
function readUploadMbps(){
  var bytes = nativeCall('DtGetNetworkUploadBytes');
  if(typeof bytes === 'number') return Math.round(bytes/(1024*1024)*10)/10;
  var el = document.getElementById('uploadSpeedDisplay');
  if(el) return parseFloat(String(el.innerText).replace(/[^\d\.]/g,''))||0;
  return 0;
}
function getTotalDownloadedBytes(){ var v = nativeCall('DtGetNetworkDownloadBytes'); return typeof v === 'number' ? v : null; }
function getTotalUploadedBytes(){ var v = nativeCall('DtGetNetworkUploadBytes'); return typeof v === 'number' ? v : null; }
function getLocalConfigVersion(){ var v = nativeCall('DtGetLocalConfigVersion'); return typeof v === 'string' ? v : null; }
function getNetworkName(){
  var n = nativeCall('DtGetNetworkName');
  if(n) return n;
  var nd = nativeCall('DtGetNetworkData');
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
  var el = document.getElementById('username');
  if(el) return el.value || el.innerText || '';
  return localStorage.getItem('username') || '';
}
function getCurrentServerName(){
  try{
    var cfg = nativeCall('DtGetDefaultConfig');
    if(cfg && typeof cfg === 'object') return cfg.name || cfg.title || cfg.plan || null;
  }catch(e){}
  var el = document.querySelector('.server-title-stats, .server-name-accordion, .server-title, #currentPlanNamePanel');
  if(el) return (el.innerText||'').trim();
  return null;
}
function updateMetricHistory(name,ping,down,up){
  try{
    if(!name) return;
    STATE.metricHistory[name] = STATE.metricHistory[name] || [];
    STATE.metricHistory[name].push({ ping: ping, down: down, up: up, ts: now() });
    if(STATE.metricHistory[name].length > CFG.metricHistoryMax) STATE.metricHistory[name] = STATE.metricHistory[name].slice(-CFG.metricHistoryMax);
    persistMetricHistory();
  }catch(e){}
}
function analyzeTrends(name){
  try{
    var h = STATE.metricHistory[name] || [];
    if(h.length < 2) return { pingRise: 0, downDrop: 0, trend: 0 };
    var pingRise = 0, downDrop = 0;
    for(var i=1;i<h.length;i++){
      if(h[i].ping>-1 && h[i-1].ping>-1) pingRise += (h[i].ping - h[i-1].ping);
      if(h[i-1].down>0) downDrop += (h[i-1].down - h[i].down)/h[i-1].down;
    }
    var pingRiseAvg = pingRise/(h.length-1);
    var downDropAvg = downDrop/(h.length-1);
    var trend = Math.round(pingRiseAvg);
    return { pingRise: pingRiseAvg, downDrop: downDropAvg, trend: trend };
  }catch(e){ return { pingRise:0, downDrop:0, trend:0 }; }
}
function qualityScoreFromMetrics(ping,down,up){
  try{
    var pingScore = (ping<=0||ping===-1)?0:Math.max(0,1-Math.min(ping,1000)/600);
    var downScore = Math.min(1,(down/20));
    var upScore = Math.min(1,(up/5));
    var raw = (pingScore*0.5 + downScore*0.35 + upScore*0.15);
    return Math.max(1,Math.min(10,Math.round(raw*9)+1));
  }catch(e){ return 1; }
}
function formatBytes(b){
  if(b===null||b===undefined) return '—';
  if(b<1024) return b+' B';
  if(b<1024*1024) return Math.round(b/1024)+' KB';
  if(b<1024*1024*1024) return Math.round(b/(1024*1024)*10)/10+' MB';
  return Math.round(b/(1024*1024*1024)*10)/10+' GB';
}
function shortId(){ return Math.random().toString(36).slice(2,10); }
function nowISO(){ return new Date().toISOString(); }
var TELEGRAM = window.AVSUPER_TELEGRAM || {};
TELEGRAM.minIntervalMs = TELEGRAM.minIntervalMs || CFG.telegramMinIntervalMs;
var tgQueue = [];
var tgSending = false;
async function sendTelegramRaw(text, critical){
  try{
    if(!TELEGRAM.token || !TELEGRAM.chatId) return false;
    var nowTs = now();
    var minInterval = critical ? (TELEGRAM.criticalMinIntervalMs || CFG.telegramCriticalMinIntervalMs) : (TELEGRAM.minIntervalMs || CFG.telegramMinIntervalMs);
    var elapsed = nowTs - (STATE.lastTelegramSent || 0);
    if(elapsed < minInterval){
      var wait = minInterval - elapsed + 200;
      await sleep(wait);
    }
    var resp = await fetch('https://api.telegram.org/bot'+TELEGRAM.token+'/sendMessage',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: TELEGRAM.chatId, text: text, parse_mode: 'HTML' })
    });
    STATE.lastTelegramSent = now();
    return resp && resp.ok;
  }catch(e){ return false; }
}
function enqueueTelegram(msg, critical){
  try{
    tgQueue.push({ msg: msg, critical: !!critical });
    if(!tgSending) processTgQueue();
  }catch(e){}
}
async function processTgQueue(){
  tgSending = true;
  while(tgQueue.length){
    var item = tgQueue.shift();
    var ok = await sendTelegramRaw(item.msg, item.critical);
    if(!ok){
      tgQueue.unshift(item);
      await sleep(2000);
    }else{
      await sleep(400);
    }
  }
  tgSending = false;
}
function persistQueue(){ try{ localStorage.setItem(CFG.queueKey, JSON.stringify(STATE.queue||[])); }catch(e){} }
function restoreQueue(){ try{ STATE.queue = safeJsonParse(localStorage.getItem(CFG.queueKey), []); }catch(e){ STATE.queue = []; } }
function persistAutolog(){ try{ localStorage.setItem(CFG.autologKey, JSON.stringify(STATE.autolog||[])); }catch(e){} }
function restoreAutolog(){ try{ STATE.autolog = safeJsonParse(localStorage.getItem(CFG.autologKey), []); }catch(e){ STATE.autolog = []; } }
function persistMetricHistory(){ try{ localStorage.setItem(CFG.metricHistoryKey, JSON.stringify(STATE.metricHistory||{})); }catch(e){} }
function restoreMetricHistory(){ try{ STATE.metricHistory = safeJsonParse(localStorage.getItem(CFG.metricHistoryKey), {}); }catch(e){ STATE.metricHistory = {}; } }
function persistBestBackup(){ try{ if(STATE.bestBackupServer) localStorage.setItem(CFG.bestBackupKey, STATE.bestBackupServer); }catch(e){} }
function restoreBestBackup(){ try{ var v = localStorage.getItem(CFG.bestBackupKey); if(v) STATE.bestBackupServer = v; }catch(e){} }
async function deliverReportDirect(payload, pretty, critical){
  try{
    enqueueTelegram(pretty, !!critical);
    STATE.queue.push({ ts: nowISO(), payload: payload });
    persistQueue();
  }catch(e){}
}
async function flushQueue(){
  try{
    restoreQueue();
    while(STATE.queue && STATE.queue.length){
      var item = STATE.queue[0];
      var pretty = formatHtmlFromPayload(item.payload, 'Relatório (reenvio)');
      var ok = await sendTelegramRaw(pretty, false);
      if(ok){
        STATE.queue.shift();
        persistQueue();
        await sleep(300);
      }else{
        break;
      }
    }
  }catch(e){}
}
function buildShortActionsSummary(limit){ try{ var a = (STATE.autolog||[]).slice(0,limit||5).map(function(x){ return (x.t?x.t.split('T')[1].split('.')[0]:'') + ' ' + (x.m||''); }); return a.join(' | ') || '-'; }catch(e){ return '-'; } }
function buildSuggestion(metrics){ try{ if(!metrics) return '—'; if(metrics.ping === -1) return 'Sem conectividade detectada. Verificar rede local (Wi-Fi / Mobile) e reiniciar a conexão.'; if(metrics.ping > 800) return 'Alta latência. Tentar trocar para servidor sugerido ou reiniciar Wi-Fi.'; if((metrics.down||0) < 0.5) return 'Baixa largura de banda. Verificar rede ISP ou alternar para outra rede.'; return 'Nenhuma ação imediata necessária. Abrir suporte se persistir.'; }catch(e){ return '—'; } }
function formatHtmlFromPayload(p, tipo){
  try{
    var severity = p.severity || 'info';
    var trendSign = (p.trend && p.trend !== 0) ? (p.trend > 0 ? '+'+Math.round(p.trend) : String(Math.round(p.trend))) : '0';
    var actions = buildShortActionsSummary(5);
    var lines = [
      '📡 <b>AVSuper — '+(tipo||'Relatório')+'</b>',
      '<b>Hora:</b> '+(p.ts||nowISO()),
      '<b>Usuário:</b> '+(p.user||'—'),
      '<b>Servidor:</b> '+(p.server && (p.server.category ? p.server.category + ' → ' + p.server.name : p.server.name) || p.serverName || '—'),
      '<b>IP:</b> '+(p.network && p.network.localIp||'—'),
      '<b>Rede:</b> '+(p.network && p.network.name||'—')+' • <b>App:</b> '+(p.app||'—'),
      '<b>Ping:</b> '+(p.metrics && p.metrics.ping===-1?'-':(p.metrics && p.metrics.ping+' ms'))+' • <b>Qualidade:</b> '+(p.quality||'—')+'/10 <b>(trend:</b> '+trendSign+' )',
      '<b>Download:</b> '+(p.metrics && p.metrics.down||0)+' Mbps • <b>Upload:</b> '+(p.metrics && p.metrics.up||0)+' Mbps',
      '<b>Bytes (D/U):</b> '+(formatBytes(p.bytes && p.bytes.down))+' / '+(formatBytes(p.bytes && p.bytes.up)),
      '<b>Config:</b> '+(p.configVersion||'—')+' • <b>Device:</b> '+(p.deviceId||'—'),
      '<b>Ações automáticas (ult.):</b> '+actions,
      '<b>Sugestão:</b> '+(p.suggestion||'—'),
      '<code>requestId: '+(p.requestId||'—')+'</code>'
    ];
    return lines.join('\n');
  }catch(e){ return 'Erro formatando mensagem'; }
}
var ACTION_LOCK = false;
async function withActionLock(fn){ if(ACTION_LOCK) return false; ACTION_LOCK = true; try{ var out = await fn(); ACTION_LOCK = false; return out; }catch(e){ ACTION_LOCK = false; return false; } }
async function rotateDns(serverName){
  return withActionLock(async function(){
    try{
      if(now() < (STATE.dnsCacheUntil||0)) return false;
      for(var i=0;i<CFG.dnsServers.length;i++){
        var p = CFG.dnsServers[i][0], s = CFG.dnsServers[i][1], k = CFG.dnsServers[i][2];
        try{ if(typeof window.DtSetDns === 'object' && typeof window.DtSetDns.execute === 'function'){ window.DtSetDns.execute(p,s,k); } else if(typeof window.dtSetDns === 'function'){ window.dtSetDns(p,s,k); } }catch(e){}
        await sleep(CFG.actionCooldownMs + Math.floor(Math.random()*600));
        var ping = readPing(), down = readDownloadMbps();
        if(ping > -1 && down > 0){
          STATE.dnsCacheUntil = now() + CFG.actionCooldownMs;
          STATE.actionHistory[serverName] = STATE.actionHistory[serverName] || {};
          STATE.actionHistory[serverName].lastDns = now();
          STATE.autolog.unshift({ t: nowISO(), m: 'DNS aplicado '+p+'/'+s+' ('+k+')' });
          persistAutolog();
          var payload = { requestId: shortId(), ts: nowISO(), user: getUsername(), deviceId: getDeviceId(), server: { name: serverName }, network: { name: getNetworkName(), localIp: getLocalIP() }, metrics: { ping: readPing(), down: readDownloadMbps(), up: readUploadMbps() }, bytes: { down: getTotalDownloadedBytes(), up: getTotalUploadedBytes() }, configVersion: getLocalConfigVersion(), actions: [{ t: nowISO(), action: 'rotateDns', result: 'ok', detail: p+'/'+s+' ('+k+')' }] };
          var pretty = formatHtmlFromPayload({ ts: payload.ts, requestId: payload.requestId, user: payload.user, deviceId: payload.deviceId, server: payload.server, network: payload.network, metrics: payload.metrics, bytes: payload.bytes, configVersion: payload.configVersion, quality: qualityScoreFromMetrics(payload.metrics.ping,payload.metrics.down,payload.metrics.up), app: (nativeCall('DtGetForegroundApp')||''), suggestion: 'DNS alterado automaticamente', trend: 0 }, 'DNS Alterado');
          await deliverReportDirect(payload, pretty, false);
          return true;
        }
      }
      STATE.dnsCacheUntil = now() + 60000;
      return false;
    }catch(e){ return false; }
  });
}
async function mtuAdjust(){
  return withActionLock(async function(){
    try{
      var originalMTU = 1500;
      for(var i=0;i<CFG.mtuCandidates.length;i++){
        var mtu = CFG.mtuCandidates[i];
        try{ if(typeof window.DtSetMTU === 'object' && typeof window.DtSetMTU.execute === 'function'){ window.DtSetMTU.execute(mtu); } else if(typeof window.dtSetMTU === 'function'){ window.dtSetMTU(mtu); } }catch(e){}
        await sleep(3000);
        var ping = readPing(), down = readDownloadMbps();
        if(ping > -1 && down > 0){
          STATE.actionHistory[getCurrentServerName()||'unknown'] = STATE.actionHistory[getCurrentServerName()||'unknown'] || {};
          STATE.actionHistory[getCurrentServerName()||'unknown'].lastMtu = now();
          STATE.autolog.unshift({ t: nowISO(), m: 'MTU ajustado '+mtu });
          persistAutolog();
          var payload = { requestId: shortId(), ts: nowISO(), user: getUsername(), deviceId: getDeviceId(), server: { name: getCurrentServerName() }, network: { name: getNetworkName(), localIp: getLocalIP() }, metrics: { ping: readPing(), down: readDownloadMbps(), up: readUploadMbps() }, bytes: { down: getTotalDownloadedBytes(), up: getTotalUploadedBytes() }, configVersion: getLocalConfigVersion(), actions: [{ t: nowISO(), action: 'mtuAdjust', result: 'ok', detail: String(mtu) }] };
          var pretty = formatHtmlFromPayload({ ts: payload.ts, requestId: payload.requestId, user: payload.user, deviceId: payload.deviceId, server: payload.server, network: payload.network, metrics: payload.metrics, bytes: payload.bytes, configVersion: payload.configVersion, quality: qualityScoreFromMetrics(payload.metrics.ping,payload.metrics.down,payload.metrics.up), app: (nativeCall('DtGetForegroundApp')||''), suggestion: 'MTU ajustado automaticamente', trend: 0 }, 'MTU Ajustado');
          await deliverReportDirect(payload, pretty, false);
          return true;
        }
      }
      try{ if(typeof window.DtSetMTU === 'object' && typeof window.DtSetMTU.execute === 'function'){ window.DtSetMTU.execute(originalMTU); } else if(typeof window.dtSetMTU === 'function'){ window.dtSetMTU(originalMTU); } }catch(e){}
      return false;
    }catch(e){ return false; }
  });
}
async function prewarm(server){
  try{
    if(!server) return false;
    var host = String(server).toLowerCase().replace(/[\s\{\}\[\]\(\)]/g,'').replace(/[^a-z0-9\-]/g,'');
    var url = 'https://'+host+CFG.serverPrewarmEndpointHostSuffix+'/health';
    try{ await Promise.race([fetch(url,{cache:'no-store',mode:'no-cors'}), new Promise(function(_,r){ setTimeout(function(){ r('t'); },1200); })]); return true; }catch(e){ return false; }
  }catch(e){ return false; }
}
async function switchToServer(name){
  return withActionLock(async function(){
    try{
      if(!name) return false;
      STATE.autolog.unshift({ t: nowISO(), m: 'Solicitada troca para '+name });
      persistAutolog();
      if(typeof window.DtSetConfig === 'object' && typeof window.DtSetConfig.execute === 'function'){
        try{
          var configs = nativeCall('DtGetConfigs') || [];
          for(var i=0;i<configs.length;i++){
            var cat = configs[i];
            if(!cat || !Array.isArray(cat.items)) continue;
            for(var j=0;j<cat.items.length;j++){
              var item = cat.items[j];
              if(!item) continue;
              var itemName = String(item.name||item.title||'').toLowerCase();
              if(item.id === name || item.configId === name || itemName === String(name||'').toLowerCase() || itemName.indexOf(String(name||'').toLowerCase()) !== -1){
                try{ window.DtSetConfig.execute(item.id || item.configId || item.id); var payload = { requestId: shortId(), ts: nowISO(), user: getUsername(), deviceId: getDeviceId(), server: { id: item.id, name: item.name }, actions: [{ t: nowISO(), action: 'setConfig', result: 'requested', detail: item.id }] }; var pretty = formatHtmlFromPayload({ ts: payload.ts, requestId: payload.requestId, user: payload.user, deviceId: payload.deviceId, server: payload.server, network: { name: getNetworkName(), localIp: getLocalIP() }, metrics: { ping: readPing(), down: readDownloadMbps(), up: readUploadMbps() }, bytes: { down: getTotalDownloadedBytes(), up: getTotalUploadedBytes() }, configVersion: getLocalConfigVersion(), quality: qualityScoreFromMetrics(readPing(),readDownloadMbps(),readUploadMbps()), app: nativeCall('DtGetForegroundApp')||'', suggestion: 'Troca de servidor solicitada' }, 'Troca Solicitada'); await deliverReportDirect(payload, pretty, false); return true; }catch(e){}
              }
            }
          }
        }catch(e){}
      }
      try{
        var candidateEl = Array.prototype.slice.call(document.querySelectorAll('[data-server-raw],[data-server]')).find(function(el){
          var dsr = el.getAttribute('data-server-raw')||el.getAttribute('data-server')||'';
          var text = (el.innerText||'')+'';
          return dsr===name || text.indexOf(name) !== -1;
        });
        if(candidateEl){ try{ candidateEl.click(); STATE.autolog.unshift({ t: nowISO(), m: 'Clicou em elemento servidor para '+name }); persistAutolog(); return true; }catch(e){} }
      }catch(e){}
      return false;
    }catch(e){ return false; }
  });
}
async function shortlist(){
  var out = [];
  try{
    var lastGood = safeJsonParse(localStorage.getItem('av_last_good')||'[]',[]);
    if(lastGood && lastGood.forEach) lastGood.forEach(function(x){ if(!out.includes(x.n)) out.push(x.n); });
    var favs = safeJsonParse(localStorage.getItem('av_favorites')||'[]',[]);
    if(favs && favs.forEach) favs.forEach(function(x){ if(!out.includes(x.n)) out.push(x.n); });
    var els = document.querySelectorAll('.server-name-accordion, .server-title-stats, .server-title, .server-item, [data-server], .server-name');
    for(var i=0;i<els.length;i++){ var t = (els[i].innerText||'').trim(); if(t && !out.includes(t)) out.push(t); }
  }catch(e){}
  return Array.from(new Set(out)).slice(0,40);
}
async function testLatency(servers){
  var out = {};
  for(var i=0;i<Math.min(servers.length,CFG.serverPrewarmCandidates);i++){
    var server = servers[i];
    var host = server.toLowerCase().replace(/[\s\{\}\[\]\(\)]/g,'').replace(/[^a-z0-9\-]/g,'');
    var url = 'https://'+host+CFG.serverPrewarmEndpointHostSuffix+'/ping?ts='+Date.now();
    var t0 = performance.now();
    try{ await Promise.race([fetch(url,{cache:'no-store',mode:'no-cors'}), new Promise(function(_,r){ setTimeout(function(){ r('t'); },1200); })]); out[server] = Math.round(performance.now()-t0); }catch(e){ out[server] = Infinity; }
    await sleep(220);
  }
  return out;
}
async function chooseAndSwitchBest(){
  return withActionLock(async function(){
    try{
      var pool = await shortlist();
      if(!pool.length) return null;
      var lat = await testLatency(pool.slice(0,12));
      var ordered = Object.keys(lat).sort(function(a,b){ return (lat[a]||Infinity)-(lat[b]||Infinity); });
      var best = ordered[0];
      if(best){
        await prewarm(best);
        await switchToServer(best);
        STATE.autolog.unshift({ t: nowISO(), m: 'Escolhido fallback por latência: '+best });
        persistAutolog();
        var payload = { requestId: shortId(), ts: nowISO(), user: getUsername(), deviceId: getDeviceId(), server: { name: best }, actions: [{ t: nowISO(), action: 'chooseAndSwitchBest', result: 'requested', detail: best }] };
        var pretty = formatHtmlFromPayload({ ts: payload.ts, requestId: payload.requestId, user: payload.user, deviceId: payload.deviceId, server: payload.server, network: { name: getNetworkName(), localIp: getLocalIP() }, metrics: { ping: readPing(), down: readDownloadMbps(), up: readUploadMbps() }, bytes: { down: getTotalDownloadedBytes(), up: getTotalUploadedBytes() }, configVersion: getLocalConfigVersion(), quality: qualityScoreFromMetrics(readPing(),readDownloadMbps(),readUploadMbps()), app: nativeCall('DtGetForegroundApp')||'', suggestion: 'Escolha automática por latência' }, 'Escolha Automática');
        await deliverReportDirect(payload, pretty, false);
        return best;
      }
    }catch(e){}
    return null;
  });
}
async function predictiveRemedy(name){
  try{
    var trends = analyzeTrends(name);
    if(trends.pingRise > CFG.predictiveThresholds.pingRiseRate || trends.downDrop > CFG.predictiveThresholds.downDropRate){
      STATE.autolog.unshift({ t: nowISO(), m: 'Tendência de degradação detectada em '+name });
      persistAutolog();
      var payload = { requestId: shortId(), ts: nowISO(), user: getUsername(), deviceId: getDeviceId(), server: { name: name }, network: { name: getNetworkName(), localIp: getLocalIP() }, metrics: { ping: readPing(), down: readDownload Mbps() }, bytes: { down: getTotalDownloadedBytes(), up: getTotalUploadedBytes() }, configVersion: getLocalConfigVersion(), actions: [] };
      var pretty = formatHtmlFromPayload({ ts: payload.ts, requestId: payload.requestId, user: payload.user, deviceId: payload.deviceId, server: payload.server, network: payload.network, metrics: payload.metrics, bytes: payload.bytes, configVersion: payload.configVersion, quality: qualityScoreFromMetrics(payload.metrics.ping,payload.metrics.down,payload.metrics.up), app: nativeCall('DtGetForegroundApp')||'', suggestion: 'Iniciando remediação preventiva', trend: trends.trend }, 'Previsão de Problema');
      await deliverReportDirect(payload, pretty, true);
      var remedied = await rotateDns(name);
      if(!remedied) remedied = await mtuAdjust();
      if(!remedied){ var best = await chooseAndSwitchBest(); if(best){ STATE.autolog.unshift({ t: nowISO(), m: 'Switch preventivo para '+best }); persistAutolog(); } }
      return true;
    }
  }catch(e){}
  return false;
}
function checkActionBudget(){ var hour = new Date().getHours(); if(hour !== STATE.lastActionHour){ STATE.lastActionHour = hour; STATE.actionsThisHour = 0; } if((STATE.actionsThisHour||0) >= CFG.maxActionsPerHour) return false; STATE.actionsThisHour = (STATE.actionsThisHour||0) + 1; return true; }
async function smartAutoConnect(){ if(STATE.isAutoConnecting) return; if(now() < (STATE.circuitOpenUntil||0)) return; STATE.isAutoConnecting = true; STATE.autolog.unshift({ t: nowISO(), m: 'Auto-connect iniciado' }); persistAutolog(); var pool = (await shortlist()).slice(0,12); if(!pool.length){ STATE.isAutoConnecting = false; return; } var lat = await testLatency(pool); var scores = {}; for(var i=0;i<pool.length;i++){ var s = pool[i]; var hist = (STATE.metricHistory[s] && STATE.metricHistory[s].length) ? STATE.metricHistory[s].reduce(function(a,c){ return a+c.down; },0)/STATE.metricHistory[s].length : 0; var p = lat[s] || Infinity; var score = 0; if(p !== Infinity) score += 10000/Math.max(1,p); score += hist*10; if(STATE.bestBackupServer === s) score *= 1.05; scores[s] = score; } var ordered = Object.keys(scores).sort(function(a,b){ return scores[b]-scores[a]; }); var attempts = 0; for(var j=0;j<ordered.length;j++){ var candidate = ordered[j]; if(attempts++ > 6) break; if(Date.now() - STATE.lastUserActivity < 3000) break; var warmed = await prewarm(candidate); if(!warmed) STATE.autolog.unshift({ t: nowISO(), m: 'Pré-aquecimento falhou '+candidate }); await switchToServer(candidate); var ok = await waitForCondition(function(){ return (getVpnState()==='CONNECTED') || (readPing()>-1 && readDownloadMbps()>0); }, 9000); if(ok){ STATE.autolog.unshift({ t: nowISO(), m: 'Auto-connect: conectado em '+candidate }); persistAutolog(); var payload = { requestId: shortId(), ts: nowISO(), user: getUsername(), deviceId: getDeviceId(), server: { name: candidate }, actions: [{ t: nowISO(), action: 'autoConnect', result: 'ok', detail: candidate }] }; var pretty = formatHtmlFromPayload({ ts: payload.ts, requestId: payload.requestId, user: payload.user, deviceId: payload.deviceId, server: payload.server, network: { name: getNetworkName(), localIp: getLocalIP() }, metrics: { ping: readPing(), down: readDownloadMbps(), up: readUploadMbps() }, bytes: { down: getTotalDownloadedBytes(), up: getTotalUploadedBytes() }, configVersion: getLocalConfigVersion(), quality: qualityScoreFromMetrics(readPing(),readDownloadMbps(),readUploadMbps()), app: nativeCall('DtGetForegroundApp')||'', suggestion: 'Auto-connect bem sucedido' }, 'Auto-Connect'); await deliverReportDirect(payload, pretty, false); STATE.isAutoConnecting = false; return; } } STATE.circuitOpenUntil = now() + 30000; STATE.autolog.unshift({ t: nowISO(), m: 'Auto-connect não obteve sucesso' }); persistAutolog(); var msg = formatHtmlFromPayload({ ts: nowISO(), requestId: shortId(), user: getUsername(), deviceId: getDeviceId(), server: { name: getCurrentServerName() }, network: { name: getNetworkName(), localIp: getLocalIP() }, metrics: { ping: readPing(), down: readDownloadMbps(), up: readUploadMbps() }, bytes: { down: getTotalDownloadedBytes(), up: getTotalUploadedBytes() }, configVersion: getLocalConfigVersion(), quality: qualityScoreFromMetrics(readPing(),readDownloadMbps(),readUploadMbps()), app: nativeCall('DtGetForegroundApp')||'', suggestion: 'Auto-connect falhou' }, 'Auto-Connect Falhou'); enqueueTelegram(msg, true); STATE.isAutoConnecting = false; }
function waitForCondition(fn, timeout, interval){ timeout = timeout || 5000; interval = interval || 400; return new Promise(function(resolve){ var start = Date.now(); var id = setInterval(function(){ try{ if(fn()){ clearInterval(id); resolve(true); } else if(Date.now()-start > timeout){ clearInterval(id); resolve(false); } }catch(e){ clearInterval(id); resolve(false); } }, interval); }); }
async function checkAndRecover(){ try{ var state = getVpnState(); var ping = readPing(), down = readDownloadMbps(), up = readUploadMbps(); var bad = (ping===-1 || ping>500 || down<0.5 || up<0.2); if(state !== 'CONNECTED' || bad){ STATE.autolog.unshift({ t: nowISO(), m: 'Recuperação: state='+state+' ping='+ping+' down='+down }); persistAutolog(); STATE.reconnectionAttempts++; if(!checkActionBudget()) return; if(now() < (STATE.circuitOpenUntil||0)) return; if(state !== 'CONNECTED' && STATE.bestBackupServer && STATE.bestBackupServer !== getCurrentServerName()){ await prewarm(STATE.bestBackupServer); await switchToServer(STATE.bestBackupServer); await sleep(1400); if(getVpnState() === 'CONNECTED'){ STATE.autolog.unshift({ t: nowISO(), m: 'Reconectado via backup '+STATE.bestBackupServer }); persistAutolog(); var payload = { requestId: shortId(), ts: nowISO(), user: getUsername(), deviceId: getDeviceId(), server: { name: STATE.bestBackupServer }, actions: [{ t: nowISO(), action: 'autoRecovery', result: 'ok', detail: STATE.bestBackupServer }] }; var pretty = formatHtmlFromPayload({ ts: payload.ts, requestId: payload.requestId, user: payload.user, deviceId: payload.deviceId, server: payload.server, network: { name: getNetworkName(), localIp: getLocalIP() }, metrics: { ping: readPing(), down: readDownloadMbps(), up: readUploadMbps() }, bytes: { down: getTotalDownloadedBytes(), up: getTotalUploadedBytes() }, configVersion: getLocalConfigVersion(), quality: qualityScoreFromMetrics(readPing(),readDownloadMbps(),readUploadMbps()), app: nativeCall('DtGetForegroundApp')||'', suggestion: 'Reconectado via backup' }, 'Auto-Recovery'); await deliverReportDirect(payload, pretty, false); STATE.reconnectionAttempts = 0; return; } } if(STATE.reconnectionAttempts <= CFG.reconnectionBackoff.length){ var delay = CFG.reconnectionBackoff[Math.min(STATE.reconnectionAttempts-1, CFG.reconnectionBackoff.length-1)]; try{ if(typeof window.DtExecuteVpnStart === 'object' && typeof window.DtExecuteVpnStart.execute === 'function'){ window.DtExecuteVpnStart.execute(); STATE.autolog.unshift({ t: nowISO(), m: 'Reiniciando VPN (API)' }); persistAutolog(); } else if(typeof window.dtStartVpn === 'function'){ window.dtStartVpn(); STATE.autolog.unshift({ t: nowISO(), m: 'Reiniciando VPN (global)' }); persistAutolog(); } else STATE.autolog.unshift({ t: nowISO(), m: 'Reinício VPN solicitado (sem API)' }); }catch(e){} await sleep(delay); }else{ await rotateDns(getCurrentServerName() || 'unknown'); await sleep(500); await mtuAdjust(); var best = await chooseAndSwitchBest(); if(best){ var payload = { requestId: shortId(), ts: nowISO(), user: getUsername(), deviceId: getDeviceId(), server: { name: best }, actions: [{ t: nowISO(), action: 'advancedRecovery', result: 'ok', detail: best }] }; var pretty = formatHtmlFromPayload({ ts: payload.ts, requestId: payload.requestId, user: payload.user, deviceId: payload.deviceId, server: payload.server, network: { name: getNetworkName(), localIp: getLocalIP() }, metrics: { ping: readPing(), down: readDownloadMbps(), up: readUploadMbps() }, bytes: { down: getTotalDownloadedBytes(), up: getTotalUploadedBytes() }, configVersion: getLocalConfigVersion(), quality: qualityScoreFromMetrics(readPing(),readDownloadMbps(),readUploadMbps()), app: nativeCall('DtGetForegroundApp')||'', suggestion: 'Recuperação avançada aplicada' }, 'Recuperação Avançada'); await deliverReportDirect(payload, pretty, true); } STATE.reconnectionAttempts = 0; } }else{ STATE.reconnectionAttempts = 0; } }catch(e){} }
async function computeBestBackup(){ try{ if(now() - (STATE.lastBestCompute||0) < CFG.bestServerComputeInterval) return; STATE.lastBestCompute = now(); var ops = ['vivo','tim','claro']; var all = await shortlist(); var pool = []; for(var i=0;i<ops.length;i++){ var op = ops[i]; pool = pool.concat(all.filter(function(n){ return (n||'').toLowerCase().indexOf(op) !== -1; }).slice(0,6)); } if(!pool.length) return; var lat = await testLatency(pool); var ordered = Object.keys(lat).sort(function(a,b){ return (lat[a]||Infinity)-(lat[b]||Infinity); }); var best = ordered[0]; if(best && best !== getCurrentServerName()){ STATE.bestBackupServer = best; STATE.autolog.unshift({ t: nowISO(), m: 'Melhor backup computado: '+best }); persistAutolog(); persistBestBackup(); var payload = { requestId: shortId(), ts: nowISO(), user: getUsername(), deviceId: getDeviceId(), server: { name: best }, actions: [{ t: nowISO(), action: 'computeBestBackup', result: 'computed', detail: best }] }; var pretty = formatHtmlFromPayload({ ts: payload.ts, requestId: payload.requestId, user: payload.user, deviceId: payload.deviceId, server: payload.server, network: { name: getNetworkName(), localIp: getLocalIP() }, metrics: { ping: readPing(), down: readDownloadMbps(), up: readUploadMbps() }, bytes: { down: getTotalDownloadedBytes(), up: getTotalUploadedBytes() }, configVersion: getLocalConfigVersion(), quality: qualityScoreFromMetrics(readPing(),readDownloadMbps(),readUploadMbps()), app: nativeCall('DtGetForegroundApp')||'', suggestion: 'Melhor backup computado' }, 'Backup Computado'); await deliverReportDirect(payload, pretty, false); } }catch(e){} }
async function preCacheDomains(list){ try{ var head = document.head || document.documentElement; var uniq = Array.from(new Set(list)).slice(0,30); for(var i=0;i<uniq.length;i++){ var host = uniq[i]; if(!document.querySelector('link[data-pref="'+host+'"]')){ var l1 = document.createElement('link'); l1.rel = 'dns-prefetch'; l1.href = '//'+host; l1.setAttribute('data-pref', host); head.appendChild(l1); var l2 = document.createElement('link'); l2.rel = 'preconnect'; l2.href = 'https://'+host; l2.crossOrigin = 'anonymous'; l2.setAttribute('data-pref', host); head.appendChild(l2); } } for(var j=0;j<Math.min(uniq.length,6);j++){ try{ await fetch('https://'+uniq[j]+'/favicon.ico',{ method:'HEAD', cache:'no-store', mode:'no-cors' }); }catch(e){} } }catch(e){} }
function persistAutolog(){ try{ localStorage.setItem(CFG.autologKey, JSON.stringify(STATE.autolog||[])); }catch(e){} }
function persistMetricHistory(){ try{ localStorage.setItem(CFG.metricHistoryKey, JSON.stringify(STATE.metricHistory||{})); }catch(e){} }
function persistBestBackup(){ try{ if(STATE.bestBackupServer) localStorage.setItem(CFG.bestBackupKey, STATE.bestBackupServer); }catch(e){} }
function persistQueue(){ try{ localStorage.setItem(CFG.queueKey, JSON.stringify(STATE.queue||[])); }catch(e){} }
function restoreAutolog(){ try{ STATE.autolog = safeJsonParse(localStorage.getItem(CFG.autologKey), []); }catch(e){ STATE.autolog = []; } }
function restoreMetricHistory(){ try{ STATE.metricHistory = safeJsonParse(localStorage.getItem(CFG.metricHistoryKey), {}); }catch(e){ STATE.metricHistory = {}; } }
function restoreBestBackup(){ try{ var v = localStorage.getItem(CFG.bestBackupKey); if(v) STATE.bestBackupServer = v; }catch(e){} }
function restoreQueue(){ try{ STATE.queue = safeJsonParse(localStorage.getItem(CFG.queueKey), []); }catch(e){ STATE.queue = []; } }
async function deliverReportInit(){
  try{
    var r = await buildReport('AVSuper Silent Iniciado','Modo invisível ativo. Relatórios serão enviados ao Telegram.');
    var pretty = formatHtmlFromPayload(r.payload, 'AVSuper Silent Iniciado');
    await deliverReportDirect(r.payload, pretty, false);
  }catch(e){}
}
async function periodic(){
  try{
    var curServer = getCurrentServerName() || 'unknown';
    var ping = readPing(), down = readDownloadMbps(), up = readUploadMbps();
    updateMetricHistory(curServer,ping,down,up);
    try{ await computeBestBackup(); }catch(e){}
    try{ await predictiveRemedy(curServer); }catch(e){}
    try{ if(now() > (STATE.dnsCacheUntil||0)) await rotateDns(curServer); }catch(e){}
    try{ await preCacheDomains(CFG.dnsPrefetchList); }catch(e){}
    try{ await backgroundUpdateCheck(); }catch(e){}
    try{ if((getVpnState()!=='CONNECTED') || ping===-1 || down<0.5) await checkAndRecover(); }catch(e){}
    try{ if(now() - (STATE.lastHealthSent||0) > CFG.healthReportIntervalMs){ var report = await buildReport('Relatório de Saúde','Relatório periódico de saúde'); var pretty = formatHtmlFromPayload(report.payload, 'Relatório de Saúde'); await deliverReportDirect(report.payload, pretty, false); STATE.lastHealthSent = now(); } }catch(e){}
    try{ await autoHealCurrentServer(); }catch(e){}
    STATE.autolog = (STATE.autolog||[]).slice(0,300);
    persistAutolog();
  }catch(e){}
  var bw = (readDownloadMbps()+readUploadMbps())/2;
  var next = (bw < 0.2) ? CFG.monitorIntervalLowBW : CFG.monitorInterval;
  setTimeout(periodic, next + Math.floor(Math.random()*CFG.monitorRandomJitter));
}
async function buildReport(type, details){
  try{
    var requestId = shortId();
    var ts = nowISO();
    var user = getUsername() || '—';
    var deviceId = getDeviceId() || '—';
    var serverInfo = await getSelectedServerInfo();
    var serverName = serverInfo && serverInfo.name ? serverInfo.name : getCurrentServerName();
    var networkName = getNetworkName();
    var localIp = getLocalIP();
    var ping = readPing();
    var down = readDownloadMbps();
    var up = readUploadMbps();
    var cfgVersion = getLocalConfigVersion() || '—';
    var totalDownBytes = getTotalDownloadedBytes();
    var totalUpBytes = getTotalUploadedBytes();
    var app = nativeCall('DtGetForegroundApp') || '';
    var trendObj = analyzeTrends(serverName||'');
    var quality = qualityScoreFromMetrics(ping,down,up);
    var severity = (ping===-1 || ping>1000 || down<0.2) ? 'critical' : (ping>500 || down<0.5 ? 'warn' : 'info');
    var payload = {
      requestId: requestId,
      ts: ts,
      user: user,
      deviceId: deviceId,
      server: serverInfo && serverInfo.name ? serverInfo : { name: serverName || '—' },
      serverName: serverName || '—',
      network: { name: networkName, localIp: localIp },
      metrics: { ping: ping, down: down, up: up },
      bytes: { down: totalDownBytes, up: totalUpBytes },
      configVersion: cfgVersion,
      app: app,
      quality: quality,
      trend: trendObj.trend || 0,
      severity: severity,
      actions: (STATE.autolog||[]).slice(0,20),
      details: details || '',
      suggestion: buildSuggestion({ ping: ping, down: down, up: up })
    };
    return { requestId: requestId, payload: payload };
  }catch(e){ return { requestId: shortId(), payload: { requestId: shortId(), ts: nowISO(), error: 'erro building report' } }; }
}
function persistAll(){ try{ persistAutolog(); persistMetricHistory(); persistBestBackup(); persistQueue(); }catch(e){} }
restoreAutolog(); restoreMetricHistory(); restoreBestBackup(); restoreQueue();
setInterval(function(){ persistAll(); flushQueue(); }, 30000);
setTimeout(function(){ periodic(); }, 1500 + Math.floor(Math.random()*1000));
setTimeout(function(){ deliverReportInit(); }, 4000);
window.AVSUPER_SILENT = { buildReport: buildReport, deliverReportDirect: deliverReportDirect, rotateDns: rotateDns, mtuAdjust: mtuAdjust, prewarm: prewarm, chooseAndSwitchBest: chooseAndSwitchBest, smartAutoConnect: smartAutoConnect, computeBestBackup: computeBestBackup, flushQueue: flushQueue };
})();
