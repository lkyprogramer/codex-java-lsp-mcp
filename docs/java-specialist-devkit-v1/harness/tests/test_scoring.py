import hashlib, tempfile, unittest
from pathlib import Path
from harness.scoring import evaluate, compare_reports, validate_regions

class ScoringTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name)
        self.source='class A {\n  void save() {\n    commit();\n  }\n}\n'
        (self.root/'A.java').write_text(self.source)
        self.h=hashlib.sha256(self.source.encode()).hexdigest()
        self.task={'id':'t1','corpus':'c1','cluster':'c1','split':'dev','kind':'qa','workflow':'entry',
                   'budget':{'max_regions':8,'max_lines':20,'max_bytes':1000}, 'anchors':[]}
        self.gold={'id':'t1','targets':[{'path':'A.java','line':2,'name':'save'}],
                   'required_evidence':[{'path':'A.java','start_line':2,'end_line':3}],
                   'optional_evidence':[], 'answer':{'operation':'commit'}}
    def tearDown(self): self.tmp.cleanup()
    def row(self, **kw):
        r={'task_id':'t1','status':'OK','regions':[], 'candidates':[], 'answer':None,'usage':None}
        r.update(kw);return r
    def region(self,a=2,b=3,**kw):
        return {'path':'A.java','start_line':a,'end_line':b,'content_hash':self.h,**kw}
    def score(self,row): return evaluate(self.task,self.gold,row,self.root)
    def test_paths_are_not_reads(self):
        r=self.score(self.row(candidates=[{'path':'A.java','line':2,'name':'save'}]))
        self.assertEqual(r['declaration_recall_at_10'],1);self.assertEqual(r['required_line_recall'],0)
        self.assertFalse(r['qa_contract_pass'])
    def test_complete_evidence_and_answer(self):
        r=self.score(self.row(regions=[self.region()],read_events=[{**self.region(),'text':'  void save() {\n    commit();\n','origin':'explicit_read'}],answer={'operation':'commit'}))
        self.assertEqual(r['required_line_recall'],1);self.assertTrue(r['qa_contract_pass'])
    def test_wrong_answer_fails_with_perfect_coverage(self):
        self.assertFalse(self.score(self.row(regions=[self.region()],answer={'operation':'rollback'}))['qa_contract_pass'])
    def test_gold_answer_without_evidence_fails(self):
        self.assertFalse(self.score(self.row(answer={'operation':'commit'}))['qa_contract_pass'])
    def test_overlap_does_not_double_recall(self):
        a=self.score(self.row(regions=[self.region(),self.region()]))
        self.assertEqual(a['required_line_recall'],1);self.assertEqual(a['emitted_lines'],4)
    def test_hash_mismatch_invalid(self):
        r=self.score(self.row(regions=[self.region(content_hash='0'*64)])); self.assertFalse(r['valid'])
    def test_path_escape_invalid(self):
        r=self.score(self.row(regions=[self.region(path='../secret')])); self.assertFalse(r['valid'])
    def test_absolute_path_invalid(self):
        r=self.score(self.row(regions=[self.region(path=str(self.root/'A.java'))]));self.assertFalse(r['valid'])
    def test_symlink_escape_invalid(self):
        (self.root/'link.java').symlink_to('/etc/passwd')
        self.assertFalse(self.score(self.row(regions=[self.region(path='link.java')]))['valid'])
    def test_out_of_bounds_invalid(self):
        self.assertFalse(self.score(self.row(regions=[self.region(1,9000)]))['valid'])
    def test_oversized_evidence_fails_budget(self):
        self.task['budget']['max_lines']=1
        r=self.score(self.row(regions=[self.region()]));self.assertFalse(r['budget_pass']);self.assertFalse(r['qa_contract_pass'])
    def test_missing_row_stays_in_denominator(self):
        r=self.score(None);self.assertEqual(r['required_line_recall'],0);self.assertEqual(r['status'],'MISSING')
    def test_usage_unknown_not_zero(self): self.assertIsNone(self.score(self.row())['usage'])
    def test_candidate_outside_scope_invalid(self):
        self.assertFalse(self.score(self.row(candidates=[{'path':'../A.java','line':2,'name':'save'}]))['valid'])
    def test_fake_success_not_trusted(self):
        self.assertFalse(self.score(self.row(task_success=True,repair_pass=True))['qa_contract_pass'])
    def test_repair_unmeasured_from_retrieval_output(self):
        self.task['kind']='repair'
        self.assertIsNone(self.score(self.row(regions=[self.region()],repair_pass=True))['repair_pass'])
    def test_utf8_budget_uses_actual_bytes(self):
        (self.root/'A.java').write_text('汉字\n');h=hashlib.sha256((self.root/'A.java').read_bytes()).hexdigest()
        regs,_=validate_regions(self.root,[{'path':'A.java','start_line':1,'end_line':1,'content_hash':h}])
        self.assertEqual(regs[0]['bytes'],7)
    def test_boolean_is_not_line_number(self):
        self.assertFalse(self.score(self.row(regions=[self.region(True,3)]))['valid'])
    def test_duplicate_candidates_no_rank_gain(self):
        c={'path':'A.java','line':2,'name':'save'}
        self.assertEqual(self.score(self.row(candidates=[c,c]))['declaration_recall_at_10'],1)
    def test_correct_answer_with_extra_wrong_field_rejected(self):
        self.assertFalse(self.score(self.row(regions=[self.region()],answer={'operation':'commit','pretend':True}))['qa_contract_pass'])
    def test_compare_mismatched_dataset_rejected(self):
        with self.assertRaises(ValueError):compare_reports({'dataset_hash':'a'},{'dataset_hash':'b'})
    def test_case_mismatch_not_empty_perfect_comparison(self):
        a={'dataset_hash':'a','run_profile':'same','rows':[{'task_id':'x','variant':'primary'}]}
        b={'dataset_hash':'a','run_profile':'same','rows':[]}
        with self.assertRaises(ValueError):compare_reports(a,b)

if __name__=='__main__':unittest.main()

class EvidenceBoundaryTests(unittest.TestCase):
    setUp=ScoringTests.setUp
    tearDown=ScoringTests.tearDown
    row=ScoringTests.row
    region=ScoringTests.region
    score=ScoringTests.score
    def test_plan_plus_answer_without_received_source_is_not_success(self):
        self.assertFalse(self.score(self.row(regions=[self.region()],answer={'operation':'commit'}))['qa_contract_pass'])
    def test_received_source_is_verified(self):
        event={**self.region(),'text':'  void save() {\n    commit();\n','origin':'explicit_read'}
        row=self.row(regions=[self.region()],read_events=[event],answer={'operation':'commit'})
        self.assertTrue(self.score(row)['qa_contract_pass'])
    def test_forged_received_text_fails(self):
        event={**self.region(),'text':'pretend','origin':'tool_response'}
        self.assertFalse(self.score(self.row(regions=[self.region()],read_events=[event],answer={'operation':'commit'}))['valid'])
    def test_unmeasured_usage_never_turns_to_zero(self):
        self.assertIsNone(self.score(self.row(usage={'source':'estimate','input_tokens':20}))['usage'])
    def test_boolean_answer_not_integer_answer(self):
        self.gold['answer']={'n':1}
        event={**self.region(),'text':'  void save() {\n    commit();\n','origin':'explicit_read'}
        self.assertFalse(self.score(self.row(regions=[self.region()],read_events=[event],answer={'n':True}))['qa_contract_pass'])
