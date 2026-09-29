"""Small source-only lexical control, not a Java compiler and not the production baseline.
Uniform 32-line windows, stride16; public task query only, never gold/expected targets.
"""
from pathlib import Path
from collections import Counter
import hashlib,math,re,unicodedata,time

def tokens(text):
    text=unicodedata.normalize('NFKC',text)
    parts=re.findall(r'[A-Za-z_$][A-Za-z0-9_$]*|[\u3400-\u9fff]+|[0-9]+',text)
    out=[]
    for p in parts:
        out.append(p.lower())
        if re.fullmatch(r'[\u3400-\u9fff]+',p):out += [p[i:i+2] for i in range(len(p)-1)]
        else:
            split=re.sub(r'([a-z0-9])([A-Z])',r'\1 \2',p)
            split=re.sub(r'([A-Z])([A-Z][a-z])',r'\1 \2',split).replace('_',' ')
            out += [x.lower() for x in split.split() if x.lower()!=p.lower()]
    return out

def retrieve(root,task,query,method='bm25'):
    start=time.monotonic();docs=[];texts={};q=tokens(query)
    for p in sorted(Path(root).rglob('*')):
        if not p.is_file() or p.suffix not in ('.java','.xml','.properties','.yml','.yaml'):continue
        raw=p.read_bytes()
        if len(raw)>2*1024*1024:continue
        lines=raw.decode('utf-8').splitlines(keepends=True);rel=p.relative_to(root).as_posix()
        texts[rel]=(lines,hashlib.sha256(raw).hexdigest())
        for i in range(0,len(lines),16):
            fragment=''.join(lines[i:i+32]);ts=tokens(fragment);docs.append((rel,i+1,min(i+32,len(lines)),Counter(ts),len(ts),fragment))
    avg=sum(d[4] for d in docs)/max(1,len(docs));df=Counter()
    for d in docs:df.update(d[3].keys())
    scored=[]
    for d in docs:
        score=0.0
        for term in set(q):
            tf=d[3][term]
            if not tf:continue
            if method=='grep':score+=1;continue
            idf=math.log(1+(len(docs)-df[term]+.5)/(df[term]+.5))
            score+=idf*tf*2.2/(tf+1.2*(.25+.75*d[4]/max(1,avg)))
        if score:scored.append((score,d))
    scored.sort(key=lambda x:(-x[0],x[1][0],x[1][1]))
    regions=[];events=[];candidates=[];seen=set();points=set();total_bytes=0;total_lines=0
    # Greedy novelty rejects overlapping windows; same behavior across control arms.
    for _,d in scored:
        rel,a,b,_,_,text=d;pts={(rel,n) for n in range(a,b+1)}
        if pts&points:continue
        size=len(text.encode());n=b-a+1
        if len(regions)>=task['budget']['max_regions'] or total_bytes+size>task['budget']['max_bytes'] or total_lines+n>task['budget']['max_lines']:continue
        rg={'path':rel,'start_line':a,'end_line':b,'content_hash':texts[rel][1]};regions.append(rg)
        events.append({**rg,'text':text,'origin':'tool_response'})
        points|=pts;total_bytes+=size;total_lines+=n
        # Approximate declarations inside selected windows. Control cannot claim binding accuracy.
        for ln,line in enumerate(texts[rel][0][a-1:b],a):
            found=re.search(r'\b(?:class|interface|enum|record)\s+(\w+)',line)
            if not found:found=re.search(r'^\s*(?:(?:public|protected|private|static|final|synchronized|abstract)\s+)*(?:[\w<>\[\],?]+\s+)?(\w+)\s*\([^;]*\)\s*(?:throws[^{}]+)?\{?',line)
            if not found or found.group(1) in ('if','for','while','switch','catch','return','throw','new'):continue
            name=found.group(1);key=(rel,ln,name)
            if key not in seen:
                candidates.append({'path':rel,'line':ln,'name':name});seen.add(key)
    return {'task_id':task['id'],'status':'OK' if regions else 'NOT_FOUND','candidates':candidates[:20],
            'regions':regions,'read_events':events,'answer':None,'usage':None,'elapsed_ms':round((time.monotonic()-start)*1000,3),
            'diagnostics':{'method':method,'windows':len(docs),'qa_not_attempted':True,'compiler_binding':False}}
