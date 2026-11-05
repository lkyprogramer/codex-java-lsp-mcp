import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from check_delivery import ReceiptError, check_receipt

class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data = b'class A {\n  int value() { return 7; }\n}\n'
        (self.root/'A.java').write_bytes(self.data)
        self.view = {'workspaceId':'work-a','contentManifestId':'manifest-a'}
        self.make()

    def make(self, text=None, nested=False):
        text = self.data.decode('utf8') if text is None else text
        content = json.dumps({'units':[{'text':text}]}, ensure_ascii=False) if nested else text
        self.body = json.dumps({'messages':[{'role':'tool','tool_call_id':'call-a','content':content}]}, ensure_ascii=False).encode()
        self.receipt = {'schema':'post-ilv2/evidence-receipt/v1', **self.view,
          'requestBodySha256':hashlib.sha256(self.body).hexdigest(),
          'units':[{'id':'unit-a','toolCallId':'call-a','messageIndex':0,
           'textPointer':'/units/0/text' if nested else '', 'relativePath':'A.java',
           'contentHash':hashlib.sha256(self.data).hexdigest(), 'startLine':1,'endLine':3,'previewKind':'source'}]}

    def call(self): return check_receipt(self.body,self.receipt,self.root,self.view)
    def bad(self):
        with self.assertRaises(ReceiptError): self.call()
    def rewrite(self, modify):
        b=json.loads(self.body); modify(b); self.body=json.dumps(b,ensure_ascii=False).encode()
        self.receipt['requestBodySha256']=hashlib.sha256(self.body).hexdigest()

    def test_plain_source(self): self.assertEqual(self.call()['status'],'REQUEST_BODY_VERIFIED')
    def test_nested_source(self): self.make(nested=True); self.assertEqual(self.call()['verifiedUnits'],1)
    def test_crlf_preserved(self):
        self.data=self.data.replace(b'\n',b'\r\n');(self.root/'A.java').write_bytes(self.data);self.make();self.call()
    def test_unicode_bytes(self):
        self.data='class A {\n String x="😀订单";\n}\n'.encode();(self.root/'A.java').write_bytes(self.data);self.make();self.call()
    def test_wrong_request_hash(self): self.receipt['requestBodySha256']='0'*64;self.bad()
    def test_wrong_source_hash(self): self.receipt['units'][0]['contentHash']='0'*64;self.bad()
    def test_wrong_workspace(self): self.receipt['workspaceId']='work-b';self.bad()
    def test_wrong_manifest(self): self.receipt['contentManifestId']='manifest-b';self.bad()
    def test_wrong_call_id(self): self.receipt['units'][0]['toolCallId']='other';self.bad()
    def test_non_tool_message(self): self.rewrite(lambda x:x['messages'][0].update(role='assistant'));self.bad()
    def test_message_index_bool(self): self.receipt['units'][0]['messageIndex']=True;self.bad()
    def test_absolute_path(self): self.receipt['units'][0]['relativePath']=str(self.root/'A.java');self.bad()
    def test_parent_escape(self): self.receipt['units'][0]['relativePath']='../A.java';self.bad()
    def test_windows_separator(self): self.receipt['units'][0]['relativePath']='src\\A.java';self.bad()
    def test_symlink_rejected(self):
        (self.root/'Link.java').symlink_to(self.root/'A.java');self.receipt['units'][0]['relativePath']='Link.java';self.bad()
    def test_zero_line(self): self.receipt['units'][0]['startLine']=0;self.bad()
    def test_float_line(self): self.receipt['units'][0]['endLine']=3.0;self.bad()
    def test_out_of_bounds(self): self.receipt['units'][0]['endLine']=4;self.bad()
    def test_redacted_not_source(self): self.receipt['units'][0]['previewKind']='redacted-preview';self.bad()
    def test_duplicate_unit(self): self.receipt['units'].append(copy.deepcopy(self.receipt['units'][0]));self.bad()
    def test_no_units(self): self.receipt['units']=[];self.bad()
    def test_lost_final_source(self):
        self.rewrite(lambda x:x['messages'][0].update(content='{"files":[],"readPlan":[]}'));self.bad()
    def test_wrong_pointer(self): self.make(nested=True);self.receipt['units'][0]['textPointer']='/units/1/text';self.bad()
    def test_changed_file(self): (self.root/'A.java').write_bytes(self.data.replace(b'7',b'9'));self.bad()
    def test_newline_normalization_fails(self):
        self.data=self.data.replace(b'\n',b'\r\n');(self.root/'A.java').write_bytes(self.data);self.make(text=self.data.decode().replace('\r\n','\n'));self.bad()
    def test_line_budget(self):
        self.data=('x\n'*81).encode();(self.root/'A.java').write_bytes(self.data);self.make();self.receipt['units'][0]['endLine']=81;self.bad()
    def test_byte_budget(self):
        self.data=('x'*16001+'\n'+'y\n'+'z\n').encode();(self.root/'A.java').write_bytes(self.data);self.make();self.bad()
    def test_duplicate_json_keys(self):
        self.body=b'{"messages":[],"messages":[{"role":"tool","tool_call_id":"call-a","content":"x"}]}'
        self.receipt['requestBodySha256']=hashlib.sha256(self.body).hexdigest();self.bad()

if __name__=='__main__': unittest.main()
