"""Independent evaluator. No import from the system under test."""
from __future__ import annotations
import hashlib, math, random, statistics, json
from pathlib import Path, PurePosixPath
from collections import defaultdict

def safe_file(root: Path, relative: str) -> Path:
    if not isinstance(relative,str) or not relative or '\\' in relative:
        raise ValueError('path must be a nonempty POSIX relative path')
    p=PurePosixPath(relative)
    if p.is_absolute() or any(x in ('','.','..') for x in relative.split('/')) or ':' in relative:
        raise ValueError('unsafe relative path')
    try:target=(root/relative).resolve(strict=True)
    except RuntimeError as e:raise ValueError('invalid symlink path') from e
    target.relative_to(root.resolve(strict=True))
    if not target.is_file(): raise ValueError('not a regular file')
    return target

def source_lines(file: Path) -> list[bytes]:
    # Keep original CRLF and UTF-8 byte cost. Lines are 1-based, inclusive.
    raw=file.read_bytes();raw.decode('utf-8',errors='strict')
    return raw.splitlines(keepends=True)

def validate_regions(root: Path, regions: list[dict]) -> tuple[list[dict],list[str]]:
    normalized=[]; errors=[]
    if not isinstance(regions,list):return [],['regions must be an array']
    for i,r in enumerate(regions):
        try:
            if not isinstance(r,dict):raise ValueError('region must be an object')
            p=safe_file(root,r['path']);lines=source_lines(p)
            a,b=r['start_line'],r['end_line']
            if type(a) is not int or type(b) is not int or not 1<=a<=b<=len(lines):
                raise ValueError('invalid source range')
            h=hashlib.sha256(p.read_bytes()).hexdigest()
            if r.get('content_hash')!=h:raise ValueError('stale or absent content hash')
            normalized.append({**r,'bytes':sum(len(x) for x in lines[a-1:b])})
        except (ValueError,KeyError,OSError,UnicodeError,TypeError) as e:
            errors.append(f'region[{i}]: {e}')
    return normalized,errors

def line_set(regions):
    return {(r['path'],n) for r in regions for n in range(r['start_line'],r['end_line']+1)}

def strict_equal(a, b):
    if type(a) is not type(b): return False
    if isinstance(a, dict): return a.keys() == b.keys() and all(strict_equal(a[k], b[k]) for k in a)
    if isinstance(a, list): return len(a) == len(b) and all(strict_equal(x,y) for x,y in zip(a,b))
    return a == b

