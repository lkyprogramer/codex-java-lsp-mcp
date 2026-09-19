"""Read-only product provenance capture. Never runs npm install or touches a runtime."""
import argparse,hashlib,json,subprocess,shutil,sys
from pathlib import Path
from .dataset import write_json

def cmd(argv,cwd):
 try:r=subprocess.run(argv,cwd=cwd,capture_output=True,text=True,timeout=15);return r.stdout.strip() if r.returncode==0 else None
 except (OSError,subprocess.TimeoutExpired):return None

def main():
 p=argparse.ArgumentParser();p.add_argument('--project',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();root=a.project.resolve()
 files=['src/java-index/stable-id.ts','src/java-index/sql/entity-search.ts','src/java-index/sql/sql-read-ranges.ts','src/mcp-server-factory.ts','src/tools/symbol.ts','package.json','package-lock.json']
 hashes={f:hashlib.sha256((root/f).read_bytes()).hexdigest() if (root/f).is_file() else None for f in files}
 sha=cmd(['git','rev-parse','HEAD'],root);dirty=cmd(['git','diff','--binary','HEAD'],root)
 report={'schema':'source-preflight/v1','source_sha':sha,'git_metadata_status':'MEASURED' if sha else 'UNAVAILABLE',
 'git_status':cmd(['git','status','--short'],root),'tracked_diff_sha256':hashlib.sha256(dirty.encode()).hexdigest() if dirty is not None else None,
 'node':cmd(['node','--version'],root),'javac':cmd(['javac','--version'],root),'python':sys.version.split()[0],
 'files':hashes,'installed_runtime_sha':None,'sut_tests':'NOT_RUN','note':'Untracked files are listed by git status but not in tracked diff hash; snapshot them before formal runs.'}
 write_json(a.output,report);print(json.dumps(report))
if __name__=='__main__':main()
