"""Finite process runner; no shell. It is not an operating-system sandbox."""
import os,signal,subprocess,tempfile,time
from pathlib import Path

def execute(argv,cwd,timeout=20,env=None,input_text=None,max_bytes=1048576):
    start=time.monotonic()
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        p=subprocess.Popen(argv,cwd=cwd,env=env,stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
                           stdout=out,stderr=err,start_new_session=(os.name=='posix'))
        timed_out=False; truncated=False; first=True
        while True:
            try:
                p.communicate(input_text.encode() if first and input_text is not None else None,timeout=.05)
                break
            except subprocess.TimeoutExpired:
                first=False
                timed_out=time.monotonic()-start>=timeout
                truncated=os.fstat(out.fileno()).st_size>max_bytes or os.fstat(err.fileno()).st_size>max_bytes
                if not timed_out and not truncated:continue
                try:
                    if os.name=='posix':os.killpg(p.pid,signal.SIGKILL)
                    else:p.kill()
                except ProcessLookupError:pass
                p.communicate();break
        out.seek(0);err.seek(0);stdout=out.read(max_bytes+1);stderr=err.read(max_bytes+1)
        truncated=truncated or len(stdout)>max_bytes or len(stderr)>max_bytes
    return {'argv':argv,'exit_code':p.returncode,'timeout':timed_out,'output_limit':truncated,
            'elapsed_ms':round((time.monotonic()-start)*1000,3),
            'stdout':stdout[:max_bytes].decode('utf-8',errors='replace'),'stderr':stderr[:max_bytes].decode('utf-8',errors='replace')}
