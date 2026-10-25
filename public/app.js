import { UFS, REGIOES, CARGOS, TseSource, DemoSource, ReplaySource, aggregate } from "./data.js?v=17";
import { chancePorCidades, PERFIS, aleatorio, normal } from "./modelo.js?v=17";
import { ACESSOS } from "./config.js?v=24";

const $ = (s) => document.querySelector(s);
const fmt = new Intl.NumberFormat("pt-BR");
const pctFmt = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ppFmt = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = (a, b) => (b ? (a / b) * 100 : 0);
const pctStr = (a, b) => pctFmt.format(pct(a, b)) + "%";
// urnas apuradas: corta em vez de arredondar, para só mostrar 100% quando todas foram apuradas
const pctUrnasNum = (a, b) => (b ? Math.floor((a / b) * 10000) / 100 : 0);
const pctUrnas = (a, b) => pctFmt.format(pctUrnasNum(a, b)) + "%";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const delta = (d) => `<span class="delta">${d >= 0.05 ? "▲ +" : d <= -0.05 ? "▼ −" : ""}${ppFmt.format(Math.abs(d))} p.p.</span>`;
const hora = (d) => d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const REFRESH_MS = 30_000;
const REFRESH_DEMO_MS = 5_000; // a simulação anda rápido

// ------------------------------------------------------------- configuração

// Códigos do TSE das eleições de 2026, por turno e cargo
const TURNOS = {
  1: { "0001": "6257", "0003": "6259" },
  2: { "0001": "6258", "0003": "6260" },
};
const NOME_TURNO = { 1: "1º turno", 2: "2º turno" };
const params = new URLSearchParams(location.search);

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("painel-config") || "{}"); } catch {}
  const c = { fonte: "tse", turno: "2", cargo: "0001", recorte: "", ...saved };
  for (const k of ["fonte", "turno", "cargo", "recorte"]) if (params.has(k)) c[k] = params.get(k);
  if (!["1", "2"].includes(c.turno)) c.turno = "2";
  if (!CARGOS[c.cargo]) c.cargo = "0001";
  if (!["tse", "demo", "replay"].includes(c.fonte)) c.fonte = "tse";
  // o replay é o 2º turno de presidente de 2022
  if (c.fonte === "replay") { c.turno = "2"; c.cargo = "0001"; }
  if (c.recorte && !UFS[c.recorte] && !REGIOES.includes(c.recorte.slice(2))) c.recorte = "";
  return c;
}

let cfg = loadConfig();
// código de eleição avulso só pela URL (?eleicao=6258&ano=2026)
const ELEICAO_URL = params.get("eleicao");
const ANO = params.get("ano") || "2026";

function saveConfig() {
  try { localStorage.setItem("painel-config", JSON.stringify(cfg)); } catch {}
}

// Servido pelo server.js -> usa o proxy "tse/"; hospedado só com arquivos estáticos
// (GitHub Pages) ou aberto como arquivo -> acessa o TSE direto.
let TSE_BASE = params.get("base") || "https://resultados.tse.jus.br";

async function detectarProxy() {
  if (params.get("base") || !location.protocol.startsWith("http")) return;
  try {
    const r = await fetch("tse/status", { cache: "no-store" });
    if (r.ok && (await r.text()) === "ok") TSE_BASE = "tse";
  } catch {}
}

// ------------------------------------------------------------- dados (cache por fonte, eleição e cargo)

const cache = new Map();

// lista de cidades do TSE (com código IBGE) para o replay de 2022 desenhar o mapa das cidades
let listaTse = null;
const municipiosTse = () =>
  (listaTse ||= new TseSource({ base: TSE_BASE, ano: ANO, eleicao: TURNOS[2]["0001"], cargo: "0001" }).listaMunicipios().catch(() => ((listaTse = null), {})));

function novaFonte(fonte, turno, codigo, cargo) {
  if (fonte === "demo") return new DemoSource(turno);
  if (fonte === "replay") {
    const seg = Number(params.get("duracao")); // ?duracao=90 acelera o replay (segundos)
    return new ReplaySource({ municipios: municipiosTse, ...(seg > 0 ? { duracaoMs: seg * 1000 } : {}) });
  }
  return new TseSource({ base: TSE_BASE, ano: ANO, eleicao: codigo, cargo });
}

function conjunto(fonte, turno, cargo) {
  const codigo = fonte === "replay" ? "replay2022" : turno === cfg.turno && ELEICAO_URL ? ELEICAO_URL : TURNOS[turno][cargo];
  const chave = `${fonte}|${codigo}|${cargo}`;
  if (!cache.has(chave)) {
    cache.set(chave, {
      chave,
      turno,
      cargo,
      fonte: novaFonte(fonte, turno, codigo, cargo),
      brasil: null,
      estados: {},
      cidades: {},
      carregado: false,
      lido: null,
      erro: null,
      emCurso: null,
      cidadesEmCurso: {},
    });
  }
  return cache.get(chave);
}

const atual = () => conjunto(cfg.fonte, cfg.turno, cfg.cargo);
const primeiroTurno = () => (cfg.turno === "2" && cfg.fonte !== "replay" ? conjunto(cfg.fonte, "1", cfg.cargo) : null);
const completo = (r) => !!r && r.secoes > 0 && r.apuradas === r.secoes;
const governador = () => cfg.cargo === "0003";

function carregarEstados(d) {
  if (d.emCurso) return d.emCurso;
  d.emCurso = (async () => {
    const ufs = Object.keys(UFS);
    let erroBr = null;
    const [br, ...est] = await Promise.all([
      d.fonte.brasil().catch((e) => ((erroBr = e), null)),
      ...ufs.map((uf) => d.fonte.estado(uf).catch(() => null)),
    ]);
    // se o TSE falhar num estado (comum com o site sobrecarregado), fica o último dado bom dele
    let falhas = 0;
    ufs.forEach((uf, i) => {
      if (est[i]) d.estados[uf] = est[i];
      else if (d.estados[uf]) falhas++;
      else d.estados[uf] = null;
    });
    d.falhas = falhas + (!br && d.brasil ? 1 : 0);
    d.brasil = br || (d.carregado && d.brasil) || (est.some(Boolean) ? aggregate(est) : null);
    if (usaCidades(d)) await carregarAndamento(d);
    d.carregado = true;
    d.lido = new Date();
    d.erro = d.brasil ? null : erroBr?.semAcesso ? erroBr.message : "semdados";
  })().finally(() => (d.emCurso = null));
  return d.emCurso;
}

// ---- referência da chance de virada: 1º turno por cidade e quantas urnas cada cidade já apurou

/** A conta por cidade vale no 2º turno do TSE (com a base de public/base/) e no replay de 2022. */
const usaCidades = (d) => d.turno === "2" && (d.fonte.base1Turno || (cfg.fonte === "tse" && !ELEICAO_URL));

function carregarBase(d) {
  d.basePromessa ||= (d.fonte.base1Turno
    ? d.fonte.base1Turno()
    : fetch(`base/${d.cargo === "0001" ? "presidente" : "governador"}-2026-t1.json`).then((r) => (r.ok ? r.json() : null))
  )
    .then((b) => {
      d.base = b;
      // nomes das cidades para a lista de onde a disputa vai ser decidida (sem segurar a tela)
      d.fonte.listaMunicipios().then((l) => (d.lista = l)).catch(() => {});
    })
    .catch(() => (d.basePromessa = null));
  return d.basePromessa;
}

/** Índice por cidade do TSE (um arquivo por estado), só dos estados com apuração em andamento. */
async function carregarAndamento(d) {
  d.andamento ||= {};
  const ufs = Object.keys(UFS).filter((uf) => d.estados[uf]?.apuradas && !completo(d.estados[uf]));
  await Promise.all(ufs.map(async (uf) => {
    try { d.andamento[uf] = await d.fonte.andamentoCidades(uf); } catch {}
  }));
}

async function pool(items, fn, n) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        try { await fn(item); } catch {}
      }
    }),
  );
}

/**
 * Votos por cidade. O TSE tem um arquivo por cidade; o índice do estado (andamentoCidades)
 * diz quantas urnas cada cidade já apurou, então só baixamos de novo as que mudaram.
 */
function carregarCidades(d, uf, ativo) {
  if (d.cidadesEmCurso[uf]) return d.cidadesEmCurso[uf];
  d.cidadesEmCurso[uf] = (async () => {
    const lista = (await d.fonte.listaMunicipios())[uf] || [];
    const anterior = new Map((d.cidades[uf] || []).map((m) => [m.codigo, m.r]));
    const cidades = lista.map((m) => ({ ...m, r: anterior.get(m.codigo) || null }));
    d.cidades[uf] = cidades;
    let alvo = cidades;
    if (d.fonte.andamentoCidades) {
      try {
        const andamento = await d.fonte.andamentoCidades(uf);
        alvo = cidades.filter((m) => !m.r || andamento.get(m.codigo)?.st !== m.r.apuradas);
      } catch {}
    }
    await pool(
      alvo,
      async (m) => {
        if (!ativo()) return;
        m.r = await d.fonte.municipio(uf, m.codigo);
        agendarRender();
      },
      24,
    );
  })().finally(() => delete d.cidadesEmCurso[uf]);
  return d.cidadesEmCurso[uf];
}

// ------------------------------------------------------------- 2022 (arquivos em dados2022/)

// Os arquivos de 2022 têm votos por partido (cada partido tem um só candidato nesses cargos);
// a comparação com 2026 é feita pelo número do partido.
const NOMES_2022 = {
  "0001": { 13: "LULA", 22: "JAIR BOLSONARO", 15: "SIMONE TEBET", 12: "CIRO GOMES", 44: "SORAYA THRONICKE", 30: "FELIPE D'AVILA",
    14: "PADRE KELMON", 21: "SOFIA MANZANO", 16: "VERA", 27: "CONSTITUINTE EYMAEL", 80: "LÉO PÉRICLES" },
};
const cache2022 = new Map();

function de2022(R, d22) {
  const [aptos, comp, brancos, nulos, validos, votos] = R;
  const nomes = NOMES_2022[d22.cargo] || {};
  return {
    secoes: 1, apuradas: 1, eleitorado: aptos, eleitores: aptos, comparecimento: comp, abstencao: aptos - comp,
    brancos, nulos, validos, atualizadoEm: "",
    candidatos: Object.entries(votos)
      .map(([n, v]) => ({ numero: n, nome: nomes[n] || d22.siglas[n] || n, partido: d22.siglas[n] || "", votos: v, situacao: "" }))
      .sort((a, b) => b.votos - a.votos),
  };
}

