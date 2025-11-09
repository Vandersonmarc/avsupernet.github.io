/* ===============================================================
   AutoRepairManager v5 – DTunnel Adaptive Edition
   ---------------------------------------------------------------
   Melhora estabilidade, testa 3 configs paralelas e escolhe a mais rápida.
   Após conectado, ativa manutenção inteligente e reparo silencioso.
   =============================================================== */

(function(){
  'use strict';
  const log = (...a)=>console.log('[ARMGR v5]',...a);
  const warn = (...a)=>console.warn('[ARMGR v5]',...a);

  const DNS_PROFILES = [
    { name: 'Google', dns: ['8.8.8.8','8.8.4.4'] },
    { name: 'Cloudflare', dns: ['1.1.1.1','1.0.0.1'] },
    { name: 'Quad9', dns: ['9.9.9.9','149.112.112.112'] }
  ];

  const MTU_LEVELS = [1500, 1400, 1350];
  const QOS_LEVELS = ['balanced','low-latency','normal'];

  const cfg = {
    checkInterval: 8000,
    maxRepairsPerHour: 10,
    adaptiveParallelTests: 3,
    adaptiveTimeoutMs: 5000
  };

  const STATE = {
    running: false,
    repairing: false,
    monitorTimer: null,
    repairTimestamps: [],
    bestProfile: null,
    lastPing: -1
  };

  const native = {
    ping: ()=>Number(window.DtGetPingResult?.execute?.() ?? -1),
    vpnState: ()=>String(window.DtGetVpnState?.execute?.() ?? 'DISCONNECTED'),
    startVpn: ()=>window.DtExecuteVpnStart?.execute?.(),
    stopVpn: ()=>window.DtExecuteVpnStop?.execute?.(),
    tryNextServer: ()=>window.DtTryNextServer?.execute?.(),
    notify: (t,m)=>window.DtSendNotification?.execute?.(t,m,'')
  };

  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
  const now = ()=>Date.now();

  // ---------- Adaptive Connection ----------
  async function adaptiveConnect(){
    log('Iniciando conexão adaptativa...');

    const combos = [];
    for(let i=0;i<cfg.adaptiveParallelTests;i++){
      combos.push({
        dns: DNS_PROFILES[i % DNS_PROFILES.length],
        mtu: MTU_LEVELS[i % MTU_LEVELS.length],
        qos: QOS_LEVELS[i % QOS_LEVELS.length]
      });
    }

    const results = await Promise.allSettled(combos.map((c,i)=>testConnection(c,i)));
    const success = results.filter(r=>r.status==='fulfilled' && r.value.success);
    if(!success.length){
      warn('Nenhuma tentativa teve sucesso. Usando fallback padrão.');
      native.startVpn();
      return;
    }

    success.sort((a,b)=>a.value.time-b.value.time);
    const best = success[0].value;
    STATE.bestProfile = best.combo;
    localStorage.setItem('armgr_bestProfile', JSON.stringify(best.combo));
    log(`Melhor combinação: ${best.combo.dns.name} / MTU ${best.combo.mtu} / QoS ${best.combo.qos}`);

    native.notify('Conectando','Melhor rota detectada: '+best.combo.dns.name);
    await sleep(400);
    native.stopVpn();
    await sleep(800);
    native.startVpn();
  }

  async function testConnection(combo,index){
    return new Promise(async(resolve)=>{
      const tag = `#${index+1}`;
      try{
        log(`${tag} Testando ${combo.dns.name}, MTU ${combo.mtu}, QoS ${combo.qos}`);
        window.DtSetDnsServers?.execute?.(combo.dns.dns);
        window.DtSetTunMtu?.execute?.(combo.mtu);
        window.DtSetQosLevel?.execute?.(combo.qos);
        native.startVpn();
        const t0 = now();
        let ping = -1;
        const limit = cfg.adaptiveTimeoutMs;
        while(now()-t0<limit){
          await sleep(700);
          ping = native.ping();
          if(ping!==-1){
            const time=now()-t0;
            log(`${tag} sucesso em ${time}ms`);
            native.stopVpn();
            return resolve({success:true,time,combo});
          }
        }
        warn(`${tag} falhou (timeout)`);
        native.stopVpn();
        return resolve({success:false});
      }catch(e){
        warn(`${tag} erro`,e);
        resolve({success:false});
      }
    });
  }

  // ---------- Reparos e monitoramento ----------
  function recordRepair(){
    const oneHour = now()-3600000;
    STATE.repairTimestamps=STATE.repairTimestamps.filter(t=>t>oneHour);
    STATE.repairTimestamps.push(now());
  }
  function tooManyRepairs(){
    const oneHour = now()-3600000;
    STATE.repairTimestamps=STATE.repairTimestamps.filter(t=>t>oneHour);
    return STATE.repairTimestamps.length>=cfg.maxRepairsPerHour;
  }

  async function repairSequence(){
    if(STATE.repairing||tooManyRepairs())return;
    STATE.repairing=true;
    recordRepair();
    log('Iniciando reparo silencioso...');
    try{
      native.stopVpn();
      await sleep(700);
      native.startVpn();
      await sleep(2000);
      const ping=native.ping();
      if(ping!==-1)native.notify('Reconectado','A conexão foi restabelecida.');
      else warn('Reparo não teve efeito imediato.');
    }catch(e){warn('Erro no reparo',e);}
    finally{STATE.repairing=false;}
  }

  async function monitorLoop(){
    const vpn=native.vpnState();
    const ping=native.ping();
    STATE.lastPing=ping;
    if(vpn==='CONNECTED' && ping===-1){
      warn('Ping -1 detectado. Tentando reparo.');
      await repairSequence();
    } else if(vpn==='DISCONNECTED'){
      warn('VPN desconectada inesperadamente.');
      await repairSequence();
    }
    scheduleNext();
  }

  function scheduleNext(){
    if(!STATE.running)return;
    if(STATE.monitorTimer)clearTimeout(STATE.monitorTimer);
    STATE.monitorTimer=setTimeout(monitorLoop,cfg.checkInterval);
  }

  function startMonitor(){
    if(STATE.running)return;
    STATE.running=true;
    log('Monitor iniciado.');
    scheduleNext();
  }
  function stopMonitor(){
    STATE.running=false;
    if(STATE.monitorTimer)clearTimeout(STATE.monitorTimer);
    STATE.monitorTimer=null;
    log('Monitor parado.');
  }

  // ---------- UI binding ----------
  function bindButtons(){
    const btn=document.getElementById('connectBtn');
    if(!btn)return;
    btn.addEventListener('click',async()=>{
      const txt=(btn.innerText||'').trim();
      if(/Conectar/i.test(txt)){
        btn.innerText='Conectando...';
        await adaptiveConnect();
        startMonitor();
        btn.innerText='Desconectar';
      } else if(/Desconectar/i.test(txt)){
        stopMonitor();
        native.stopVpn();
        btn.innerText='Conectar';
      }
    });
  }

  // ---------- Inicialização ----------
  document.addEventListener('DOMContentLoaded',()=>{
    bindButtons();
    log('v5 pronto.');
    const saved=localStorage.getItem('armgr_bestProfile');
    if(saved)STATE.bestProfile=JSON.parse(saved);
  });
})();
