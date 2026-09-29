import unittest, tempfile, json
from pathlib import Path
from harness.dataset import load_dataset, validate_dataset, load_json, expected_cases, dataset_digest

ROOT=Path(__file__).resolve().parents[2]
class DatasetTests(unittest.TestCase):
    def test_count_and_split(self):
        ds=load_dataset(ROOT/'dataset');self.assertEqual(len(ds['tasks']),36)
        self.assertEqual(sum(t['split']=='dev' for t in ds['tasks']),24)
        self.assertEqual(sum(t['split']=='locked' for t in ds['tasks']),12)
    def test_all_gold_resolves(self): self.assertEqual(validate_dataset(ROOT/'dataset')['errors'],[])
    def test_variants_are_72_queries_not_72_tasks(self):
        self.assertEqual(len(expected_cases(load_dataset(ROOT/'dataset')['tasks'],'all')),72)
    def test_28_qa_8_repair(self):
        ts=load_dataset(ROOT/'dataset')['tasks'];self.assertEqual(sum(t['kind']=='repair' for t in ts),8)
        self.assertEqual(sum(t['kind']=='qa' for t in ts),28)
    def test_12_clusters(self):self.assertEqual(len({t['cluster'] for t in load_dataset(ROOT/'dataset')['tasks']}),12)
    def test_no_cluster_cross_split(self):
        d={}
        for t in load_dataset(ROOT/'dataset')['tasks']:d.setdefault(t['cluster'],set()).add(t['split'])
        self.assertTrue(all(len(v)==1 for v in d.values()))
    def test_nonfinite_json_rejected(self):
        with tempfile.TemporaryDirectory() as p:
            f=Path(p)/'a.json';f.write_text('{"n":NaN}')
            with self.assertRaises(ValueError):load_json(f)
    def test_duplicate_json_key_rejected(self):
        with tempfile.TemporaryDirectory() as p:
            f=Path(p)/'a.json';f.write_text('{"n":1,"n":2}')
            with self.assertRaises(ValueError):load_json(f)
    def test_digest_stable(self):self.assertEqual(dataset_digest(ROOT/'dataset'),dataset_digest(ROOT/'dataset'))

    def test_nested_manifest_is_part_of_dataset_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'repairs').mkdir()
            nested=root/'repairs/manifest.json';nested.write_text('{"allowed_edits":["A.java"]}')
            first=dataset_digest(root)
            nested.write_text('{"allowed_edits":["B.java"]}')
            self.assertNotEqual(first,dataset_digest(root))
    def test_root_manifest_is_excluded_to_avoid_self_reference(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'data.txt').write_text('frozen input')
            first=dataset_digest(root)
            (root/'manifest.json').write_text('{"dataset_hash":"example"}')
            self.assertEqual(first,dataset_digest(root))