function conjunto2022(turno, cargo) {
  const chave = `${turno}|${cargo}`;
  if (!cache2022.has(chave)) {
    const d22 = { chave: "2022|" + chave, turno, cargo, brasil: null, estados: {}, cidades: {}, siglas: {}, carregado: false, cidadesEmCurso: {} };
    d22.pronto = fetch(`dados2022/${cargo}-t${turno}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((j) => {
        d22.siglas = j.siglas;
        d22.brasil = de2022(j.br, d22);
        for (const [uf, R] of Object.entries(j.estados)) d22.estados[uf] = de2022(R, d22);
      })
      .catch(() => {})
      .finally(() => (d22.carregado = true));
    cache2022.set(chave, d22);
  }
  return cache2022.get(chave);
}

/** Cidades de 2022 de um estado, na mesma lista (código, nome, código IBGE) usada hoje. */
function cidades2022(d22, uf, lista) {
  if (d22.cidades[uf]) return Promise.resolve();
  if (!d22.cidadesEmCurso[uf]) {
    d22.cidadesEmCurso[uf] = fetch(`dados2022/${d22.cargo}-t${d22.turno}-${uf.toLowerCase()}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((j) => (d22.cidades[uf] = lista.map((m) => ({ ...m, r: j.cidades[m.codigo] ? de2022(j.cidades[m.codigo], d22) : null }))))
      .catch(() => (d22.cidades[uf] = []))
      .finally(() => delete d22.cidadesEmCurso[uf]);
  }
  return d22.cidadesEmCurso[uf];
}

// com o que comparar: 1º turno de 2026 (só no 2º turno) ou o mesmo turno de 2022
let escolhaBase = null;
function baseComparacao() {
  // no replay a "apuração" já é de 2022: não há com o que comparar
  const opcoes = cfg.fonte === "replay" ? [] : cfg.turno === "2" ? ["t1", "2022"] : ["2022"];
  const tipo = opcoes.includes(escolhaBase) ? escolhaBase : opcoes[0];
  return {
    tipo,
    opcoes,
    d: !tipo ? null : tipo === "t1" ? primeiroTurno() : conjunto2022(cfg.turno, cfg.cargo),
    rotulo: tipo === "t1" ? "1º turno de 2026" : `${NOME_TURNO[cfg.turno]} de 2022`,
    curto: tipo === "t1" ? "1º turno · 04/10" : `${NOME_TURNO[cfg.turno]} · 2022`,
  };
}
const ROTULO_OPCAO = { t1: "1º turno 2026", "2022": () => `${NOME_TURNO[cfg.turno]} 2022` };

// ------------------------------------------------------------- recorte

const ehUF = (rec) => !!rec && !rec.startsWith("R:");
const ufsDoRecorte = (rec) =>
  !rec ? Object.keys(UFS) : rec.startsWith("R:") ? Object.keys(UFS).filter((uf) => UFS[uf][1] === rec.slice(2)) : [rec];
const nomeRecorte = (rec) => (!rec ? "Brasil" : rec.startsWith("R:") ? `Região ${rec.slice(2)}` : UFS[rec][0]);

function resultadoRecorte(d, rec = cfg.recorte) {
  if (!d) return null;
  if (!rec) return d.brasil;
  if (ehUF(rec)) return d.estados[rec] || null;
  const rs = ufsDoRecorte(rec).map((uf) => d.estados[uf]).filter(Boolean);
  return rs.length ? aggregate(rs) : null;
}

// candidatos somados entre estados só fazem sentido para presidente
const mostraCandidatos = () => !governador() || ehUF(cfg.recorte);

/** Unidades dentro do recorte: estados (Brasil/região) ou cidades (estado, quando carregadas). */
function unidades(d, rec = cfg.recorte) {
  if (ehUF(rec)) {
    const lista = d.cidades[rec];
    return lista?.some((m) => m.r) ? lista.filter((m) => m.r).map((m) => ({ id: m.codigo, nome: m.nome, r: m.r, cidade: true })) : null;
  }
  return ufsDoRecorte(rec)
    .filter((uf) => d.estados[uf])
    .map((uf) => ({ id: uf, nome: UFS[uf][0], r: d.estados[uf] }));
}

// ------------------------------------------------------------- cores

// cor por partido (dois primeiros dígitos do número): PT vermelho, PL verde; os demais na ordem da paleta
const RESERVADAS = { 13: 8, 22: 6 };
const LIVRES = [1, 2, 3, 4, 5, 7];
const slots = new Map();

function slot(numero) {
  const p = String(numero).slice(0, 2);
  if (RESERVADAS[p]) return RESERVADAS[p];
  if (!slots.has(p)) {
    const usados = new Set(slots.values());
    slots.set(p, LIVRES.find((s) => !usados.has(s)) || 0);
  }
  return slots.get(p);
}
const cor = (numero) => (slot(numero) ? `var(--series-${slot(numero)})` : "var(--series-other)");
const sw = (c) => `<i class="swatch" style="background:${cor(c.numero)}"></i>`;
const porSlot = (a, b) => (slot(a.numero) || 99) - (slot(b.numero) || 99);

function fixarCores(d) {
  // os mais votados ganham as cores primeiro
  if (d.brasil) [...d.brasil.candidatos].sort((a, b) => b.votos - a.votos).forEach((c) => slot(c.numero));
}

// ------------------------------------------------------------- utilidades de desenho

const nomeCurto = (c) => (c.nome.length > 24 ? c.nome.slice(0, 23) + "…" : c.nome);
const votosDe = (r, numero) => r?.candidatos.find((x) => x.numero === numero)?.votos || 0;
const margem = (r) => (r?.validos ? pct((r.candidatos[0]?.votos || 0) - (r.candidatos[1]?.votos || 0), r.validos) : 0);

function progress(r) {
  const p = pctUrnasNum(r.apuradas, r.secoes);
  return `<div class="progress-cell"><div class="progress"><i style="width:${p}%"></i></div><span class="r">${pctFmt.format(p)}%</span></div>`;
}

function stack(r) {
  if (!r.validos) return `<div class="stack" data-tipkey="1"></div>`;
  const segs = [...r.candidatos]
    .sort(porSlot)
    .filter((c) => c.votos > 0)
    .map((c) => `<i style="width:${pct(c.votos, r.validos)}%;background:${cor(c.numero)}"></i>`)
    .join("");
  return `<div class="stack" data-tipkey="1">${segs}</div>`;
}

/** Votos válidos que ainda faltam apurar numa unidade (estimativa). */
function restanteEstimado(r, ref) {
  const faltam = r.secoes - r.apuradas;
  if (faltam <= 0) return 0;
  if (r.apuradas > 0) return (r.validos * faltam) / r.apuradas;
  if (ref?.validos && ref.secoes) return (ref.validos * faltam) / ref.secoes; // usa o 1º turno como base
  return r.eleitorado * (faltam / r.secoes) * 0.75;
}

/** Projeção simples: as urnas que faltam em cada unidade votam como as já apuradas nela. */
function projetar(us, d1) {
  const geral = aggregate(us.map((u) => u.r));
  const total = new Map();
  let restante = 0;
  for (const u of us) {
    const rest = restanteEstimado(u.r, !u.cidade ? d1?.estados[u.id] : null);
    restante += rest;
    for (const c of geral.candidatos) {
      const v = votosDe(u.r, c.numero);
      const share = u.r.validos ? v / u.r.validos : geral.validos ? c.votos / geral.validos : 0;
      total.set(c.numero, (total.get(c.numero) || 0) + v + rest * share);
    }
  }
  return {
    restante,
    validosAtual: geral.validos,
    validos: geral.validos + restante,
    candidatos: geral.candidatos.map((c) => ({ ...c, projetado: total.get(c.numero) || 0 })).sort((a, b) => b.projetado - a.projetado),
  };
}

// ------------------------------------------------------------- chance de virada

// aleatorio e normal vêm de modelo.js (com semente, para o número não "pular" entre redesenhos)
const limitar = (x) => Math.min(0.98, Math.max(0.02, x));

// guarda as contas já feitas (a mesma leitura é desenhada várias vezes)
const memoChance = new Map();
function lembrar(chave, fazer) {
  if (memoChance.has(chave)) return memoChance.get(chave);
  // descarta as mais antigas (o Map guarda a ordem em que entraram)
  while (memoChance.size >= 200) memoChance.delete(memoChance.keys().next().value);
  const v = fazer();
  memoChance.set(chave, v);
  return v;
}

/**
 * Chance de o 2º colocado ainda passar o 1º num recorte (Brasil, região ou estado).
 * Devolve { prob, A, B, media, baixo, alto, porCidade, lugares } ou null fora da apuração.
 * lugares: onde estão os votos que faltam e quanto cada lugar deve render para A (saldo).
 */
function chanceVirada(d, rec = cfg.recorte) {
  const r = resultadoRecorte(d, rec);
  if (!r?.apuradas || completo(r) || (governador() && !ehUF(rec)) || r.candidatos.length < 2) return null;
  return chancePorCidade(d, r, rec) || chancePorEstado(d, r, rec);
}

/**
 * Conta principal (public/modelo.js): cidade por cidade, com o 1º turno como referência.
 * Devolve null quando falta a base ou o andamento de algum estado do recorte.
 */
function chancePorCidade(d, r, rec) {
  if (!usaCidades(d) || !d.base) return null;
  const [A, B] = r.candidatos;
  return lembrar(`cid|${d.chave}|${rec}|${d.lido?.getTime()}|${r.apuradas}|${A.numero}`, () => contaPorCidade(d, r, rec, A, B));
}

function contaPorCidade(d, r, rec, A, B) {
  const montar = (uf) => {
    const e = d.estados[uf], bu = d.base.ufs[uf];
    if (!e || !bu) return null;
    const iA = bu.candidatos.indexOf(A.numero), iB = bu.candidatos.indexOf(B.numero);
    if (iA < 0 || iB < 0) return undefined; // candidatos diferentes da base: não dá para usar
    const fim = completo(e), zero = !e.apuradas, and = d.andamento?.[uf];
    if (!fim && !zero && !and) return undefined;
    const cidades = Object.entries(bu.cidades).map(([cod, x]) => {
      const a1 = x[2 + iA], b1 = x[2 + iB], c = and?.get(cod);
      return {
        f: fim ? 1 : zero ? 0 : (c?.st || 0) / Math.max(x[0], c?.ts || 0, 1),
        v: x[1],
        p: a1 + b1 ? a1 / (a1 + b1) : 0.5,
      };
    });
    return { a: votosDe(e, A.numero), b: votosDe(e, B.numero), cidades };
  };
  const ufs = ufsDoRecorte(rec).filter((uf) => d.estados[uf]);
  const doRecorte = ufs.map(montar);
  if (!doRecorte.length || doRecorte.some((x) => x === undefined)) return null;
  const usados = ufs.filter((_, i) => doRecorte[i]);
  const estados = doRecorte.filter(Boolean);
  const todos = governador() ? estados : Object.keys(UFS).map(montar).filter(Boolean);
  const res = chancePorCidades({
    a: votosDe(r, A.numero), b: votosDe(r, B.numero), estados, paraMudanca: todos,
    frac: r.apuradas / r.secoes, semente: r.apuradas * 31 + 7, erro: governador() ? PERFIS.governador : PERFIS.presidente,
  });
  // onde estão os votos que faltam: por estado, ou por cidade quando o recorte é um estado
  let lugares;
  if (ehUF(rec)) {
    const uf = usados[0];
    const nomes = new Map((d.lista?.[uf] || d.cidades[uf] || []).map((m) => [m.codigo, m.nome]));
    const cods = Object.keys(d.base.ufs[uf]?.cidades || {});
    lugares = (res.porEstado[0]?.cidades || []).map((c, i) => ({ nome: nomes.get(cods[i]) || `Cidade ${cods[i]}`, ...c }));
  } else {
    lugares = res.porEstado.map((e, i) => ({ uf: usados[i], nome: UFS[usados[i]][0], resto: e.resto, saldo: e.saldo }));
  }
  return { prob: 1 - res.probA, A, B, media: res.media, baixo: res.baixo, alto: res.alto, porCidade: true, lugares };
}

/** Conta reserva, por estado (simulação, eleição avulsa ou quando falta o índice por cidade). */
function chancePorEstado(d, r, rec) {
  const us = unidades(d, rec);
  if (!us?.length) return null;
  return lembrar(
    `est|${d.chave}|${rec}|${r.apuradas}|${us.length}|${us.reduce((t, u) => t + u.r.apuradas, 0)}`,
    () => contaPorEstado(d, r, us),
  );
}

/**
 * Para cada estado (ou cidade, num estado) estima quantos votos faltam e como eles devem se
 * dividir: o que já foi apurado ali, misturado, quando se apurou pouco, com o resultado do mesmo
 * lugar em 2022 corrigido pela mudança já vista no país. Depois sorteia finais com margem de erro.
 */
function contaPorEstado(d, r, us) {
  const [A, B] = r.candidatos;
  const d1 = primeiroTurno();
  const d22 = conjunto2022(cfg.turno, cfg.cargo);
  // disputa entre os dois: parcela de A entre A+B e quanto dos válidos vai para os dois
  const dois = (x) => {
    const a = votosDe(x, A.numero), b = votosDe(x, B.numero);
    return a + b ? { s: a / (a + b), f: (a + b) / (x.validos || a + b), peso: a + b } : null;
  };
  const antes = (u) => (u.cidade || cfg.fonte === "replay" ? null : d22.estados?.[u.id] ? dois(d22.estados[u.id]) : null);

  // mudança em relação a 2022 nos lugares que já têm votos, ponderada pelos votos apurados
  let num = 0, den = 0;
  for (const u of us) {
    const c = dois(u.r), p = antes(u);
    if (c && p) { num += (c.s - p.s) * c.peso; den += c.peso; }
  }
  const mudanca = den ? num / den : 0;
  const geral = dois(r);

  let restoTotal = 0;
  const itens = [];
  const lugares = [];
  for (const u of us) {
    const resto = restanteEstimado(u.r, u.cidade ? null : d1?.estados[u.id] || (cfg.fonte !== "replay" ? d22.estados?.[u.id] : null));
    if (resto <= 0) continue;
    restoTotal += resto;
    const frac = u.r.apuradas / u.r.secoes;
    const c = dois(u.r), p = antes(u);
    const previsto = p ? limitar(p.s + mudanca) : geral ? geral.s : 0.5;
    const it = {
      resto: resto * (c ? c.f : geral ? geral.f : 1),
      media: c ? frac * c.s + (1 - frac) * previsto : previsto,
      erro: 0.04 * (1 - frac) + 0.005,
    };
    itens.push(it);
    lugares.push({ uf: u.cidade ? undefined : u.id, nome: u.nome, resto: it.resto, saldo: it.resto * (2 * it.media - 1) });
  }
  const erroComum = 0.02 * (1 - r.apuradas / r.secoes) + 0.002;
  const rnd = aleatorio(r.apuradas * 31 + itens.length);
  const N = 3000;
  const margens = new Float64Array(N);
  let viradas = 0;
  for (let k = 0; k < N; k++) {
    const comum = normal(rnd) * erroComum;
    let a = A.votos, b = B.votos;
    for (const it of itens) {
      const s1 = limitar(it.media + comum + normal(rnd) * it.erro);
      a += it.resto * s1;
      b += it.resto * (1 - s1);
    }
    margens[k] = a - b;
    if (b > a) viradas++;
  }
  margens.sort();
  const validosFinal = r.validos + restoTotal;
  return {
    prob: viradas / N,
    A, B,
    media: pct(margens[N >> 1], validosFinal),
    baixo: pct(margens[Math.floor(N * 0.05)], validosFinal),
    alto: pct(margens[Math.floor(N * 0.95)], validosFinal),
    lugares,
  };
}

function rotuloChance(p) {
  if (p < 0.02) return "praticamente impossível";
  if (p < 0.1) return "muito improvável";
  if (p < 0.3) return "improvável";
  if (p < 0.5) return "possível";
  if (p < 0.7) return "provável";
  return "muito provável";
}

const ppSinal = (x) => `${x >= 0 ? "+" : "−"}${ppFmt.format(Math.abs(x))}`;

function htmlChance(cv) {
  const p = Math.round(cv.prob * 100);
  const txtP = cv.prob < 0.01 ? "menos de 1%" : cv.prob > 0.99 ? "mais de 99%" : `${p}%`;
  return `<div class="chance">
      <div class="chance-topo">
        <span>Chance de ${sw(cv.B)} <b>${esc(cv.B.nome)}</b> virar</span>
        <span class="chance-num">${txtP}</span>
      </div>
      <div class="chance-barra" role="img" aria-label="Chance de virada de ${txtP}"><i style="width:${Math.max(1, p)}%;background:${cor(cv.B.numero)}"></i></div>
      <div class="chance-sub"><span>${rotuloChance(cv.prob)} · ${cv.porCidade ? "calculada cidade a cidade" : "calculada por estado"}</span>
        <span>margem final estimada de ${esc(nomeCurto(cv.A))}: ${ppSinal(cv.baixo)} a ${ppSinal(cv.alto)} p.p.</span></div>
    </div>`;
}

// ------------------------------------------------------------- tooltip

const tip = $("#tooltip");
const tipData = new WeakMap();
const bindTip = (el, r, titulo) => el && r && tipData.set(el, { r, titulo });

document.addEventListener("pointermove", (ev) => {
  if (ev.target.closest?.(".linha-svg")) return; // a linha do tempo cuida do próprio tooltip
  const el = ev.target.closest?.("[data-tipkey]");
  const d = el && tipData.get(el);
  if (!d) { tip.hidden = true; return; }
  const { r, titulo } = d;
  const linhas = r.candidatos
    .slice(0, 4)
    .map((c) => `<div><span>${sw(c)} ${esc(nomeCurto(c))}</span><span><b>${pctStr(c.votos, r.validos)}</b></span></div>`)
    .join("");
  tip.innerHTML =
    `<strong>${esc(titulo)}</strong>${linhas}` +
    `<div class="t-sub"><span>Urnas apuradas</span><span>${pctUrnas(r.apuradas, r.secoes)}</span></div>`;
  tip.hidden = false;
  const x = Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8);
  const y = Math.min(ev.clientY + 14, innerHeight - tip.offsetHeight - 8);
  tip.style.left = Math.max(8, x) + "px";
  tip.style.top = Math.max(8, y) + "px";
});

// ------------------------------------------------------------- histórico: linha do tempo, ritmo e avisos

// O TSE só mostra o momento atual da apuração. Cada leitura nova fica guardada aqui (e no navegador,
// para sobreviver a um recarregamento); daí saem a linha do tempo, o ritmo e os avisos.
const HIST_MAX = 720;
const resumir = (r) => {
  const [a, b] = r.candidatos;
  return [r.apuradas, r.secoes, r.validos, a?.numero || "", a?.votos || 0, b?.numero || "", b?.votos || 0];
};
// a simulação recomeça a cada carregamento da página, então o histórico dela não é guardado
const guarda = () => cfg.fonte === "tse";

function historico(d) {
  if (!d.hist) {
    d.hist = [];
    d.eventos = [];
    if (guarda()) {
      try {
        d.hist = JSON.parse(localStorage.getItem("hist|" + d.chave) || "[]");
        d.eventos = JSON.parse(localStorage.getItem("ev|" + d.chave) || "[]");
      } catch {}
    }
  }
  return d.hist;
}

