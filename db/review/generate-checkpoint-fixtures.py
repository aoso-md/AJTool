"""Synthetic demo inputs with independent 60-digit Decimal reference arithmetic.
No imports from either production statistical engine. Not a certification.
"""
from decimal import Decimal as D, getcontext
from pathlib import Path
import json
getcontext().prec = 60
out = Path(__file__).resolve().parents[1] / 'test' / 'fixtures' / 'checkpoint-demo'
out.mkdir(exist_ok=True)
mean = lambda xs: sum(xs) / len(xs)
xs = [D('9.96') if i % 2 == 0 else D('10.04') for i in range(25)]
avg = mean(xs)
within = mean([abs(b-a) for a,b in zip(xs,xs[1:])]) / D('1.128')
overall = (sum((x-avg)**2 for x in xs)/(len(xs)-1)).sqrt()
cpk = dict(partId='DEMO-SHAFT',characteristicId='DIAMETER',lsl=9.95,usl=10.05,target=10,
           measurements=list(map(float,xs)),notes='Synthetic: 25 individual subgroups of size 1; MR(2), not Rbar/d2 for groups of 5.')
cpk_expected = dict(cp=float(D('.1')/(6*within)),cpk=float(min(D('10.05')-avg,avg-D('9.95'))/(3*within)),
                    pp=float(D('.1')/(6*overall)),ppk=float(min(D('10.05')-avg,avg-D('9.95'))/(3*overall)),
                    sigmaWithin=float(within),sigmaOverall=float(overall))
obs = [dict(partId=f'P{p+1}',operatorId=f'O{o+1}',trial=r+1,value=float(D('10')+p*D('.02')+o*D('.002')+r*D('.001')))
       for p in range(10) for o in range(3) for r in range(3)]
ev = D('.002')*D('.5908')
av = ((D('.004')*D('.5231'))**2-ev**2/D(30)).sqrt()
pv = D('.18')*D('.3146')
grr = (ev**2+av**2).sqrt()
tv = (grr**2+pv**2).sqrt()
msa_expected = dict(repeatability=float(ev),reproducibility=float(av),partVariation=float(pv),grr=float(grr),
                    totalVariation=float(tv),gageRRPercent=float(100*grr/tv),ndc=int(D('1.41')*pv/grr))
for name, data in [('cpk-payload',cpk),('msa-payload',dict(gaugeId='DEMO-MICROMETER',observations=obs)),
                   ('expected',dict(method='MR(2) individuals; Average & Range 3x10x3; independent Decimal(60)',cpk=cpk_expected,msa=msa_expected))]:
    (out / (name+'.json')).write_text(json.dumps(data,indent=2)+'\n',encoding='utf-8')
print('Generated 25 individual subgroups and 90 MSA measurements with independent expected values.')
