# Grava public/pesquisas.json (rodar na raiz do repositório).
# Uso: python3 finalizar.py AAAA-MM-DD <pasta-dos-txt>
# NOTICIAS: pesquisas que só uma lista traz, conferidas à mão numa reportagem.
import json, re, sys, os
D=os.path.join(sys.argv[2], '')  # mesma pasta do montar.py
o=json.load(open(D+'pesq_out.json'))
WP='https://pt.wikipedia.org/wiki/Pesquisas_de_opini%C3%A3o_para_a_elei%C3%A7%C3%A3o_presidencial_no_Brasil_em_2026'
# confirmadas nas reportagens (só a Wikipédia em português trazia)
NOTICIAS={('Alfa','2026-10-22'):('https://exame.com/brasil/pesquisa-alfa-a-dois-dias-do-2o-turno-flavio-bolsonaro-tem-52-e-lula-48/','2026-10-23'),
          ('Real Time Big Data','2026-10-22'):('https://www.gazetadopovo.com.br/eleicoes/2026/pesquisa-eleitoral-2026/real-time-big-data-presidente-outubro-2026-segundo-turno-2/','2026-10-23')}
# conferidas à mão nas reportagens: entram se nenhuma Wikipédia tiver a pesquisa, ou substituem os
# campos da versão da Wikipédia (mesmo instituto e mesmo fim de campo) quando ela não estava conferida
MANUAIS=[
  {"instituto":"Veritá","contratante":None,"campo":["2026-10-18","2026-10-22"],"divulgacao":"2026-10-23","amostra":15554,"margem":1,
   "registro":"BR-06070/2026","totais":{"22":50.2,"13":47.5},"validos":{"22":51.3,"13":48.7},
   "fonte":"https://ncnews.com.br/2026/10/23/verita-flavio-bolsonaro-lula-2-turno/","conferido":True},
  # a Wikipédia em inglês traz Flávio 45,1; a em português (45,6) bate com os 51,4% dos válidos da reportagem
  {"instituto":"Instituto França","campo":["2026-10-21","2026-10-23"],"totais":{"22":45.6,"13":43.1},"validos":{"22":51.4,"13":48.6},
   "fonte":"https://www.poder360.com.br/poder-eleicoes-2026/flavio-tem-514-contra-486-de-lula-em-votos-validos-diz-pesquisa/","conferido":True},
  {"instituto":"Instituto França","campo":["2026-10-16","2026-10-20"],"registro":"BR-07896/2026","validos":{"22":50.8,"13":49.2},
   "fonte":"https://www.congressoemfoco.com.br/noticia/123423/flavio-tem-50-8-contra-49-2-de-lula-em-pesquisa-do-instituto-franca","conferido":True},
  {"instituto":"Vetor Arrow","campo":["2026-10-22","2026-10-23"],"amostra":6867,"margem":1.2,"registro":"BR-06957/2026",
   "totais":{"22":50,"13":44.9},"validos":{"22":52.7,"13":47.3},
   "fonte":"https://agendadopoder.com.br/flavio-bolsonaro-tem-527-dos-votos-validos-contra-473-de-lula-aponta-pesquisa-vetor-arrow/","conferido":True},
]
fin=[]
for p in o:
    if p.get('antesDo1Turno'):
        if p['instituto']=='Datafolha' and p['conferido']: p['fonte']=p['fonte'] or WP; fin.append(p)
        elif p['instituto']=='Quaest':
            p.update(conferido=True, fonte='https://g1.globo.com/politica/eleicoes/2026/pesquisa-eleitoral/noticia/2026/10/03/quaest-2o-turno-flavio-bolsonaro-44percent-lula-42percent.ghtml', margem=2.0, amostra=3702); fin.append(p)
        continue
    k=(p['instituto'],p['campo'][1])
    if k in NOTICIAS and not p['conferido']: p['fonte'],p['divulgacao']=NOTICIAS[k]; p['conferido']=True
    p['fonte']=p['fonte'] or WP
    fin.append(p)
