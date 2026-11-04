"""Independent Decimal arithmetic; does not import or read either JavaScript engine.
Generates auditable synthetic golden vectors for the documented existing methods.
"""
from decimal import Decimal, getcontext
from pathlib import Path
from collections import defaultdict
import json

getcontext().prec = 60
D = lambda x: Decimal(str(x))
mean = lambda xs: sum(xs) / len(xs)
span = lambda xs: max(xs) - min(xs)

cpk = []
for label, values, lower, upper in [
    ('centered-individuals', [10, 10.02, 9.99, 10.01, 10, 9.98, 10.01, 10.02], 9.9, 10.1),
    ('drifting-individuals', [10+i*.01 for i in range(30)], 9.9, 10.4),
    ('off-center-out-of-spec', [9.8,10,10.2,10.1,10.3], 9.95, 10.05)
]:
    xs = list(map(D, values)); avg = mean(xs)
    overall = (sum((x-avg)**2 for x in xs)/(len(xs)-1)).sqrt()
    within = mean([abs(b-a) for a,b in zip(xs,xs[1:])])/D('1.128')
    distance = min(D(upper)-avg,avg-D(lower)); width = D(upper)-D(lower)
    cpk.append(dict(name=label,input=dict(measurements=values,lsl=lower,usl=upper),expected={
        'mean':float(avg),'sigmaOverall':float(overall),'sigmaWithin':float(within),
        'cp':float(width/(6*within)),'cpk':float(distance/(3*within)),
        'pp':float(width/(6*overall)),'ppk':float(distance/(3*overall))}))

msa = []
K1={2:D('.8862'),3:D('.5908')}; K2={2:D('.7071'),3:D('.5231')}
K3=dict(zip(range(2,11),map(D,['.7071','.5231','.4467','.4030','.3742','.3534','.3375','.3249','.3146'])))
for parts in range(2,11):
    for operators in (2,3):
        for trials in (2,3):
            cells=defaultdict(list); observations=[]
            for p in range(parts):
                for o in range(operators):
                    for r in range(trials):
                        value=D('10')+p*D('.2')+o*D('.002')+r*D('.001')
                        cells[o,p].append(value)
                        observations.append(dict(partId=f'P{p}',operatorId=f'O{o}',trial=r+1,value=float(value)))
            ev=mean([span(xs) for xs in cells.values()])*K1[trials]
            opmeans=[mean([x for (op,_),xs in cells.items() if op==o for x in xs]) for o in range(operators)]
            av=max(D(0),(span(opmeans)*K2[operators])**2-ev**2/(parts*trials)).sqrt()
            pv=span([mean([x for (_,part),xs in cells.items() if part==p for x in xs]) for p in range(parts)])*K3[parts]
            grr=(ev**2+av**2).sqrt(); tv=(grr**2+pv**2).sqrt()
            msa.append(dict(name=f'{parts}x{operators}x{trials}',input=observations,expected={
                'repeatability':float(ev),'reproducibility':float(av),'partVariation':float(pv),
                'grr':float(grr),'totalVariation':float(tv),'gageRRPercent':float(100*grr/tv),
                'contributionPercent':float(100*grr**2/tv**2),'ndc':int(D('1.41')*pv/grr)}))

output=Path('db/test/fixtures/statistical-golden.json');output.parent.mkdir(exist_ok=True)
output.write_text(json.dumps(dict(method='Existing MR(2)/sample-SD capability and AIAG Average & Range; 60-digit independent Decimal arithmetic',cpk=cpk,msa=msa),indent=2)+'\n',encoding='utf-8')
print(f'Generated {len(cpk)} capability and {len(msa)} balanced MSA reference vectors')
