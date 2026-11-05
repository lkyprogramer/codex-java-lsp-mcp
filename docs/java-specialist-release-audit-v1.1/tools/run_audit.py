#!/usr/bin/env python3
"""Run read-only source-export counterexamples. Exit 1 means remaining defects, 2 means setup error."""
import argparse,hashlib,json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def sha(file): return hashlib.sha256(file.read_bytes()).hexdigest()
def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--project',required=True,type=Path)
    ap.add_argument('--output',required=True,type=Path)
    ap.add_argument('--cases',default='',help='Comma-separated case IDs; a focused run is not full validation')
    args=ap.parse_args(); project=args.project.resolve(strict=True); out=args.output.resolve()
    if out==project or project in out.parents: raise ValueError('output must be outside the product checkout')
    if out.exists() and any(out.iterdir()): raise ValueError('output directory must be new or empty; previous evidence is immutable')
    out.mkdir(parents=True,exist_ok=True)
    environment={'PATH':os.environ.get('PATH',''),'HOME':str(out/'home'),'TMPDIR':str(out/'tmp'),
                 'AUDIT_STUB_SDK':'1','AUDIT_CASES':args.cases,'LC_ALL':'C.UTF-8'}
    if os.environ.get('TYPESCRIPT_JS'): environment['TYPESCRIPT_JS']=os.environ['TYPESCRIPT_JS']
    for p in ('home','tmp'): (out/p).mkdir()
    sources=json.loads((ROOT/'provenance/audited-files.json').read_text())
    hashes=[{'path':f['path'],'sha256':sha(project/f['path']) if (project/f['path']).is_file() else None} for f in sources['files']]
    metadata={'schema':'audit-run/v1','project':str(project),'sources':hashes,'selectedCases':args.cases,
              'noNetwork':True,'noLiveModel':True,'noJdt':True,'notTypechecked':True}
    (out/'run.json').write_text(json.dumps(metadata,indent=2))
    try:
        with (out/'transpile.log').open('w') as log:
            r=subprocess.run(['node',str(ROOT/'tools/transpile.cjs'),str(project),str(out/'compiled')],env=environment,stdout=log,stderr=subprocess.STDOUT,timeout=90)
        if r.returncode: print('BLOCKED_ENV_OR_SOURCE_LOAD: see transpile.log'); return 2
        with (out/'counterexamples.log').open('w') as log:
            r=subprocess.run(['node','--experimental-loader',str(ROOT/'tools/offline-sdk-loader.mjs'),
                   str(ROOT/'tools/audit-regressions.mjs'),str(project),str(out/'compiled'),str(out/'counterexamples.json')],
                   env=environment,stdout=log,stderr=subprocess.STDOUT,timeout=120)
        f=out/'counterexamples.json'
        if not f.exists(): print('BLOCKED_ENV_OR_ADAPTER: see counterexamples.log');return 2
        data=json.loads(f.read_text()); known={x['id'] for x in data['rows']}
        requested=set(filter(None,args.cases.split(',')))
        if requested and requested!=known: raise ValueError(f'unknown or unexecuted case IDs: {requested-known}')
        print(json.dumps(data['summary'],ensure_ascii=False));
        if data['summary']['errors']: return 2
        return r.returncode
    except (FileNotFoundError,subprocess.TimeoutExpired) as e:
        (out/'blocked.json').write_text(json.dumps({'status':'BLOCKED_ENV','detail':str(e)}));print(str(e));return 2
if __name__=='__main__':
    try: sys.exit(main())
    except (ValueError,OSError) as e: print(f'ERROR: {e}',file=sys.stderr);sys.exit(2)
