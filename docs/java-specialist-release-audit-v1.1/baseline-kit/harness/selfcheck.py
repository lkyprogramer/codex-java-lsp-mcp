"""Run all OFFLINE kit checks. It does not modify or certify the product."""
import argparse,sys
from pathlib import Path
from .process import execute
from .dataset import write_json

def main():
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
 root=Path(__file__).resolve().parents[1]
 commands=[('dataset',[sys.executable,'-m','harness','validate']),
 ('unit',[sys.executable,'-m','unittest','discover','-s','harness/tests','-v']),
 ('repair-oracles',[sys.executable,'-m','harness','check-repairs','--output',str(a.output.resolve()/'repair-oracles.json')]),
 ('upstream',[sys.executable,'-m','harness.verify_upstream']),
 ('faultcheck',[sys.executable,'-m','harness.faultcheck','--output',str(a.output.resolve()/'evaluator-faultcheck.json')])]
 rows=[]
 for name,argv in commands:
  r=execute(argv,root,180,max_bytes=1048576);write_json(a.output/(name+'-command.json'),r);rows.append({'name':name,'exit':r['exit_code'],'timeout':r['timeout'],'output_limit':r['output_limit']})
 result={'schema':'kit-selfcheck/v1','passed':all(x['exit']==0 and not x['timeout'] and not x['output_limit'] for x in rows),'scope':'KIT_ONLY','product_release':'NOT_RUN','live_agent':'NOT_RUN','rows':rows}
 write_json(a.output/'summary.json',result);print(result);raise SystemExit(0 if result['passed'] else 1)
if __name__=='__main__':main()
