#!/usr/bin/env python3
"""Target-M1 static-discovery adapter; no product score is inferred if the schema is absent.
Run against an explicitly isolated loopback MCP port, never the documented production port.
Tested with a local fake HTTP MCP server; real product integration is a T06 gate.
"""
import argparse,hashlib,json,sys,urllib.request,urllib.parse
from pathlib import Path

def normalize(payload,task):
    if not isinstance(payload,dict) or payload.get('schemaVersion')!='java-discovery/v1' or payload.get('scopeState') not in ('READY','PARTIAL') or not isinstance(payload.get('candidates'),list):
        return {'task_id':task['id'],'status':'UNSUPPORTED','diagnostics':{'reason':'M1 discovery contract absent'}}
    candidates=[];regions=[];events=[]
    for hit in payload['candidates']:
        d=hit.get('declaration',{});selection=d.get('selection',{})
        if not all(k in d for k in ('relativePath','contentHash','signature','fqn')):continue
        # Name must be exposed explicitly by target M1, not guessed from a display label.
        name=d.get('name')
        if not isinstance(name,str) or not name:raise ValueError('declaration.name required; cannot guess from display label')
        candidates.append({'path':d['relativePath'],'line':selection['line'],'name':name,'content_hash':d['contentHash']})
        ev=hit.get('evidenceRange')
        if ev:
            rg={'path':d['relativePath'],'start_line':ev['startLine'],'end_line':ev['endLine'],'content_hash':d['contentHash']}
            regions.append(rg)
            # A preview only counts if it is the exact returned source, not summary prose.
            if hit.get('previewKind')=='source' and isinstance(hit.get('preview'),str):
                events.append({**rg,'text':hit['preview'],'origin':'tool_response'})
    return {'task_id':task['id'],'status':'PARTIAL' if payload.get('scopeState')=='PARTIAL' else 'OK',
            'candidates':candidates,'regions':regions,'read_events':events,'answer':None,'usage':None,
            'diagnostics':{'qa_not_attempted':True,'mcp_returned':True}}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--url',required=True);args=ap.parse_args();url=urllib.parse.urlparse(args.url)
    if url.scheme!='http' or url.hostname not in ('127.0.0.1','localhost') or not url.port or url.port==38456 or url.path!='/mcp':
        raise ValueError('use an isolated explicit loopback HTTP /mcp port, not production 38456')
    req=json.load(sys.stdin);task=req['task'];session=None
    def rpc(method,params,ident):
        nonlocal session
        obj={'jsonrpc':'2.0','method':method,'params':params}
        if ident is not None:obj['id']=ident
        headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
        if session:headers['Mcp-Session-Id']=session
        r=urllib.request.urlopen(urllib.request.Request(args.url,data=json.dumps(obj).encode(),headers=headers),timeout=15)
        session=r.headers.get('Mcp-Session-Id',session);body=r.read(1048577)
        if len(body)>1048576:raise ValueError('MCP output cap')
        if not body:return {}
        if r.headers.get('Content-Type','').startswith('text/event-stream'):
            messages=[json.loads(line[5:].strip()) for line in body.decode().splitlines() if line.startswith('data:')]
            return next(x for x in reversed(messages) if x.get('id')==ident)
        return json.loads(body)
    rpc('initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'java-independent-bench','version':'1'}},1)
    rpc('notifications/initialized',{},None)
    result=rpc('tools/call',{'name':'java_symbol','arguments':{'repoRoot':req['repo_root'],'operation':'query','backend':'static','searchMode':'auto','query':task['query'],'limit':8}},2)
    if 'error' in result or result.get('result',{}).get('isError'):
        print(json.dumps({'task_id':task['id'],'status':'UNSUPPORTED','diagnostics':{'mcp_error':result}}));return
    data=result['result'];payload=data.get('structuredContent')
    if payload is None:
        text=''.join(c['text'] for c in data.get('content',[]) if c.get('type')=='text')
        try:payload=json.loads(text)
        except ValueError:payload={}
    print(json.dumps(normalize(payload,task),ensure_ascii=False))
if __name__=='__main__':
    try:main()
    except Exception as e:print(json.dumps({'error':str(e)}),file=sys.stderr);sys.exit(2)
