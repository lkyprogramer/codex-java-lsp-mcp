"""Inject deliberate evaluator bugs into TEMP COPIES and verify that negative tests kill them."""
from pathlib import Path
import tempfile,shutil,json
from .process import execute
from .dataset import write_json
B=Path(__file__).resolve().parents[1]
def check():
 mutants=[('ignore-stale-hash',"if r.get('content_hash')!=h:","if False:", 'test_hash_mismatch_invalid'),
 ('plan-is-read',"qa=(valid and budget_pass and received_complete and strict_equal", "qa=(valid and budget_pass and evidence_complete and strict_equal", 'test_plan_plus_answer_without_received_source_is_not_success')]
 rows=[]
 for name,old,new,test in mutants:
  with tempfile.TemporaryDirectory(prefix='evaluator-fault-') as tmp:
   tmp=Path(tmp);shutil.copytree(B/'harness',tmp/'harness',ignore=shutil.ignore_patterns('__pycache__'))
   p=tmp/'harness/scoring.py';text=p.read_text()
   if old not in text:raise ValueError('fault target drifted')
   p.write_text(text.replace(old,new,1))
   cls='ScoringTests' if name=='ignore-stale-hash' else 'EvidenceBoundaryTests'
   import sys
   r=execute([sys.executable,'-m','unittest',f'harness.tests.test_scoring.{cls}.{test}','-v'],tmp,10)
   rows.append({'mutant':name,'detected':r['exit_code']==1 and 'AssertionError' in r['stderr'],'test':test,'run':r})
 return {'schema':'evaluator-fault-injection/v1','not_product_results':True,'passed':all(x['detected'] for x in rows),'rows':rows}
if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path);args=p.parse_args()
 r=check()
 if args.output:write_json(args.output,r)
 print(json.dumps(r,indent=2));raise SystemExit(0 if r['passed'] else 1)
