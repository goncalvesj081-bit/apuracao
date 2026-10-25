// Camada de dados: lê os JSON públicos do TSE (resultados.tse.jus.br) ou gera
// uma simulação, e devolve tudo num formato único:
//
//   { secoes, apuradas, eleitorado, eleitores, comparecimento, abstencao, brancos, nulos,
//     validos, atualizadoEm, candidatos: [{ numero, nome, partido, votos, situacao }] }
//
// eleitorado = total de eleitores aptos; eleitores = aptos nas seções já apuradas
// (é a base do comparecimento e da abstenção).

export const UFS = {
  AC: ["Acre", "Norte"], AM: ["Amazonas", "Norte"], AP: ["Amapá", "Norte"], PA: ["Pará", "Norte"],
  RO: ["Rondônia", "Norte"], RR: ["Roraima", "Norte"], TO: ["Tocantins", "Norte"],
  AL: ["Alagoas", "Nordeste"], BA: ["Bahia", "Nordeste"], CE: ["Ceará", "Nordeste"], MA: ["Maranhão", "Nordeste"],
  PB: ["Paraíba", "Nordeste"], PE: ["Pernambuco", "Nordeste"], PI: ["Piauí", "Nordeste"],
  RN: ["Rio Grande do Norte", "Nordeste"], SE: ["Sergipe", "Nordeste"],
  DF: ["Distrito Federal", "Centro-Oeste"], GO: ["Goiás", "Centro-Oeste"], MS: ["Mato Grosso do Sul", "Centro-Oeste"],
  MT: ["Mato Grosso", "Centro-Oeste"],
  ES: ["Espírito Santo", "Sudeste"], MG: ["Minas Gerais", "Sudeste"], RJ: ["Rio de Janeiro", "Sudeste"], SP: ["São Paulo", "Sudeste"],
  PR: ["Paraná", "Sul"], RS: ["Rio Grande do Sul", "Sul"], SC: ["Santa Catarina", "Sul"],
  ZZ: ["Exterior", "Exterior"],
};

export const REGIOES = ["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul", "Exterior"];

export const CARGOS = { "0001": "Presidente", "0003": "Governador" };

const int = (v) => Number.parseInt(String(v ?? "0").replace(/\D/g, ""), 10) || 0;

export function emptyResult() {
  return { secoes: 0, apuradas: 0, eleitorado: 0, eleitores: 0, comparecimento: 0, abstencao: 0, brancos: 0, nulos: 0, validos: 0, atualizadoEm: "", candidatos: [] };
}

/** Soma vários resultados (usado para regiões e, se faltar o arquivo BR, para o país). */
export function aggregate(results) {
  const out = emptyResult();
  const cands = new Map();
  for (const r of results) {
    if (!r) continue;
    for (const k of ["secoes", "apuradas", "eleitorado", "eleitores", "comparecimento", "abstencao", "brancos", "nulos", "validos"]) out[k] += r[k];
    if (r.atualizadoEm > out.atualizadoEm) out.atualizadoEm = r.atualizadoEm;
    for (const c of r.candidatos) {
      const acc = cands.get(c.numero) || { ...c, votos: 0 };
      acc.votos += c.votos;
      cands.set(c.numero, acc);
    }
  }
  out.candidatos = [...cands.values()].sort((a, b) => b.votos - a.votos);
  return out;
}

// ---------------------------------------------------------------- TSE

// Formato atual (2024+): dados/{uf}/{abr}-c{cargo}-e{eleicao}-u.json, com os totais
// em s (seções), e (eleitorado) e v (votos) e os candidatos em carg[].agr[].par[].cand[].
function parseTse(j) {
  const s = j.s || {}, e = j.e || {}, v = j.v || {};
  const candidatos = [];
  for (const cargo of j.carg || []) {
    for (const agr of cargo.agr || []) {
      for (const par of agr.par || []) {
        for (const c of par.cand || []) {
          candidatos.push({
            numero: String(c.n),
            nome: c.nmu || c.nm,
            partido: par.sg || agr.com || "",
            votos: int(c.vap),
            situacao: c.st || "",
          });
        }
      }
    }
  }
  return {
    secoes: int(s.ts),
    apuradas: int(s.st),
    eleitorado: int(e.te),
    eleitores: int(e.est ?? e.te),
    comparecimento: int(e.c),
    abstencao: int(e.a),
    brancos: int(v.vb),
    nulos: int(v.tvn),
    validos: int(v.vv),
    atualizadoEm: j.dt && j.ht ? `${j.dt.split("/").reverse().join("-")} ${j.ht}` : "",
    candidatos: candidatos.sort((a, b) => b.votos - a.votos),
  };
}