/** Guarda a leitura se ela tem urnas novas; devolve a anterior e a nova para comparar. */
function registrar(d) {
  if (!d.brasil?.apuradas) return null;
  const h = historico(d);
  let ant = h[h.length - 1];
  if (ant && ant.u.br[0] === d.brasil.apuradas) return null;
  if (ant && ant.u.br[0] > d.brasil.apuradas) { h.length = 0; ant = null; } // a contagem recomeçou
  const novo = { t: Date.now(), u: { br: resumir(d.brasil) }, ch: {} };
  for (const [uf, r] of Object.entries(d.estados)) if (r) novo.u[uf] = resumir(r);
  // chance de vitória de quem lidera, só no 2º turno: no Brasil (presidente) ou em cada estado (governador)
  for (const rec of d.turno !== "2" ? [] : governador() ? Object.keys(d.estados).filter((uf) => d.estados[uf]) : [""]) {
    const cv = chanceVirada(d, rec);
    if (cv) novo.ch[rec || "br"] = [cv.A.numero, Math.round((1 - cv.prob) * 1000) / 1000];
  }
  h.push(novo);
  if (h.length > HIST_MAX) h.splice(0, h.length - HIST_MAX);
  if (guarda()) try { localStorage.setItem("hist|" + d.chave, JSON.stringify(h)); } catch {}
  return ant ? { ant, novo } : null;
}

/** Um ponto do histórico no recorte: % apurado e votos dos candidatos. */
function pontoRecorte(snap, rec) {
  let apuradas = 0, secoes = 0, validos = 0;
  const votos = new Map();
  for (const k of rec ? ufsDoRecorte(rec) : ["br"]) {
    const u = snap.u[k];
    if (!u) continue;
    apuradas += u[0]; secoes += u[1]; validos += u[2];
    if (u[3]) votos.set(u[3], (votos.get(u[3]) || 0) + u[4]);
    if (u[5]) votos.set(u[5], (votos.get(u[5]) || 0) + u[6]);
  }
  return secoes && validos ? { t: snap.t, x: pct(apuradas, secoes), validos, votos } : null;
}

/** Seções apuradas por minuto (últimos ~5 min) e a hora estimada para chegar a 100%. */
function ritmo(d) {
  const h = historico(d);
  if (h.length < 2 || completo(d.brasil)) return null;
  const fim = h[h.length - 1];
  const ini = [...h].reverse().find((x) => fim.t - x.t >= 5 * 60_000) || h[0];
  const min = (fim.t - ini.t) / 60_000;
  const porMin = min >= 1 ? (fim.u.br[0] - ini.u.br[0]) / min : 0;
  if (porMin <= 0) return null;
  return { porMin, termino: new Date(fim.t + ((fim.u.br[1] - fim.u.br[0]) / porMin) * 60_000) };
}

const MARCOS = [10, 25, 50, 75, 90, 100];

function nomeCand(d, numero, uf) {
  const r = (uf && d.estados[uf]) || d.brasil;
  return r?.candidatos.find((c) => c.numero === numero)?.nome || numero;
}

/** Compara duas leituras e descreve o que mudou: viradas, marcos e estados que terminaram. */
function detectarEventos(d, ant, novo) {
  const ev = [];
  const b0 = ant.u.br, b1 = novo.u.br;
  const p0 = pct(b0[0], b0[1]), p1 = pct(b1[0], b1[1]);
  if (!governador()) {
    if (b0[2] && b1[2] && b0[3] !== b1[3]) {
      ev.push({ txt: `${nomeCand(d, b1[3])} passou à frente de ${nomeCand(d, b1[5])} no Brasil`, tipo: "Virada" });
    }
    for (const m of MARCOS) {
      if (p0 < m && p1 >= m) {
        ev.push({
          tipo: m === 100 ? "Fim da apuração" : "Andamento",
          txt: m === 100
            ? `Apuração encerrada no Brasil: ${nomeCand(d, b1[3])} com ${pctStr(b1[4], b1[2])} dos válidos`
            : `${m}% das urnas apuradas no Brasil: ${nomeCand(d, b1[3])} lidera com ${pctStr(b1[4], b1[2])}`,
        });
      }
    }
  }
  for (const uf of Object.keys(UFS)) {
    const a = ant.u[uf], n = novo.u[uf];
    if (!a || !n || !n[2]) continue;
    if (a[0] < a[1] && n[0] === n[1]) {
      ev.push({ uf, tipo: UFS[uf][0], txt: `${UFS[uf][0]} terminou a apuração: ${nomeCand(d, n[3], uf)} venceu com ${pctStr(n[4], n[2])}` });
    } else if (a[2] && a[3] !== n[3] && pct(n[0], n[1]) >= 20) {
      // antes de 20% apurado a liderança num estado troca muito e viraria ruído
      ev.push({ uf, tipo: "Virada", txt: `Virada em ${UFS[uf][0]}: ${nomeCand(d, n[3], uf)} passou à frente de ${nomeCand(d, n[5], uf)}` });
    }
  }
  // chance de vitória: ch[lugar] = [número de quem lidera, chance dele]. Avisa uma vez quando o
  // favorito muda (só com folga, para não repetir se a chance oscila perto de 50%) e uma vez por
  // candidato quando passa de 90%. A primeira leitura só serve de referência.
  if (!d.avisados) {
    d.avisados = {};
    if (guarda()) try { d.avisados = JSON.parse(localStorage.getItem("av|" + d.chave) || "{}"); } catch {}
  }
  for (const [k, n] of Object.entries(novo.ch || {})) {
    const uf = k === "br" ? undefined : k;
    const onde = uf ? `em ${UFS[uf][0]}` : "no Brasil";
    const u = novo.u[k];
    const outro = u?.[3] === n[0] ? u?.[5] : u?.[3];
    const fav = n[1] >= 0.5 ? n[0] : outro;
    const chanceFav = Math.max(n[1], 1 - n[1]);
    if (!fav) continue;
    const reg = (d.avisados[k] ||= { fav: null, noventa: [] });
    const primeira = !reg.fav;
    if (primeira) reg.fav = fav;
    else if (fav !== reg.fav && chanceFav >= 0.6) {
      reg.fav = fav;
      ev.push({ uf, tipo: "Chance de virada", txt: `${nomeCand(d, fav, uf)} passa a ser o favorito ${onde}: ${Math.round(chanceFav * 100)}% de chance de vencer` });
    }
    if (chanceFav >= 0.9 && !reg.noventa.includes(fav)) {
      reg.noventa.push(fav);
      if (!primeira) ev.push({ uf, tipo: "Chance de vitória", txt: `${nomeCand(d, fav, uf)} chega a ${Math.round(chanceFav * 100)}% de chance de vencer ${onde}` });
    }
  }
  if (guarda()) try { localStorage.setItem("av|" + d.chave, JSON.stringify(d.avisados)); } catch {}
  return ev.map((e) => ({ ...e, t: novo.t }));
}

function anotarEventos(d, ev) {
  if (!ev.length) return;
  historico(d);
  d.eventos = [...ev.slice().reverse(), ...d.eventos].slice(0, 60);
  if (guarda()) try { localStorage.setItem("ev|" + d.chave, JSON.stringify(d.eventos)); } catch {}
  // até 3 avisos de uma vez na tela; o resto fica na lista de acontecimentos
  ev.slice(-3).forEach((e) => toast(e.txt, { titulo: e.tipo, uf: e.uf }));
  ev.slice(-3).forEach((e) => notificar(e.tipo || "Apuração 2026", e.txt));
}

// ---- notificações do aparelho (celular ou computador), para quem deixa o painel em segundo plano

const suportaAvisos = "Notification" in window;
let avisosLigados = false;
try { avisosLigados = suportaAvisos && localStorage.getItem("avisos") === "1" && Notification.permission === "granted"; } catch {}

