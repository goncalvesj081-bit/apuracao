# Junta as tabelas de 2º turno da Wikipédia (pt e en) e marca o que bate nas duas.
# Uso: python3 montar.py <pasta-dos-txt>
import re, json, datetime
import sys, os
D=os.path.join(sys.argv[1], '')  # pasta com ptp.txt e enp.txt (baixar.sh)
MES={'Sep':9,'Set':9,'Oct':10,'Out':10}
def clean(c):
    c=re.sub(r'<ref[^>]*/>|<ref[^>]*>.*?</ref>|<!--.*?-->','',c,flags=re.S)
    c=re.sub(r'^\s*(style|colspan|rowspan|class)[^|]*\|','',c)
    c=re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]",r'\1',c); c=re.sub(r"'''?","",c); c=re.sub(r"\{\{n/a\}\}","",c,flags=re.I)
    return c.strip()
def blocos(txt):
    for blk in re.split(r'\n\|-[^\n]*',txt):
        cells=[]
        for line in blk.split('\n'):
            if line.startswith('|}') : break
            if line.startswith('|'): cells.append(line[1:])
            elif line.startswith('!'): cells=[]; break
            elif cells: cells[-1]+='\n'+line
        if cells: yield blk, cells
def num(s):
    s=s.replace('%','').replace('±','').replace('pp','').replace(',','.').strip()
    try: return float(s)
    except: return None
def amostra(s):
    s=re.sub(r'[^\d]','',s); return int(s) if s else None
def datas(s):
    s=s.replace('–','-').replace(' - ','-')
    m=re.match(r'(\d+)\s*([A-Za-z]{3})?\s*-\s*(\d+)\s*([A-Za-z]{3})',s.strip())
    if m:
        d1,m1,d2,m2=m.groups(); m1=m1 or m2
        return [f'2026-{MES[m1]:02d}-{int(d1):02d}', f'2026-{MES[m2]:02d}-{int(d2):02d}']
    m=re.match(r'(\d+)\s*([A-Za-z]{3})',s.strip())
    if m: d=f'2026-{MES[m.group(2)]:02d}-{int(m.group(1)):02d}'; return [d,d]
    return None
def url(blk):
    u=re.findall(r'url=\s*([^\s|}]+)',blk); 
    u=[re.sub(r'[?&]utm_[^#]*','',x).split('#')[0] for x in u]
    return u[0] if u else None
def citedate(blk):
    m=re.search(r'\|\s*date=\s*(\d{4}-\d{2}-\d{2})',blk); return m.group(1) if m else None
NOME={'IFP':'Instituto França','França':'Instituto França','Instituto França':'Instituto França','Datatrends':'DataTrends','DataFolha':'Datafolha','PoderData/Aya':'PoderData','Nexus/BTG':'Nexus','BTG/Nexus':'Nexus','Meio/Ideia':'Ideia','CNT/MDA':'MDA','Alfa Inteligência':'Alfa','Real Time Big Data':'Real Time Big Data','Real Time':'Real Time Big Data','Veritá':'Veritá','Verita':'Veritá','Vox Brasil':'Vox','Vox':'Vox'}
CONTR={'Nexus/BTG':'BTG Pactual','BTG/Nexus':'BTG Pactual','Meio/Ideia':'Meio','CNT/MDA':'CNT'}
# --- en
en=[]
L=open(D+'enp.txt').read().split('\n')
a=L.index('==== October (after 1st round) ===='); b=L.index('==== Aug–Oct (Campaign period) ====', a)
txt='\n'.join(L[a:b]) + '\n' + '\n'.join(L[b:b+45])
for blk,c in blocos(txt):
    cc=[clean(x) for x in c]
    if len(cc)<8 or not cc[0] or num(cc[2]) is None: continue
    d=datas(cc[1])
    if not d or d[1]<'2026-10-02': continue
    en.append(dict(nome=NOME.get(cc[0],cc[0]),campo=d,L=num(cc[2]),F=num(cc[3]),und=cc[4],margem=num(cc[-4]) if 'pp' in cc[-4] else None,amostra=amostra(cc[-3]) if re.search(r'\d',cc[-3]) else None,url=url(blk),data=citedate(blk)))
# en pre-round rows have extra cols; fix margem/amostra by searching
# --- pt
pt=[]
L=open(D+'ptp.txt').read().split('\n')
a=L.index('== Segundo turno =='); a=L.index('==== 2026 ====', a); b=L.index('==== 2025 ====', a)
for blk,c in blocos('\n'.join(L[a:b])):
    cc=[clean(x) for x in c]
    if len(cc)<8: continue
    d=datas(cc[1])
    if not d: continue
    if d[1]<'2026-10-02': break
    br=re.findall(r'BR-\d{5}/\d{4}',blk)
    pt.append(dict(nome=NOME.get(cc[0],cc[0]),orig=cc[0],campo=d,amostra=amostra(cc[2]),margem=num(cc[3]),L=num(cc[4]),F=num(cc[5]),und=cc[6],registro=br[0] if br else None))
print(len(en),'en',len(pt),'pt')
def dias(a,b): return abs((datetime.date.fromisoformat(a)-datetime.date.fromisoformat(b)).days)
def bate(e,p):
    if e['nome']!=p['nome'] or dias(e['campo'][1],p['campo'][1])>1: return None
    if abs(e['L']-p['L'])<0.05 and abs(e['F']-p['F'])<0.05: return 'totais'
    s=e['L']+e['F']; vl=e['L']/s*100
    if not p['und'] and abs(p['L']+p['F']-100)<0.2 and abs(vl-p['L'])<0.8: return 'validos'
    return 'diverge'
out=[]; usados=set()
for e in en:
    m=None
    # tenta primeiro a linha com o mesmo fim de campo (a lista em português às vezes repete a pesquisa)
    for i,p in sorted(enumerate(pt), key=lambda ip: dias(e['campo'][1], ip[1]['campo'][1])):
        if i in usados: continue
        r=bate(e,p)
        if r: m=(i,p,r); break
    reg=None; conf=False; val=None; contr=None
    if m:
        i,p,r=m; usados.add(i); reg=p['registro']; contr=CONTR.get(p['orig'])
        conf = r!='diverge'
        if r=='validos': val={'22':p['F'],'13':p['L']}
        if r=='diverge': print('DIVERGE',e['nome'],e['campo'],e['L'],e['F'],'| pt',p['L'],p['F'])
    else: print('só en:',e['nome'],e['campo'],e['L'],e['F'])
    out.append(dict(instituto=e['nome'],contratante=contr,campo=e['campo'],divulgacao=e['data'],amostra=e['amostra'] or (m and m[1]['amostra']),margem=e['margem'] if e['margem'] is not None else (m and m[1]['margem']),registro=reg,totais={'22':e['F'],'13':e['L']},validos=val,fonte=e['url'],conferido=conf,**({'antesDo1Turno':True} if e['campo'][1]<'2026-10-04' else {})))
for i,p in enumerate(pt):
    if i in usados: continue
    if p['L'] is None: continue
    print('só pt:',p['nome'],p['campo'],p['L'],p['F'],p['und'])
    validos = not p['und'] and abs(p['L']+p['F']-100)<0.2
    out.append(dict(instituto=p['nome'],contratante=CONTR.get(p['orig']),campo=p['campo'],divulgacao=None,amostra=p['amostra'],margem=p['margem'],registro=p['registro'],
      totais=None if validos else {'22':p['F'],'13':p['L']},validos={'22':p['F'],'13':p['L']} if validos else None,
      fonte='https://pt.wikipedia.org/wiki/Pesquisas_de_opini%C3%A3o_para_a_elei%C3%A7%C3%A3o_presidencial_no_Brasil_em_2026',conferido=False,**({'antesDo1Turno':True} if p['campo'][1]<'2026-10-04' else {})))
out=[o for o in out if not o.get('antesDo1Turno') or o['campo'][1]=='2026-10-03' and o['instituto'] in ('Datafolha','Quaest')]
out.sort(key=lambda o:(o['campo'][1],o['instituto']),reverse=True)
json.dump(out,open(D+'pesq_out.json','w'),ensure_ascii=False,indent=1)
print(len(out),'total',sum(o['conferido'] for o in out),'conferidas')
