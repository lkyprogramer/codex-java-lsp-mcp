from __future__ import annotations
import argparse,hashlib,json,os,shutil,statistics,sys,tempfile,time
from pathlib import Path
from collections import Counter
from .dataset import load_dataset,validate_dataset,dataset_digest,write_json,load_json,expected_cases,parse_json
from .scoring import evaluate,compare_reports,safe_file
from .baseline import retrieve
from .repairs import run_repair,verify_all
from .process import execute

KIT=Path(__file__).resolve().parents[1]

def select(ds,split):return [t for t in ds['tasks'] if split=='all' or t['split']==split]
def corpus_fingerprint(root):
    h=hashlib.sha256()
    for p in sorted(root.rglob('*')):
        if not p.is_file() or '.git' in p.relative_to(root).parts:continue
        h.update(p.relative_to(root).as_posix().encode()+b'\0'+hashlib.sha256(p.read_bytes()).digest())
    return h.hexdigest()

def profile(args,corpora_root):
    return {'corpus_mode':'bundled-scoped' if args.corpora_root is None else 'external-full',
            'corpus_hash':corpus_fingerprint(corpora_root),'variant_set':args.variants,
            'evaluation_mode':'retrieval','repeats':getattr(args,'repeats',1),'cache_state':'per-attempt-retrieval-control','model_id':None,'host_id':'external-adapter/v1',
            'budget_profile':'fixed-160-lines-16000-bytes/v1'}

def aggregate(rows):
    def summary(rs):
        out={'attempts':len(rs),'task_groups':len({r['task_id'] for r in rs}),
             'status_counts':dict(Counter(r['status'] for r in rs)),
             'invalid':sum(not r['valid'] for r in rs),'over_budget':sum(not r['budget_pass'] for r in rs)}
        for m in ('declaration_recall_at_10','mrr','ndcg_at_10','required_line_recall','received_line_recall','anchor_containment','emitted_bytes','received_bytes'):
            vals=[r[m] for r in rs if r.get(m)is not None];out[m]=statistics.mean(vals) if vals else None
        qa=[r['qa_contract_pass'] for r in rs if r.get('qa_contract_pass')is not None]
        out['qa_contract_pass_rate']=sum(qa)/len(qa) if qa else None
        us=[r.get('usage') for r in rs]
        measured=[u.get('input_tokens') for u in us if isinstance(u,dict) and type(u.get('input_tokens'))is int]
        out['provider_input_measured_attempts']=len(measured)
        out['provider_input_tokens_total']=sum(measured) if len(measured)==len(rs) and rs else None
        out['repair_success']='UNMEASURED_USE_FROZEN_REPAIR_RUNNER'
        return out
    return {'overall':summary(rows),'by_origin':{k:summary([r for r in rows if r['origin']==k]) for k in sorted({r['origin'] for r in rows})},
            'by_split':{s:summary([r for r in rows if r['split']==s]) for s in sorted({r['split'] for r in rows})},
            'by_corpus':{c:summary([r for r in rows if r['corpus']==c]) for c in sorted({r['corpus'] for r in rows})}}

def make_stage(task,dest,corpora_root):
    dest=Path(dest)
    if dest.exists():raise ValueError('stage output must not already exist')
    dest.mkdir(parents=True);shutil.copytree(corpora_root/task['corpus'],dest/'repo',ignore=shutil.ignore_patterns('.git'))
    write_json(dest/'task.json',task)
    (dest/'README.txt').write_text('Agent-visible inputs only. Gold, reference patches and frozen tests are evaluator-owned. This directory is NOT an OS security boundary.\n')
    return dest/'repo'