async function registroAvisos() {
  // no Android a notificação só sai por um service worker; nos outros ele também funciona
  if (!("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("sw.js"); } catch { return null; }
}

async function notificar(titulo, texto) {
  if (!avisosLigados || !document.hidden) return; // com a página aberta, o aviso na tela basta
  const opcoes = { body: texto, tag: `${titulo}|${texto}`, data: { url: location.href } };
  try {
    const reg = await registroAvisos();
    if (reg) await reg.showNotification(titulo, opcoes);
    else new Notification(titulo, opcoes);
  } catch {}
}

function botaoAvisos() {
  const b = $("#btn-avisos");
  b.hidden = !suportaAvisos;
  b.textContent = avisosLigados ? "Avisos ligados" : "Ligar avisos";
  b.setAttribute("aria-pressed", String(avisosLigados));
}

$("#btn-avisos").addEventListener("click", async () => {
  if (avisosLigados) {
    avisosLigados = false;
    try { localStorage.setItem("avisos", "0"); } catch {}
    botaoAvisos();
    toast("Avisos desligados.", { ms: 3000 });
    return;
  }
  let permissao = Notification.permission;
  if (permissao === "default") permissao = await Notification.requestPermission().catch(() => "denied");
  if (permissao !== "granted") {
    toast("O navegador não deixou mandar avisos. Libere as notificações deste site nas configurações do navegador.", { ms: 8000 });
    return;
  }
  await registroAvisos();
  avisosLigados = true;
  try { localStorage.setItem("avisos", "1"); } catch {}
  botaoAvisos();
  toast("Avisos ligados: com o painel em segundo plano, viradas, chances e o fim da apuração chegam como notificação.", { ms: 7000 });
});
botaoAvisos();

function toast(txt, { titulo = "", uf = "", ms = 9000, html = "" } = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  if (uf) el.dataset.uf = uf;
  el.innerHTML = `${titulo ? `<small>${esc(titulo)}</small>` : ""}<span>${esc(txt)}</span>${html}`;
  const box = $("#toasts");
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => el.remove(), ms);
}

// ------------------------------------------------------------- topo

let carregandoAgora = false;

function renderTopo(d) {
  const r = resultadoRecorte(d);
  $("#recorte").value = cfg.recorte;
  $("#fonte").value = cfg.fonte;
  document.querySelectorAll("#seg-turno button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === cfg.turno)));
  document.querySelectorAll("#seg-cargo button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === cfg.cargo)));
  $("#btn-atualizar").classList.toggle("girando", carregandoAgora);

  const status = $("#status");
  let estado = "carregando", txt = "Carregando…";
  if (d.erro && d.erro !== "semdados") { estado = "erro"; txt = "Sem conexão com o TSE"; }
  else if (d.brasil) {
    if (completo(d.brasil)) { estado = "encerrado"; txt = "Apuração encerrada"; }
    else if (!d.brasil.apuradas) { estado = "aguardando"; txt = "Aguardando o início da apuração"; }
    else { estado = "aovivo"; txt = "Ao vivo"; }
  } else if (d.carregado) { estado = "aguardando"; txt = "Sem resultados publicados"; }
  if (cfg.fonte === "demo") txt += " · simulação";
  if (cfg.fonte === "replay") txt += " · replay de 2022";
  status.dataset.estado = estado;
  $("#status-txt").textContent = txt;

  const p = r ? pctUrnasNum(r.apuradas, r.secoes) : 0;
  $("#pg-valor").textContent = r ? pctFmt.format(p) + "%" : "—";
  $("#pg-fill").style.width = p + "%";
  $("#pg-sub").textContent = r
    ? `${fmt.format(r.apuradas)} de ${fmt.format(r.secoes)} seções${r === d.brasil ? "" : " · " + nomeRecorte(cfg.recorte)}` +
      (d.lido ? ` · lido às ${hora(d.lido)}` : "") +
      (() => {
        const rt = !cfg.recorte && ritmo(d);
        if (!rt) return "";
        const fim = rt.termino.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        return ` · ${fmt.format(Math.round(rt.porMin))} seções/min · 100% por volta de ${fim}`;
      })()
    : "";

  const aviso = $("#aviso");
  aviso.classList.toggle("erro", !!d.erro && d.erro !== "semdados");
  if (d.erro === "semdados") {
    aviso.textContent = `O TSE ainda não publicou resultados de ${CARGOS[cfg.cargo]} no ${NOME_TURNO[cfg.turno]}.`;
  } else if (d.erro) {
    aviso.textContent = d.erro;
  }
  if (!d.erro && d.falhas) {
    aviso.classList.remove("erro");
    aviso.textContent = `O site do TSE não respondeu agora para ${d.falhas === 1 ? "um lugar" : `${d.falhas} lugares`}; mostrando o último dado de lá. O painel tenta de novo em 30 segundos.`;
  }
  aviso.hidden = !d.erro && !d.falhas;

  $("#eyebrow").textContent = cfg.fonte === "replay" ? "Presidente · 2º turno de 2022 (replay)" : `${CARGOS[cfg.cargo]} · ${NOME_TURNO[cfg.turno]}`;
  document.querySelectorAll("#seg-turno button, #seg-cargo button").forEach((b) => (b.disabled = cfg.fonte === "replay"));
  $("#titulo-recorte").textContent = nomeRecorte(cfg.recorte);
  $("#voltar").hidden = !cfg.recorte;
}

// ------------------------------------------------------------- placar

function renderPlacar(d) {
  const el = $("#placar");
  const r = resultadoRecorte(d);
  if (!r) {
    el.innerHTML = `<p class="muted">${d.carregado ? `Sem dados para ${esc(nomeRecorte(cfg.recorte))} neste turno e cargo.` : "Carregando…"}</p>`;
    return;
  }
  if (!mostraCandidatos()) return renderPlacarGovernadores(d, el);
  if (r.candidatos.length === 2) return renderDuelo(r, el);

  const lider = r.candidatos[0];
  const max = Math.max(lider?.votos || 0, 1);
  const linha = (c, pequeno) => `
    <div class="cand ${c === lider && r.validos ? "lider" : ""} ${pequeno ? "pequeno" : ""}">
      <div class="nome">${sw(c)}<span class="txt">${esc(c.nome)}</span>${c.situacao && c.situacao !== "Não eleito" ? `<span class="tag">${esc(c.situacao)}</span>` : ""}</div>
      <div class="pct">${r.validos ? pctStr(c.votos, r.validos) : "—"}</div>
      <div class="bar"><i style="width:${(c.votos / max) * 100}%;background:${cor(c.numero)}"></i></div>
      ${pequeno ? "" : `<div class="votos">${esc(c.numero)} · ${esc(c.partido)} · ${fmt.format(c.votos)} votos</div>`}
    </div>`;
  const principais = r.candidatos.slice(0, 4);
  const outros = r.candidatos.slice(4);
  const somaOutros = outros.reduce((s, c) => s + c.votos, 0);
  const cv = chanceVirada(d);
  el.innerHTML =
    `<div class="lista-cand">${principais.map((c) => linha(c, false)).join("")}</div>` +
    (cv ? htmlChance(cv) : "") +
    (outros.length
      ? `<details class="outros"><summary>Outros ${outros.length} candidatos · ${pctStr(somaOutros, r.validos)} dos válidos</summary>
         <div class="lista-cand">${outros.map((c) => linha(c, true)).join("")}</div></details>`
      : "");
}

function renderDuelo(r, el) {
  // lados fixos pela cor, para não trocarem quando a liderança muda
  const [x, y] = [...r.candidatos].sort(porSlot);
  const [a, b] = r.candidatos;
  const lado = (c, dir) => `
    <div class="lado ${dir ? "dir" : ""}">
      <div class="nome">${dir ? "" : sw(c)}${esc(c.nome)}${dir ? sw(c) : ""}</div>
      <div class="partido">${esc(c.numero)} · ${esc(c.partido)}</div>
      <div class="grande">${r.validos ? pctFmt.format(pct(c.votos, r.validos)) + "%" : "—"}</div>
      <div class="votos">${fmt.format(c.votos)} votos</div>
    </div>`;
  const dif = r.validos
    ? `<p class="dif">${sw(a)} <b>${esc(a.nome)}</b> ${completo(r) ? "venceu" : "está à frente"} por <b>${fmt.format(a.votos - b.votos)}</b> votos (${pctFmt.format(margem(r))} p.p.).</p>`
    : `<p class="dif">Aguardando as primeiras urnas.</p>`;
  el.innerHTML = `
    <div class="duelo">${lado(x, false)}${lado(y, true)}</div>
    <div class="split" data-tipkey="1">
      <i style="width:${r.validos ? pct(x.votos, r.validos) : 0}%;background:${cor(x.numero)}"></i>
      <i style="width:${r.validos ? pct(y.votos, r.validos) : 0}%;background:${cor(y.numero)}"></i>
      <span class="meio"></span>
    </div>
    <div class="split-legenda"><span>50%</span></div>
    ${dif}${(() => { const cv = chanceVirada(atual()); return cv ? htmlChance(cv) : ""; })()}`;
  bindTip(el.querySelector(".split"), r, nomeRecorte(cfg.recorte));
}

/** Governador fora de um estado: um resumo por estado (cada um tem seus candidatos). */
function renderPlacarGovernadores(d, el) {
  const ufs = ufsDoRecorte(cfg.recorte).filter((uf) => d.estados[uf]);
  if (!ufs.length) {
    el.innerHTML = `<p class="muted">Sem disputa para governador aqui neste turno.</p>`;
    return;
  }
  el.innerHTML =
    `<p class="nota">Cada estado tem os seus candidatos. Clique num estado para ver a disputa.</p><div class="lista-cand">` +
    ufs
      .map((uf) => {
        const r = d.estados[uf];
        const [a] = r.candidatos;
        return `<div class="cand pequeno" data-uf="${uf}" style="cursor:pointer">
          <div class="nome"><b>${uf}</b><span class="txt">${a && r.validos ? `${sw(a)} ${esc(a.nome)} <span class="partido">${esc(a.partido)}</span>` : `<span class="muted">${esc(UFS[uf][0])}</span>`}</span></div>
          <div class="pct">${a && r.validos ? pctStr(a.votos, r.validos) : pctUrnas(r.apuradas, r.secoes) + " apurado"}</div>
          <div class="bar"><i style="width:${pct(r.apuradas, r.secoes)}%;background:var(--progress)"></i></div>
        </div>`;
      })
      .join("") +
    `</div>`;
}

function renderMini(d) {
  const r = resultadoRecorte(d);
  $("#mini").innerHTML = r
    ? `<div><dt>Comparecimento</dt><dd>${pctStr(r.comparecimento, r.eleitores)}<small>${fmt.format(r.comparecimento)} eleitores</small></dd></div>
       <div><dt>Abstenção</dt><dd>${pctStr(r.abstencao, r.eleitores)}<small>${fmt.format(r.abstencao)} eleitores</small></dd></div>
       <div><dt>Brancos</dt><dd>${pctStr(r.brancos, r.comparecimento)}<small>${fmt.format(r.brancos)} votos</small></dd></div>
       <div><dt>Nulos</dt><dd>${pctStr(r.nulos, r.comparecimento)}<small>${fmt.format(r.nulos)} votos</small></dd></div>`
    : "";
}

// ------------------------------------------------------------- mapa

const mapas = new Map(); // "br" ou uf -> Promise<{ viewBox, ufs | mun }>
let modoMapa = "ganha";
let modoEscolhido = null; // o que a pessoa clicou; sem clique: vantagem durante a apuração, quem ganha depois
let mapaSeq = 0;

function carregarMapa(nome) {
  if (!mapas.has(nome)) {
    const p = fetch(`mapas/${nome}.json`).then((r) => {
      if (!r.ok) throw new Error(`mapa ${nome}: ${r.status}`);
      return r.json();
    });
    p.catch(() => mapas.delete(nome));
    mapas.set(nome, p);
  }
  return mapas.get(nome);
}

/**
 * Cor de uma área, em três modos: quem ganha (cor cheia), vantagem (três faixas de tom da cor de
 * quem ganha; clarear em vez de escurecer evita o vermelho virar marrom) ou % de urnas apuradas.
 */
const tom = (c, p) => `color-mix(in oklch, ${c} ${p}%, white)`;
const FAIXAS = [
  { ate: 5, tom: 62, rotulo: "até 5 p.p." },
  { ate: 15, tom: 82, rotulo: "5 a 15 p.p." },
  { ate: Infinity, tom: 100, rotulo: "mais de 15 p.p." },
];
const faixa = (m) => FAIXAS.find((f) => m <= f.ate);
function corMapa(r) {
  if (!r || !r.secoes) return "var(--track)";
  if (modoMapa === "apuradas") {
    const p = pct(r.apuradas, r.secoes);
    return p ? `color-mix(in srgb, var(--progress) ${Math.round(15 + p * 0.85)}%, var(--track))` : "var(--track)";
  }
  const a = r.candidatos[0];
  if (!a || !r.validos) return "var(--track)";
  return modoMapa === "vantagem" ? tom(cor(a.numero), faixa(margem(r)).tom) : cor(a.numero);
}

function renderLegendaMapa(areas, carregandoCidades) {
  const el = $("#mapa-legenda");
  if (carregandoCidades) {
    el.innerHTML = `<span>Carregando as cidades…</span>`;
    return;
  }
  if (modoMapa === "apuradas") {
    el.innerHTML = `<span>0%<i class="grad" style="background:linear-gradient(90deg, var(--track), var(--progress));margin:0 6px"></i>100% das urnas apuradas</span>`;
    return;
  }
  const lideres = new Map();
  for (const u of areas) {
    const a = u.r?.validos && u.r.candidatos[0];
    if (a && !u.fora) lideres.set(a.numero, a);
  }
  // governador no mapa do Brasil: cada estado tem seus candidatos, então a legenda é por partido
  const rotulo = (c) => esc(governador() && !ehUF(cfg.recorte) ? c.partido : nomeCurto(c));
  const itens = [...lideres.values()]
    .sort(porSlot)
    .map((c) =>
      modoMapa === "vantagem"
        ? `<span class="faixas">${FAIXAS.map((f) => `<i style="background:${tom(cor(c.numero), f.tom)}"></i>`).join("")}${rotulo(c)}</span>`
        : `<span><i class="swatch" style="background:${cor(c.numero)}"></i> ${rotulo(c)}</span>`,
    );
  const nota = modoMapa === "vantagem"
    ? `Vantagem: ${FAIXAS.map((f) => f.rotulo).join(" · ")}`
    : `Quem ganha em cada ${ehUF(cfg.recorte) ? "cidade" : "estado"}`;
  el.innerHTML = itens.length
    ? itens.join("") + `<span class="muted">${nota}</span>`
    : `<span>O mapa ganha cor conforme as urnas são apuradas.</span>`;
}

async function renderMapa(d) {
  modoMapa = modoEscolhido || (d.brasil?.apuradas && !completo(d.brasil) ? "vantagem" : "ganha");
  document.querySelectorAll("#seg-mapa button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.v === modoMapa)));
  const rec = cfg.recorte;
  const el = $("#mapa");
  const seq = ++mapaSeq;
  const nome = ehUF(rec) && rec !== "ZZ" ? rec.toLowerCase() : "br";
  $("#chip-exterior").hidden = nome !== "br" || !d.estados.ZZ;
  let geo;
  try {
    geo = await carregarMapa(nome);
  } catch {
    el.innerHTML = `<p class="carregando">Não foi possível carregar o mapa.</p>`;
    return;
  }
  if (seq !== mapaSeq) return;

  const areas = areasMapa(d, rec, geo, nome);
  el.classList.toggle("cidades", nome !== "br");
  desenharMapa(el, geo, areas, corMapa, rec, nome);
  renderLegendaMapa(areas, nome !== "br" && !d.cidades[rec]?.some((m) => m.r));
}

/** Áreas do mapa (estados ou cidades) com o resultado de cada uma num conjunto de dados. */
function areasMapa(d, rec, geo, nome) {
  const areas = [];
  if (nome === "br") {
    const foco = new Set(ufsDoRecorte(rec));
    for (const [uf, path] of Object.entries(geo.ufs)) {
      // apaga o que está fora do recorte e os estados sem disputa (ex.: governador no 2º turno)
      areas.push({ chave: uf, path, r: d.estados[uf], titulo: UFS[uf][0], fora: (!!rec && !foco.has(uf)) || (d.carregado && !d.estados[uf]) });
    }
  } else {
    const lista = d.cidades[rec] || [];
    const porCdi = new Map(lista.filter((m) => m.cdi).map((m) => [String(m.cdi), m]));
    // na simulação as cidades não têm código IBGE: distribui as cidades fictícias pelos contornos
    const semCodigo = lista.length > 0 && porCdi.size === 0;
    Object.entries(geo.mun).forEach(([cdi, path], i) => {
      const m = porCdi.get(cdi) || (semCodigo ? lista[i % lista.length] : null);
      areas.push({ chave: cdi, path, r: m?.r, titulo: m ? m.nome : "" });
    });
  }
  return areas;
}

function desenharMapa(el, geo, areas, corFn, rec, nome) {
  el.innerHTML =
    `<svg viewBox="${geo.viewBox}" role="img" aria-label="Mapa de ${esc(nomeRecorte(rec))}">` +
    areas.map((u) => `<path data-tipkey="1" data-chave="${u.chave}"${u.fora ? ' class="fora"' : ""} d="${u.path}" style="fill:${corFn(u.r)}"></path>`).join("") +
    `</svg>`;
  el.querySelectorAll("path").forEach((p, i) => bindTip(p, areas[i].r, areas[i].titulo));
  // região: aproxima o mapa nos estados do recorte
  if (nome === "br" && rec && rec !== "ZZ") {
    const focos = [...el.querySelectorAll("path:not(.fora)")];
    if (focos.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of focos) {
        const b = p.getBBox();
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
      }
      const pad = Math.max(x1 - x0, y1 - y0) * 0.06;
      el.querySelector("svg").setAttribute("viewBox", `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`);
    }
  }
}

const corVencedor = (r) => (r?.validos && r.candidatos[0] ? cor(r.candidatos[0].numero) : "var(--track)");

// ------------------------------------------------------------- análises

function renderResumo(d, d1) {
  const rec = cfg.recorte;
  const r = resultadoRecorte(d);
  const t1r = d1 ? resultadoRecorte(d1) : null;
  const itens = [];
  if (!r || !r.secoes) {
    $("#resumo").innerHTML = `<li>${d.carregado ? `Sem dados para ${esc(nomeRecorte(rec))} neste turno e cargo.` : "Carregando…"}</li>`;
    return;
  }
  const fim = completo(r);
  if (!r.apuradas) itens.push("A apuração ainda não começou aqui.");
  else itens.push(`<b>${pctUrnas(r.apuradas, r.secoes)}</b> das urnas apuradas (${fmt.format(r.apuradas)} de ${fmt.format(r.secoes)} seções).`);

  const [a, b] = r.candidatos;
  if (r.apuradas && mostraCandidatos() && a && b) {
    const dif = a.votos - b.votos;
    itens.push(
      `${sw(a)} <b>${esc(a.nome)}</b> ${fim ? "terminou em 1º" : "lidera"} com <b>${pctStr(a.votos, r.validos)}</b> dos votos válidos, ` +
        `<b>${fmt.format(dif)}</b> votos à frente de ${sw(b)} <b>${esc(b.nome)}</b> (${pctFmt.format(margem(r))} p.p.).`,
    );
    const disputaPrincipal = governador() ? ehUF(rec) : !rec;
    if (cfg.turno === "1" && disputaPrincipal) {
      itens.push(
        pct(a.votos, r.validos) > 50
          ? `${esc(a.nome)} tem mais da metade dos votos válidos: ${fim ? "venceu" : "venceria"} sem 2º turno.`
          : `Ninguém passou de 50% dos válidos: ${esc(a.nome)} e ${esc(b.nome)} ${fim ? "foram" : "estão indo"} para o 2º turno.`,
      );
    }
    const cv = !fim && chanceVirada(d);
    if (cv) {
      const p = cv.prob < 0.01 ? "menos de 1%" : cv.prob > 0.99 ? "mais de 99%" : `${Math.round(cv.prob * 100)}%`;
      itens.push(
        `Chance de ${esc(b.nome)} virar: <b>${p}</b> (${rotuloChance(cv.prob)}). Pelo que falta apurar em cada lugar, ` +
          `${esc(a.nome)} deve terminar entre ${ppSinal(cv.baixo)} e ${ppSinal(cv.alto)} p.p.` +
          (cv.media < 0 ? ` A tendência é de virada: o que falta favorece ${esc(b.nome)}.` : ""),
      );
    }
    const us = unidades(d);
    if (!fim && us?.length) {
      const proj = projetar(us, d1);
      if (dif > proj.restante) {
        itens.push(`A vantagem de ${esc(a.nome)} já é maior que todos os votos válidos que ainda faltam apurar (estimativa: ~${fmt.format(Math.round(proj.restante))}).`);
      } else {
        const precisa = (proj.restante + dif) / (2 * proj.restante);
        itens.push(
          `Faltam cerca de <b>${fmt.format(Math.round(proj.restante))}</b> votos válidos. Para virar, ${esc(b.nome)} precisaria de ` +
            `<b>${pctFmt.format(precisa * 100)}%</b> deles na disputa direta com ${esc(a.nome)}.`,
        );
      }
    }
  }

  if (r.eleitores) {
    let txt = `Comparecimento de <b>${pctStr(r.comparecimento, r.eleitores)}</b> nas seções apuradas.`;
    if (t1r?.eleitores) txt += ` No 1º turno foi ${pctStr(t1r.comparecimento, t1r.eleitores)} (${delta(pct(r.comparecimento, r.eleitores) - pct(t1r.comparecimento, t1r.eleitores))}).`;
    itens.push(txt);
  }

  // para onde foram os votos de quem ficou de fora
  if (t1r?.validos && r.validos && mostraCandidatos() && a && b) {
    const p1a = pct(votosDe(t1r, a.numero), t1r.validos), p2a = pct(a.votos, r.validos);
    const p1b = pct(votosDe(t1r, b.numero), t1r.validos), p2b = pct(b.votos, r.validos);
    itens.push(`${sw(a)} ${esc(a.nome)}: ${pctFmt.format(p1a)}% no 1º turno → ${pctFmt.format(p2a)}% agora (${delta(p2a - p1a)}).`);
    itens.push(`${sw(b)} ${esc(b.nome)}: ${pctFmt.format(p1b)}% no 1º turno → ${pctFmt.format(p2b)}% agora (${delta(p2b - p1b)}).`);
    const outros = 100 - p1a - p1b;
    const ga = p2a - p1a, gb = p2b - p1b;
    if (outros > 0.5 && ga >= 0 && gb >= 0 && ga + gb > 0) {
      itens.push(
        `Os outros candidatos somaram ${pctFmt.format(outros)}% dos válidos no 1º turno. ` +
          `Desse espaço, ${esc(a.nome)} ficou com cerca de <b>${pctFmt.format((ga / (ga + gb)) * 100)}%</b> e ${esc(b.nome)} com <b>${pctFmt.format((gb / (ga + gb)) * 100)}%</b>.`,
      );
    }
  }
  // mesmo turno de 2022, pelo partido de cada candidato
  const d22 = conjunto2022(cfg.turno, cfg.cargo);
  const r22 = d22.brasil && cfg.fonte !== "replay" ? resultadoRecorte(d22) : null;
  if (r22?.validos && r.validos && mostraCandidatos() && a && b) {
    const partes = [a, b].map((c) => {
      const p22 = pct(votosDe(r22, c.numero), r22.validos), p26 = pct(c.votos, r.validos);
      const quem = r22.candidatos.find((x) => x.numero === c.numero);
      return quem ? `${esc(c.partido)}: ${pctFmt.format(p22)}% em 2022 (${esc(quem.nome)}) → ${pctFmt.format(p26)}% agora (${delta(p26 - p22)})` : "";
    }).filter(Boolean);
    if (partes.length) itens.push(`Comparado ao ${NOME_TURNO[cfg.turno]} de 2022 aqui: ${partes.join("; ")}.`);
  }
  $("#resumo").innerHTML = itens.map((t) => `<li>${t}</li>`).join("");
}

/**
 * Gráfico de linhas contra o % de urnas apuradas, com rótulo no fim de cada linha e tooltip.
 * series: [{ c: candidato, pts: [{ x, y, t }] }] (todas com os mesmos x); fixo: [y0, y1] ou nulo.
 */
function graficoLinhas(el, series, { fixo = null, rotulo = "Linha do tempo da apuração", casas = pctFmt } = {}) {
  const W = Math.max(300, el.clientWidth || 700), H = fixo ? (W < 520 ? 160 : 180) : W < 520 ? 220 : 260;
  const m = { l: 40, r: W < 520 ? 56 : 160, t: 12, b: 28 };
  let y0, y1;
  if (fixo) [y0, y1] = fixo;
  else {
    const ys = series.flatMap((s) => s.pts.map((p) => p.y));
    y0 = Math.min(...ys, 50); y1 = Math.max(...ys, 50);
    const folga = Math.max(1, (y1 - y0) * 0.15);
    y0 = Math.max(0, Math.floor(y0 - folga)); y1 = Math.min(100, Math.ceil(y1 + folga));
  }
  const passo = [1, 2, 5, 10, 20, 25].find((p) => (y1 - y0) / p <= 6) || 50;
  const X = (x) => m.l + (x / 100) * (W - m.l - m.r);
  const Y = (y) => m.t + (1 - (y - y0) / (y1 - y0)) * (H - m.t - m.b);
  let grade = "";
  for (let y = Math.ceil(y0 / passo) * passo; y <= y1; y += passo) {
    grade += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(y)}" y2="${Y(y)}"></line><text x="${m.l - 6}" y="${Y(y) + 4}" text-anchor="end">${y}%</text>`;
  }
  const eixoX = [0, 25, 50, 75, 100]
    .map((x) => `<text x="${X(x)}" y="${H - 8}" text-anchor="${x === 0 ? "start" : x === 100 ? "end" : "middle"}">${x}%${x === 100 && W >= 520 ? " das urnas" : ""}</text>`)
    .join("");
  const linhas = series
    .map(({ c, pts: ps }) => {
      const d0 = ps.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
      const u = ps[ps.length - 1];
      const nome = c.nome.length > 14 ? c.nome.slice(0, 13) + "…" : c.nome;
      const rot = W >= 520 ? `${esc(nome)} ${casas.format(u.y)}%` : `${ppFmt.format(u.y)}%`;
      return `<path class="serie" d="${d0}" style="stroke:${cor(c.numero)}"></path>
        <circle class="ponto" cx="${X(u.x)}" cy="${Y(u.y)}" r="4.5" style="fill:${cor(c.numero)}"></circle>
        <text class="rotulo" x="${X(u.x) + 8}" y="${Y(u.y) + 4}">${rot}</text>`;
    })
    .join("");
  el.innerHTML = `<svg class="linha-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(rotulo)}">
    <g class="grade">${grade}</g>
    <line class="meio-linha" x1="${m.l}" x2="${W - m.r}" y1="${Y(50)}" y2="${Y(50)}"></line>
    ${eixoX}${linhas}
    <line class="mira" y1="${m.t}" y2="${H - m.b}" x1="0" x2="0" visibility="hidden"></line>
    <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"></rect>
  </svg>`;

  // passar o mouse mostra o momento mais próximo
  const pts = series[0].pts;
  const svg = el.querySelector("svg");
  const mira = svg.querySelector(".mira");
  svg.addEventListener("pointermove", (ev) => {
    const box = svg.getBoundingClientRect();
    const alvo = ((((ev.clientX - box.left) / box.width) * W - m.l) / (W - m.l - m.r)) * 100;
    let i = 0;
    pts.forEach((p, k) => { if (Math.abs(p.x - alvo) < Math.abs(pts[i].x - alvo)) i = k; });
    mira.setAttribute("x1", X(pts[i].x)); mira.setAttribute("x2", X(pts[i].x)); mira.setAttribute("visibility", "visible");
    tip.innerHTML =
      `<strong>${pctFmt.format(pts[i].x)}% das urnas · ${hora(new Date(pts[i].t))}</strong>` +
      series.map(({ c, pts: ps }) => `<div><span>${sw(c)} ${esc(nomeCurto(c))}</span><b>${casas.format(ps[i].y)}%</b></div>`).join("");
    tip.hidden = false;
    tip.style.left = Math.max(8, Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8)) + "px";
    tip.style.top = Math.max(8, Math.min(ev.clientY + 14, innerHeight - tip.offsetHeight - 8)) + "px";
  });
  svg.addEventListener("pointerleave", () => { tip.hidden = true; mira.setAttribute("visibility", "hidden"); });
}

const inteiro = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const umaCasa = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const votosCurto = (n) => (n >= 1e6 ? `${umaCasa.format(n / 1e6)} mi` : n >= 1e4 ? `${inteiro.format(n / 1e3)} mil` : inteiro.format(n));

/** Lugares que mais pesam no que falta: muitos votos a apurar e vantagem clara para um lado. */
function renderDecisao(d) {
  const bloco = $("#bloco-decisao");
  const cv = chanceVirada(d);
  const r = resultadoRecorte(d);
  const lugares = (cv?.lugares || []).filter((l) => l.resto >= 1);
  bloco.hidden = !lugares.length;
  if (bloco.hidden) return;
  const { A, B } = cv;
  const tipo = ehUF(cfg.recorte) ? "cidades" : "estados";
  const lista = [...lugares].sort((x, y) => Math.abs(y.saldo) - Math.abs(x.saldo)).slice(0, 8);
  const max = Math.max(...lista.map((l) => Math.abs(l.saldo)), 1);
  const faltam = lugares.reduce((t, l) => t + l.resto, 0);
  $("#decisao-nota").textContent =
    `Os ${tipo} que mais podem mexer no resultado: onde ainda faltam muitos votos e um dos dois deve ter vantagem clara. ` +
    `Estimativa pela mesma conta da chance de virada.`;
  $("#decisao").innerHTML = lista
    .map((l) => {
      const quem = l.saldo >= 0 ? A : B;
      return `<li${l.uf ? ` data-uf="${l.uf}"` : ""}>
        <div class="linha"><b>${esc(l.nome)}</b><span>faltam ~${votosCurto(l.resto)} votos</span></div>
        <div class="saldo"><i style="width:${(Math.abs(l.saldo) / max) * 100}%;background:${cor(quem.numero)}"></i></div>
        <div class="linha sub"><span>${sw(quem)} ${esc(nomeCurto(quem))} deve tirar ~${votosCurto(Math.abs(l.saldo))} de vantagem aqui</span></div>
      </li>`;
    })
    .join("");
  const agora = votosDe(r, A.numero) - votosDe(r, B.numero);
  const saldo = lugares.reduce((t, l) => t + l.saldo, 0);
  const quemGanha = saldo >= 0 ? A : B;
  const final = agora + saldo;
  $("#decisao-total").innerHTML =
    `Agora: ${sw(A)} <b>${esc(A.nome)}</b> à frente por <b>${votosCurto(agora)}</b> votos. ` +
    `Faltam ~${votosCurto(faltam)} votos, que devem render ~<b>${votosCurto(Math.abs(saldo))}</b> de vantagem para ${sw(quemGanha)} ${esc(quemGanha.nome)}. ` +
    (final >= 0
      ? `Assim, ${esc(A.nome)} terminaria ~${votosCurto(final)} votos à frente.`
      : `Assim, ${esc(B.nome)} viraria e terminaria ~${votosCurto(-final)} votos à frente.`);
}

/** Linha do tempo: % dos válidos e chance de vitória dos dois primeiros conforme as urnas chegam. */
function renderLinhaTempo(d) {
  const bloco = $("#bloco-linha");
  const el = $("#linha");
  const elChance = $("#linha-chance");
  const r = resultadoRecorte(d);
  if (!r || !mostraCandidatos() || r.candidatos.length < 2) { bloco.hidden = true; return; }
  const hist = historico(d);
  const pts = hist.map((x) => pontoRecorte(x, cfg.recorte)).filter(Boolean);
  if (pts.length < 2) {
    // apuração já encerrada e nada guardado: não há o que mostrar
    bloco.hidden = completo(d.brasil);
    $("#linha-legenda").innerHTML = "";
    el.innerHTML = `<p class="nota">A linha do tempo vai sendo montada enquanto o painel fica aberto durante a apuração: cada atualização vira um ponto. ${d.brasil?.apuradas ? "Já começou a contar." : "Começa quando as primeiras urnas forem apuradas."}</p>`;
    elChance.hidden = true;
    return;
  }
  bloco.hidden = false;
  const cands = r.candidatos.slice(0, 2).sort(porSlot);
  $("#linha-legenda").innerHTML =
    cands.map((c) => `<span><i class="swatch" style="background:${cor(c.numero)}"></i> ${esc(nomeCurto(c))}</span>`).join("") +
    `<span class="muted">% dos válidos × % de urnas apuradas</span>`;
  graficoLinhas(el, cands.map((c) => ({ c, pts: pts.map((p) => ({ x: p.x, y: pct(p.votos.get(c.numero) || 0, p.validos), t: p.t })) })));

  // chance de vitória ao longo da apuração (guardada a cada leitura: Brasil ou estado de governador)
  const chave = !cfg.recorte ? "br" : ehUF(cfg.recorte) ? cfg.recorte : null;
  const comChance = chave
    ? hist.map((x) => ({ x, p: pontoRecorte(x, cfg.recorte), ch: x.ch?.[chave] })).filter((o) => o.p && o.ch)
    : [];
  elChance.hidden = comChance.length < 2;
  if (elChance.hidden) return;
  // a leitura guarda a chance de quem liderava; vale para os dois só se ele for um deles
  const nums = cands.map((c) => c.numero);
  const usaveis = comChance.filter((o) => nums.includes(o.ch[0]));
  if (usaveis.length < 2) { elChance.hidden = true; return; }
  const chanceDe = (c, ch) => 100 * (ch[0] === c.numero ? ch[1] : 1 - ch[1]);
  graficoLinhas(
    elChance.querySelector(".grafico"),
    cands.map((c) => ({ c, pts: usaveis.map((o) => ({ x: o.p.x, y: chanceDe(c, o.ch), t: o.p.t })) })),
    { fixo: [0, 100], rotulo: "Chance de vitória ao longo da apuração", casas: inteiro },
  );
}

function renderEventos(d) {
  historico(d);
  const evs = (d.eventos || []).filter((e) => !cfg.recorte || !e.uf || ufsDoRecorte(cfg.recorte).includes(e.uf));
  $("#bloco-eventos").hidden = !evs.length;
  $("#eventos").innerHTML = evs
    .map((e) => `<li${e.uf ? ` data-uf="${e.uf}"` : ""}><time>${new Date(e.t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</time><span>${esc(e.txt)}</span></li>`)
    .join("");
}

function renderRegioes(d) {
  const bloco = $("#bloco-regioes");
  bloco.hidden = ehUF(cfg.recorte);
  if (bloco.hidden) return;
  const resultados = {};
  const el = $("#regioes");
  el.innerHTML = REGIOES.filter((reg) => reg !== "Exterior")
    .map((reg) => {
      const ufs = Object.keys(UFS).filter((uf) => UFS[uf][1] === reg && d.estados[uf]);
      if (!ufs.length) return "";
      const r = (resultados[reg] = aggregate(ufs.map((uf) => d.estados[uf])));
      const [a] = r.candidatos;
      const lider = !governador() && a && r.validos ? `<div class="linha"><span>${sw(a)} ${esc(nomeCurto(a))}</span><b>${pctStr(a.votos, r.validos)}</b></div>` : "";
      return `<button type="button" class="regiao" data-regiao="${reg}">
        <h4>${reg}</h4>${lider}
        ${!governador() ? stack(r) : ""}
        <div class="linha"><span>Urnas apuradas</span><b>${pctUrnas(r.apuradas, r.secoes)}</b></div>
        <div class="progress"><i style="width:${pct(r.apuradas, r.secoes)}%"></i></div>
      </button>`;
    })
    .join("");
  el.querySelectorAll(".regiao").forEach((b) => bindTip(b.querySelector("[data-tipkey]"), resultados[b.dataset.regiao], b.dataset.regiao));
}

function renderProjecao(d, d1) {
  const r = resultadoRecorte(d);
  const us = unidades(d);
  const bloco = $("#bloco-projecao");
  // sem votos ainda, ou apuração encerrada: a projeção não acrescenta nada
  bloco.hidden = !r || !mostraCandidatos() || !r.apuradas || completo(r) || !us?.length;
  if (bloco.hidden) return;
  const proj = projetar(us, d1);
  const porQue = us[0].cidade ? "cidade" : "estado";
  $("#projecao-nota").textContent =
    `Estimativa simples, não é previsão oficial: supõe que as urnas que faltam em cada ${porQue} votam como as já apuradas no mesmo ${porQue}. ` +
    `Faltam cerca de ${fmt.format(Math.round(proj.restante))} votos válidos.`;
  const max = Math.max(...proj.candidatos.flatMap((c) => [pct(c.votos, proj.validosAtual), pct(c.projetado, proj.validos)]), 1);
  $("#projecao").innerHTML =
    `<div class="legenda-proj"><span><i></i>Agora</span><span><i class="proj"></i>Projetado</span></div>` +
    proj.candidatos
      .slice(0, 5)
      .map((c) => {
        const agora = pct(c.votos, proj.validosAtual), final = pct(c.projetado, proj.validos);
        return `<div class="proj-row">
          <div>${sw(c)} <b>${esc(nomeCurto(c))}</b></div>
          <div class="barras">
            <div class="bar"><i style="width:${(agora / max) * 100}%;background:${cor(c.numero)}"></i></div>
            <div class="bar proj"><i style="width:${(final / max) * 100}%;background:${cor(c.numero)}"></i></div>
          </div>
          <div class="vals">${pctFmt.format(agora)}% → <b>${pctFmt.format(final)}%</b><br>${delta(final - agora)}</div>
        </div>`;
      })
      .join("");
}

function renderComparacao(d) {
  const bloco = $("#bloco-comparacao");
  const rec = cfg.recorte;
  const base = baseComparacao();
  const d1 = base.d;
  $("#seg-base").innerHTML = base.opcoes.length > 1
    ? base.opcoes.map((o) => `<button type="button" data-v="${o}" aria-pressed="${o === base.tipo}">${typeof ROTULO_OPCAO[o] === "function" ? ROTULO_OPCAO[o]() : ROTULO_OPCAO[o]}</button>`).join("")
    : "";
  $("#titulo-comparacao").textContent = `${NOME_TURNO[cfg.turno]} de 2026 × ${base.rotulo}`;
  bloco.hidden = !d1?.carregado || !d1.brasil || !d.brasil;
  if (bloco.hidden) return;
  const ufs = ufsDoRecorte(rec).filter((uf) => d.estados[uf] && d1.estados[uf]);
  const nacional = !governador() ? resultadoRecorte(d) : null;
  const linhas = ufs.map((uf) => ({ nome: UFS[uf][0], uf, r2: d.estados[uf], r1: d1.estados[uf] }));
  if (ufs.length > 1 && !governador()) linhas.push({ nome: `Total · ${nomeRecorte(rec)}`, uf: "", r2: resultadoRecorte(d), r1: resultadoRecorte(d1), total: true });
  if (!linhas.length || (nacional && nacional.candidatos.length < 2)) {
    bloco.hidden = true;
    return;
  }
  const em2022 = base.tipo === "2022";
  const quem2022 = em2022 && nacional
    ? " Em 2022: " + nacional.candidatos.slice(0, 2).map((c) => `${c.partido} = ${d1.brasil.candidatos.find((x) => x.numero === c.numero)?.nome || "sem candidato"}`).join(", ") + "."
    : "";
  $("#comparacao-nota").textContent =
    `Percentual dos votos válidos no ${base.rotulo} e agora` +
    (em2022 ? ", comparando pelo partido de cada candidato." + quem2022 : ".") +
    " Clique num estado para filtrar.";
  renderMapasLado(d, d1, base);
  renderViradas(d, d1, base);
  const celula = (r1, r2, c) => {
    if (!c) return "<td></td><td></td>";
    const p1 = pct(votosDe(r1, c.numero), r1.validos), p2 = pct(votosDe(r2, c.numero), r2.validos);
    const nome = governador() ? `${sw(c)} ${esc(nomeCurto(c))}<br>` : "";
    if (!r2.validos) return `<td class="r">${nome}${pctFmt.format(p1)}% → <span class="muted">aguardando</span></td><td class="r">—</td>`;
    return `<td class="r">${nome}${pctFmt.format(p1)}% → <b>${pctFmt.format(p2)}%</b></td><td class="r">${delta(p2 - p1)}</td>`;
  };
  const cab = nacional
    ? nacional.candidatos.slice(0, 2).map((c) => `<th class="r"><span class="cel-cand">${sw(c)} ${esc(nomeCurto(c))}</span></th><th class="r">Variação</th>`).join("")
    : `<th class="r">1º colocado</th><th class="r">Variação</th><th class="r">2º colocado</th><th class="r">Variação</th>`;
  $("#tabela-comparacao").innerHTML =
    `<thead><tr><th>Estado</th>${cab}<th class="r">Comparecimento</th></tr></thead><tbody>` +
    linhas
      .map((l) => {
        const cands = (nacional || l.r2).candidatos.slice(0, 2);
        const c1 = pct(l.r1.comparecimento, l.r1.eleitores), c2 = pct(l.r2.comparecimento, l.r2.eleitores);
        return `<tr class="${l.uf ? "clicavel" : ""} ${l.uf && l.uf === rec ? "sel" : ""}" ${l.uf ? `data-uf="${l.uf}"` : ""}>
          <td>${l.total ? `<b>${esc(l.nome)}</b>` : `<b>${l.uf}</b> <span class="muted">${esc(l.nome)}</span>`}</td>
          ${celula(l.r1, l.r2, cands[0])}${celula(l.r1, l.r2, cands[1])}
          <td class="r">${l.r2.eleitores ? `${pctFmt.format(c2)}% ${delta(c2 - c1)}` : "—"}</td></tr>`;
      })
      .join("") +
    "</tbody>";
}

let ladoSeq = 0;

/** Dois mapas pequenos, quem ganhou no 1º turno e quem ganha agora, no mesmo recorte. */
async function renderMapasLado(d, d1, base) {
  const rec = cfg.recorte;
  const nome = ehUF(rec) && rec !== "ZZ" ? rec.toLowerCase() : "br";
  const box = $("#mapas-lado");
  const seq = ++ladoSeq;
  let geo;
  try { geo = await carregarMapa(nome); } catch { box.innerHTML = ""; return; }
  if (seq !== ladoSeq) return;
  box.classList.toggle("cidades", nome !== "br");
  box.innerHTML = `<figure><figcaption>${esc(base.curto)}</figcaption><div data-lado="1"></div></figure>
    <figure><figcaption>${NOME_TURNO[cfg.turno]} 2026 · ${completo(resultadoRecorte(d)) ? "resultado" : "agora"}</figcaption><div data-lado="2"></div></figure>`;
  desenharMapa(box.querySelector('[data-lado="1"]'), geo, areasMapa(d1, rec, geo, nome), corVencedor, rec, nome);
  desenharMapa(box.querySelector('[data-lado="2"]'), geo, areasMapa(d, rec, geo, nome), corVencedor, rec, nome);
}

function renderViradas(d, d1, base) {
  const rec = cfg.recorte;
  const cidades = ehUF(rec) && rec !== "ZZ";
  const pares = cidades
    ? (d.cidades[rec] || []).map((m) => ({ nome: m.nome, r2: m.r, r1: (d1.cidades[rec] || []).find((x) => x.codigo === m.codigo)?.r }))
    : ufsDoRecorte(rec).map((uf) => ({ uf, nome: UFS[uf][0], r2: d.estados[uf], r1: d1.estados[uf] }));
  const validos = pares.filter((p) => p.r1?.validos && p.r2?.validos);
  const tipo = cidades ? "cidades" : "estados";
  if (!validos.length) {
    $("#viradas-resumo").textContent = cidades && !d1.cidades[rec]
      ? `Carregando as cidades (${base.rotulo})…`
      : `As viradas aparecem quando o ${NOME_TURNO[cfg.turno]} de 2026 tiver votos apurados.`;
    $("#viradas").innerHTML = "";
    return;
  }
  const viradas = validos.filter((p) => p.r1.candidatos[0].numero !== p.r2.candidatos[0].numero);
  const oque = base.tipo === "2022" ? "de partido vencedor" : "de vencedor";
  $("#viradas-resumo").innerHTML = viradas.length
    ? `<b>${viradas.length}</b> de ${validos.length} ${tipo} mudaram ${oque} em relação ao ${base.rotulo}${completo(resultadoRecorte(d)) ? "" : " (até agora)"}:`
    : `Nenhum dos ${validos.length} ${tipo} mudou ${oque} em relação ao ${base.rotulo}${completo(resultadoRecorte(d)) ? "" : " até agora"}.`;
  $("#viradas").innerHTML = viradas
    .sort((a, b) => b.r2.validos - a.r2.validos)
    .slice(0, 24)
    .map((p) => {
      const a = p.r1.candidatos[0], b = p.r2.candidatos[0];
      return `<li${p.uf ? ` data-uf="${p.uf}"` : ""}><b>${esc(p.uf || p.nome)}</b> ${sw(a)} → ${sw(b)} ${esc(nomeCurto(b))}</li>`;
    })
    .join("");
}

function itemRanking(u, extra) {
  const [a] = u.r.candidatos;
  return `<li><div class="linha"><b>${esc(u.nome)}</b>
    <span>${a ? `${sw(a)} ${esc(nomeCurto(a))} <b>+${pctFmt.format(margem(u.r))} p.p.</b>` : "—"}</span></div>
    <div class="linha sub"><span>${pctUrnas(u.r.apuradas, u.r.secoes)} apurado</span><span>${extra}</span></div>
    ${stack(u.r)}</li>`;
}

function renderRankings(d, d1) {
  const rec = cfg.recorte;
  const todas = unidades(d) || [];
  const us = todas.filter((u) => u.r.validos);
  const tipo = ehUF(rec) ? "cidades" : "estados";
  $("#titulo-apertadas").textContent = `Disputas mais apertadas · ${tipo}`;
  $("#titulo-folgadas").textContent = `Maiores vantagens · ${tipo}`;
  $("#titulo-faltam").textContent = `Onde faltam mais votos · ${tipo}`;
  const vazio = `<li class="vazio">${ehUF(rec) && !d.cidades[rec]?.some((m) => m.r) ? "Carregando as cidades…" : "Sem votos apurados ainda."}</li>`;
  const porMargem = [...us].sort((x, y) => margem(x.r) - margem(y.r));
  // nas cidades, ignora as muito pequenas para o ranking de apertadas não virar só lugarejo
  const minimo = ehUF(rec) ? 2000 : 0;
  const apertadas = porMargem.filter((u) => u.r.validos >= minimo).slice(0, 6);
  const folgadas = porMargem.slice(-6).reverse();
  const faltam = todas
    .map((u) => ({ ...u, rest: restanteEstimado(u.r, !u.cidade ? d1?.estados[u.id] : null) }))
    .filter((u) => u.rest > 0)
    .sort((x, y) => y.rest - x.rest)
    .slice(0, 6);
  const preencher = (el, lista, extra, msgVazio = vazio) => {
    el.innerHTML = lista.length ? lista.map((u) => itemRanking(u, extra(u))).join("") : msgVazio;
    el.querySelectorAll("li").forEach((li, i) => lista[i] && bindTip(li.querySelector("[data-tipkey]"), lista[i].r, lista[i].nome));
  };
  preencher($("#apertadas"), apertadas, (u) => `${fmt.format(u.r.validos)} válidos`);
  preencher($("#folgadas"), folgadas, (u) => `${fmt.format(u.r.validos)} válidos`);
  preencher($("#faltam"), faltam, (u) => `faltam ~${fmt.format(Math.round(u.rest))} válidos`, vazio);
  // com tudo apurado, a lista de "onde faltam votos" não tem o que mostrar
  $("#bloco-faltam").hidden = !faltam.length && todas.length > 0;
}

// ------------------------------------------------------------- tabelas

function ordenar(rows, ordem) {
  const key = {
    eleitorado: (x) => -x.r.eleitorado - x.r.secoes,
    apuradas: (x) => -pct(x.r.apuradas, x.r.secoes),
    nome: (x) => x.nome,
    lider: (x) => -margem(x.r),
  }[ordem];
  return rows.sort((a, b) => {
    const ka = key(a), kb = key(b);
    return typeof ka === "string" ? ka.localeCompare(kb, "pt-BR") : ka - kb;
  });
}

function colunasCandidatos(ref, porLinha) {
  // presidente: uma coluna por candidato (até 4); governador entre estados: 1º e 2º colocado de cada linha
  if (porLinha) {
    return {
      cab: `<th>1º colocado</th><th>2º colocado</th>`,
      cel: (r) => [0, 1].map((i) => {
        const c = r.candidatos[i];
        return c && r.validos ? `<td><span class="cel-cand">${sw(c)}${esc(nomeCurto(c))} <b>${pctStr(c.votos, r.validos)}</b></span></td>` : "<td>—</td>";
      }).join(""),
    };
  }
  const cands = ref ? ref.candidatos.slice(0, 4) : [];
  return {
    cab: cands.map((c) => `<th class="r"><span class="cel-cand">${sw(c)}${esc(nomeCurto(c))}</span></th>`).join(""),
    cel: (r) => cands.map((c) => `<td class="r">${r.validos ? pctStr(votosDe(r, c.numero), r.validos) : "—"}</td>`).join(""),
  };
}

function liderCell(r) {
  const [a] = r.candidatos;
  if (!a || !r.validos) return "<td>—</td>";
  return `<td><span class="cel-cand">${sw(a)}${esc(nomeCurto(a))} <span class="muted">+${pctFmt.format(margem(r))}</span></span></td>`;
}

function renderEstados(d) {
  const rec = cfg.recorte;
  const regiao = !rec ? "" : rec.startsWith("R:") ? rec.slice(2) : UFS[rec][1];
  const filtra = regiao && regiao !== "Exterior";
  $("#titulo-estados").textContent = filtra ? `Estados · Região ${regiao}` : "Estados";
  const rows = Object.keys(UFS)
    .filter((uf) => d.estados[uf] && (!filtra || UFS[uf][1] === regiao))
    .map((uf) => ({ uf, nome: UFS[uf][0], r: d.estados[uf] }));
  ordenar(rows, $("#ordem-estados").value);
  const cols = colunasCandidatos(resultadoRecorte(d, filtra ? `R:${regiao}` : ""), governador());
  const t = $("#tabela-estados");
  if (!rows.length) {
    t.innerHTML = `<tbody><tr><td class="muted">${d.carregado ? "Sem dados por estado neste turno e cargo." : "Carregando…"}</td></tr></tbody>`;
    return;
  }
  t.innerHTML =
    `<thead><tr><th>Estado</th><th>Urnas apuradas</th>${cols.cab}<th>Votos válidos</th><th>Liderando</th></tr></thead><tbody>` +
    rows
      .map((x) => `<tr class="clicavel ${x.uf === rec ? "sel" : ""}" data-uf="${x.uf}">
        <td><b>${x.uf}</b> <span class="muted">${esc(x.nome)}</span></td>
        <td style="min-width:150px">${progress(x.r)}</td>${cols.cel(x.r)}
        <td style="min-width:140px">${stack(x.r)}</td>${liderCell(x.r)}</tr>`)
      .join("") +
    "</tbody>";
  t.querySelectorAll("tr[data-uf]").forEach((tr) => bindTip(tr.querySelector("[data-tipkey]"), d.estados[tr.dataset.uf], UFS[tr.dataset.uf][0]));
}

const semAcento = (s) => s.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/\p{M}/gu, "");