// até quando os downloads de cidades devem esperar depois de um 429 do TSE
let pausaTse = 0;
export const tseOcupado = () => Date.now() < pausaTse;

export class TseSource {
  /** @param {{base: string, ano: string, eleicao: string, cargo: string}} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.municipios = null;
  }

  get root() {
    return `${this.cfg.base}/oficial/ele${this.cfg.ano}/${this.cfg.eleicao}`;
  }

  /**
   * Busca um arquivo do TSE. Na noite da apuração o site limita os pedidos (429) e às vezes recusa
   * (403/5xx ou falha de rede): tenta de novo com espera crescente e avisa os downloads de cidades
   * para darem uma pausa (tseOcupado).
   */
  async json(url, tentativas = 3) {
    for (let i = 0; ; i++) {
      let r = null;
      try {
        r = await fetch(url, { cache: "no-store" });
      } catch {}
      if (r?.ok) return r.json();
      if (r?.status === 429) {
        const espera = Math.min(60, Number(r.headers.get("retry-after")) || 15);
        pausaTse = Math.max(pausaTse, Date.now() + espera * 1000);
      }
      const tentaDeNovo = !r || r.status === 429 || r.status === 403 || r.status >= 500;
      if (!tentaDeNovo || i + 1 >= tentativas) {
        if (r) throw new Error(`${r.status} em ${url}`);
        const err = new Error("Sem acesso ao site do TSE. Confira a internet ou rode o painel com node server.js.");
        err.semAcesso = true;
        throw err;
      }
      await new Promise((ok) => setTimeout(ok, 700 * 2 ** i + Math.random() * 500));
    }
  }

  file(abr) {
    const e = this.cfg.eleicao.padStart(6, "0");
    return `${this.root}/dados/${abr.slice(0, 2)}/${abr}-c${this.cfg.cargo}-e${e}-u.json`;
  }

  async brasil() {
    return parseTse(await this.json(this.file("br")));
  }

  async estado(uf) {
    return parseTse(await this.json(this.file(uf.toLowerCase())));
  }

  /** Lista de municípios por UF: { SP: [{ codigo, nome, cdi, capital }] } */
  async listaMunicipios() {
    if (this.municipios) return this.municipios;
    const e = this.cfg.eleicao.padStart(6, "0");
    const j = await this.json(`${this.root}/config/mun-e${e}-cm.json`);
    this.municipios = {};
    for (const abr of j.abr || []) {
      this.municipios[abr.cd.toUpperCase()] = (abr.mu || []).map((m) => ({
        codigo: m.cd,
        nome: m.nm,
        cdi: m.cdi, // código IBGE, usado no mapa
        capital: String(m.c).toLowerCase() === "s",
      }));
    }
    return this.municipios;
  }

  async municipio(uf, codigo) {
    return parseTse(await this.json(this.file(uf.toLowerCase() + codigo), 1));
  }

  /**
   * Andamento de todas as cidades de um estado num arquivo só (sem os votos):
   * Map código da cidade -> { st: seções apuradas, ts: seções }. Serve para baixar de novo só as
   * cidades que mudaram e para a chance de virada saber quais cidades ainda faltam.
   */
  async andamentoCidades(uf) {
    const e = this.cfg.eleicao.padStart(6, "0");
    const u = uf.toLowerCase();
    const j = await this.json(`${this.root}/dados/${u}/${u}-e${e}-ab.json`);
    const out = new Map();
    for (const a of j.abr || []) if (a.tpabr === "mun") out.set(a.cdabr, { st: int(a.s?.st), ts: int(a.s?.ts) });
    return out;
  }

