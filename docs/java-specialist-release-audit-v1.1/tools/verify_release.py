#!/usr/bin/env python3
"""Fail-closed release evidence inventory check; it cannot independently prove a model execution."""
import argparse,hashlib,json,math,re,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
POLICY=json.loads((ROOT/'contracts/release-policy.json').read_text())
STATES={'PASS','FAIL','BLOCKED_ENV','BLOCKED_AUTH','NOT_RUN','INVALID_EXPERIMENT'}

def unique_pairs(pairs):
    result={}
    for k,v in pairs:
        if k in result: raise ValueError('duplicate JSON key: '+k)
        result[k]=v
    return result

def read_json(file):
    return json.loads(Path(file).read_text(),object_pairs_hook=unique_pairs,parse_constant=lambda v: (_ for _ in ()).throw(ValueError('nonfinite number '+v)))

def verify(data,evidence_root):
    errors=[];evidence_root=Path(evidence_root).resolve()
    if data.get('schema')!='java-specialist-release-evidence/v1.1':errors.append('unsupported schema')
    if not re.fullmatch('[0-9a-f]{40}',str(data.get('candidateSha',''))):errors.append('candidateSha must be full 40-hex')
    for key in ('datasetHash','scorerHash','protocolHash'):
        if not re.fullmatch('[0-9a-f]{64}',str(data.get(key,''))):errors.append(key+' must be a measured 64-hex digest')
    def artifact(ref):
        if not isinstance(ref,dict): errors.append('evidence reference must be an object');return
        rel=ref.get('path');digest=ref.get('sha256')
        if not isinstance(rel,str) or Path(rel).is_absolute() or '..' in Path(rel).parts:errors.append('unsafe artifact path');return
        p=evidence_root/rel
        try:
            for q in [p,*[evidence_root.joinpath(*Path(rel).parts[:i]) for i in range(1,len(Path(rel).parts))]]:
                if q.is_symlink():raise ValueError('symlink artifact')
            p.resolve(strict=True).relative_to(evidence_root)
            if not p.is_file():raise ValueError('not a file')
            if hashlib.sha256(p.read_bytes()).hexdigest()!=digest:raise ValueError('digest mismatch')
        except (ValueError,OSError) as e:errors.append(f'artifact {rel}: {e}')
    for collection,expected in [('gates',POLICY['requiredGates']),('contracts',POLICY['requiredContracts'])]:
        rows=data.get(collection,[])
        if not isinstance(rows,list):errors.append(collection+' must be an array');continue
        seen=set()
        for row in rows:
            if not isinstance(row,dict):errors.append(collection+' entry must be an object');continue
            ident=row.get('id')
            if ident in seen:errors.append('duplicate '+str(ident))
            seen.add(ident)
            if ident not in expected: errors.append('unexpected '+str(ident))
            if row.get('status') not in STATES: errors.append('invalid status '+str(ident))
            if row.get('status')!='PASS':errors.append(str(ident)+' not PASS')
            refs=row.get('evidence',[])
            if not isinstance(refs,list) or not refs:errors.append(str(ident)+' missing evidence')
            else:
                for ref in refs:artifact(ref)
        for missing in set(expected)-seen:errors.append('missing '+missing)
    metrics=data.get('metrics',{})
    def number(name):
        n=metrics.get(name)
        if type(n) not in (int,float) or not math.isfinite(n):errors.append('unmeasured '+name);return None
        return n
    q=number('qaContractRate');new=number('newCriticalRegressions');rep=number('actualRepairTaskGroups')
    if q is not None and not 0<=q<=1:errors.append('invalid qa rate')
    if q is not None and q<POLICY['minimumQaContractRate']:errors.append('QA frozen floor failed')
    if new is not None and new!=0:errors.append('new critical regression')
    if rep!=8:errors.append('all eight real-agent repair groups must be measured; no oracle substitution')
    for n in ('scheduledRuns','receivedRuns'):
        if type(metrics.get(n)) is not int or metrics[n]<1:errors.append('invalid '+n)
    if metrics.get('scheduledRuns')!=metrics.get('receivedRuns'):errors.append('missing scheduled run records')
    if metrics.get('runMode')!='REAL_AGENT':errors.append('LIVE evidence is not REAL_AGENT')
    if metrics.get('scoringProtocol')!='FROZEN_CANONICAL':errors.append('noncanonical scorer')
    if data.get('claims',{}).get('costReduction') is True and metrics.get('usageComplete') is not True:errors.append('cost claim without complete provider usage')
    if data.get('optionalExperimentEnabled') is True and data.get('optionalExperimentDecision')!='GO_OPTIONAL':errors.append('optional experiment not qualified')
    if data.get('optionalExperimentEnabled') is True:
        refs=data.get('optionalExperimentEvidence',[])
        if not refs:errors.append('missing fixed-budget/cache-reproducible experiment evidence')
        for ref in refs:artifact(ref)
    # Eligibility and user authorization are deliberately distinct.
    return {'schema':'java-specialist-release-verdict/v1.1','eligibility':'NO_GO' if errors else 'ELIGIBLE_FOR_MANUAL_REVIEW',
            'deploymentAuthorized':data.get('deploymentAuthorized') is True,'deploymentPerformed':False,'errors':errors,
            'limit':'Artifact hashes and declared states do not prove execution. A separate reviewer must inspect raw traces, candidate provenance and all per-case outcomes.'}

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('manifest',type=Path);ap.add_argument('--evidence-root',required=True,type=Path);ap.add_argument('--out',type=Path)
    args=ap.parse_args();r=verify(read_json(args.manifest),args.evidence_root);text=json.dumps(r,ensure_ascii=False,indent=2)
    if args.out:args.out.parent.mkdir(parents=True,exist_ok=True);args.out.write_text(text)
    print(text);return 1 if r['errors'] else 0
if __name__=='__main__':
    try:sys.exit(main())
    except (ValueError,OSError,TypeError,KeyError) as e:print('INVALID_MANIFEST: '+str(e),file=sys.stderr);sys.exit(2)