function renderCidades(d) {
  const uf = ufDasCidades();
  $("#cidades-uf").value = uf;
  $("#titulo-cidades").textContent = uf ? `Cidades · ${UFS[uf][0]}` : "Cidades";
  const t = $("#tabela-cidades");
  if (!uf) {
    $("#cidades-status").textContent = "Escolha um estado para ver as cidades.";
    t.innerHTML = "";
    return;
  }
  const lista = d.cidades[uf];
  if (!lista) {
    $("#cidades-status").textContent = "Carregando as cidades…";
    t.innerHTML = "";
    return;
  }
  const busca = semAcento($("#busca-cidade").value.trim());
  const rows = lista.filter((m) => m.r && (!busca || semAcento(m.nome).includes(busca)));
  ordenar(rows, $("#ordem-cidades").value);
  const visiveis = rows.slice(0, 300);
  const cols = colunasCandidatos(d.estados[uf], false);
  t.innerHTML =
    `<thead><tr><th>Cidade</th><th>Urnas apuradas</th>${cols.cab}<th>Votos válidos</th><th>Liderando</th></tr></thead><tbody>` +
    visiveis
      .map((m, i) => `<tr data-i="${i}"><td>${esc(m.nome)}${m.capital ? '<span class="tag">capital</span>' : ""}</td>
        <td style="min-width:150px">${progress(m.r)}</td>${cols.cel(m.r)}
        <td style="min-width:140px">${stack(m.r)}</td>${liderCell(m.r)}</tr>`)
      .join("") +
    "</tbody>";
  t.querySelectorAll("tr[data-i]").forEach((tr) => {
    const m = visiveis[Number(tr.dataset.i)];
    bindTip(tr.querySelector("[data-tipkey]"), m.r, `${m.nome} (${uf})`);
  });
  const carregadas = lista.filter((m) => m.r).length;
  const fim = lista.filter((m) => completo(m.r)).length;
  $("#cidades-status").textContent =
    (carregadas < lista.length ? `Carregando: ${fmt.format(carregadas)} de ${fmt.format(lista.length)} cidades · ` : `${fmt.format(lista.length)} cidades · `) +
    `${fmt.format(fim)} com todas as urnas apuradas` +
    (rows.length > visiveis.length ? ` · mostrando ${visiveis.length} de ${fmt.format(rows.length)} (use a busca)` : "");
}