def score_pack(d,corpora_root,pack,split):
    if pack.get('schema')!='java-specialist-results/v1':raise ValueError('unsupported result schema')
    if pack.get('dataset_hash')!=dataset_digest(d):raise ValueError('dataset hash mismatch')
    if not isinstance(pack.get('run_profile'),dict):raise ValueError('missing run_profile')
    if pack['run_profile'].get('evaluation_mode') not in ('retrieval','structured-qa','agent'):raise ValueError('invalid evaluation_mode')
    if pack['run_profile'].get('corpus_hash')!=corpus_fingerprint(corpora_root):raise ValueError('corpus fingerprint mismatch')
    ds=load_dataset(d);ts=select(ds,split);variants=pack['run_profile'].get('variant_set')
    if variants not in ('primary','all'):raise ValueError('unsupported variant_set')
    repeats=pack['run_profile'].get('repeats',1)
    if type(repeats)is not int or not 1<=repeats<=10:raise ValueError('invalid repeats')
    cases=[(t,v,q,n) for n in range(repeats) for t,v,q in expected_cases(ts,variants)]
    universe={(t['id'],v,n) for t,v,q,n in cases};by={}
    if not isinstance(pack.get('results'),list):raise ValueError('results must be an array')
    for r in pack['results']:
        key=(r['task_id'],r.get('variant','primary'),r.get('repeat',0))
        if key in by:raise ValueError(f'duplicate case: {key}')
        if key not in universe:raise ValueError(f'unexpected case for selected split: {key}')
        by[key]=r
    rows=[]
    for t,v,q,n in cases:
        r=evaluate(t,ds['gold'][t['id']],by.get((t['id'],v,n)),corpora_root/t['corpus'])
        r['variant']=v;r['repeat']=n;r['origin']=t['origin']
        if pack['run_profile'].get('evaluation_mode')=='retrieval':r['qa_contract_pass']=None
        rows.append(r)
    return {'schema':'java-specialist-report/v1','dataset_hash':pack['dataset_hash'],'run_profile':pack['run_profile'],
            'arm':pack.get('arm'),'source_sha':pack.get('source_sha'),'selected_split':split,'rows':rows,'summary':aggregate(rows),
            'qualification':'RETRIEVAL_AND_STRUCTURED_QA_ONLY','scorer_hash':hashlib.sha256((KIT/'harness/scoring.py').read_bytes()).hexdigest()}

def render(report):
    s=report['summary']['overall'];lines=['# Java Specialist Benchmark Report','',f"- Arm: `{report.get('arm')}`",f"- Dataset: `{report['dataset_hash']}`",f"- Scope: `{report['run_profile']['corpus_mode']}`",'',
    '| Metric | Value |','|---|---:|']
    for k,v in s.items():lines.append(f'| {k} | {json.dumps(v,ensure_ascii=False)} |')
    lines += ['','## Case results','','| Task / variant | Status | R@10 | Required lines | Received lines | QA |','|---|---|---:|---:|---:|---|']
    for r in report['rows']:lines.append(f"| {r['task_id']} / {r['variant']} | {r['status']} | {r['declaration_recall_at_10']} | {r['required_line_recall']} | {r['received_line_recall']} | {r['qa_contract_pass']} |")
    lines += ['','## Limits','Corpus-scoped QA is not a full repository repair benchmark. Missing/unsupported attempts remain in the denominator. Repair results require separately recorded frozen-test execution. Variants and tasks in the same corpus are correlated; use cluster-aware comparison.']
    return '\n'.join(lines)+'\n'