# linhas da Wikipédia que repetem outra pesquisa (a Veritá de 19–23/10 copia os números da de 18–22/10;
# nenhuma reportagem traz rodada nova até 24/10)
IGNORAR={("Veritá","2026-10-23")}
fin=[p for p in fin if (p['instituto'],p['campo'][1]) not in IGNORAR]
por={(p['instituto'],p['campo'][1]):p for p in fin}
for m in MANUAIS:
    p=por.get((m['instituto'],m['campo'][1]))
    if p is None:
        if 'totais' in m or 'validos' in m: fin.append({'contratante':None,'divulgacao':None,'amostra':None,'margem':None,'registro':None,'totais':None,'validos':None,**m})
    elif not p['conferido']: p.update(m)
    else: p.update({k:v for k,v in m.items() if p.get(k) is None})  # já conferida: só completa o que falta
fin.sort(key=lambda o:(o['campo'][1],o['instituto']),reverse=True)
for p in fin:
    if p['margem'] is not None and float(p['margem']).is_integer(): p['margem']=int(p['margem'])
    for g in ('totais','validos'):
        if p[g]: p[g]={k:(int(v) if float(v).is_integer() else v) for k,v in p[g].items()}
# próximas: registradas no TSE, resultado ainda não divulgado
MES={'Out':10,'Set':9}
L=open(D+'ptp.txt').read().split('\n'); a=L.index('== Segundo turno =='); a=L.index('==== 2026 ====', a); b=L.index('==== 2025 ====', a)
prox=[]
for blk in re.split(r'\n\|-[^\n]*','\n'.join(L[a:b])):
    if 'ainda não divulgado' not in blk: continue
    lines=[l for l in blk.split('\n') if l.startswith('|')]
    nome=re.sub(r'<ref.*|<!--.*','',lines[0][1:]).strip()
    nome={'DataFolha':'Datafolha','PoderData/Aya':'PoderData','Nexus/BTG':'Nexus','CNT/MDA':'MDA','Alfa Inteligência':'Alfa'}.get(nome,nome)
    m=re.findall(r'(\d+) (Out|Set)',lines[1]); reg=re.search(r'BR-\d{5}/\d{4}',blk); dv=re.search(r'divulga\w+(?: registrad[oa])?:\s*(\d\d)/(\d\d)/(\d{4})',blk)
    if len(m)<1 or not dv: continue
    am=re.sub(r'\D','',lines[2]) if len(lines)>2 else ''
    prox.append({'instituto':nome,'campo':[f'2026-{MES[m[0][1]]:02d}-{int(m[0][0]):02d}',f'2026-{MES[m[-1][1]]:02d}-{int(m[-1][0]):02d}'],
                 'divulgacao':f'{dv.group(3)}-{dv.group(2)}-{dv.group(1)}','amostra':int(am) if am else None,'registro':reg.group(0) if reg else None})
prox=[x for x in prox if x['divulgacao']<='2026-10-25']  # registro com divulgação depois da eleição não interessa
prox.sort(key=lambda x:(x['divulgacao'],x['instituto']))
d=json.load(open('public/pesquisas.json'))
d['atualizado']=sys.argv[1]; d['pesquisas']=fin; d['proximas']=prox
d['nota']="Pesquisas de 2º turno para presidente (Flávio Bolsonaro × Lula) desde o 1º turno, reunidas das tabelas da Wikipédia em português e em inglês e conferidas nas reportagens, com o link de cada fonte. \"Conferida\" = os mesmos números aparecem em duas fontes independentes; \"a conferir\" = só uma delas traz a pesquisa ou as datas não batem."
open('public/pesquisas.json','w').write(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
print(len(fin),'pesquisas',sum(p['conferido'] for p in fin),'conferidas |',len(prox),'próximas')
for x in prox: print(' ',x)