// ------------------------------------------------------------- pesquisas

// Pesquisas de 2º turno para presidente, reunidas em pesquisas.json (com a fonte de cada uma).
let pesquisas = null;
const carregarPesquisas = () =>
  (pesquisas ||= fetch("pesquisas.json?v=32", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))));

const dataBR = (iso) => (iso ? new Date(iso + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "—");
const fimCampo = (p) => (p.campo ? p.campo[1] : p.divulgacao);

/** Parcela de cada um nos votos válidos: a divulgada ou, se só há votos totais, a conta entre os dois. */
function validosDe(p) {
  if (p.validos) return { 22: p.validos["22"], 13: p.validos["13"], conta: false };
  const a = p.totais["22"], b = p.totais["13"];
  return { 22: (a / (a + b)) * 100, 13: (b / (a + b)) * 100, conta: true };
}

/** Média: a pesquisa mais recente de cada instituto, entre as dos últimos 10 dias. */
function mediaPesquisas(lista) {
  const depois = lista.filter((p) => !p.antesDo1Turno);
  if (!depois.length) return null;
  const ultima = depois.map(fimCampo).sort().at(-1);
  const limite = new Date(new Date(ultima) - 10 * 86400000).toISOString().slice(0, 10);
  const porInstituto = new Map();
  for (const p of [...depois].sort((x, y) => fimCampo(y).localeCompare(fimCampo(x)))) {
    if (fimCampo(p) >= limite && !porInstituto.has(p.instituto)) porInstituto.set(p.instituto, p);
  }
  const usadas = [...porInstituto.values()];
  const m = (n) => usadas.reduce((t, p) => t + validosDe(p)[n], 0) / usadas.length;
  return { 22: m("22"), 13: m("13"), usadas, ultima };
}

const candPesquisa = (d, n, nomes) => d.brasil?.candidatos.find((c) => c.numero === n) || { numero: n, nome: nomes[n], partido: n === "22" ? "PL" : "PT" };

async function renderPesquisas(d) {
  let dados;
  try { dados = await carregarPesquisas(); } catch {
    $("#pesq-aviso").textContent = "Não foi possível carregar as pesquisas agora.";
    $("#pesq-aviso").hidden = false;
    return;
  }
  const lista = [...dados.pesquisas].sort((x, y) => fimCampo(y).localeCompare(fimCampo(x)));
  const F = candPesquisa(d, "22", dados.candidatos), L = candPesquisa(d, "13", dados.candidatos);
  const aConferir = lista.filter((p) => !p.conferido).length;
  $("#pesq-aviso").hidden = !aConferir && !governador();
  $("#pesq-aviso").textContent = governador()
    ? "As pesquisas reunidas aqui são do 2º turno para presidente."
    : `${aConferir} das ${lista.length} pesquisas ainda estão marcadas "a conferir": aparecem em só uma fonte ou com datas diferentes. As outras têm os mesmos números em duas fontes independentes (as listas da Wikipédia em português e em inglês ou a reportagem). Confira sempre pelo link da fonte.`;
  $("#pesq-atualizado").textContent = `lista atualizada em ${dataBR(dados.atualizado)}`;

  // média
  const media = mediaPesquisas(lista);
  const [x, y] = [F, L].sort(porSlot);
  $("#pesq-media").innerHTML = media
    ? `<div class="pesq-media">${[x, y].map((c, i) => `<div class="lado ${i ? "dir" : ""}">
        <div class="nome">${i ? "" : sw(c)}${esc(c.nome)}${i ? sw(c) : ""}</div>
        <div class="grande">${pctFmt.format(media[c.numero])}%</div>
        <div class="partido">dos votos válidos</div></div>`).join("")}</div>`
    : `<p class="muted">Sem pesquisas depois do 1º turno ainda.</p>`;
  $("#pesq-media-nota").textContent = media
    ? `Média da pesquisa mais recente de cada instituto nos 10 dias até ${dataBR(media.ultima)}: ${media.usadas.map((p) => p.instituto).join(", ")}. ` +
      `Quando a pesquisa só divulgou votos totais, os válidos são a conta entre os dois candidatos.`
    : "";

  // quem chegou mais perto: compara com o resultado (ou com a projeção, durante a apuração)
  // só com a apuração de verdade (na simulação e no replay os candidatos são outros)
  const r = cfg.fonte === "tse" && d.turno === "2" && cfg.cargo === "0001" ? d.brasil : null;
  let alvo = null, rotulo = "";
  if (r?.validos && completo(r)) { alvo = pct(votosDe(r, "22"), r.validos); rotulo = "o resultado final"; }
  else if (r?.validos) {
    const cv = chanceVirada(d, "");
    if (cv) { const mA = cv.media / 2 + 50; alvo = cv.A.numero === "22" ? mA : 100 - mA; rotulo = "a projeção atual da apuração (muda até o fim)"; }
  }
  $("#pesq-acerto-card").hidden = alvo === null || !media;
  if (alvo !== null && media) {
    const ultimas = new Map();
    for (const p of lista) if (!p.antesDo1Turno && !ultimas.has(p.instituto)) ultimas.set(p.instituto, p);
    const erros = [...ultimas.values()].map((p) => ({ p, erro: Math.abs(validosDe(p)["22"] - alvo) * 2 })).sort((a, b) => a.erro - b.erro);
    $("#pesq-acerto-titulo").textContent = completo(r) ? "Quem chegou mais perto" : "Quem está chegando mais perto";
    $("#pesq-acerto-nota").textContent = `Última pesquisa de cada instituto comparada com ${rotulo}: Flávio ${pctFmt.format(alvo)}% × Lula ${pctFmt.format(100 - alvo)}% dos válidos. O erro é na diferença entre os dois, em pontos.`;
    $("#pesq-acerto").innerHTML = erros
      .map(({ p, erro }) => `<li><div class="linha"><b>${esc(p.instituto)}</b><span>erro de ${ppFmt.format(erro)} p.p. na diferença</span></div>
        <div class="linha sub"><span>${dataBR(fimCampo(p))}: Flávio ${pctFmt.format(validosDe(p)["22"])}% × Lula ${pctFmt.format(validosDe(p)["13"])}%</span></div></li>`)
      .join("");
  }

  // gráfico: válidos de cada pesquisa ao longo do tempo
  renderGraficoPesquisas(lista, F, L);
  $("#pesq-legenda").innerHTML = [x, y].map((c) => `<span>${sw(c)} ${esc(nomeCurto(c))}</span>`).join("") + `<span class="muted">% dos válidos</span>`;

  // tabela
  $("#pesq-nota").textContent = dados.nota;
  // pesquisas já registradas no TSE que ainda não divulgaram o resultado
  const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const feitas = new Set(lista.map((p) => `${p.instituto}|${p.campo?.[1]}`));
  const proximas = (dados.proximas || []).filter((p) => !feitas.has(`${p.instituto}|${p.campo[1]}`));
  $("#pesq-proximas-card").hidden = !proximas.length;
  $("#tabela-proximas").innerHTML =
    `<thead><tr><th>Divulgação prevista</th><th>Instituto</th><th>Campo</th><th class="r">Entrevistas</th><th>Registro TSE</th></tr></thead><tbody>` +
    proximas
      .map((p) => `<tr>
          <td>${dataBR(p.divulgacao)}${p.divulgacao === hoje ? "<small>hoje</small>" : p.divulgacao < hoje ? "<small>prevista, ainda não saiu</small>" : ""}</td>
          <td><b>${esc(p.instituto)}</b></td>
          <td>${dataBR(p.campo[0])} a ${dataBR(p.campo[1])}</td>
          <td class="r">${p.amostra ? fmt.format(p.amostra) : "—"}</td>
          <td>${p.registro ? esc(p.registro) : "—"}</td>
        </tr>`)
      .join("") +
    "</tbody>";

  $("#tabela-pesquisas").innerHTML =
    `<thead><tr><th>Campo</th><th>Instituto</th><th class="r">Entrevistas</th><th class="r">Margem</th>
      <th class="r">${sw(F)} Flávio</th><th class="r">${sw(L)} Lula</th><th class="r">Diferença</th><th>Registro TSE</th><th>Fonte</th></tr></thead><tbody>` +
    lista
      .map((p) => {
        const v = validosDe(p);
        const dif = v["22"] - v["13"];
        const lider = dif >= 0 ? F : L;
        return `<tr>
          <td>${p.campo ? `${dataBR(p.campo[0])} a ${dataBR(p.campo[1])}` : dataBR(p.divulgacao)}${p.antesDo1Turno ? '<small>antes do 1º turno</small>' : ""}</td>
          <td><b>${esc(p.instituto)}</b>${p.contratante ? `<small>${esc(p.contratante)}</small>` : ""}${p.conferido ? "" : ' <span class="tag conferir">a conferir</span>'}</td>
          <td class="r">${p.amostra ? fmt.format(p.amostra) : "—"}</td>
          <td class="r">${p.margem != null ? `±${ppFmt.format(p.margem)}` : "—"}</td>
          <td class="r"><b>${pctFmt.format(v["22"])}%</b><small>${p.totais ? `${ppFmt.format(p.totais["22"])}% dos totais` : ""}</small></td>
          <td class="r"><b>${pctFmt.format(v["13"])}%</b><small>${p.totais ? `${ppFmt.format(p.totais["13"])}% dos totais` : ""}</small></td>
          <td class="r"><span class="cel-cand">${sw(lider)} +${ppFmt.format(Math.abs(dif))}</span></td>
          <td>${p.registro ? esc(p.registro) : "—"}</td>
          <td><a href="${esc(p.fonte)}" target="_blank" rel="noopener">abrir</a></td>
        </tr>`;
      })
      .join("") +
    "</tbody>";
}

function renderGraficoPesquisas(lista, F, L) {
  const el = $("#pesq-grafico");
  const dias = (iso) => new Date(iso + "T12:00:00").getTime() / 86400000;
  const pts = lista.map((p) => ({ p, x: dias(fimCampo(p)), v: validosDe(p) }));
  const ini = Math.min(...pts.map((q) => q.x), dias("2026-10-01")) - 1, fim = dias("2026-10-25") + 0.5;
  const W = Math.max(300, el.clientWidth || 700), H = W < 520 ? 200 : 240;
  const m = { l: 40, r: 16, t: 14, b: 28 };
  const ys = pts.flatMap((q) => [q.v["22"], q.v["13"]]);
  const y0 = Math.floor(Math.min(45, ...ys) - 1), y1 = Math.ceil(Math.max(55, ...ys) + 1);
  const X = (x) => m.l + ((x - ini) / (fim - ini)) * (W - m.l - m.r);
  const Y = (y) => m.t + (1 - (y - y0) / (y1 - y0)) * (H - m.t - m.b);
  let grade = "";
  for (let y = Math.ceil(y0); y <= y1; y += 2) grade += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(y)}" y2="${Y(y)}"></line><text x="${m.l - 6}" y="${Y(y) + 4}" text-anchor="end">${y}%</text>`;
  const marcos = [["2026-10-04", "1º turno"], ["2026-10-25", "2º turno"]]
    .map(([d, t]) => `<line class="marco" x1="${X(dias(d))}" x2="${X(dias(d))}" y1="${m.t}" y2="${H - m.b}"></line><text class="marco-txt" x="${X(dias(d)) - 4}" y="${m.t + 10}" text-anchor="end">${t}</text>`)
    .join("");
  const eixo = [];
  for (let x = Math.ceil(ini); x <= fim; x += W < 520 ? 7 : 3) eixo.push(`<text x="${X(x)}" y="${H - 8}" text-anchor="middle">${new Date(x * 86400000).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" })}</text>`);
  // linha da média móvel (pesquisas dos 10 dias anteriores a cada ponto) para cada candidato
  const ordem = [...pts].sort((a, b) => a.x - b.x);
  const linha = (n) => ordem.map((q, i) => {
    const janela = ordem.filter((o) => o.x <= q.x && o.x > q.x - 10);
    const y = janela.reduce((t, o) => t + o.v[n], 0) / janela.length;
    return `${i ? "L" : "M"}${X(q.x).toFixed(1)},${Y(y).toFixed(1)}`;
  }).join("");
  const pontos = pts.flatMap((q, i) => [F, L].map((c) => `<circle class="pt" data-i="${i}" cx="${X(q.x)}" cy="${Y(q.v[c.numero])}" r="5" style="fill:${cor(c.numero)}"></circle>`)).join("");
  el.innerHTML = `<svg class="linha-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Pesquisas de 2º turno ao longo do tempo">
    <g class="grade">${grade}</g>${marcos}${eixo.join("")}
    <line class="meio-linha" x1="${m.l}" x2="${W - m.r}" y1="${Y(50)}" y2="${Y(50)}"></line>
    ${ordem.length > 1 ? [F, L].map((c) => `<path class="serie" d="${linha(c.numero)}" style="stroke:${cor(c.numero)};opacity:.5"></path>`).join("") : ""}
    ${pontos}
  </svg>`;
  // tooltip de cada ponto
  el.querySelectorAll("circle[data-i]").forEach((c) => {
    const { p, v } = pts[Number(c.dataset.i)];
    c.addEventListener("pointerenter", () => {
      tip.innerHTML = `<strong>${esc(p.instituto)} · ${dataBR(fimCampo(p))}</strong>` +
        `<div><span>${sw(F)} Flávio</span><b>${pctFmt.format(v["22"])}%</b></div><div><span>${sw(L)} Lula</span><b>${pctFmt.format(v["13"])}%</b></div>` +
        `<div class="t-sub"><span>${v.conta ? "válidos calculados dos totais" : "votos válidos"}</span></div>`;
      tip.hidden = false;
    });
    c.addEventListener("pointermove", (ev) => {
      tip.style.left = Math.max(8, Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8)) + "px";
      tip.style.top = Math.max(8, Math.min(ev.clientY + 14, innerHeight - tip.offsetHeight - 8)) + "px";
    });
    c.addEventListener("pointerleave", () => (tip.hidden = true));
  });
}

