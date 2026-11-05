import unittest,json,tempfile,hashlib,sys,importlib.util,threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer
from harness.cli import score_pack,make_stage,corpus_fingerprint
from harness.dataset import load_dataset,dataset_digest
from harness.process import execute
ROOT=Path(__file__).resolve().parents[2];D=ROOT/'dataset'
class PipelineTests(unittest.TestCase):
 def setUp(self):
  self.ds=load_dataset(D);self.pack={'schema':'java-specialist-results/v1','dataset_hash':dataset_digest(D),'run_profile':{'corpus_hash':corpus_fingerprint(D/'corpora'),'variant_set':'primary','evaluation_mode':'retrieval'},'results':[]}
 def test_missing_all_keeps_24_dev_cases(self):
  r=score_pack(D,D/'corpora',self.pack,'dev');self.assertEqual(len(r['rows']),24);self.assertEqual(r['summary']['overall']['required_line_recall'],0)
 def test_wrong_hash_rejected(self):
  self.pack['dataset_hash']='bad'
  with self.assertRaises(ValueError):score_pack(D,D/'corpora',self.pack,'dev')
 def test_wrong_corpus_hash_rejected(self):
  self.pack['run_profile']['corpus_hash']='bad'
  with self.assertRaises(ValueError):score_pack(D,D/'corpora',self.pack,'dev')
 def test_duplicate_cases_rejected(self):
  r={'task_id':self.ds['tasks'][0]['id'],'status':'OK'};self.pack['results']=[r,r]
  with self.assertRaises(ValueError):score_pack(D,D/'corpora',self.pack,'dev')
 def test_unexpected_case_rejected(self):
  self.pack['results']=[{'task_id':'fake','status':'OK'}]
  with self.assertRaises(ValueError):score_pack(D,D/'corpora',self.pack,'dev')
 def test_stage_excludes_gold_tests_answers(self):
  with tempfile.TemporaryDirectory() as t:
   root=make_stage(self.ds['tasks'][0],Path(t)/'stage',D/'corpora')
   names=[p.relative_to(root.parent).as_posix() for p in root.parent.rglob('*')]
   self.assertFalse(any('/gold/' in p or '/repairs/' in p or 'reference-change' in p or 'Frozen' in p for p in names))
 def test_stage_refuses_overwrite(self):
  with tempfile.TemporaryDirectory() as t:
   with self.assertRaises(ValueError):make_stage(self.ds['tasks'][0],Path(t),D/'corpora')
 def test_process_timeout(self):
  r=execute([sys.executable,'-c','import time;time.sleep(5)'],ROOT,timeout=.15)
  self.assertTrue(r['timeout']);self.assertLess(r['elapsed_ms'],2000)
 def test_process_output_cap(self):
  r=execute([sys.executable,'-c','while True: print("x"*10000,flush=True)'],ROOT,timeout=2,max_bytes=10000)
  self.assertTrue(r['output_limit']);self.assertLessEqual(len(r['stdout']),10000)
 def test_adapter_rejects_old_contract(self):
  spec=importlib.util.spec_from_file_location('adapter',ROOT/'adapters/mcp_static.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  self.assertEqual(m.normalize({'items':[]},{'id':'T'})['status'],'UNSUPPORTED')
 def test_adapter_does_not_guess_name(self):
  spec=importlib.util.spec_from_file_location('adapter',ROOT/'adapters/mcp_static.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  p={'schemaVersion':'java-discovery/v1','scopeState':'READY','candidates':[{'declaration':{'relativePath':'A.java','contentHash':'x','fqn':'demo.A#f','signature':'f()','selection':{'line':1,'column':1}}}]}
  with self.assertRaises(ValueError):m.normalize(p,{'id':'T'})
 def test_mcp_adapter_with_fake_http(self):
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_POST(self):
    data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
    if 'id' not in data:self.send_response(202);self.end_headers();return
    result={'protocolVersion':'2025-03-26','capabilities':{},'serverInfo':{'name':'fake','version':'1'}}
    if data['method']=='tools/call':result={'structuredContent':{'schemaVersion':'java-discovery/v1','scopeState':'READY','candidates':[]},'content':[]}
    raw=json.dumps({'jsonrpc':'2.0','id':data['id'],'result':result}).encode()
    self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
  server=HTTPServer(('127.0.0.1',0),Handler);th=threading.Thread(target=server.serve_forever,daemon=True);th.start()
  try:
   r=execute([sys.executable,str(ROOT/'adapters/mcp_static.py'),'--url',f'http://127.0.0.1:{server.server_port}/mcp'],ROOT,5,input_text=json.dumps({'task':{'id':'T','query':'x'},'repo_root':'/isolated/repo'}))
   self.assertEqual(r['exit_code'],0,r['stderr']);self.assertEqual(json.loads(r['stdout'])['status'],'OK')
  finally:server.shutdown();server.server_close();th.join()

class RepairBoundaryTests(unittest.TestCase):
 def test_unapproved_edit_rejected_before_compile(self):
  from harness.repairs import run_repair
  import shutil
  with tempfile.TemporaryDirectory() as t:
   repo=Path(t)/'repo';shutil.copytree(D/'corpora/payments',repo)
   (repo/'fake-pass.txt').write_text('PASS')
   r=run_repair(D,'JSB-PAYMENTS-03','candidate',repo)
   self.assertEqual(r['status'],'DISALLOWED_EDIT');self.assertFalse(r['validated_success'])
 def test_compile_error_not_counted_as_expected_defect(self):
  from harness.repairs import run_repair
  import shutil
  with tempfile.TemporaryDirectory() as t:
   repo=Path(t)/'repo';shutil.copytree(D/'corpora/payments',repo)
   (repo/'src/main/java/lab/payments/PaymentService.java').write_text('this is not java')
   r=run_repair(D,'JSB-PAYMENTS-03','candidate',repo)
   self.assertEqual(r['status'],'COMPILE_FAILED');self.assertFalse(r['validated_success'])
 def test_reference_is_not_only_way_to_pass(self):
  from harness.repairs import run_repair
  import shutil
  with tempfile.TemporaryDirectory() as t:
   repo=Path(t)/'repo';shutil.copytree(D/'corpora/payments',repo)
   p=repo/'src/main/java/lab/payments/PaymentService.java';p.write_text(p.read_text().replace('String key = tenant;', 'String key = tenant.length() + ":" + tenant + requestId.length() + ":" + requestId;'))
   r=run_repair(D,'JSB-PAYMENTS-03','candidate',repo)
   self.assertTrue(r['validated_success'],r)

 def test_exit_zero_before_frozen_assertions_is_not_success(self):
  from harness.repairs import run_repair
  import shutil
  with tempfile.TemporaryDirectory() as t:
   repo=Path(t)/'repo';shutil.copytree(D/'corpora/payments',repo)
   p=repo/'src/main/java/lab/payments/PaymentService.java'
   p.write_text(p.read_text().replace('String key = tenant;', 'System.exit(0); String key = tenant;'))
   r=run_repair(D,'JSB-PAYMENTS-03','candidate',repo)
   self.assertEqual(r['compile']['exit_code'],0,r)
   self.assertEqual(r['run']['exit_code'],0,r)
   self.assertFalse(r['validated_success'],r)

class GateTests(unittest.TestCase):
 def test_retrieval_unmeasured_is_qualification_fail_not_crash(self):
  from harness.cli import main
  from harness.dataset import write_json
  with tempfile.TemporaryDirectory() as t:
   inp=Path(t)/'report.json';out=Path(t)/'gate.json'
   pack={'schema':'java-specialist-results/v1','dataset_hash':dataset_digest(D),'run_profile':{'corpus_hash':corpus_fingerprint(D/'corpora'),'variant_set':'primary','evaluation_mode':'retrieval'},'results':[]}
   report=score_pack(D,D/'corpora',pack,'dev');write_json(inp,report)
   code=main(['gate','--report',str(inp),'--output',str(out)])
   self.assertEqual(code,1);self.assertEqual(json.loads(out.read_text())['decision'],'QUALIFICATION_FAIL')
 def test_repeat_denominator(self):
  pack={'schema':'java-specialist-results/v1','dataset_hash':dataset_digest(D),'run_profile':{'corpus_hash':corpus_fingerprint(D/'corpora'),'variant_set':'all','repeats':3,'evaluation_mode':'retrieval'},'results':[]}
  r=score_pack(D,D/'corpora',pack,'dev')
  self.assertEqual(len(r['rows']),24*2*3)
  self.assertEqual(len({x['task_id'] for x in r['rows']}),24)
