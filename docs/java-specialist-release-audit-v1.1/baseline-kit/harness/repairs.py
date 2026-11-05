"""Judge repairs using clean copies and evaluator-owned frozen tests, never an agent PASS flag."""
from pathlib import Path
import hashlib,shutil,tempfile,secrets
from .dataset import load_json
from .scoring import safe_file
from .process import execute

def tree_hash(root):
    return {p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}

def run_repair(dataset,task_id,mode='baseline',candidate=None):
    ds=Path(dataset);specs=load_json(ds/'repairs/manifest.json')
    spec=next((s for s in specs if s['task_id']==task_id),None)
    if spec is None:raise ValueError('not a repair task')
    if mode not in ('baseline','reference','candidate'):raise ValueError('unknown repair mode')
    original=ds/'corpora'/spec['corpus']
    with tempfile.TemporaryDirectory(prefix='java-bench-repair-') as tmp:
        tmp=Path(tmp);root=tmp/'repo';shutil.copytree(original,root)
        if mode=='reference':
            patch=load_json(ds/spec['reference_change']);p=safe_file(root,patch['path']);txt=p.read_text()
            if txt.count(patch['before'])!=1:raise ValueError('reference patch context mismatch')
            p.write_text(txt.replace(patch['before'],patch['after']))
        if mode=='candidate':
            if candidate is None:raise ValueError('candidate directory required')
            candidate=Path(candidate);old=tree_hash(original);new=tree_hash(candidate)
            changed={f for f in set(old)|set(new) if old.get(f)!=new.get(f)}
            if changed-set(spec['allowed_edits']):
                return {'task_id':task_id,'mode':mode,'status':'DISALLOWED_EDIT','validated_success':False,'changed':sorted(changed)}
            for f in spec['allowed_edits']:shutil.copyfile(safe_file(candidate,f),root/f)
        test_path=safe_file(ds,spec['test_file']);frozen_hash=hashlib.sha256(test_path.read_bytes()).hexdigest()
        judge=tmp/'judge';judge.mkdir();test=judge/test_path.name;shutil.copyfile(test_path,test)
        wrapper=judge/'FrozenJudgeRunner.java'
        wrapper.write_text("""import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.charset.StandardCharsets;
public final class FrozenJudgeRunner {
  public static void main(String[] args) throws Exception {
    Class.forName(args[0]).getMethod("main", String[].class)
        .invoke(null, (Object) new String[0]);
    Files.write(Paths.get(args[1]), args[2].getBytes(StandardCharsets.UTF_8));
  }
}
""",encoding='utf-8')
        completion=tmp/'judge-completed';nonce=secrets.token_hex(24)
        src=[]
        for rel in spec['source_roots']:src+=sorted(str(p) for p in (root/rel).rglob('*.java'))
        classes=tmp/'classes';classes.mkdir()
        compile_result=execute(['javac','-encoding','UTF-8','-proc:none','--release',str(spec['java_release']),'-d',str(classes),*src,str(test),str(wrapper)],tmp,spec['timeout_seconds'])
        result={'task_id':task_id,'mode':mode,'frozen_test_sha256':frozen_hash,'judge_wrapper_sha256':hashlib.sha256(wrapper.read_bytes()).hexdigest(),'candidate_tree':tree_hash(root),
                'compile':compile_result,'run':None,'status':'COMPILE_FAILED','validated_success':False}
        if compile_result['exit_code']==0 and not compile_result['timeout']:
            result['run']=execute(['java','-Xmx128m','-cp',str(classes),'FrozenJudgeRunner',spec['test_class'],str(completion),nonce],tmp,spec['timeout_seconds'])
            r=result['run'];completed=completion.is_file() and completion.read_text(encoding='utf-8')==nonce
            result['frozen_test_completed']=completed
            passed=r['exit_code']==0 and not r['timeout'] and not r['output_limit'] and completed
            result['validated_success']=passed;result['status']='PASS' if passed else 'TEST_FAILED'
        return result

def verify_all(dataset):
    rows=[]
    for s in load_json(Path(dataset)/'repairs/manifest.json'):
        a=run_repair(dataset,s['task_id'],'baseline');b=run_repair(dataset,s['task_id'],'reference')
        # A compile failure is NOT evidence that the intended defect was detected.
        ok=a['status']=='TEST_FAILED' and a['compile']['exit_code']==0 and not a['run']['timeout'] and 'AssertionError' in a['run']['stderr'] and b['validated_success']
        rows.append({'task_id':s['task_id'],'oracle_check_pass':ok,'baseline':a,'reference':b})
    return {'schema':'repair-oracle-validation/v1','not_sut_results':True,'passed':all(r['oracle_check_pass'] for r in rows),'rows':rows}