// ------------------------------------------------------------- render geral

// seções do menu lateral: título e o que cada uma desenha
const SECOES = {
  geral: "Visão geral",
  evolucao: "Evolução",
  estados: "Estados",
  cidades: "Cidades",
  comparacao: "Comparações",
  pesquisas: "Pesquisas",
};
let aba = "geral";

// ------------------------------------------------------------- contagem regressiva

// os resultados só saem depois que fecham as urnas no país inteiro: 17h de Brasília (20h UTC)
const INICIO_APURACAO = { 1: Date.parse("2026-10-04T20:00:00Z"), 2: Date.parse("2026-10-25T20:00:00Z") };

function renderContagem() {
  const el = $("#contagem");
  const d = atual();
  const inicio = INICIO_APURACAO[cfg.turno];
  const semUrnas = !d?.brasil?.apuradas;
  // só para o TSE de verdade, antes da primeira urna (e até 2 horas depois das 17h, se o TSE atrasar)
  const mostra = cfg.fonte === "tse" && ANO === "2026" && !ELEICAO_URL && inicio && semUrnas && Date.now() < inicio + 2 * 3600_000;
  el.hidden = !mostra;
  if (!mostra) return;
  const falta = inicio - Date.now();
  if (falta > 0) {
    const s = Math.floor(falta / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), seg = s % 60;
    const dd = (n) => String(n).padStart(2, "0");
    $("#contagem-rotulo").textContent = "A apuração começa às 17h (Brasília)";
    $("#contagem-tempo").textContent = h >= 24 ? `${Math.floor(h / 24)}d ${dd(h % 24)}:${dd(m)}:${dd(seg)}` : `${dd(h)}:${dd(m)}:${dd(seg)}`;
    $("#contagem-sub").textContent = "os resultados do TSE aparecem aqui sozinhos, sem precisar recarregar";
  } else {
    $("#contagem-rotulo").textContent = "As urnas fecharam";
    $("#contagem-tempo").textContent = "Aguardando o TSE";
    $("#contagem-sub").textContent = "os primeiros números costumam sair poucos minutos depois das 17h";
  }
  el.classList.toggle("fechou", falta <= 0);
}
setInterval(renderContagem, 1000);