  /** Lista as eleições publicadas no TSE para o ano (para descobrir o código). */
  static async descobrirEleicoes(base, ano) {
    const r = await fetch(`${base}/oficial/comum/config/ele-c.json`, { cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status} ao ler a lista de eleições`);
    const j = await r.json();
    const found = [];
    for (const pl of j.pl || []) {
      if (ano && pl.c !== `ele${ano}`) continue;
      for (const e of pl.e || []) {
        const cargos = [...new Set((e.abr || []).flatMap((a) => (a.cp || []).map((c) => c.ds)))];
        found.push({ codigo: String(Number(e.cd)), nome: e.nm, data: pl.dt || "", cargos });
      }
    }
    // eleições ordinárias primeiro, depois as mais recentes
    const chave = (x) => (x.nome.includes("Ordinária") ? "1" : "0") + x.data.split("/").reverse().join("");
    return found.sort((a, b) => chave(b).localeCompare(chave(a)));
  }
}

// ---------------------------------------------------------------- simulação

function rng(seed) {
  let s = 0;
  for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ELEITORES_UF = {
  SP: 34.6, MG: 16.3, RJ: 12.8, BA: 11.3, RS: 8.6, PR: 8.5, PE: 7.0, CE: 6.8, PA: 6.1, MA: 5.0, SC: 5.5, GO: 4.9,
  PB: 3.0, ES: 2.9, AM: 2.6, RN: 2.6, AL: 2.4, PI: 2.6, MT: 2.5, DF: 2.2, MS: 2.0, SE: 1.7, RO: 1.2, TO: 1.1,
  AC: 0.6, AP: 0.6, RR: 0.4, ZZ: 0.7,
}; // milhões (aprox.)

const CAPITAIS = {
  AC: "Rio Branco", AM: "Manaus", AP: "Macapá", PA: "Belém", RO: "Porto Velho", RR: "Boa Vista", TO: "Palmas",
  AL: "Maceió", BA: "Salvador", CE: "Fortaleza", MA: "São Luís", PB: "João Pessoa", PE: "Recife", PI: "Teresina",
  RN: "Natal", SE: "Aracaju", DF: "Brasília", GO: "Goiânia", MS: "Campo Grande", MT: "Cuiabá", ES: "Vitória",
  MG: "Belo Horizonte", RJ: "Rio de Janeiro", SP: "São Paulo", PR: "Curitiba", RS: "Porto Alegre", SC: "Florianópolis",
  ZZ: "Exterior",
};

const DEMO_CANDS = [
  { numero: "10", nome: "CANDIDATO A", partido: "PARTIDO A" },
  { numero: "20", nome: "CANDIDATO B", partido: "PARTIDO B" },
  { numero: "30", nome: "CANDIDATO C", partido: "PARTIDO C" },
  { numero: "40", nome: "CANDIDATO D", partido: "PARTIDO D" },
];

/**
 * Simulação: no 2º turno a apuração avança sozinha (~100% em 6 min), para testar o painel
 * antes de domingo; o 1º turno já vem encerrado, com quatro candidatos.
 */
export class DemoSource {
  constructor(turno = "2") {
    this.turno = turno;
    this.inicio = Date.now() - 90_000; // começa com parte das urnas já apuradas
    this.municipiosCache = null;
  }

  sim(key, eleitores, lean) {
    const r = rng(key);
    const atraso = r() * 0.25; // algumas regiões começam a apurar depois
    const ritmo = 0.7 + r() * 0.6;
    const t = (Date.now() - this.inicio) / 360_000; // 0..1 em 6 minutos
    const frac = this.turno === "1" ? 1 : Math.max(0, Math.min(1, (t - atraso) * ritmo * 1.4));
    const secoes = Math.max(1, Math.round(eleitores / 330));
    const apuradas = Math.round(secoes * frac);
    const e = Math.round(eleitores * (apuradas / secoes));
    const comparecimento = Math.round(e * (0.76 + r() * 0.08) * (this.turno === "1" ? 1.02 : 1));
    const brancos = Math.round(comparecimento * (0.01 + r() * 0.02));
    const nulos = Math.round(comparecimento * (0.02 + r() * 0.03));
    const validos = comparecimento - brancos - nulos;
    const shareA = Math.max(0.15, Math.min(0.85, 0.5 + lean + (r() - 0.5) * 0.12));
    const a = Math.round(validos * shareA);
    const d = new Date();
    let votos = [a, validos - a];
    if (this.turno === "1") {
      // no 1º turno os dois finalistas têm menos votos e C e D dividem o resto
      const fa = Math.round(a * (0.84 + r() * 0.06));
      const fb = Math.round((validos - a) * (0.82 + r() * 0.06));
      const c = Math.round((validos - fa - fb) * (0.55 + r() * 0.2));
      votos = [fa, fb, c, validos - fa - fb - c];
    }
    return {
      secoes, apuradas, eleitorado: Math.round(eleitores), eleitores: e, comparecimento,
      abstencao: e - comparecimento, brancos, nulos, validos,
      atualizadoEm: `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 8)}`,
      candidatos: votos.map((v, i) => ({ ...DEMO_CANDS[i], votos: v, situacao: "" })).sort((x, y) => y.votos - x.votos),
    };
  }

  leanUf(uf) {
    const base = { Norte: 0.04, Nordeste: 0.14, "Centro-Oeste": -0.1, Sudeste: -0.03, Sul: -0.12, Exterior: -0.05 }[UFS[uf][1]];
    return base + (rng("lean" + uf)() - 0.5) * 0.08;
  }

  async listaMunicipios() {
    if (this.municipiosCache) return this.municipiosCache;
    this.municipiosCache = {};
    for (const uf of Object.keys(UFS)) {
      const n = uf === "ZZ" ? 6 : Math.max(8, Math.round(ELEITORES_UF[uf] * 6));
      this.municipiosCache[uf] = Array.from({ length: n }, (_, i) => ({
        codigo: String(i + 1).padStart(5, "0"),
        nome: i === 0 ? CAPITAIS[uf] : `Município ${uf}-${String(i + 1).padStart(3, "0")}`,
        capital: i === 0,
      }));
    }
    return this.municipiosCache;
  }

  async municipio(uf, codigo) {
    const lista = (await this.listaMunicipios())[uf];
    // a capital concentra ~20% do eleitorado; o resto é dividido com peso decrescente
    const i = Number(codigo) - 1;
    const pesoCap = 0.2;
    const resto = lista.length - 1;
    const w = i === 0 ? pesoCap : ((1 - pesoCap) * 2 * (resto - i + 1)) / (resto * (resto + 1));
    return this.sim(uf + codigo, ELEITORES_UF[uf] * 1e6 * w, this.leanUf(uf) + (i === 0 ? -0.06 : 0.02));
  }

  async estado(uf) {
    const lista = (await this.listaMunicipios())[uf];
    return aggregate(await Promise.all(lista.map((m) => this.municipio(uf, m.codigo))));
  }

  async brasil() {
    return aggregate(await Promise.all(Object.keys(UFS).map((uf) => this.estado(uf))));
  }
}

// ---------------------------------------------------------------- replay de 2022

const ORDEM_2022 = { Sul: 0, Sudeste: 0.04, "Centro-Oeste": 0.06, Norte: 0.16, Nordeste: 0.2, Exterior: 0.3 };
const NOMES_REPLAY = { 13: ["LULA", "PT"], 22: ["JAIR BOLSONARO", "PL"] };
const secoesDe = (aptos) => Math.max(1, Math.round(aptos / 330));

/**
 * Reapura o 2º turno de 2022 cidade por cidade (resultado real, ritmo simulado): Sul e Sudeste
 * contam primeiro, Norte e Nordeste depois, e cidades maiores demoram mais. Os estados e o país são
 * a soma das cidades, então a chance de virada roda exatamente como no domingo, com o 1º turno de
 * 2022 como referência (base1Turno).
 */
export class ReplaySource {
  constructor({ duracaoMs = 8 * 60_000, municipios } = {}) {
    this.inicio = Date.now() - 20_000;
    this.duracao = duracaoMs;
    this.municipiosDe = municipios; // lista de cidades do TSE (com código IBGE), para o mapa
    this.arquivos = {};
    this.fotos = {};
  }

  arquivo(nome) {
    return (this.arquivos[nome] ||= fetch(`dados2022/${nome}.json`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))));
  }

  /** Foto do estado agora: resultado parcial de cada cidade (refeita no máximo uma vez por segundo). */
  async foto(uf) {
    const seg = Math.floor(Date.now() / 1000);
    if (this.fotos[uf]?.seg === seg) return this.fotos[uf].p;
    const p = this.arquivo(`0001-t2-${uf.toLowerCase()}`).then(({ cidades }) => {
      const t = (Date.now() - this.inicio) / this.duracao;
      const maior = Math.max(...Object.values(cidades).map((R) => R[4]));
      const out = {};
      for (const [cod, R] of Object.entries(cidades)) {
        const r = rng("replay" + uf + cod);
        const atraso = ORDEM_2022[UFS[uf][1]] + r() * 0.25 + 0.12 * Math.sqrt(R[4] / maior);
        const frac = Math.max(0, Math.min(1, (t - atraso) * (1.4 + r() * 0.8)));
        out[cod] = this.parcial(R, frac, uf + cod);
      }
      return out;
    });
    this.fotos[uf] = { seg, p };
    return p;
  }

  parcial(R, frac, chave) {
    const [aptos, comp, brancos, nulos, validos, votos] = R;
    const secoes = secoesDe(aptos);
    const apuradas = Math.round(secoes * frac);
    const f = apuradas / secoes;
    // as primeiras urnas de uma cidade não têm exatamente o resultado final dela
    const desvio = (rng("desvio" + chave)() - 0.5) * 0.06 * (1 - f);
    const v13 = votos["13"] || 0, v22 = votos["22"] || 0;
    const s13 = Math.max(0, Math.min(1, v13 / (v13 + v22 || 1) + desvio));
    const val = Math.round(validos * f);
    const a = Math.round(val * s13);
    const d = new Date();
    return {
      secoes, apuradas, eleitorado: aptos, eleitores: Math.round(aptos * f), comparecimento: Math.round(comp * f),
      abstencao: Math.round((aptos - comp) * f), brancos: Math.round(brancos * f), nulos: Math.round(nulos * f), validos: val,
      atualizadoEm: `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 8)}`,
      candidatos: [
        { numero: "13", nome: NOMES_REPLAY[13][0], partido: NOMES_REPLAY[13][1], votos: a, situacao: "" },
        { numero: "22", nome: NOMES_REPLAY[22][0], partido: NOMES_REPLAY[22][1], votos: val - a, situacao: "" },
      ].sort((x, y) => y.votos - x.votos),
    };
  }

  async estado(uf) {
    return aggregate(Object.values(await this.foto(uf)));
  }

  async brasil() {
    const rs = await Promise.all(Object.keys(UFS).map((uf) => this.estado(uf).catch(() => null)));
    return aggregate(rs);
  }

  async andamentoCidades(uf) {
    const foto = await this.foto(uf);
    return new Map(Object.entries(foto).map(([cod, r]) => [cod, { st: r.apuradas, ts: r.secoes }]));
  }

  /** Referência da chance de virada: o 1º turno de 2022 por cidade, no formato de public/base/. */
  async base1Turno() {
    const ufs = {};
    await Promise.all(Object.keys(UFS).map(async (uf) => {
      try {
        const [t1, t2] = await Promise.all([this.arquivo(`0001-t1-${uf.toLowerCase()}`), this.arquivo(`0001-t2-${uf.toLowerCase()}`)]);
        const cidades = {};
        for (const [cod, R] of Object.entries(t1.cidades)) {
          const aptos2 = t2.cidades[cod]?.[0] ?? R[0];
          cidades[cod] = [secoesDe(aptos2), R[4], R[5]["22"] || 0, R[5]["13"] || 0];
        }
        ufs[uf] = { candidatos: ["22", "13"], cidades };
      } catch {}
    }));
    return { ufs };
  }

  async listaMunicipios() {
    return this.municipiosDe ? this.municipiosDe() : {};
  }

  async municipio(uf, codigo) {
    const r = (await this.foto(uf))[codigo];
    if (!r) throw new Error("sem dados");
    return r;
  }
}
