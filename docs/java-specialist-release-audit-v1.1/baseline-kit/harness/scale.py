"""Deterministic load-only corpus, not additional quality tasks."""
import argparse,hashlib,json
from pathlib import Path

def main():
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--files',type=int,default=1000);a=p.parse_args()
 if a.output.exists():raise ValueError('output must not exist')
 if not 1<=a.files<=100000:raise ValueError('files must be in 1..100000')
 a.output.mkdir(parents=True)
 (a.output/'pom.xml').write_text('<project><modelVersion>4.0.0</modelVersion><groupId>load</groupId><artifactId>java-load</artifactId><version>1</version><properties><maven.compiler.release>8</maven.compiler.release></properties></project>\n')
 for i in range(a.files):
  folder=a.output/f'src/main/java/load/p{i//100:04d}';folder.mkdir(parents=True,exist_ok=True)
  text=f'package load.p{i//100:04d};\npublic class Entry{i:06d} {{\n'
  for j in range(12):text+=f'  public long process{j}(long value) {{ return value + {i+j}; }}\n'
  text+='}\n';(folder/f'Entry{i:06d}.java').write_text(text)
 meta={'kind':'synthetic-load-not-quality','files':a.files,'methods':12*a.files,'generator_version':1,'seed':'arithmetic-v1','query_set':['process','value',f'Entry{a.files-1:06d}','doesNotExistAnywhere']}
 (a.output.parent/f'{a.output.name}-manifest.json').write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps(meta))
if __name__=='__main__':main()
