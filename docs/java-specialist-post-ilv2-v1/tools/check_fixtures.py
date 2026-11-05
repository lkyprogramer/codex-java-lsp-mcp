#!/usr/bin/env python3
"""Validate original mechanism labels, compile isolated JDK units, run registered controls."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def sha(data: bytes) -> str: return hashlib.sha256(data).hexdigest()


def execute(argv: list[str], cwd: Path, timeout: int = 45) -> dict:
    started = time.monotonic()
    try:
        p = subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout, check=False)
        return {'exitCode':p.returncode,'elapsedMs':round((time.monotonic()-started)*1000,3),
                'stdout':p.stdout.decode('utf8','replace')[:12000],
                'stderr':p.stderr.decode('utf8','replace')[:12000]}
    except subprocess.TimeoutExpired:
        return {'exitCode':None,'status':'TIMEOUT','elapsedMs':round((time.monotonic()-started)*1000,3)}


def main() -> int:
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, required=True)
    a=p.parse_args()
    manifest=json.loads((ROOT/'evaluator/fixture-manifest.json').read_text())
    cases=json.loads((ROOT/'evaluator/cases.json').read_text())['cases']
    errors=[]
    for item in manifest['files']:
        f=ROOT/item['path']
        if not f.is_file() or sha(f.read_bytes())!=item['sha256']:
            errors.append('MANIFEST_MISMATCH:'+item['path'])
    ids=set()
    for case in cases:
        if case['caseId'] in ids: errors.append('DUPLICATE_CASE:'+case['caseId'])
        ids.add(case['caseId'])
        for target in case['requiredEvidence']:
            f=ROOT/'fixtures/projects'/case['groupId']/target['path']
            if not f.is_file():errors.append('MISSING_TARGET:'+case['caseId']);continue
            data=f.read_bytes();n=len(data.splitlines())
            if sha(data)!=target['contentHash']:errors.append('TARGET_HASH:'+case['caseId'])
            s,e=target['startLine'],target['endLine']
            if type(s) is not int or type(e) is not int or not 1<=s<=e<=n:
                errors.append('TARGET_RANGE:'+case['caseId'])
        if 'expectedSelection' in case:
            target=case['requiredEvidence'][0]
            line=(ROOT/'fixtures/projects'/case['groupId']/target['path']).read_bytes().decode().splitlines()[target['startLine']-1]
            token=case['expectedSelection']['name']
            pos=line.index(token)
            col=len(line[:pos].encode('utf-16-le'))//2+1
            if col!=case['expectedSelection']['columnUtf16']:errors.append('UTF16_SELECTION:'+case['caseId'])
    javac=shutil.which('javac');java=shutil.which('java')
    report={'schema':'post-ilv2/fixture-validation/v1','classification':'KIT_ONLY_NOT_PRODUCT_TEST',
            'caseCount':len(cases),'groupCount':len(set(c['groupId'] for c in cases)),
            'fileCount':len(manifest['files']),'labelErrors':errors,'compilation':[], 'controls':[],
            'productTests':'NOT_RUN','macNativeTests':'NOT_RUN','realJdt':'NOT_RUN'}
    if not javac or not java:
        report['status']='BLOCKED_ENV';report['reason']='JDK_REQUIRED'
    elif errors:
        report['status']='FAIL'
    else:
        report['javac']=execute([javac,'-version'],ROOT)
        report['java']=execute([java,'-version'],ROOT)
        with tempfile.TemporaryDirectory(prefix='post-ilv2-fixtures-') as temp:
            tmp=Path(temp)
            for unit in manifest['compileUnits']:
                out=tmp/unit['group'];out.mkdir()
                files=[]
                for sr in unit['sourceRoots']:files.extend(sorted((ROOT/sr).rglob('*.java')))
                ctrls=[c for c in manifest['controls'] if c['group']==unit['group']]
                files += [ROOT/c['file'] for c in ctrls]
                result=execute([javac,'--release','17','-proc:none','-encoding','UTF-8',
                                '-d',str(out),*[str(f) for f in files]],tmp)
                report['compilation'].append({'group':unit['group'],'sources':len(files),**result})
                if result['exitCode']==0:
                    for c in ctrls:
                        r=execute([java,'-Xmx128m','-cp',str(out),c['main']],tmp,10)
                        report['controls'].append({'group':unit['group'],'main':c['main'],**r})
        report['status']='PASS' if all(x['exitCode']==0 for x in report['compilation']+report['controls']) and len(report['compilation'])==len(manifest['compileUnits']) and len(report['controls'])==len(manifest['controls']) else 'FAIL'
    a.output.parent.mkdir(parents=True,exist_ok=True)
    a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps({'status':report['status'],'cases':len(cases),'groups':report['groupCount'],
                      'compiled':len(report['compilation']),'controls':len(report['controls']),
                      'report':str(a.output)},ensure_ascii=False))
    return 0 if report['status']=='PASS' else 2 if report['status']=='BLOCKED_ENV' else 1

if __name__=='__main__': raise SystemExit(main())