def main(argv=None):
    ap=argparse.ArgumentParser(description='Java Specialist independent evaluation kit (stdlib only)')
    ap.add_argument('--dataset',type=Path,default=KIT/'dataset');ap.add_argument('--corpora-root',type=Path)
    sub=ap.add_subparsers(dest='cmd',required=True)
    p=sub.add_parser('validate');p.add_argument('--output',type=Path)
    for name in ('baseline','run-adapter'):
        p=sub.add_parser(name);p.add_argument('--split',choices=['dev','locked','all'],default='dev');p.add_argument('--variants',choices=['primary','all'],default='primary');p.add_argument('--repeats',type=int,choices=range(1,11),default=1);p.add_argument('--output',type=Path,required=True)
        if name=='baseline':p.add_argument('--method',choices=['bm25','grep'],default='bm25')
        else:
            p.add_argument('--command-json',required=True,help='JSON argv array; executed without shell, one request on stdin')
            p.add_argument('--arm',required=True);p.add_argument('--source-sha',required=True);p.add_argument('--timeout',type=int,default=30)
    p=sub.add_parser('score');p.add_argument('--input',type=Path,required=True);p.add_argument('--split',choices=['dev','locked','all'],default='dev');p.add_argument('--output',type=Path,required=True)
    p=sub.add_parser('compare');p.add_argument('--baseline',type=Path,required=True);p.add_argument('--candidate',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p=sub.add_parser('stage');p.add_argument('--task',required=True);p.add_argument('--output',type=Path,required=True)
    p=sub.add_parser('check-repairs');p.add_argument('--output',type=Path,required=True)
    p=sub.add_parser('repair');p.add_argument('--task',required=True);p.add_argument('--mode',choices=['baseline','reference','candidate'],required=True);p.add_argument('--candidate',type=Path);p.add_argument('--output',type=Path,required=True)
    p=sub.add_parser('hydrate-public');p.add_argument('--output',type=Path,required=True);p.add_argument('--allow-network',action='store_true')
    p=sub.add_parser('gate');p.add_argument('--report',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    args=ap.parse_args(argv);d=args.dataset.resolve();corpora=(args.corpora_root or d/'corpora').resolve()
    check=validate_dataset(d)
    if check['errors']:raise ValueError('; '.join(check['errors']))
    ds=load_dataset(d)
    if args.cmd=='validate':
        if args.output:write_json(args.output,check)
        print(json.dumps(check,ensure_ascii=False));return 0
    if args.cmd in ('baseline','run-adapter'):
        rows=[];ts=select(ds,args.split);rawlogs=[]
        if args.cmd=='run-adapter':
            command=parse_json(args.command_json)
            if not isinstance(command,list) or not command or not all(isinstance(x,str) for x in command):raise ValueError('command must be a JSON string array')
        for t,v,q,n in [(t,v,q,n) for n in range(args.repeats) for t,v,q in expected_cases(ts,args.variants)]:
            if args.cmd=='baseline':row=retrieve(corpora/t['corpus'],t,q,args.method)
            else:
                with tempfile.TemporaryDirectory(prefix='java-bench-case-') as temp:
                    home=Path(temp)/'home';home.mkdir();root=make_stage(t,Path(temp)/'stage',corpora)
                    request={'schema':'java-specialist-request/v1','task':{**t,'query':q},'variant':v,'repeat':n,'repo_root':str(root),'output_cap_bytes':1048576}
                    env={'PATH':os.environ.get('PATH',''),'HOME':str(home),'XDG_CACHE_HOME':str(home/'cache'),'XDG_CONFIG_HOME':str(home/'config'),
                        'JAVA_LSP_CACHE_BASE':str(home/'java-cache'),'JAVA_LSP_OWNERSHIP_BASE':str(home/'ownership'),
                        'CODEX_HOME':str(home/'codex'),'GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_NOSYSTEM':'1'}
                    try:
                        proc=execute(command,root,args.timeout,env,json.dumps(request))
                        rawlogs.append({'task_id':t['id'],'variant':v,'repeat':n,**proc})
                        if proc['timeout']:row={'task_id':t['id'],'status':'TIMEOUT'}
                        elif proc['exit_code']!=0 or proc['output_limit']:row={'task_id':t['id'],'status':'ERROR','diagnostics':{'exit_code':proc['exit_code']}}
                        else:
                            row=parse_json(proc['stdout'])
                            if not isinstance(row,dict):raise ValueError('adapter result must be an object')
                        row['elapsed_ms']=proc['elapsed_ms']
                    except (OSError,ValueError) as e:row={'task_id':t['id'],'status':'ERROR','diagnostics':{'error':str(e)}}
            row['variant']=v;row['repeat']=n;rows.append(row)
        arm=args.method if args.cmd=='baseline' else args.arm
        pack={'schema':'java-specialist-results/v1','dataset_hash':dataset_digest(d),'run_profile':profile(args,corpora),'arm':arm,
              'source_sha':None if args.cmd=='baseline' else args.source_sha,'results':rows}
        write_json(args.output,pack)
        if rawlogs:write_json(args.output.with_suffix('.raw.json'),rawlogs)
        print(f'{len(rows)} query attempts written; no product quality verdict implied');return 0
    if args.cmd=='score':
        report=score_pack(d,corpora,load_json(args.input),args.split);write_json(args.output,report)
        args.output.with_suffix('.md').write_text(render(report));print(json.dumps(report['summary']['overall']));return 0
    if args.cmd=='compare':
        result=compare_reports(load_json(args.baseline),load_json(args.candidate));write_json(args.output,result);print(json.dumps(result));return 0
    if args.cmd=='stage':
        t=next(t for t in ds['tasks'] if t['id']==args.task);print(make_stage(t,args.output,corpora));return 0
    if args.cmd=='check-repairs':
        result=verify_all(d);write_json(args.output,result);print('ORACLE_CHECK_PASS' if result['passed'] else 'ORACLE_CHECK_FAIL');return 0 if result['passed'] else 1
    if args.cmd=='repair':
        result=run_repair(d,args.task,args.mode,args.candidate);write_json(args.output,result);print(result['status']);return 0 if result['validated_success'] else 1
    if args.cmd=='gate':
        r=load_json(args.report);rules=load_json(KIT/'schemas/gates.json')
        if r.get('schema')!='java-specialist-report/v1' or r.get('dataset_hash')!=dataset_digest(d):raise ValueError('gate report provenance mismatch')
        if r.get('selected_split') not in ('dev','locked','all'):raise ValueError('gate report split missing')
        rows=r['rows'];qa=[x for x in rows if x['kind']=='qa']
        qa_measured=bool(qa) and all(type(x.get('qa_contract_pass'))is bool for x in qa)
        expected={(t['id'],v,n) for n in range(r['run_profile'].get('repeats',1)) for t,v,q in expected_cases(select(ds,r['selected_split']),r['run_profile']['variant_set'])}
        actual={(x['task_id'],x.get('variant','primary'),x.get('repeat',0)) for x in rows}
        if expected!=actual or len(rows)!=len(actual):raise ValueError('gate case universe mismatch')
        tests={'integrity':all(x['valid'] for x in rows),'budget':all(x['budget_pass'] for x in rows),
               'anchors':all(x['anchor_containment'] in (None,1.0) for x in rows),
               'qa_measurement_complete':qa_measured,
               'qa_contract_floor': qa_measured and sum(x['qa_contract_pass'] for x in qa)/len(qa)>=rules['qa_contract_floor']}
        result={'decision':'QUALIFICATION_PASS' if all(tests.values()) else 'QUALIFICATION_FAIL','gates':tests,
                'scope':'STRUCTURED_QA_ONLY_NOT_RELEASE','full_release_requires':rules['release_requires']}
        write_json(args.output,result);print(json.dumps(result));return 0 if all(tests.values()) else 1
    if args.cmd=='hydrate-public':
        if not args.allow_network:raise ValueError('explicit --allow-network required')
        if args.output.exists():raise ValueError('output must not exist')
        args.output.mkdir(parents=True);up=load_json(KIT/'provenance/upstream.json');full=[]
        for c in ds['corpora']:
            target=args.output/c['id']
            if c['origin']=='authored':shutil.copytree(d/'corpora'/c['id'],target);continue
            target.mkdir()
            for cmd in (['git','init','-q'],['git','-c','protocol.file.allow=never','fetch','--depth=1',f"https://github.com/{c['repository']}.git",c['commit']],['git','checkout','--detach','FETCH_HEAD']):
                p=execute(cmd,target,180)
                if p['exit_code']!=0:raise ValueError(f"hydrate failed {c['id']}: {p['stderr']}")
            head=execute(['git','rev-parse','HEAD'],target)['stdout'].strip()
            if head!=c['commit']:raise ValueError('checkout SHA mismatch')
            for file in [f for f in up if f['corpus']==c['id']]:
                if hashlib.sha256(safe_file(target,file['path']).read_bytes()).hexdigest()!=file['sha256']:raise ValueError('upstream source mismatch')
            full.append({'id':c['id'],'commit':head})
        write_json(args.output.parent/(args.output.name+'-manifest.json'),{'full_repos':full,'corpus_hash':corpus_fingerprint(args.output),'profile':'external-full'})
        print('Full corpus fetched; label range checks passed for pinned seed files. No upstream builds were run.');return 0
    return 2

if __name__=='__main__':
    try:sys.exit(main())
    except (ValueError,OSError,KeyError,StopIteration) as e:print(f'ERROR: {e}',file=sys.stderr);sys.exit(2)
