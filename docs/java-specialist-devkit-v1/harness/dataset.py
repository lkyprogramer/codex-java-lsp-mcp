"""Dataset loader and integrity checks independent of JavaIndex and product rankings."""
from __future__ import annotations
import hashlib,json
from pathlib import Path
from collections import Counter
from .scoring import safe_file, source_lines

def _pairs(pairs):
    d={}
    for k,v in pairs:
        if k in d:raise ValueError(f'duplicate JSON key: {k}')
        d[k]=v
    return d

def parse_json(text):
    def bad(x):raise ValueError(f'nonfinite JSON: {x}')
    return json.loads(text,object_pairs_hook=_pairs,parse_constant=bad)

def load_json(p):return parse_json(Path(p).read_text(encoding='utf-8'))
def jsonl(p):return [parse_json(x) for x in Path(p).read_text(encoding='utf-8').splitlines() if x.strip()]
def write_json(p,obj):
    p=Path(p);p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(obj,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')

def dataset_digest(d:Path):
    h=hashlib.sha256()
    for p in sorted(d.rglob('*')):
        if not p.is_file() or p==d/'manifest.json':continue
        rel=p.relative_to(d).as_posix()
        h.update(rel.encode()+b'\0'+hashlib.sha256(p.read_bytes()).digest())
    return h.hexdigest()

def load_dataset(d:Path):
    tasks=[];gold=[]
    for s in ('dev','locked'):
        tasks+=jsonl(d/'prompts'/f'{s}.jsonl');gold+=jsonl(d/'gold'/f'{s}.jsonl')
    if len({x['id'] for x in tasks})!=len(tasks) or len({x['id'] for x in gold})!=len(gold):
        raise ValueError('duplicate task/gold ID')
    return {'tasks':tasks,'gold':{g['id']:g for g in gold},'corpora':load_json(d/'corpora.json')}

def expected_cases(tasks,variants='primary'):
    out=[]
    for t in tasks:
        out.append((t,'primary',t['query']))
        if variants=='all':out.extend((t,v['id'],v['query']) for v in t.get('variants',[]))
    return out

def validate_dataset(d:Path):
    errors=[];ds=load_dataset(d);clusters={};corpora={c['id'] for c in ds['corpora']}
    if set(ds['gold'])!={t['id'] for t in ds['tasks']}:errors.append('gold/task universe differs')
    for t in ds['tasks']:
        ident=t['id'];g=ds['gold'].get(ident,{})
        try:
            if t['corpus'] not in corpora:raise ValueError('unknown corpus')
            if t['split'] not in ('dev','locked'):raise ValueError('unknown split')
            clusters.setdefault(t['cluster'],set()).add(t['split'])
            if len({v['id'] for v in t.get('variants',[])})!=len(t.get('variants',[])):raise ValueError('duplicate variant')
            if not g.get('targets') or not g.get('required_evidence'):raise ValueError('empty ground truth')
            root=d/'corpora'/t['corpus']
            for target in g['targets']:
                lines=source_lines(safe_file(root,target['path']));n=target['line']
                if type(n)is not int or not 1<=n<=len(lines):raise ValueError('target out of bounds')
                if target['name'] not in lines[n-1].decode('utf-8'):raise ValueError('target name not at labelled line')
            for r in g['required_evidence']+g.get('optional_evidence',[]):
                lines=source_lines(safe_file(root,r['path']))
                if not 1<=r['start_line']<=r['end_line']<=len(lines):raise ValueError('gold range out of bounds')
            if t['kind']=='qa' and not isinstance(g.get('answer'),dict):raise ValueError('QA requires structured answer')
            if t['kind']=='repair' and g.get('answer') is not None:raise ValueError('repair cannot use QA answer')
            for a in t.get('anchors',[]):
                text=source_lines(safe_file(root,a['path']))[a['line']-1].decode('utf-8').rstrip('\r\n')
                if not 1<=a['column']<=len(text.encode('utf-16-le'))//2+1:raise ValueError('anchor UTF-16 column invalid')
        except (ValueError,KeyError,IndexError,OSError) as e:errors.append(f'{ident}: {e}')
    if any(len(v)>1 for v in clusters.values()):errors.append('cluster leakage across splits')
    m=d/'manifest.json'
    if m.exists():
        frozen=load_json(m)
        if dataset_digest(d)!=frozen['dataset_hash']:errors.append('dataset differs from frozen manifest')
    return {'schema':'dataset-validation/v1','task_groups':len(ds['tasks']),'query_variants':len(expected_cases(ds['tasks'],'all')),
            'clusters':len(clusters),'split_counts':dict(Counter(t['split'] for t in ds['tasks'])),
            'origin_counts':dict(Counter(t['origin'] for t in ds['tasks'])),'errors':errors,'dataset_hash':dataset_digest(d)}
