"""Verify copied upstream bytes against Git blob identities and local SHA-256."""
import hashlib,json
from pathlib import Path
B=Path(__file__).resolve().parents[1]
def verify():
 rows=[]
 for item in json.loads((B/'provenance/upstream.json').read_text()):
  raw=(B/'dataset/corpora'/item['corpus']/item['path']).read_bytes()
  blob=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
  ok=blob==item['git_blob_sha1'] and hashlib.sha256(raw).hexdigest()==item['sha256']
  rows.append({'corpus':item['corpus'],'path':item['path'],'pass':ok,'git_blob_sha1':blob,'commit':item['commit']})
 return {'schema':'upstream-byte-verification/v1','passed':all(r['pass'] for r in rows),'files':rows}
if __name__=='__main__':
 r=verify();print(json.dumps(r,indent=2));raise SystemExit(0 if r['passed'] else 1)