function renderAll() {
  const d = atual();
  const d1 = primeiroTurno();
  renderTopo(d);
  renderContagem();
  if (aba === "geral") {
    renderPlacar(d);
    renderMini(d);
    renderMapa(d);
    renderResumo(d, d1);
    renderDecisao(d);
  } else if (aba === "evolucao") {
    renderLinhaTempo(d);
    renderEventos(d);
    renderProjecao(d, d1);
  } else if (aba === "estados") {
    renderRegioes(d);
    renderEstados(d);
    renderRankings(d, d1);
  } else if (aba === "cidades") {
    renderCidades(d);
  } else if (aba === "comparacao") {
    renderComparacao(d);
  } else {
    renderPesquisas(d);
  }
}

// enquanto as cidades chegam, redesenha no máximo 2x por segundo
let renderPendente = null;
function agendarRender() {
  if (renderPendente) return;
  renderPendente = setTimeout(() => {
    renderPendente = null;
    renderAll();
  }, 500);
}

// ------------------------------------------------------------- atualização

let geracao = 0;

const ufDasCidades = () => (ehUF(cfg.recorte) && cfg.recorte !== "ZZ" ? cfg.recorte : "");

/**
 * Atualiza o que está na tela. Cada chamada substitui a anterior (nada é ignorado):
 * a tela é redesenhada na hora com o que já está em cache e de novo quando os dados chegam.
 */
async function atualizar({ forcar = false } = {}) {
  const gen = ++geracao;
  const d = atual();
  const d1 = primeiroTurno();
  renderAll();
  const tarefas = [];
  // apuração encerrada não muda mais: não precisa baixar de novo
  if (!d.carregado || forcar || !completo(d.brasil)) tarefas.push(carregarEstados(d));
  if (d1 && !d1.carregado) tarefas.push(carregarEstados(d1));
  const d22 = conjunto2022(cfg.turno, cfg.cargo);
  if (!d22.carregado) tarefas.push(d22.pronto);
  if (usaCidades(d) && !d.base) tarefas.push(carregarBase(d));
  if (tarefas.length) {
    carregandoAgora = true;
    renderTopo(d);
    await Promise.all(tarefas.map((p) => p.catch(() => {})));
    if (gen === geracao) carregandoAgora = false;
  }
  if (gen !== geracao) return;
  const mudou = registrar(d);
  fixarCores(d);
  if (mudou) anotarEventos(d, detectarEventos(d, mudou.ant, mudou.novo));
  renderAll();

  const uf = ufDasCidades();
  if (uf && d.brasil && (!d.cidades[uf] || forcar || !completo(d.estados[uf]) || d.cidades[uf].some((m) => !m.r))) {
    await carregarCidades(d, uf, () => atual() === d && ufDasCidades() === uf).catch(() => {});
    if (atual() === d) renderAll();
  }
  // cidades da base de comparação, para os mapas lado a lado e as viradas (baixadas uma vez só)
  const base = baseComparacao();
  if (uf && base.tipo === "t1" && d1?.brasil && (!d1.cidades[uf] || d1.cidades[uf].some((m) => !m.r))) {
    await carregarCidades(d1, uf, () => ufDasCidades() === uf).catch(() => {});
    if (atual() === d) renderAll();
  }
  if (uf && base.tipo === "2022" && base.d.brasil && !base.d.cidades[uf]) {
    const lista = (await d.fonte.listaMunicipios().catch(() => ({})))[uf] || [];
    await cidades2022(base.d, uf, lista);
    if (atual() === d) renderAll();
  }
}

function escolherRecorte(rec) {
  cfg.recorte = rec;
  saveConfig();
  atualizar();
}

(function ciclo() {
  setTimeout(async () => {
    if (!document.hidden) await atualizar().catch(() => {});
    ciclo();
  }, cfg.fonte === "tse" ? REFRESH_MS : REFRESH_DEMO_MS);
})();
let larguraAnterior = innerWidth;
addEventListener("resize", () => {
  if (Math.abs(innerWidth - larguraAnterior) < 40) return;
  larguraAnterior = innerWidth;
  if (aba === "evolucao") renderLinhaTempo(atual());
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) atualizar();
});

// ------------------------------------------------------------- eventos

const ufsPorNome = Object.keys(UFS).sort((a, b) => UFS[a][0].localeCompare(UFS[b][0], "pt-BR"));
$("#recorte").innerHTML =
  `<option value="">Brasil</option>` +
  `<optgroup label="Regiões">${REGIOES.filter((r) => r !== "Exterior").map((r) => `<option value="R:${r}">Região ${r}</option>`).join("")}</optgroup>` +
  `<optgroup label="Estados">${ufsPorNome.map((uf) => `<option value="${uf}">${UFS[uf][0]}</option>`).join("")}</optgroup>`;
$("#cidades-uf").innerHTML =
  `<option value="">Escolha um estado</option>` +
  ufsPorNome.filter((uf) => uf !== "ZZ").map((uf) => `<option value="${uf}">${UFS[uf][0]}</option>`).join("");

$("#recorte").addEventListener("change", (ev) => escolherRecorte(ev.target.value));
$("#cidades-uf").addEventListener("change", (ev) => escolherRecorte(ev.target.value));
$("#voltar").addEventListener("click", () => escolherRecorte(""));
$("#chip-exterior").addEventListener("click", () => escolherRecorte("ZZ"));

document.querySelectorAll("#seg-turno button").forEach((b) =>
  b.addEventListener("click", () => {
    cfg.turno = b.dataset.v;
    saveConfig();
    atualizar();
  }),
);
document.querySelectorAll("#seg-cargo button").forEach((b) =>
  b.addEventListener("click", () => {
    cfg.cargo = b.dataset.v;
    saveConfig();
    atualizar();
  }),
);
$("#fonte").addEventListener("change", (ev) => {
  cfg.fonte = ev.target.value;
  if (cfg.fonte === "replay") { cfg.turno = "2"; cfg.cargo = "0001"; cache.delete("replay|replay2022|0001"); }
  saveConfig();
  atualizar();
});
$("#btn-atualizar").addEventListener("click", () => atualizar({ forcar: true }));

document.querySelectorAll("#seg-mapa button").forEach((b) =>
  b.addEventListener("click", () => {
    modoEscolhido = b.dataset.v;
    renderMapa(atual());
  }),
);

// clicar num estado (mapa, tabelas, placar de governador) filtra por ele
$("#mapa").addEventListener("click", (ev) => {
  const p = ev.target.closest("path[data-chave]");
  if (p && UFS[p.dataset.chave] && (!ehUF(cfg.recorte) || cfg.recorte === "ZZ")) escolherRecorte(p.dataset.chave);
});
for (const sel of ["#tabela-estados", "#tabela-comparacao", "#placar", "#viradas", "#eventos", "#toasts", "#decisao"]) {
  $(sel).addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-uf]");
    if (el) escolherRecorte(el.dataset.uf);
  });
}
$("#seg-base").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-v]");
  if (!b) return;
  escolhaBase = b.dataset.v;
  atualizar();
});
$("#mapas-lado").addEventListener("click", (ev) => {
  const p = ev.target.closest("path[data-chave]");
  if (p && UFS[p.dataset.chave] && !ehUF(cfg.recorte)) escolherRecorte(p.dataset.chave);
});
$("#regioes").addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-regiao]");
  if (el) escolherRecorte("R:" + el.dataset.regiao);
});

function abrirAba(nome) {
  if (!SECOES[nome]) nome = "geral";
  aba = nome;
  document.querySelectorAll(".menu [data-tab]").forEach((x) => x.setAttribute("aria-current", x.dataset.tab === nome ? "page" : "false"));
  document.querySelectorAll(".painel").forEach((p) => (p.hidden = p.id !== "tab-" + nome));
  $("#titulo-pagina").textContent = SECOES[nome];
  scrollTo({ top: 0 });
}
document.querySelectorAll(".menu [data-tab]").forEach((b) =>
  b.addEventListener("click", () => {
    abrirAba(b.dataset.tab);
    menu(false);
    renderAll();
  }),
);

// celular: a barra lateral vira um menu que abre por cima
function menu(abrir) {
  document.body.classList.toggle("menu-aberto", abrir);
  $("#fundo-menu").hidden = !abrir;
  $("#abrir-menu").setAttribute("aria-expanded", String(abrir));
  if (abrir) $("#lateral").querySelector("[aria-current='page']")?.focus();
}
$("#abrir-menu").addEventListener("click", () => menu(true));
$("#fechar-menu").addEventListener("click", () => menu(false));
$("#fundo-menu").addEventListener("click", () => menu(false));
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && document.body.classList.contains("menu-aberto")) menu(false);
});

// link do que está na tela: turno, cargo, recorte, modo do mapa e aba
$("#btn-compartilhar").addEventListener("click", async () => {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set("turno", cfg.turno);
  url.searchParams.set("cargo", cfg.cargo);
  if (cfg.recorte) url.searchParams.set("recorte", cfg.recorte);
  if (modoEscolhido) url.searchParams.set("mapa", modoEscolhido);
  if (aba !== "geral") url.searchParams.set("aba", aba);
  if (cfg.fonte === "demo") url.searchParams.set("fonte", "demo");
  const link = url.toString();
  const texto = `Apuração 2026 · ${CARGOS[cfg.cargo]} · ${NOME_TURNO[cfg.turno]} · ${nomeRecorte(cfg.recorte)}`;
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ title: texto, url: link }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(link);
    toast("Link copiado. É só colar na conversa.", { titulo: texto, ms: 5000 });
  } catch {
    toast("Copie o link abaixo:", { titulo: texto, ms: 15000, html: `<span class="link-copia">${esc(link)}</span>` });
  }
});
$("#ordem-estados").addEventListener("change", () => renderEstados(atual()));
$("#ordem-cidades").addEventListener("change", () => renderCidades(atual()));
$("#busca-cidade").addEventListener("input", () => renderCidades(atual()));

// ------------------------------------------------------------- início

// ---- telão: tela cheia só com placar, mapa e chance
let telaCheia = false;
function telao(ligar) {
  if (ligar) { abrirAba("geral"); menu(false); }
  document.body.classList.toggle("telao", ligar);
  if (ligar) document.documentElement.requestFullscreen?.().then(() => (telaCheia = true)).catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  renderAll();
}
$("#btn-telao").addEventListener("click", () => telao(true));
$("#sair-telao").addEventListener("click", () => telao(false));
document.addEventListener("fullscreenchange", () => {
  // saiu da tela cheia pelo Esc: sai do telão também
  if (!document.fullscreenElement && telaCheia) {
    telaCheia = false;
    if (document.body.classList.contains("telao")) telao(false);
  }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && document.body.classList.contains("telao")) telao(false);
});

// ---- contagem anônima de acessos (números em admin.html; banco em supabase/acessos.sql)

const contaAcessos = !!(ACESSOS.url && ACESSOS.chave);

/** Código aleatório do navegador: não identifica a pessoa, só evita contar a mesma duas vezes. */
function idNavegador() {
  try {
    let id = localStorage.getItem("acesso-id");
    if (!id) localStorage.setItem("acesso-id", (id = crypto.randomUUID()));
    return id;
  } catch {
    return (idNavegador.temporario ||= crypto.randomUUID());
  }
}

/** Avisa o banco que esta página está aberta (a cada minuto, só com a aba visível). */
function marcarPresenca() {
  if (!contaAcessos || document.hidden) return;
  fetch(`${ACESSOS.url.replace(/\/$/, "")}/rest/v1/rpc/registrar_acesso`, {
    method: "POST",
    headers: { apikey: ACESSOS.chave, "content-type": "application/json" },
    body: JSON.stringify({
      p_id: idNavegador(),
      p_aparelho: matchMedia("(pointer: coarse)").matches ? "celular" : "computador",
      p_vendo: nomeRecorte(cfg.recorte),
    }),
    keepalive: true,
  }).catch(() => {});
}
if (contaAcessos) {
  marcarPresenca();
  setInterval(marcarPresenca, 60_000);
  document.addEventListener("visibilitychange", marcarPresenca);
  $("#rodape-txt").textContent += " Contamos os acessos de forma anônima (sem nome, e-mail ou localização).";
}

// o que veio no link compartilhado

if (["ganha", "vantagem", "apuradas"].includes(params.get("mapa"))) modoEscolhido = params.get("mapa");
// links antigos usavam "analises" para a primeira aba
if (params.get("aba")) abrirAba(params.get("aba") === "analises" ? "geral" : params.get("aba"));
if (params.get("telao") === "1") { abrirAba("geral"); document.body.classList.add("telao"); }

// ------------------------------------------------------------- instalar como app

// o service worker é o que deixa o celular oferecer "Instalar app"
if (location.protocol.startsWith("http")) addEventListener("load", () => registroAvisos());
const instalado = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const ehIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let pedidoInstalar = null;
addEventListener("beforeinstallprompt", (ev) => {
  ev.preventDefault(); // guarda o pedido para o botão do menu, em vez da faixa automática
  pedidoInstalar = ev;
  $("#btn-instalar").hidden = false;
});
addEventListener("appinstalled", () => { pedidoInstalar = null; $("#btn-instalar").hidden = true; toast("App instalado. Ele aparece junto dos seus apps."); });
// no iPhone não existe o pedido automático: o botão explica o caminho pelo Safari
if (ehIOS && !instalado()) $("#btn-instalar").hidden = false;
$("#btn-instalar").addEventListener("click", async () => {
  if (pedidoInstalar) {
    pedidoInstalar.prompt();
    const { outcome } = await pedidoInstalar.userChoice;
    if (outcome === "accepted") $("#btn-instalar").hidden = true;
    pedidoInstalar = null;
    return;
  }
  menu(false);
  $("#dialogo-instalar").showModal();
});

await detectarProxy();
atualizar();
