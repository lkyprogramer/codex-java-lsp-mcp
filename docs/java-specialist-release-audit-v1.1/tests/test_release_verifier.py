"""Verifier self-tests use fabricated evidence inventories; these are NEVER product eligibility results."""
import copy,hashlib,json,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from verify_release import POLICY,verify,read_json
class VerifierTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        raw=b'synthetic verifier self-test; not a real measurement\n';(self.root/'proof.txt').write_bytes(raw)
        ref={'path':'proof.txt','sha256':hashlib.sha256(raw).hexdigest()}
        self.good={'schema':'java-specialist-release-evidence/v1.1','candidateSha':'a'*40,
                   'datasetHash':'b'*64,'scorerHash':'c'*64,'protocolHash':'d'*64,
                   'gates':[{'id':k,'status':'PASS','evidence':[ref]} for k in POLICY['requiredGates']],
                   'contracts':[{'id':k,'status':'PASS','evidence':[ref]} for k in POLICY['requiredContracts']],
                   'metrics':{'qaContractRate':0.8,'newCriticalRegressions':0,'actualRepairTaskGroups':8,
                              'scheduledRuns':72,'receivedRuns':72,'runMode':'REAL_AGENT','scoringProtocol':'FROZEN_CANONICAL','usageComplete':False},
                   'claims':{'costReduction':False},'optionalExperimentEnabled':False,'deploymentAuthorized':False}
    def tearDown(self):self.temp.cleanup()
    def rejected(self,d):self.assertEqual(verify(d,self.root)['eligibility'],'NO_GO')
    def test_inventory_pass_is_not_authorization(self):
        r=verify(self.good,self.root);self.assertEqual(r['eligibility'],'ELIGIBLE_FOR_MANUAL_REVIEW');self.assertFalse(r['deploymentAuthorized']);self.assertFalse(r['deploymentPerformed'])
    def test_missing_k(self):d=copy.deepcopy(self.good);d['contracts'].pop();self.rejected(d)
    def test_duplicate_k(self):d=copy.deepcopy(self.good);d['contracts'].append(d['contracts'][0]);self.rejected(d)
    def test_not_run_k(self):d=copy.deepcopy(self.good);d['contracts'][0]['status']='NOT_RUN';self.rejected(d)
    def test_partial_cannot_pass(self):d=copy.deepcopy(self.good);d['contracts'][0]['status']='PARTIAL';self.rejected(d)
    def test_missing_gate(self):d=copy.deepcopy(self.good);d['gates'].pop();self.rejected(d)
    def test_invalid_experiment(self):d=copy.deepcopy(self.good);d['gates'][2]['status']='INVALID_EXPERIMENT';self.rejected(d)
    def test_missing_evidence(self):d=copy.deepcopy(self.good);d['gates'][0]['evidence']=[];self.rejected(d)
    def test_corrupt_digest(self):d=copy.deepcopy(self.good);d['gates'][0]['evidence'][0]['sha256']='0'*64;self.rejected(d)
    def test_traversal(self):d=copy.deepcopy(self.good);d['gates'][0]['evidence'][0]['path']='../proof.txt';self.rejected(d)
    def test_symlink(self):
        (self.root/'link').symlink_to(self.root/'proof.txt');d=copy.deepcopy(self.good);d['gates'][0]['evidence'][0]['path']='link';self.rejected(d)
    def test_qa_floor(self):d=copy.deepcopy(self.good);d['metrics']['qaContractRate']=0.79;self.rejected(d)
    def test_bool_not_number(self):d=copy.deepcopy(self.good);d['metrics']['qaContractRate']=True;self.rejected(d)
    def test_missing_attempts(self):d=copy.deepcopy(self.good);d['metrics']['receivedRuns']=71;self.rejected(d)
    def test_oracle_not_live(self):d=copy.deepcopy(self.good);d['metrics']['runMode']='ORACLE';self.rejected(d)
    def test_only_seven_repairs(self):d=copy.deepcopy(self.good);d['metrics']['actualRepairTaskGroups']=7;self.rejected(d)
    def test_noncanonical_scorer(self):d=copy.deepcopy(self.good);d['metrics']['scoringProtocol']='JS_STRING_COERCION';self.rejected(d)
    def test_invented_cost_claim(self):d=copy.deepcopy(self.good);d['claims']['costReduction']=True;self.rejected(d)
    def test_unqualified_optional(self):d=copy.deepcopy(self.good);d['optionalExperimentEnabled']=True;d['optionalExperimentDecision']='KEEP_EXTERNAL';self.rejected(d)
    def test_duplicate_json_key(self):
        f=self.root/'dup.json';f.write_text('{"a":1,"a":2}');self.assertRaises(ValueError,read_json,f)
    def test_nonfinite_json(self):
        f=self.root/'nan.json';f.write_text('{"a":NaN}');self.assertRaises(ValueError,read_json,f)
    def test_authorized_does_not_fix_missing_tests(self):
        d=copy.deepcopy(self.good);d['deploymentAuthorized']=True;d['contracts']=[];self.rejected(d)
if __name__=='__main__':unittest.main()
