#!/usr/bin/env python3
"""Verify every tracked package file and the nested original frozen kit. No mutation."""
import hashlib,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    manifest=json.loads((ROOT/'MANIFEST.json').read_text());errors=[]
    for f in manifest['files']:
        rel=Path(f['path']);p=ROOT/rel
        if rel.is_absolute() or '..' in rel.parts or p.is_symlink() or not p.is_file(): errors.append(f['path']+': unsafe/missing');continue
        if hashlib.sha256(p.read_bytes()).hexdigest()!=f['sha256']:errors.append(f['path']+': hash mismatch')
    print(json.dumps({'status':'PASS' if not errors else 'FAIL','checked':len(manifest['files']),'errors':errors},ensure_ascii=False))
    return int(bool(errors))
if __name__=='__main__':sys.exit(main())
