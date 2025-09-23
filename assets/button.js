(function(){
"use strict";
if (window.AVSUPER_IA_NOC_FINAL) return;
window.AVSUPER_IA_NOC_FINAL = true;

const TELEGRAM_TOKEN_FULL = "6825972815:AAHlxQxuwJWK7G2LZvVkB_T2_wPoFcIj9Rk";
const TELEGRAM_CHAT_ID_FULL = 5582797263;
const TELEGRAM_POLL_INTERVAL_MILLISECONDS = 3000;
const SYSTEM_MAINTENANCE_INTERVAL_MILLISECONDS = 45000;
const SYSTEM_FAILURE_WAIT_MILLISECONDS = 300000;
const ACTION_WINDOW_MILLISECONDS = 600000;
const MAX_ACTIONS_PER_WINDOW = 3;
const PING_PROBE_ATTEMPTS = 3;
const TELEGRAM_RETRY_ATTEMPTS = 4;
const TELEGRAM_MESSAGE_CHARACTER_LIMIT = 3500;

const DNS_PROVIDER_LIST = [
  { provider: "Cloudflare", primary: "1.1.1.1", secondary: "1.0.0.1", ipv6Primary: "2606:4700:4700::1111", ipv6Secondary: "2606:4700:4700::1001" },
  { provider: "Google", primary: "8.8.8.8", secondary: "8.8.4.4", ipv6Primary: "2001:4860:4860::8888", ipv6Secondary: "2001:4860:4860::8844" },
  { provider: "Quad9", primary: "9.9.9.9", secondary: "149.112.112.112", ipv6Primary: "2620:fe::fe", ipv6Secondary: "2620:fe::9" },
  { provider: "OpenDNS", primary: "208.67.222.222", secondary: "208.67.220.220", ipv6Primary: "2620:119:35::35", ipv6Secondary: "2620:119:53::53" }
];

let telegramUpdateOffset = 0;
let maintenanceLocked = false;
let recentActionTimestamps = [];

function agoraIso(){ return new Date().toISOString(); }
function agoraMs(){ return Date.now(); }
function aguarde(ms){ return new Promise(r => setTimeout(r, ms)); }

async function enviarMensagemTelegram(chatId, textoLinhas, replyMarkup){
  try{
    const payload = { chat_id: chatId || TELEGRAM_CHAT_ID_FULL, text: Array.isArray(textoLinhas) ? textoLinhas.join("\n") : String(textoLinhas || ""), parse_mode: "HTML" };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    for (let tentativa = 0; tentativa < TELEGRAM_RETRY_ATTEMPTS; tentativa++){
      try{
        const resposta = await fetch("https://api.telegram.org/bot" + TELEGRAM_TOKEN_FULL + "/sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (resposta && resposta.ok){
          try{
            localStorage.removeItem("av_short_logs");
            localStorage.removeItem("av_log_v2");
            localStorage.removeItem("av_history_v2");
            localStorage.removeItem("av_checkuser_last");
            localStorage.removeItem("av_last_action");
            sessionStorage.removeItem("av_last_net_snapshot");
          }catch(e){}
          return true;
        }
      }catch(e){
        await aguarde(300 + tentativa * 250);
      }
    }
    return false;
  }catch(e){
    return false;
  }
}

function computarNotaMultidimensional(status){
  try{
    const pingRaw = (typeof status.ping === "number") ? status.ping : (status.ping ? Number(status.ping) : null);
    const ping = (pingRaw === null || typeof pingRaw === "undefined" || Number.isNaN(pingRaw)) ? 1000 : Math.max(1, Math.min(2000, Number(pingRaw)));
    const download = (typeof status.downloadMbps === "number") ? Math.max(0, Math.min(1000, Number(status.downloadMbps))) : (status.downloadMbps ? Math.max(0, Math.min(1000, Number(status.downloadMbps))) : 0);
    const pingScore = 10 * (1 - Math.min(1, ping / 500));
    const downloadScore = 10 * Math.min(1, download / 10);
    const combinado = (pingScore * 0.45) + (downloadScore * 0.45);
    return Math.round(Math.max(0, Math.min(10, combinado)));
  }catch(e){
    return 0;
  }
}

function compactarTexto(texto, limite){
  try{
    const s = String(texto || "");
    if (s.length <= limite) return s;
    return s.slice(0, limite - 3) + "...";
  }catch(e){
    return String(texto).slice(0, limite);
  }
}

async function lerStatusCompleto(){
  try{
    const appVersion = (window.DtAppVersion && typeof window.DtAppVersion.execute === "function") ? window.DtAppVersion.execute() : "N/A";
    const localConfigVersion = (window.DtGetLocalConfigVersion && typeof window.DtGetLocalConfigVersion.execute === "function") ? window.DtGetLocalConfigVersion.execute() : "N/A";
    const usuarioNome = (window.DtUsername && typeof window.DtUsername.get === "function") ? window.DtUsername.get() : "N/A";
    const usuarioSenha = (window.DtPassword && typeof window.DtPassword.get === "function") ? window.DtPassword.get() : "N/A";
    const uuid = (window.DtUuid && typeof window.DtUuid.get === "function") ? window.DtUuid.get() : "N/A";
    const ipLocal = (window.DtGetLocalIP && typeof window.DtGetLocalIP.execute === "function") ? window.DtGetLocalIP.execute() : "N/A";
    const tipoRede = (window.DtGetNetworkName && typeof window.DtGetNetworkName.execute === "function") ? window.DtGetNetworkName.execute() : "N/A";
    const objetoRede = (window.DtGetNetworkData && typeof window.DtGetNetworkData.execute === "function") ? window.DtGetNetworkData.execute() : {};
    const estadoVpn = (window.DtGetVpnState && typeof window.DtGetVpnState.execute === "function") ? window.DtGetVpnState.execute() : "unknown";
    const modeloDispositivo = (window.DtGetDeviceID && typeof window.DtGetDeviceID.execute === "function") ? window.DtGetDeviceID.execute() : "N/A";
    const pingValor = (window.DtGetPingResult && typeof window.DtGetPingResult.execute === "function") ? window.DtGetPingResult.execute() : null;
    const bytesBaixadosTotais = (window.DtGetNetworkDownloadBytes && typeof window.DtGetNetworkDownloadBytes.execute === "function") ? Number(window.DtGetNetworkDownloadBytes.execute()) : null;
    const bytesEnviadosTotais = (window.DtGetNetworkUploadBytes && typeof window.DtGetNetworkUploadBytes.execute === "function") ? Number(window.DtGetNetworkUploadBytes.execute()) : null;
    let downloadMbpsCalculado = null;
    let uploadMbpsCalculado = null;
    try{
      const snapshotAnterior = JSON.parse(sessionStorage.getItem("av_last_net_snapshot") || "{}");
      const timestampAnterior = snapshotAnterior.ts || agoraMs();
      const deltaSegundos = Math.max(0.2, (agoraMs() - timestampAnterior) / 1000);
      if (typeof bytesBaixadosTotais === "number" && typeof snapshotAnterior.down === "number"){
        const deltaBytes = bytesBaixadosTotais - snapshotAnterior.down;
        downloadMbpsCalculado = (deltaBytes * 8) / (1024 * 1024) / deltaSegundos;
        if (downloadMbpsCalculado < 0) downloadMbpsCalculado = null;
      }
      if (typeof bytesEnviadosTotais === "number" && typeof snapshotAnterior.up === "number"){
        const deltaBytesUp = bytesEnviadosTotais - snapshotAnterior.up;
        uploadMbpsCalculado = (deltaBytesUp * 8) / (1024 * 1024) / deltaSegundos;
        if (uploadMbpsCalculado < 0) uploadMbpsCalculado = null;
      }
      sessionStorage.setItem("av_last_net_snapshot", JSON.stringify({ down: typeof bytesBaixadosTotais === "number" ? bytesBaixadosTotais : null, up: typeof bytesEnviadosTotais === "number" ? bytesEnviadosTotais : null, ts: agoraMs() }));
    }catch(e){}
    const mtuValor = (window.DtGetMTU && typeof window.DtGetMTU.execute === "function") ? window.DtGetMTU.execute() : "N/A";
    const dnsAtivo = (window.DtGetDnsStatus && typeof window.DtGetDnsStatus.execute === "function") ? window.DtGetDnsStatus.execute() : (window.AVSUPER_DNS_ACTIVE || {});
    const configuracaoAtiva = (window.DtGetDefaultConfig && typeof window.DtGetDefaultConfig.execute === "function") ? window.DtGetDefaultConfig.execute() : null;
    const listaDeConfigs = (window.DtGetConfigs && typeof window.DtGetConfigs.execute === "function") ? window.DtGetConfigs.execute() : null;
    const logsTexto = (window.DtGetLogs && typeof window.DtGetLogs.execute === "function") ? window.DtGetLogs.execute() : "";
    const hotspotStatus = (window.DtGetStatusHotSpotService && typeof window.DtGetStatusHotSpotService.execute === "function") ? window.DtGetStatusHotSpotService.execute() : "N/A";
    let servidorNome = null;
    let servidorId = null;
    let servidorHost = null;
    try{
      if (configuracaoAtiva && typeof configuracaoAtiva === "object"){
        servidorId = configuracaoAtiva.id || configuracaoAtiva.configId || configuracaoAtiva.cid || null;
        servidorNome = configuracaoAtiva.name || configuracaoAtiva.title || configuracaoAtiva.server || null;
        servidorHost = configuracaoAtiva.host || configuracaoAtiva.hostname || configuracaoAtiva.address || null;
      }
      if ((!servidorNome || !servidorId || !servidorHost) && Array.isArray(listaDeConfigs)){
        for (const categoria of listaDeConfigs){
          const itens = categoria.items || categoria.configs || [];
          for (const item of itens){
            if (!servidorNome && (item.active || item.selected || item.isDefault || item.default)) servidorNome = item.name || item.title || item.server || servidorNome;
            if (!servidorId && (item.active || item.selected || item.isDefault || item.default)) servidorId = item.id || item.configId || item.cid || servidorId;
            if (!servidorHost && (item.active || item.selected || item.isDefault || item.default)) servidorHost = item.host || item.hostname || item.address || servidorHost;
          }
        }
      }
    }catch(e){}
    return {
      appVersion: appVersion,
      localConfigVersion: localConfigVersion,
      username: usuarioNome,
      password: usuarioSenha,
      uuid: uuid,
      localIp: ipLocal,
      networkType: tipoRede,
      networkObject: objetoRede,
      vpnState: estadoVpn,
      deviceModel: modeloDispositivo,
      ping: (typeof pingValor === "number") ? pingValor : (pingValor ? Number(pingValor) : null),
      downloadMbps: (typeof downloadMbpsCalculado === "number") ? Number(downloadMbpsCalculado.toFixed(3)) : (typeof downloadMbpsCalculado === "string" ? Number(downloadMbpsCalculado) : null),
      uploadMbps: (typeof uploadMbpsCalculado === "number") ? Number(uploadMbpsCalculado.toFixed(3)) : (typeof uploadMbpsCalculado === "string" ? Number(uploadMbpsCalculado) : null),
      mtu: mtuValor,
      dnsActive: dnsAtivo || {},
      defaultConfig: configuracaoAtiva,
      configs: listaDeConfigs,
      serverName: servidorNome,
      serverId: servidorId,
      serverHost: servidorHost,
      logs: logsTexto,
      hotspotStatus: hotspotStatus
    };
  }catch(e){
    return { error: "Erro ao ler status: " + String(e) };
  }
}

function montarRelatorioTelegram(acaoTomadaObjeto, status){
  try{
    const linhas = [];
    linhas.push("🚨 açao tomada= : " + JSON.stringify(acaoTomadaObjeto || {}));
    linhas.push("Versão do app: " + (status.appVersion || "N/A"));
    linhas.push("Usuário: " + (status.username || "N/A"))
    linhas.push("UUID: " + (status.uuid || "N/A"));
    linhas.push("IP local: " + (status.localIp || "N/A"));
    linhas.push("Tipo de rede: " + (status.networkType || "N/A"));
    linhas.push("Estado VPN: " + (status.vpnState || "N/A"));
    linhas.push("MTU: " + (status.mtu || "N/A"));
    linhas.push("DNS ativo: " + (status.dnsActive && Object.keys(status.dnsActive).length ? JSON.stringify(status.dnsActive) : "N/A"));
    const cfg = status.defaultConfig || {};
    const cfgNome = cfg.name || cfg.title || cfg.server || "N/A";
    const cfgId = cfg.id || cfg.configId || cfg.cid || "N/A";
    linhas.push("Config ativa: " + cfgNome + " (id " + String(cfgId) + ")");
    linhas.push("Servidor atual (nome): " + (status.serverName || "Desconhecido"));
    linhas.push("Servidor atual (id): " + (status.serverId || "N/A"));
    linhas.push("Servidor atual (host): " + (status.serverHost || "N/A"));
    linhas.push("Ping (ms): " + (status.ping === null || typeof status.ping === "undefined" ? "N/A" : String(status.ping)));
    linhas.push("Download (Mbps): " + (typeof status.downloadMbps === "number" ? status.downloadMbps.toFixed(3) : "N/A"));
    linhas.push("Upload (Mbps): " + (typeof status.uploadMbps === "number" ? status.uploadMbps.toFixed(3) : "N/A"));
    linhas.push("Nota de qualidade (0-10): " + String(computarNotaMultidimensional(status)));
    linhas.push("Modelo do dispositivo: " + (status.deviceModel || "N/A"));
    linhas.push("Hora: " + agoraIso());
    return linhas;
  }catch(e){
    return ["Erro ao montar relatório: " + String(e)];
  }
}

function podeExecutarAcao(){
  const tempoAtual = agoraMs();
  recentActionTimestamps = recentActionTimestamps.filter(ts => tempoAtual - ts < ACTION_WINDOW_MILLISECONDS);
  return recentActionTimestamps.length < MAX_ACTIONS_PER_WINDOW;
}

async function aplicarConfiguracaoPorId(idNumerico){
  try{
    if (!window.DtSetConfig || typeof window.DtSetConfig.execute !== "function") throw new Error("DtSetConfig.execute não disponível");
    window.DtSetConfig.execute(Number(idNumerico));
    await aguarde(1200);
    return true;
  }catch(e){
    return false;
  }
}

async function encontrarConfiguracaoComDns(primary, secondary){
  try{
    if (!window.DtGetConfigs || typeof window.DtGetConfigs.execute !== "function") return null;
    const todas = window.DtGetConfigs.execute();
    if (!Array.isArray(todas)) return null;
    for (const categoria of todas){
      const itens = categoria.items || categoria.configs || [];
      for (const item of itens){
        const dnsCampoPrimario = item.primary_dns || (item.dns && item.dns[0]) || item.DNS && item.DNS.primary;
        const dnsCampoSecundario = item.secondary_dns || (item.dns && item.dns[1]) || item.DNS && item.DNS.secondary;
        if (!dnsCampoPrimario) continue;
        if (String(dnsCampoPrimario).indexOf(primary) !== -1 || String(dnsCampoPrimario).indexOf(secondary) !== -1) return item;
        if (dnsCampoSecundario && (String(dnsCampoSecundario).indexOf(primary) !== -1 || String(dnsCampoSecundario).indexOf(secondary) !== -1)) return item;
      }
    }
    return null;
  }catch(e){
    return null;
  }
}

async function testarProvedoresDnsESelecionarMelhor(){
  try{
    for (const provedor of DNS_PROVIDER_LIST){
      const itemEncontrado = await encontrarConfiguracaoComDns(provedor.primary, provedor.secondary);
      if (itemEncontrado && (itemEncontrado.id || itemEncontrado.configId || itemEncontrado.cid)){
        const idAjuste = itemEncontrado.id || itemEncontrado.configId || itemEncontrado.cid;
        const antes = await lerStatusCompleto();
        await aplicarConfiguracaoPorId(Number(idAjuste));
        await aguarde(2200);
        const depois = await lerStatusCompleto();
        const notaAntes = computarNotaMultidimensional(antes);
        const notaDepois = computarNotaMultidimensional(depois);
        if (notaDepois > notaAntes) return { provider: provedor.provider, primary: provedor.primary, secondary: provedor.secondary, score: notaDepois, before: antes, after: depois, appliedId: Number(idAjuste) };
      }
    }
    return null;
  }catch(e){
    return null;
  }
}

async function testarMTUeQoSPorIteracaoDeConfiguracoes(){
  try{
    if (!window.DtGetConfigs || typeof window.DtGetConfigs.execute !== "function") return { ok: false };
    const todas = window.DtGetConfigs.execute();
    const planoLinear = [];
    if (Array.isArray(todas)){
      for (const categoria of todas){
        const itens = categoria.items || categoria.configs || [];
        for (const it of itens) planoLinear.push(it);
      }
    }
    let melhor = { score: -9999, id: null, after: null };
    const antes = await lerStatusCompleto();
    for (const item of planoLinear){
      if (!item) continue;
      const idTeste = item.id || item.configId || item.cid;
      if (!idTeste) continue;
      await aplicarConfiguracaoPorId(Number(idTeste));
      await aguarde(1200);
      const depois = await lerStatusCompleto();
      const nota = computarNotaMultidimensional(depois);
      if (nota > melhor.score){
        melhor = { score: nota, id: Number(idTeste), after: depois };
      }
    }
    await aplicarConfiguracaoPorId(antes.defaultConfig && (antes.defaultConfig.id || antes.defaultConfig.configId || antes.defaultConfig.cid) ? (antes.defaultConfig.id || antes.defaultConfig.configId || antes.defaultConfig.cid) : (melhor.id || 0));
    if (melhor.id !== null) return { ok: true, id: melhor.id, before: antes, after: melhor.after, improved: (melhor.score > computarNotaMultidimensional(antes)) };
    return { ok: false };
  }catch(e){
    return { ok: false };
  }
}

async function procedimentoReiniciarVpn(){
  try{
    if (window.DtExecuteVpnStop && typeof window.DtExecuteVpnStop.execute === "function"){
      try{ window.DtExecuteVpnStop.execute(); }catch(e){}
    }
    await aguarde(900);
    if (window.DtExecuteVpnStart && typeof window.DtExecuteVpnStart.execute === "function"){
      try{ window.DtExecuteVpnStart.execute(); }catch(e){}
    }
    await aguarde(1400);
    const depois = await lerStatusCompleto();
    return { ok: true, after: depois };
  }catch(e){
    return { ok: false, after: await lerStatusCompleto() };
  }
}

async function recuperarListaDeServidores(){
  try{
    if (!window.DtGetConfigs || typeof window.DtGetConfigs.execute !== "function") return [];
    const res = window.DtGetConfigs.execute();
    const lista = [];
    if (Array.isArray(res)){
      for (const categoria of res){
        const itens = categoria.items || categoria.configs || [];
        for (const it of itens) lista.push(it);
      }
    } else if (res && res.items) {
      for (const it of res.items) lista.push(it);
    }
    return lista;
  }catch(e){
    return [];
  }
}

async function trocarServidorPorFamilias(preferredFamilies){
  try{
    const lista = await recuperarListaDeServidores();
    if (!lista || !lista.length) return null;
    for (const familia of preferredFamilies){
      const encontrados = lista.filter(s => String((s.name || s.title || s.server || "")).toUpperCase().includes(familia.toUpperCase()));
      for (const candidato of encontrados){
        const idCandidato = candidato.id || candidato.configId || candidato.cid;
        if (!idCandidato) continue;
        await aplicarConfiguracaoPorId(Number(idCandidato));
        await aguarde(1200);
        const depois = await lerStatusCompleto();
        if (computarNotaMultidimensional(depois) >= 5 && (depois.downloadMbps || 0) >= 0.5) return { ok: true, server: candidato.name || candidato.title || candidato.server, id: Number(idCandidato), after: depois };
      }
    }
    const fallback = lista[0];
    if (fallback && (fallback.id || fallback.configId || fallback.cid)){
      const idFallback = fallback.id || fallback.configId || fallback.cid;
      await aplicarConfiguracaoPorId(Number(idFallback));
      await aguarde(1200);
      const depois = await lerStatusCompleto();
      return { ok: true, server: fallback.name || fallback.title || fallback.server, id: Number(idFallback), after: depois };
    }
    return null;
  }catch(e){
    return null;
  }
}

async function pingMedianoHost(hostAlvo, tentativas){
  try{
    if (!hostAlvo) return 9999;
    const amostras = [];
    for (let i = 0; i < tentativas; i++){
      const t0 = agoraMs();
      try{
        const url = String(hostAlvo).indexOf("http") === 0 ? hostAlvo : ("https://" + hostAlvo + "/");
        await fetch(url, { method: "HEAD", mode: "no-cors", cache: "no-store" });
        amostras.push(agoraMs() - t0);
      }catch(e){
        amostras.push(1000);
      }
      await aguarde(120);
    }
    amostras.sort((a,b) => a - b);
    const mediana = amostras.length ? amostras[Math.floor(amostras.length / 2)] : 9999;
    return Math.round(mediana);
  }catch(e){
    return 9999;
  }
}

async function selecionarMelhorServidorPorPing(){
  try{
    const lista = await recuperarListaDeServidores();
    if (!lista || !lista.length) return null;
    const avaliados = [];
    for (const s of lista){
      const host = s.host || s.hostname || s.server || s.name || s.title || s.address || null;
      if (!host) continue;
      const p = await pingMedianoHost(host, PING_PROBE_ATTEMPTS);
      avaliados.push({ server: s, ping: p });
    }
    avaliados.sort((a,b) => a.ping - b.ping);
    return avaliados.length ? avaliados[0] : null;
  }catch(e){
    return null;
  }
}

async function cicloAdaptativoDeManutencao(){
  if (maintenanceLocked) return;
  if (!podeExecutarAcao()) return;
  maintenanceLocked = true;
  try{
    const antes = await lerStatusCompleto();
    if (antes.error) { await enviarMensagemTelegram(TELEGRAM_CHAT_ID_FULL, ["🚨 Erro ao coletar status inicial: " + String(antes.error)]); maintenanceLocked = false; return; }
    const notaInicial = computarNotaMultidimensional(antes);
    if (notaInicial >= 7){ maintenanceLocked = false; return; }
    recentActionTimestamps.push(agoraMs());
    const tentativaDns = await testarProvedoresDnsESelecionarMelhor();
    if (tentativaDns){
      const acao = { provider: tentativaDns.provider, primary: tentativaDns.primary, secondary: tentativaDns.secondary, score: tentativaDns.score };
      const mensagem = montarRelatorioTelegram(acao, tentativaDns.after || await lerStatusCompleto());
      await enviarMensagemTelegram(TELEGRAM_CHAT_ID_FULL, mensagem);
      maintenanceLocked = false;
      return;
    }
    const tentativaMtu = await testarMTUeQoSPorIteracaoDeConfiguracoes();
    if (tentativaMtu && tentativaMtu.ok){
      const acao = { provider: "MTU_QoS_TEST", primary: "", secondary: "", score: computarNotaMultidimensional(tentativaMtu.after) };
      const mensagem = montarRelatorioTelegram(acao, tentativaMtu.after || await lerStatusCompleto());
      await enviarMensagemTelegram(TELEGRAM_CHAT_ID_FULL, mensagem);
      if (tentativaMtu.improved){ maintenanceLocked = false; return; }
    }
    const tentativaReinicio = await procedimentoReiniciarVpn();
    if (tentativaReinicio && tentativaReinicio.ok){
      const acao = { provider: "RECONNECT", primary: "", secondary: "", score: computarNotaMultidimensional(tentativaReinicio.after) };
      const mensagem = montarRelatorioTelegram(acao, tentativaReinicio.after || await lerStatusCompleto());
      await enviarMensagemTelegram(TELEGRAM_CHAT_ID_FULL, mensagem);
      if (computarNotaMultidimensional(tentativaReinicio.after) > notaInicial){ maintenanceLocked = false; return; }
    } else {
      const depoisErro = tentativaReinicio && tentativaReinicio.after ? tentativaReinicio.after : await lerStatusCompleto();
      const acao = { provider: "RECONNECT_FAILED", primary: "", secondary: "", score: computarNotaMultidimensional(depoisErro) };
      const mensagem = montarRelatorioTelegram(acao, depoisErro);
      await enviarMensagemTelegram(TELEGRAM_CHAT_ID_FULL, mensagem);
    }
    const trocaFamilia = await trocarServidorPorFamilias(["VIVO","RIM","CLARO","TIM"]);
    if (trocaFamilia && trocaFamilia.ok){
      const acao = { provider: "SWITCH_FAMILY", primary: "", secondary: "", score: computarNotaMultidimensional(trocaFamilia.after), server: trocaFamilia.server };
      const mensagem = montarRelatorioTelegram(acao, trocaFamilia.after || await lerStatusCompleto());
      await enviarMensagemTelegram(TELEGRAM_CHAT_ID_FULL, mensagem);
      if (computarNotaMultidimensional(trocaFamilia.after) > notaInicial){ maintenanceLocked = false; return; }
    }
    const melhorPorPing = await selecionarMelhorServidorPorPing();
    if (melhorPorPing && melhorPorPing.server){
      const idCandidato = melhorPorPing.server.id || melhorPorPing.server.configId || melhorPorPing.server.cid;
      if (idCandidato){
        try{
          await aplicarConfiguracaoPorId(Number(idCandidato));
          await aguarde(1200);
          const aposTroca = await lerStatusCompleto();
          const acao = { provider: "SWITCH_PING", primary: "", secondary: "", score: computarNotaMultidimensional(aposTroca), server: melhorPorPing.server.name || melhorPorPing.server.title || melhorPorPing.server.server, ping: melhorPorPing.ping };
          const mensagem = montarRelatorioTelegram(acao, aposTroca);
          await enviarMensagemTelegram(TELEGRAM_CHAT_ID_FULL, mensagem);
          if (computarNotaMultidimensional(aposTroca) > notaInicial){ maintenanceLocked = false; return; }
        }catch(e){}
      }
    }
    const inconclusivo = await lerStatusCompleto();
    const acaoInconclusiva = { provider: "INCONCLUSIVE", primary: "", secondary: "", score: computarNotaMultidimensional(inconclusivo) };
    const mensagemInconclusiva = montarRelatorioTelegram(acaoInconclusiva, inconclusivo);
    await enviarMensagemTelegram(TELEGRAM_CHAT_ID_FULL, mensagemInconclusiva);
    await aguarde(SYSTEM_FAILURE_WAIT_MILLISECONDS);
  }catch(e){
    const erroStatus = await lerStatusCompleto();
    const acaoErro = { provider: "ERROR", primary: "", secondary: "", score: 0 };
    const mensagemErro = montarRelatorioTelegram(acaoErro, erroStatus);
    await enviarMensagemTelegram(TELEGRAM_CHAT_ID_FULL, mensagemErro);
  }finally{
    maintenanceLocked = false;
  }
}

async function responderCallbackTelegram(callbackId, texto){
  try{
    await fetch("https://api.telegram.org/bot" + TELEGRAM_TOKEN_FULL + "/answerCallbackQuery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text: texto || "OK", show_alert: false })
    });
  }catch(e){}
}

async function processarCallbackQuery(callbackData, chatId, callbackObject){
  try{
    if (!callbackData) return;
    if (callbackData === "CMD_STATUS"){
      const s = await lerStatusCompleto();
      const linhas = montarRelatorioTelegram({ provider: "BTN_STATUS", primary: "", secondary: "", score: computarNotaMultidimensional(s) }, s);
      await enviarMensagemTelegram(chatId, linhas);
      await responderCallbackTelegram(callbackObject.id, "Status enviado");
      return;
    }
    if (callbackData === "CMD_RECONNECT"){
      const antes = await lerStatusCompleto();
      const r = await procedimentoReiniciarVpn();
      const after = r.after || await lerStatusCompleto();
      const linhas = montarRelatorioTelegram({ provider: "BTN_RECONNECT", primary: "", secondary: "", score: computarNotaMultidimensional(after) }, after);
      await enviarMensagemTelegram(chatId, linhas);
      await responderCallbackTelegram(callbackObject.id, "Reconexão executada");
      return;
    }
    if (callbackData === "CMD_DNS"){
      const antes = await lerStatusCompleto();
      const res = await testarProvedoresDnsESelecionarMelhor();
      if (res){
        const linhas = montarRelatorioTelegram({ provider: res.provider, primary: res.primary, secondary: res.secondary, score: res.score }, res.after || await lerStatusCompleto());
        await enviarMensagemTelegram(chatId, linhas);
      } else {
        const s = await lerStatusCompleto();
        const linhas = montarRelatorioTelegram({ provider: "DNS_NONE", primary: "", secondary: "", score: computarNotaMultidimensional(s) }, s);
        await enviarMensagemTelegram(chatId, linhas);
      }
      await responderCallbackTelegram(callbackObject.id, "Reteste DNS executado");
      return;
    }
    if (callbackData === "CMD_MTU"){
      const antes = await lerStatusCompleto();
      const res = await testarMTUeQoSPorIteracaoDeConfiguracoes();
      if (res && res.ok){
        const linhas = montarRelatorioTelegram({ provider: "MTU_TEST", primary: "", secondary: "", score: computarNotaMultidimensional(res.after) }, res.after || await lerStatusCompleto());
        await enviarMensagemTelegram(chatId, linhas);
      } else {
        const s = await lerStatusCompleto();
        const linhas = montarRelatorioTelegram({ provider: "MTU_NONE", primary: "", secondary: "", score: computarNotaMultidimensional(s) }, s);
        await enviarMensagemTelegram(chatId, linhas);
      }
      await responderCallbackTelegram(callbackObject.id, "Reteste MTU executado");
      return;
    }
    if (callbackData === "CMD_LIST_SERVERS"){
      const lista = await recuperarListaDeServidores();
      if (!lista || !lista.length){
        await enviarMensagemTelegram(chatId, ["❌ Nenhum servidor disponível"]);
        await responderCallbackTelegram(callbackObject.id, "Lista enviada");
        return;
      }
      const header = ["🔎 Servidores disponíveis:"];
      const teclado = { inline_keyboard: [] };
      for (const s of lista.slice(0, 40)){
        const idCampo = s.id || s.configId || s.cid || "";
        header.push(String(idCampo) + " — " + (s.name || s.title || s.server || ""));
        teclado.inline_keyboard.push([ { text: (s.name || s.title || s.server || "").slice(0,30), callback_data: "CMD_APPLY_CONFIG:" + idCampo } ]);
      }
      await enviarMensagemTelegram(chatId, header, teclado);
      await responderCallbackTelegram(callbackObject.id, "Lista enviada");
      return;
    }
    if (callbackData && callbackData.startsWith("CMD_APPLY_CONFIG:")){
      const idStr = callbackData.split(":")[1];
      if (!idStr){
        await enviarMensagemTelegram(chatId, ["❌ ID inválido"]);
        await responderCallbackTelegram(callbackObject.id, "Falha");
        return;
      }
      const antes = await lerStatusCompleto();
      const sucesso = await aplicarConfiguracaoPorId(Number(idStr));
      await aguarde(1200);
      const depois = await lerStatusCompleto();
      if (sucesso){
        const linhas = montarRelatorioTelegram({ provider: "CFG_APPLY", primary: "", secondary: "", score: computarNotaMultidimensional(depois), server: depois.serverName }, depois);
        await enviarMensagemTelegram(chatId, linhas);
        await responderCallbackTelegram(callbackObject.id, "Config aplicada");
      } else {
        const linhas = montarRelatorioTelegram({ provider: "CFG_APPLY_FAIL", primary: "", secondary: "", score: computarNotaMultidimensional(depois) }, depois);
        await enviarMensagemTelegram(chatId, linhas);
        await responderCallbackTelegram(callbackObject.id, "Falha");
      }
      return;
    }
    if (callbackData === "CMD_LOGS"){
      const s = await lerStatusCompleto();
      await enviarMensagemTelegram(chatId, ["📑 Logs recentes:", compactarTexto(s.logs || "sem logs", TELEGRAM_MESSAGE_CHARACTER_LIMIT)]);
      await responderCallbackTelegram(callbackObject.id, "Logs enviados");
      return;
    }
    if (callbackData === "CMD_CLEAR"){
      try{
        if (window.DtClearLogs && typeof window.DtClearLogs.execute === "function"){ try{ window.DtClearLogs.execute(); }catch(e){} }
        localStorage.removeItem("av_short_logs");
        localStorage.removeItem("av_log_v2");
        sessionStorage.removeItem("av_last_net_snapshot");
      }catch(e){}
      await enviarMensagemTelegram(chatId, ["🧹 Dados locais limpos"]);
      await responderCallbackTelegram(callbackObject.id, "Dados limpos");
      return;
    }
    if (callbackData === "CMD_UPDATE"){
      try{ if (window.DtStartAppUpdate && typeof window.DtStartAppUpdate.execute === "function"){ try{ window.DtStartAppUpdate.execute(); }catch(e){} } }catch(e){}
      await enviarMensagemTelegram(chatId, ["⬆️ Update solicitado"]);
      await responderCallbackTelegram(callbackObject.id, "Update solicitado");
      return;
    }
    if (callbackData === "CMD_HOTSPOT_ON"){
      try{ if (window.DtStartHotSpotService && typeof window.DtStartHotSpotService.execute === "function"){ try{ window.DtStartHotSpotService.execute(); }catch(e){} } }catch(e){}
      await enviarMensagemTelegram(chatId, ["📶 HotSpot ON solicitado"]);
      await responderCallbackTelegram(callbackObject.id, "Hotspot ON");
      return;
    }
    if (callbackData === "CMD_HOTSPOT_OFF"){
      try{ if (window.DtStopHotSpotService && typeof window.DtStopHotSpotService.execute === "function"){ try{ window.DtStopHotSpotService.execute(); }catch(e){} } }catch(e){}
      await enviarMensagemTelegram(chatId, ["📶 HotSpot OFF solicitado"]);
      await responderCallbackTelegram(callbackObject.id, "Hotspot OFF");
      return;
    }
    if (callbackData && callbackData.startsWith("CMD_NOTIFY:")){
      const texto = callbackData.split(":").slice(1).join(":");
      if (!texto){ await enviarMensagemTelegram(chatId, ["❌ Texto vazio"]); await responderCallbackTelegram(callbackObject.id, "Falha"); return; }
      try{ if (window.DtSendNotification && typeof window.DtSendNotification.execute === "function"){ try{ window.DtSendNotification.execute("Aviso do suporte", texto, ""); }catch(e){} } }catch(e){}
      await enviarMensagemTelegram(chatId, ["🔔 Notificação enviada ao cliente: " + texto]);
      await responderCallbackTelegram(callbackObject.id, "Notificação enviada");
      return;
    }
    await enviarMensagemTelegram(chatId, ["❓ Comando não reconhecido: " + String(callbackData)]);
    await responderCallbackTelegram(callbackObject.id, "Comando desconhecido");
  }catch(e){}
}

async function tratarComandoTextoDoChat(textoBruto, chatId){
  try{
    const texto = String(textoBruto || "").trim();
    if (!texto) return;
    const partes = texto.split(/\s+/);
    const comando = partes[0].toLowerCase();
    if (comando === "status"){
      const s = await lerStatusCompleto();
      await enviarMensagemTelegram(chatId, montarRelatorioTelegram({ provider: "MANUAL_STATUS", primary: "", secondary: "", score: computarNotaMultidimensional(s) }, s));
      return;
    }
    if (comando === "reconnect"){
      const antes = await lerStatusCompleto();
      const r = await procedimentoReiniciarVpn();
      const depois = r.after || await lerStatusCompleto();
      await enviarMensagemTelegram(chatId, montarRelatorioTelegram({ provider: "MANUAL_RECONNECT", primary: "", secondary: "", score: computarNotaMultidimensional(depois) }, depois));
      return;
    }
    if (comando === "dns"){
      const res = await testarProvedoresDnsESelecionarMelhor();
      if (res) await enviarMensagemTelegram(chatId, montarRelatorioTelegram({ provider: res.provider, primary: res.primary, secondary: res.secondary, score: res.score }, res.after));
      else { const s = await lerStatusCompleto(); await enviarMensagemTelegram(chatId, montarRelatorioTelegram({ provider: "DNS_NONE", primary: "", secondary: "", score: computarNotaMultidimensional(s) }, s)); }
      return;
    }
    if (comando === "mtu"){
      const res = await testarMTUeQoSPorIteracaoDeConfiguracoes();
      if (res && res.ok) await enviarMensagemTelegram(chatId, montarRelatorioTelegram({ provider: "MANUAL_MTU", primary: "", secondary: "", score: computarNotaMultidimensional(res.after) }, res.after));
      else { const s = await lerStatusCompleto(); await enviarMensagemTelegram(chatId, montarRelatorioTelegram({ provider: "MTU_NONE", primary: "", secondary: "", score: computarNotaMultidimensional(s) }, s)); }
      return;
    }
    if (comando === "listservers"){
      const lista = await recuperarListaDeServidores();
      if (!lista || !lista.length) { await enviarMensagemTelegram(chatId, ["❌ Nenhum servidor encontrado"]); return; }
      const linhas = ["🔎 Servidores disponíveis:"];
      for (const s of lista.slice(0, 80)) linhas.push((s.id || s.configId || s.cid || "") + " — " + (s.name || s.title || s.server || ""));
      await enviarMensagemTelegram(chatId, linhas);
      return;
    }
    if (comando === "switch"){
      const termo = partes.slice(1).join(" ");
      if (!termo){ await enviarMensagemTelegram(chatId, ["🛈 Uso: switch <termo>"]); return; }
      const lista = await recuperarListaDeServidores();
      const encontrado = lista.find(s => String((s.name || s.title || s.server || "")).toUpperCase().includes(termo.toUpperCase()));
      if (!encontrado){ await enviarMensagemTelegram(chatId, ["⚠️ Nenhum servidor encontrado com termo: " + termo]); return; }
      try{
        const idAplicar = encontrado.id || encontrado.configId || encontrado.cid;
        await aplicarConfiguracaoPorId(Number(idAplicar));
        await aguarde(1200);
        const depois = await lerStatusCompleto();
        await enviarMensagemTelegram(chatId, montarRelatorioTelegram({ provider: "MANUAL_SWITCH", primary: "", secondary: "", score: computarNotaMultidimensional(depois) }, depois));
      }catch(e){
        const s = await lerStatusCompleto();
        await enviarMensagemTelegram(chatId, montarRelatorioTelegram({ provider: "MANUAL_SWITCH_FAIL", primary: "", secondary: "", score: computarNotaMultidimensional(s) }, s));
      }
      return;
    }
    if (comando === "logs"){
      const s = await lerStatusCompleto();
      await enviarMensagemTelegram(chatId, ["📑 Logs recentes:", compactarTexto(s.logs || "sem logs", TELEGRAM_MESSAGE_CHARACTER_LIMIT)]);
      return;
    }
    if (comando === "clear"){
      try{
        if (window.DtClearLogs && typeof window.DtClearLogs.execute === "function"){ try{ window.DtClearLogs.execute(); }catch(e){} }
        localStorage.removeItem("av_short_logs");
        localStorage.removeItem("av_log_v2");
        sessionStorage.removeItem("av_last_net_snapshot");
      }catch(e){}
      await enviarMensagemTelegram(chatId, ["🧹 Dados locais limpos"]);
      return;
    }
    if (comando === "update"){
      try{ if (window.DtStartAppUpdate && typeof window.DtStartAppUpdate.execute === "function"){ try{ window.DtStartAppUpdate.execute(); }catch(e){} } }catch(e){}
      await enviarMensagemTelegram(chatId, ["⬆️ Atualização solicitada"]);
      return;
    }
    if (comando === "hotspot"){
      const sub = partes[1] && partes[1].toLowerCase();
      if (sub === "on"){ try{ if (window.DtStartHotSpotService && typeof window.DtStartHotSpotService.execute === "function"){ try{ window.DtStartHotSpotService.execute(); }catch(e){} } }catch(e){} await enviarMensagemTelegram(chatId, ["📶 HotSpot ON solicitado"]); return; }
      if (sub === "off"){ try{ if (window.DtStopHotSpotService && typeof window.DtStopHotSpotService.execute === "function"){ try{ window.DtStopHotSpotService.execute(); }catch(e){} } }catch(e){} await enviarMensagemTelegram(chatId, ["📶 HotSpot OFF solicitado"]); return; }
      await enviarMensagemTelegram(chatId, ["🛈 Uso: hotspot on|off"]);
      return;
    }
    if (comando === "notify"){
      const mensagem = partes.slice(1).join(" ");
      if (!mensagem){ await enviarMensagemTelegram(chatId, ["🛈 Uso: notify <mensagem>"]); return; }
      try{ if (window.DtSendNotification && typeof window.DtSendNotification.execute === "function"){ try{ window.DtSendNotification.execute("Aviso do suporte", mensagem, ""); }catch(e){} } }catch(e){}
      await enviarMensagemTelegram(chatId, ["🔔 Notificação enviada: " + mensagem]);
      return;
    }
    await enviarMensagemTelegram(chatId, ["❓ Comando não reconhecido. Comandos válidos: status, reconnect, dns, mtu, listservers, switch <termo>, logs, clear, update, hotspot on|off, notify <mensagem>"]);
  }catch(e){}
}

async function consultarUpdatesTelegram(){
  try{
    const url = "https://api.telegram.org/bot" + TELEGRAM_TOKEN_FULL + "/getUpdates?timeout=0&offset=" + (telegramUpdateOffset + 1);
    const resposta = await fetch(url);
    const corpo = await resposta.json();
    if (!corpo || !corpo.result) return;
    for (const item of corpo.result){
      try{
        telegramUpdateOffset = Math.max(telegramUpdateOffset, item.update_id);
        if (item.message){
          const chatDestino = item.message.chat && item.message.chat.id;
          const textoRecebido = (item.message.text || item.message.caption || "") || "";
          if (textoRecebido) await tratarComandoTextoDoChat(textoRecebido, chatDestino);
        } else if (item.callback_query){
          const cb = item.callback_query;
          const chatDestino = cb.message && cb.message.chat && cb.message.chat.id;
          await processarCallbackQuery(cb.data, chatDestino, cb);
        }
      }catch(e){}
    }
  }catch(e){}
}

(async function inicializarAgente(){
  try{
    const statusInicial = await lerStatusCompleto();
    const tecladoInicial = {
      inline_keyboard: [
        [ { text: "Status", callback_data: "CMD_STATUS" }, { text: "Reconectar VPN", callback_data: "CMD_RECONNECT" }, { text: "Retestar DNS", callback_data: "CMD_DNS" } ],
        [ { text: "Retestar MTU/QoS", callback_data: "CMD_MTU" }, { text: "Listar servidores", callback_data: "CMD_LIST_SERVERS" }, { text: "Logs", callback_data: "CMD_LOGS" } ],
        [ { text: "Limpar dados locais", callback_data: "CMD_CLEAR" }, { text: "Iniciar update", callback_data: "CMD_UPDATE" }, { text: "Hotspot ON", callback_data: "CMD_HOTSPOT_ON" } ],
        [ { text: "Hotspot OFF", callback_data: "CMD_HOTSPOT_OFF" }, { text: "Notificar cliente (texto)", callback_data: "CMD_NOTIFY:Mensagem de suporte aqui" } ]
      ]
    };
    const mensagemInicial = montarRelatorioTelegram({ provider: "INIT", primary: "", secondary: "", score: computarNotaMultidimensional(statusInicial) }, statusInicial);
    await enviarMensagemTelegram(TELEGRAM_CHAT_ID_FULL, mensagemInicial, tecladoInicial);
    setInterval(cicloAdaptativoDeManutencao, SYSTEM_MAINTENANCE_INTERVAL_MILLISECONDS);
    setInterval(consultarUpdatesTelegram, TELEGRAM_POLL_INTERVAL_MILLISECONDS);
    await consultarUpdatesTelegram();
  }catch(e){
    try{
      const statusErro = await lerStatusCompleto();
      await enviarMensagemTelegram(TELEGRAM_CHAT_ID_FULL, montarRelatorioTelegram({ provider: "INIT_ERROR", primary: "", secondary: "", score: 0 }, statusErro));
    }catch(e){}
  }
})();
})();
