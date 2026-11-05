#!/usr/bin/env python3
"""Verify package bytes, task DAG, local Markdown links and code-fence balance."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote

ROOT=Path(__file__).resolve().parents[1]

def main() -> int:
    errors=[]
    inventory=ROOT/'SHA256SUMS'
    if not inventory.exists():
        print(json.dumps({'status':'FAIL','errors':['SHA256SUMS_MISSING']}));return 1
    expected={}
    for row in inventory.read_text().splitlines():
        h,name=row.split('  ',1)
        p=ROOT/name
        if name in expected:errors.append('DUPLICATE_INVENTORY:'+name)
        expected[name]=h
        if not p.is_file():errors.append('MISSING:'+name)
        elif hashlib.sha256(p.read_bytes()).hexdigest()!=h:errors.append('HASH:'+name)
    actual={p.relative_to(ROOT).as_posix() for p in ROOT.rglob('*') if p.is_file()
            and '__pycache__' not in p.parts and p.suffix!='.pyc' and p.name!='SHA256SUMS'}
    for extra in sorted(actual-set(expected)):errors.append('UNMANIFESTED:'+extra)
    tasks=json.loads((ROOT/'contracts/tasks.json').read_text())['tasks']
    byid={t['id']:t for t in tasks}
    if len(byid)!=len(tasks):errors.append('DUPLICATE_TASK')
    done=set()
    for t in tasks:
        if not (ROOT/t['path']).is_file():errors.append('TASK_FILE:'+t['id'])
        for dependency in t['dependsOn']:
            if dependency not in done:errors.append('DAG_ORDER:'+t['id']+'->'+dependency)
        done.add(t['id'])
    for f in ROOT.rglob('*.md'):
        text=f.read_text(encoding='utf8')
        fences=sum(1 for line in text.splitlines() if line.lstrip().startswith('```'))
        if fences%2:errors.append('FENCE:'+str(f.relative_to(ROOT)))
        for link in re.findall(r'\]\(([^)]+)\)',text):
            if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:',link) or link.startswith('#'):continue
            target=unquote(link.split('#',1)[0])
            if target and not (f.parent/target).resolve().exists():
                errors.append('LINK:'+str(f.relative_to(ROOT))+'->'+target)
    print(json.dumps({'status':'PASS' if not errors else 'FAIL','files':len(expected),
                      'tasks':len(tasks),'errors':errors},ensure_ascii=False,indent=2))
    return 1 if errors else 0

if __name__=='__main__':raise SystemExit(main())