def evaluate(task: dict, gold: dict, result: dict|None, root: Path) -> dict:
    r=result or {'task_id':task['id'],'status':'MISSING','regions':[],'candidates':[],'answer':None,'usage':None}
    errors=[]
    if r.get('task_id')!=task['id']:errors.append('wrong task_id')
    regions,region_errors=validate_regions(root,r.get('regions',[]));errors+=region_errors
    candidates=[];seen=set()
    if not isinstance(r.get('candidates',[]),list):errors.append('candidates must be an array')
    else:
        for c in r.get('candidates',[]):
            try:
                p=safe_file(root,c['path']);n=c['line']
                if type(n) is not int or not 1<=n<=len(source_lines(p)):raise ValueError('candidate line out of bounds')
                if not isinstance(c.get('name'),str) or not c['name']:raise ValueError('candidate name required')
                # Exact identity is grounded in source path + declaration name + source line.
                key=(c['path'],n,c['name'])
                if key not in seen:candidates.append(c);seen.add(key)
            except (ValueError,KeyError,OSError,TypeError) as e:errors.append(f'candidate: {e}')
    received,read_errors=validate_regions(root,r.get('read_events',[])); errors+=read_errors
    for e in received:
        p=safe_file(root,e['path'])
        expected_text=b''.join(source_lines(p)[e['start_line']-1:e['end_line']]).decode('utf-8')
        if e.get('text')!=expected_text or e.get('origin') not in ('tool_response','explicit_read'):
            errors.append('invalid read receipt: source text/origin mismatch')
    usage=r.get('usage')
    if usage is not None:
        if not isinstance(usage,dict) or usage.get('source')!='provider':
            errors.append('usage must be provider-measured or null');usage=None
        elif any(type(v) is not int or v<0 for k,v in usage.items() if k in ('input_tokens','output_tokens','cached_input_tokens') and v is not None):
            errors.append('invalid provider usage');usage=None
    elapsed=r.get('elapsed_ms')
    if elapsed is not None and (type(elapsed) not in (int,float) or not math.isfinite(elapsed) or elapsed<0):errors.append('invalid elapsed_ms')
    budget=task['budget'];emitted_lines=sum(rg['end_line']-rg['start_line']+1 for rg in regions)
    emitted_bytes=sum(rg['bytes'] for rg in regions)
    budget_pass=(len(regions)<=budget['max_regions'] and emitted_lines<=budget['max_lines'] and emitted_bytes<=budget['max_bytes'])
    received_lines=sum(e['end_line']-e['start_line']+1 for e in received)
    received_bytes=sum(e['bytes'] for e in received)
    budget_pass=budget_pass and received_lines<=budget['max_lines'] and received_bytes<=budget['max_bytes']
    status=r.get('status','ERROR')
    valid=not errors and status in ('OK','PARTIAL','NOT_FOUND')
    pred=line_set(regions) if valid else set()
    req=line_set(gold['required_evidence']);opt=line_set(gold.get('optional_evidence',[]))
    targets={(t['path'],t['line'],t['name']) for t in gold.get('targets',[])}
    ranks=[i+1 for i,c in enumerate(candidates) if (c['path'],c['line'],c['name']) in targets] if valid else []
    def recall(k):
        hit={(c['path'],c['line'],c['name']) for c in candidates[:k]} if valid else set()
        return len(hit&targets)/len(targets) if targets else None
    def ndcg(k):
        dcg=sum(1/math.log2(i+2) for i,c in enumerate(candidates[:k]) if (c['path'],c['line'],c['name']) in targets) if valid else 0
        ideal=sum(1/math.log2(i+2) for i in range(min(k,len(targets))))
        return dcg/ideal if ideal else None
    line_recall=len(pred&req)/len(req) if req else None
    evidence_complete=bool(req) and req<=pred
    anchor_points={(a['path'],a['line']) for a in task.get('anchors',[])}
    anchor_rate=len(anchor_points&pred)/len(anchor_points) if anchor_points else None
    # Structured QA: strict value and key equality plus all frozen required evidence.
    expected=gold.get('answer')
    received_points=line_set(received) if valid else set()
    received_complete=bool(req) and req<=received_points
    qa=(valid and budget_pass and received_complete and strict_equal(r.get('answer'),expected)) if task['kind']=='qa' else None
    return {'task_id':task['id'],'cluster':task['cluster'],'corpus':task['corpus'],'split':task['split'],
        'workflow':task['workflow'],'kind':task['kind'],'variant':r.get('variant','primary'),
        'status':status,'valid':valid,'errors':errors,'budget_pass':budget_pass,
        'declaration_recall_at_5':recall(5),'declaration_recall_at_10':recall(10),
        'mrr':1/ranks[0] if ranks else 0.0,'ndcg_at_10':ndcg(10),
        'required_line_recall':line_recall,'evidence_complete':evidence_complete,
        'anchor_containment':anchor_rate,
        'received_line_recall':len(req & received_points)/len(req) if req else None,
        'received_evidence_complete':received_complete,'received_lines':received_lines,'received_bytes':received_bytes,
        'explicit_read_line_recall':len(req & line_set([e for e in received if e.get('origin')=='explicit_read']))/len(req) if req and valid else 0.0,
        'annotated_evidence_precision':len(pred&(req|opt))/len(pred) if pred else 0.0,
        'emitted_lines':emitted_lines,'emitted_bytes':emitted_bytes,
        'qa_contract_pass':qa,'repair_pass':None,'usage':usage,'elapsed_ms':r.get('elapsed_ms'),
        'notes':['repair success can only be established by the external frozen-test runner',
                 'annotated precision is a lower-bound proxy; unlabelled lines may be useful']}

def compare_reports(a:dict,b:dict,*,samples:int=2000,seed:int=1984)->dict:
    for key in ('dataset_hash','run_profile','scorer_hash'):
        if a.get(key)!=b.get(key):raise ValueError(f'incomparable {key}')
    if not a.get('dataset_hash') or not a.get('run_profile'):raise ValueError('missing dataset/profile')
    ra={(r['task_id'],r.get('variant','primary'),r.get('repeat',0)):r for r in a.get('rows',[])}
    rb={(r['task_id'],r.get('variant','primary'),r.get('repeat',0)):r for r in b.get('rows',[])}
    if len(ra)!=len(a.get('rows',[])) or len(rb)!=len(b.get('rows',[])):raise ValueError('duplicate case rows')
    if not ra or set(ra)!=set(rb):raise ValueError('case universe differs or is empty')
    metrics=('declaration_recall_at_10','mrr','required_line_recall','received_line_recall','qa_contract_pass','emitted_bytes')
    out={'dataset_hash':a['dataset_hash'],'paired_queries':len(ra),'metrics':{},'decision':'REVIEW_REQUIRED'}
    for m in metrics:
        task_delta=defaultdict(list);clusters={}
        for k,old in ra.items():
            new=rb[k]
            if old.get(m) is None or new.get(m) is None:continue
            task_delta[k[0]].append(float(new[m])-float(old[m]));clusters[k[0]]=old['cluster']
        by_cluster=defaultdict(list)
        for t,vals in task_delta.items():by_cluster[clusters[t]].append(statistics.mean(vals))
        means=[statistics.mean(v) for v in by_cluster.values()]
        if not means:out['metrics'][m]=None;continue
        rng=random.Random(seed);boot=sorted(statistics.mean(rng.choices(means,k=len(means))) for _ in range(samples))
        out['metrics'][m]={'cluster_macro_delta':statistics.mean(means),
                          'task_macro_delta':statistics.mean(statistics.mean(v) for v in task_delta.values()),
                          'cluster_bootstrap_95':[boot[int(samples*.025)],boot[min(samples-1,int(samples*.975))]],
                          'clusters':len(means),'task_groups':len(task_delta),'samples':samples,'seed':seed}
    return out
