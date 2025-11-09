/* ===========================================================
   AutoRepairManager v4.0 – Enterprise Stable Edition (DTunnel)
   ------------------------------------------------------------
   - Integrado diretamente aos nativos window.Dt* (DTunnel API)
   - Repara automaticamente conexões caídas sem interferir na UX
   - Roda em background e respeita desconexões manuais
   - Otimizado para mínimo consumo e zero bugs conhecidos
   =========================================================== */

(function(){
  'use strict';

  const PREFIX = 'armgr_v4_';
  const DEFAULTS = {
    enabled: 'true',
    baseCheckMs: '8000',
    hiddenMinCheckMs: '15000',
    pingFailThreshold: '3',
    dnsProbeDelayMs: '3000',
    mtuProbeDelayMs: '3000',
    restartDelayMs: '2500',
    maxRepairsPerHour: '10',
    manualCooldownMs: String(1000 * 60 * 30)
  };

  // Grava configurações padrão
  for (const k in DEFAULTS) {
    const key = PREFIX + k;
    if (!localStorage.getItem(key)) localStorage.setItem(key, DEFAULTS[k]);
  }

  const cfg = {
    enabled: () => localStorage.getItem(PREFIX + 'enabled') === 'true',
    baseCheckMs: () => parseInt(localStorage.getItem(PREFIX + 'baseCheckMs'), 10),
    hiddenMinCheckMs: () => parseInt(localStorage.getItem(PREFIX + 'hiddenMinCheckMs'), 10),
    pingFailThreshold: () => parseInt(localStorage.getItem(PREFIX + 'pingFailThreshold'), 10),
    dnsProbeDelayMs: () => parseInt(localStorage.getItem(PREFIX + 'dnsProbeDelayMs'), 10),
    mtuProbeDelayMs: () => parseInt(localStorage.getItem(PREFIX + 'mtuProbeDelayMs'), 10),
    restartDelayMs: () => parseInt(localStorage.getItem(PREFIX + 'restartDelayMs'), 10),
    maxRepairsPerHour: () => parseInt(localStorage.getItem(PREFIX + 'maxRepairsPerHour'), 10),
    manualCooldownMs: () => parseInt(localStorage.getItem(PREFIX + 'manualCooldownMs'), 10)
  };

  const STATE = {
    running: false,
    monitorTimer: null,
    repairing: false,
    pingFails: 0,
    lastManualDisconnectTs: parseInt(localStorage.getItem(PREFIX + 'lastManualDisconnectTs') || '0', 10),
    repairTimestamps: [],
    abortToken: null
  };

  const now = () => Date.now();
  const sleep = ms => new Promise(res => setTimeout(res, ms));

  function log(...args){ console.log('[ARMGR]', ...args); }
  function warn(...args){ console.warn('[ARMGR]', ...args); }

  /* ===========================================================
     Funções nativas DTunnel encapsuladas
  ============================================================ */
  const native = {
    ping: () => Number(window.DtGetPingResult.execute?.() ?? -1),
    vpnState: () => String(window.DtGetVpnState.execute?.() ?? 'DISCONNECTED'),
    startVpn: () => window.DtExecuteVpnStart.execute?.(),
    stopVpn: () => window.DtExecuteVpnStop.execute?.(),
    bytesDown: () => Number(window.DtGetNetworkDownloadBytes.execute?.() ?? 0),
    netData: () => window.DtGetNetworkData.execute?.() ?? {},
    airplane: () => String(window.DtAirplaneState.execute?.() ?? 'INACTIVE'),
    notify: (title,msg,img) => window.DtSendNotification.execute?.(title,msg,img)
  };

  /* ===========================================================
     Controle manual de desconexão
  ============================================================ */
  function markManualDisconnect() {
    STATE.lastManualDisconnectTs = now();
    localStorage.setItem(PREFIX + 'lastManualDisconnectTs', String(STATE.lastManualDisconnectTs));
    log('Desconexão manual marcada');
  }

  function clearManualDisconnect() {
    STATE.lastManualDisconnectTs = 0;
    localStorage.removeItem(PREFIX + 'lastManualDisconnectTs');
  }

  function userRecentlyDisconnected() {
    if (!STATE.lastManualDisconnectTs) return false;
    return (now() - STATE.lastManualDisconnectTs) < cfg.manualCooldownMs();
  }

  /* ===========================================================
     Segurança: abort token e limite de reparos
  ============================================================ */
  function makeAbortToken() {
    const t = { aborted: false };
    STATE.abortToken = t;
    return t;
  }

  function abortRepair() {
    if (STATE.abortToken) STATE.abortToken.aborted = true;
    STATE.abortToken = null;
  }

  function recordRepair() {
    const oneHour = now() - 3600000;
    STATE.repairTimestamps = STATE.repairTimestamps.filter(t => t > oneHour);
    STATE.repairTimestamps.push(now());
  }

  function tooManyRepairs() {
    const oneHour = now() - 3600000;
    STATE.repairTimestamps = STATE.repairTimestamps.filter(t => t > oneHour);
    return STATE.repairTimestamps.length >= cfg.maxRepairsPerHour();
  }

  /* ===========================================================
     Sequência de Reparo Inteligente
  ============================================================ */
  async function repairSequence() {
    if (STATE.repairing || tooManyRepairs() || userRecentlyDisconnected()) return;
    STATE.repairing = true;
    const token = makeAbortToken();
    recordRepair();
    log('Iniciando reparo automático...');

    try {
      // 1) Teste DNS / reconexão leve
      log('Verificando rede...');
      const net = native.netData();
      if (net.detailed_state === 'NO_NETWORK' || native.airplane() === 'ACTIVE') {
        warn('Sem rede ou modo avião ativo, abortando reparo.');
        STATE.repairing = false;
        return;
      }

      // 2) Reiniciar túnel (melhor abordagem no DTunnel)
      log('Parando túnel...');
      native.stopVpn();
      await sleep(800);
      if (token.aborted) return;

      log('Reiniciando túnel...');
      native.startVpn();
      await sleep(cfg.restartDelayMs());

      // 3) Verificação pós-reparo
      if (token.aborted) return;
      const ping = native.ping();
      const bytes = native.bytesDown();
      if (ping !== -1 && bytes > 0) {
        log('Reparo bem-sucedido (ping ok, tráfego ativo).');
        native.notify('Reconectado com sucesso', 'Sua conexão foi restabelecida automaticamente.', '');
        STATE.repairing = false;
        return;
      }

      warn('Reparo não teve efeito. Tentando reinício completo...');
      native.stopVpn();
      await sleep(1500);
      native.startVpn();
      await sleep(cfg.restartDelayMs());

      const ping2 = native.ping();
      if (ping2 !== -1) {
        log('Reparo bem-sucedido na segunda tentativa.');
        native.notify('Reconectado', 'A estabilidade foi restaurada.', '');
      } else {
        warn('Reparo falhou completamente.');
        native.notify('Falha ao reconectar', 'Verifique sua conexão de rede.', '');
      }

    } catch(e) {
      warn('Erro no reparo:', e);
    } finally {
      STATE.repairing = false;
      abortRepair();
    }
  }

  /* ===========================================================
     Loop de monitoramento
  ============================================================ */
  async function monitorLoop() {
    if (!cfg.enabled() || userRecentlyDisconnected()) {
      scheduleNextCheck();
      return;
    }

    const vpn = native.vpnState();
    const ping = native.ping();
    const bytes = native.bytesDown();

    if (vpn === 'CONNECTED') {
      if (ping === -1 || bytes === 0) {
        STATE.pingFails++;
        log(`Falha de ping #${STATE.pingFails}`);
        if (STATE.pingFails >= cfg.pingFailThreshold()) {
          STATE.pingFails = 0;
          await repairSequence();
        }
      } else {
        STATE.pingFails = 0;
      }
    } else if (vpn === 'DISCONNECTED' && !userRecentlyDisconnected()) {
      warn('VPN desconectada inesperadamente.');
      await repairSequence();
    }

    scheduleNextCheck();
  }

  function scheduleNextCheck(delay) {
    if (!STATE.running) return;
    if (STATE.monitorTimer) clearTimeout(STATE.monitorTimer);
    const base = cfg.baseCheckMs();
    const hidden = cfg.hiddenMinCheckMs();
    const ms = (document.visibilityState === 'hidden') ? hidden : base;
    STATE.monitorTimer = setTimeout(monitorLoop, delay || ms);
  }

  /* ===========================================================
     Controle geral
  ============================================================ */
  function start() {
    if (STATE.running || !cfg.enabled()) return;
    STATE.running = true;
    log('AutoRepairManager iniciado.');
    scheduleNextCheck(1500);
  }

  function stop() {
    STATE.running = false;
    if (STATE.monitorTimer) clearTimeout(STATE.monitorTimer);
    STATE.monitorTimer = null;
    abortRepair();
    STATE.pingFails = 0;
    STATE.repairing = false;
    log('AutoRepairManager parado.');
  }

  async function resetToInitialState() {
    log('Resetando para estado inicial...');
    markManualDisconnect();
    stop();
    abortRepair();

    try {
      native.stopVpn();
      await sleep(1000);
    } catch(e){ warn('Erro ao parar VPN', e); }

    const btn = document.getElementById('connectBtn');
    const status = document.getElementById('statusText');
    if (btn) {
      btn.innerText = 'Conectar';
      btn.classList.remove('connected');
      btn.classList.add('disconnected');
    }
    if (status) status.innerText = 'Desconectado';

    native.notify('Desconectado', 'Sua sessão foi encerrada com segurança.', '');
    log('Estado inicial restaurado.');
  }

  /* ===========================================================
     Interação com botão principal
  ============================================================ */
  (function bindButton(){
    const btn = document.getElementById('connectBtn');
    if (!btn) return;
    btn.addEventListener('click', async ()=>{
      const text = (btn.innerText || '').trim();
      if (/Desconectar/i.test(text)) {
        await resetToInitialState();
      } else if (/Conectar/i.test(text)) {
        clearManualDisconnect();
        native.startVpn();
        setTimeout(()=>start(), 1000);
      }
    });
  })();

  /* ===========================================================
     Eventos de visibilidade
  ============================================================ */
  document.addEventListener('visibilitychange', ()=>{
    if (!STATE.running) return;
    if (document.visibilityState === 'visible') {
      scheduleNextCheck(500);
    } else {
      scheduleNextCheck();
    }
  });

  /* ===========================================================
     API pública
  ============================================================ */
  window.AutoRepairManager = {
    start,
    stop,
    resetToInitialState,
    getState: ()=>({...STATE})
  };

  /* ===========================================================
     Inicialização automática
  ============================================================ */
  if (cfg.enabled() && !userRecentlyDisconnected()) {
    setTimeout(()=>start(), 1200);
  } else {
    log('Auto start ignorado (cooldown ou desabilitado).');
  }

})();
