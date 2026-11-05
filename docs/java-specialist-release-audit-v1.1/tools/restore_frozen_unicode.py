#!/usr/bin/env python3
"""Restore only the known CRLF corruption. Dry-run by default. Does not rewrite any manifests."""
import argparse,hashlib,os,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
REL='dataset/contracts/fixtures/unicode/src/main/java/demo/Unicode.java'
BAD='42f1c89bcc4ced94b42e738de6f536104b13be8a809645ccbd6611cdc5aa681b'
GOOD='294cd139daf877efe01a66a81da59ca3ec652806837da749eb60486eb0dd43b3'
def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--project',required=True,type=Path);ap.add_argument('--apply',action='store_true');a=ap.parse_args()
    original=(ROOT/'baseline-kit'/REL).read_bytes()
    if hashlib.sha256(original).hexdigest()!=GOOD:raise ValueError('frozen recovery source corrupt')
    dest=a.project.resolve(strict=True)/'docs/java-specialist-devkit-v1'/REL
    if dest.is_symlink():raise ValueError('refuse symlink destination')
    current=hashlib.sha256(dest.read_bytes()).hexdigest()
    if current==GOOD:print('UNCHANGED: exact frozen bytes already restored');return 0
    if current!=BAD:raise ValueError('unexpected source bytes; do not overwrite a new change')
    if not a.apply:print('DRY_RUN: known LF-normalization drift; --apply restores original CRLF bytes only');return 0
    temporary=dest.with_name(dest.name+'.audit-restore-tmp')
    with temporary.open('xb') as f:f.write(original)
    os.replace(temporary,dest)
    print('RESTORED: add the explicit .gitattributes rule and verify a fresh clone before committing');return 0
if __name__=='__main__':
    try:sys.exit(main())
    except (ValueError,OSError) as e:print(str(e),file=sys.stderr);sys.exit(2)
