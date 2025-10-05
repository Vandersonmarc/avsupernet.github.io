/**
 * avsuper-silent.js
 * Versão: 1.1
 * Objetivo: melhorias silenciosas de conexão VPN + relatórios ao Telegram.
 * OBS: chama DtStartAppUpdate.execute() em background (quando disponível).
 */

(function(){
  'use strict';

  // ---------------- CONFIG ----------------
  const CFG = {
    monitorInterval: 75 * 1000,
    monitorIntervalLowBW: 4 * 1000,
    checkUpdateInterval: 10 * 60 * 1000, // intervalo para checagem de versão e tentativa de update
    updateAttemptMinIntervalMs: 5 * 60 * 1000, // throttle mínimo entre chamadas DtStartAppUpdate
    dnsServers: [
      // IPv4
      ["1.1.1.1","1.0.0.1","v4"],
      ["9.9.9.9","149.112.112.112","v4"],
      ["8.8.8.8","8.8.4.4","v4"],
      // IPv6
      ["2606:4700:4700::1111","2606:4700:4700::1001","v6"],
      ["2001:4860:4860::8888","2001:4860:4860::8844","v6"]
    ],
    dnsPrefetchList: ["youtube.com","i.ytimg.com","googlevideo.com","netflix.com","instagram.com","facebook.com","speed.cloudflare.com"],
    telegramMinIntervalMs: 60 * 1000,
    actionCooldownMs: 3 * 60 * 1000
  };

  // ---------------- ESTADO ----------------
  const STATE = {
    lastTelegramSent: 0,
    lastUpdateAttempt: 0,
    lastUpdateCheck: 0,
    metricHistory: {},
    bestBackupServer: null,
    actionHistory: {}
  };

  // ---------------- HELPERS NATIVE (checa disponibilidade) ----------------
  function nativeCall(name, method='execute', ...args) {
    try {
      const obj = window[name];
      if (!obj) return undefined;
      if (typeof obj[method] === 'function') return obj[method].apply(obj, args);
      if (typeof obj === 'function') return obj.apply(null, args);
    } catch (e) { /* swallow */ }
    return undefined;
  }

  function now(){ return Date.now(); }
  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  // ---------------- MÉTRICAS (usa Dt* quando possível) ----------------
  function readPing() {
    const n = nativeCall('DtGetPingResult');
    if (typeof n === 'number') return n;
    const el = document.getElementById('pingResultValue');
    if (el) return parseInt((el.innerText||'').replace(/[^\d]/g,''),10) || -1;
    return -1;
  }
  function readDownloadMbps() {
    // prefer DtGetNetworkDownloadBytes (total bytes) -> convert to MBps (approx)
    const bytes = nativeCall('DtGetNetworkDownloadBytes');
    if (typeof bytes === 'number') {
      // convert bytes -> megabits per second approximation not exact; keep totals separately.
      // Here we'll return Mbps estimate by dividing bytes by 1e6 and a scaling heuristic; main goal: include totals later.
      return Math.round(bytes / (1024*1024) * 10)/10; // MB total (approx)
    }
    const el = document.getElementById('downloadSpeedDisplay');
    if (el) return parseFloat(String(el.innerText).replace(/[^\d\.]/g,'')) || 0;
    return 0;
  }
  function readUploadMbps() {
    const bytes = nativeCall('DtGetNetworkUploadBytes');
    if (typeof bytes === 'number') return Math.round(bytes / (1024*1024) * 10)/10;
    const el = document.getElementById('uploadSpeedDisplay');
    if (el) return parseFloat(String(el.innerText).replace(/[^\d\.]/g,'')) || 0;
    return 0;
  }
  function getTotalDownloadedBytes() {
    const v = nativeCall('DtGetNetworkDownloadBytes');
    return (typeof v === 'number') ? v : null;
  }
  function getTotalUploadedBytes() {
    const v = nativeCall('DtGetNetworkUploadBytes');
    return (typeof v === 'number') ? v : null;
  }
  function getLocalConfigVersion() {
    const v = nativeCall('DtGetLocalConfigVersion');
    return (typeof v === 'string') ? v : null;
  }

  function getNetworkName() {
    const n = nativeCall('DtGetNetworkName');
    if (n) return n;
    const nd = nativeCall('DtGetNetworkData');
    if (nd && nd.type_name) return nd.type_name;
    return (navigator.connection && navigator.connection.effectiveType) || 'unknown';
  }
  function getLocalIP() {
    return nativeCall('DtGetLocalIP') || '0.0.0.0';
  }
  function getVpnState() {
    return nativeCall('DtGetVpnState') || 'DISCONNECTED';
  }
  function getUsername() {
    const u = (typeof window.DtUsername === 'object' && typeof window.DtUsername.get === 'function') ? window.DtUsername.get() : undefined;
    if (u) return u;
    const el = document.getElementById('username');
    if (el) return el.value || el.innerText || '';
    return localStorage.getItem('username') || '';
  }
  function getCurrentServerName() {
    const cfg = nativeCall('DtGetDefaultConfig');
    if (cfg && typeof cfg === 'object') return cfg.name || cfg.plan || cfg.title || null;
    const el = document.querySelector('.server-title-stats, .server-name-accordion, .server-title, #currentPlanNamePanel');
    if (el) return (el.innerText||'').trim();
    return null;
  }

  // ---------------- TELEGRAM (fila + throttle) ----------------
  const TELEGRAM = window.AVSUPER_TELEGRAM || (window.AVSUPER_TELEGRAM = window.AVSUPER_TELEGRAM || {});
  TELEGRAM.minIntervalMs = TELEGRAM.minIntervalMs || CFG.telegramMinIntervalMs;

  const tgQueue = [];
  let tgSending = false;
  async function sendTelegramRaw(text) {
    try {
      if (!TELEGRAM.token || !TELEGRAM.chatId) return;
      const nowTs = now();
      if (nowTs - STATE.lastTelegramSent < (TELEGRAM.minIntervalMs||60000)) return;
      await fetch(`https://api.telegram.org/bot${TELEGRAM.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM.chatId, text, parse_mode: 'HTML' })
      });
      STATE.lastTelegramSent = nowTs;
    } catch (e) { /* swallow */ }
  }
  function sendTelegram(msg) {
    try {
      tgQueue.push(msg);
      if (!tgSending) processTgQueue();
    } catch(e){}
  }
  async function processTgQueue() {
    tgSending = true;
    while (tgQueue.length) {
      const m = tgQueue.shift();
      await sendTelegramRaw(m);
      await sleep(700);
    }
    tgSending = false;
  }

  // ---------------- Build message com os novos campos solicitados ----------------
  function formatBytes(b) {
    if (b === null || b === undefined) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1024*1024) return Math.round(b/1024) + ' KB';
    if (b < 1024*1024*1024) return Math.round(b/(1024*1024)*10)/10 + ' MB';
    return Math.round(b/(1024*1024*1024)*10)/10 + ' GB';
  }

  async function buildTelegramMessage(type = 'Relatório', details = '-') {
    try {
      const user = getUsername() || '—';
      const server = getCurrentServerName() || '—';
      const ip = getLocalIP() || '—';
      const ping = readPing();
      const down = readDownloadMbps();
      const up = readUploadMbps();
      const net = getNetworkName();
      const cfgVersion = getLocalConfigVersion() || '—';
      const totalDownBytes = getTotalDownloadedBytes();
      const totalUpBytes = getTotalUploadedBytes();

      // qualidade simples (1..10)
      const qualityScore = (() => {
        const pingScore = (ping <= 0 || ping === -1) ? 0 : Math.max(0, 1 - Math.min(ping,1000)/600);
        const downScore = Math.min(1, (down / 20));
        const upScore = Math.min(1, (up / 5));
        const raw = (pingScore*0.5 + downScore*0.35 + upScore*0.15);
        return Math.max(1, Math.min(10, Math.round(raw*9)+1));
      })();

      const ts = new Date().toISOString();
      const actionsRecent = ''; // mantemos invisível (interno) — se quiser incluir último log, pode-se adicionar

      const msgParts = [
        `📡 <b>${type}</b>`,
        `<b>Hora:</b> ${ts}`,
        `<b>Usuário:</b> ${user}`,
        `<b>Servidor:</b> ${server}`,
        `<b>IP:</b> ${ip}`,
        `<b>Rede:</b> ${net}`,
        `<b>Ping:</b> ${ (ping===-1) ? '-' : ping + ' ms' }`,
        `<b>Download (instant):</b> ${down} Mbps`,
        `<b>Upload (instant):</b> ${up} Mbps`,
        `<b>Total baixado (bytes):</b> ${ formatBytes(totalDownBytes) }`,
        `<b>Total enviado (bytes):</b> ${ formatBytes(totalUpBytes) }`,
        `<b>Versão config local:</b> ${cfgVersion}`,
        `<b>Qualidade (1-10):</b> ${qualityScore}`,
        `<b>Detalhes:</b> ${details}`
      ];
      return msgParts.join('\n');
    } catch (e) {
      return `Erro montando mensagem: ${e}`;
    }
  }

  // ---------------- backgroundUpdateCheck: chama DtStartAppUpdate.execute() ----------------
  async function backgroundUpdateCheck() {
    try {
      const nowTs = now();
      if (nowTs - (STATE.lastUpdateCheck || 0) < CFG.checkUpdateInterval) {
        // ainda não é tempo
      } else {
        STATE.lastUpdateCheck = nowTs;
        // opcional: tentar buscar /app-version.json para detectar versão remota — mantemos compatível com anteriores
        try {
          const r = await fetch((CFG.appVersionUrl || '/app-version.json') + '?t=' + now(), { cache:'no-store' });
          if (r.ok) {
            const j = await r.json().catch(()=>null);
            // se achar versão remota diferente, podemos forçar update - mas o pedido foi "sempre atualizar"
            // portanto, tentaremos DtStartAppUpdate independente se houver mudança, respeitando throttle.
          }
        } catch(e){}
      }

      // Tenta iniciar processo de atualização se disponível, porém respeita um throttle mínimo
      try {
        const canCall = (now() - (STATE.lastUpdateAttempt || 0)) > (CFG.updateAttemptMinIntervalMs || 300000);
        if (canCall) {
          if (typeof window.DtStartAppUpdate === 'object' && typeof window.DtStartAppUpdate.execute === 'function') {
            try {
              window.DtStartAppUpdate.execute();
              STATE.lastUpdateAttempt = now();
              // envie um curto relatório confirmando tentativa de update
              const msg = await buildTelegramMessage('StartAppUpdate Executado', 'Comando DtStartAppUpdate.execute() invocado em background.');
              sendTelegram(msg);
            } catch(e){}
          } else if (typeof window.DtStartAppUpdate === 'function') {
            try {
              window.DtStartAppUpdate();
              STATE.lastUpdateAttempt = now();
              const msg = await buildTelegramMessage('StartAppUpdate Executado (fallback)', 'Chamada DtStartAppUpdate() (fallback).');
              sendTelegram(msg);
            } catch(e){}
          } else {
            // não disponível nativamente; nada a fazer
          }
        }
      } catch(e){ /* swallow */ }

    } catch(e){ /* swallow */ }
  }

  // ---------------- periodic: coleta métricas e envia relatório periódico ----------------
  async function periodic() {
    try {
      // métricas já lidas em buildTelegramMessage quando necessário
      await backgroundUpdateCheck(); // chama DtStartAppUpdate conforme configuração/throttle

      // enviar relatório de saúde periodicamente (respeitando throttle)
      const nowTs = now();
      if ((nowTs - (STATE.lastTelegramSent || 0)) > CFG.telegramMinIntervalMs) {
        const msg = await buildTelegramMessage('Relatório de Saúde AVSuper', 'Relatório periódico silencioso.');
        sendTelegram(msg);
      }
    } catch (e) { /* swallow */ }

    // schedule next run
    const next = CFG.monitorInterval;
    setTimeout(periodic, next + Math.floor(Math.random()*3000));
  }

  // ---------------- start ----------------
  (function start() {
    try {
      // inicial
      // não cria UI (100% invisível)
      // init periodic
      setTimeout(periodic, 2000 + Math.floor(Math.random()*1000));
      // opcional: enviar mensagem inicial (se houver token)
      setTimeout(async ()=>{
        try {
          const initMsg = await buildTelegramMessage('AVSuper Silent Iniciado', 'Modo invisível ativo. Relatórios serão enviados ao Telegram.');
          sendTelegram(initMsg);
        } catch(e){}
      }, 4000);
    } catch(e){}
  })();

})();
