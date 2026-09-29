// This adapter only transpiles; it does not typecheck, build native dependencies or start MCP.
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const [projectArg, outArg] = process.argv.slice(2);
if (!projectArg || !outArg) throw new Error('Usage: node transpile.cjs PROJECT OUTPUT');
const project=path.resolve(projectArg), out=path.resolve(outArg), src=path.join(project,'src');
if (out===project || out.startsWith(project+path.sep)) throw new Error('OUTPUT must be outside project');
let candidates=[process.env.TYPESCRIPT_JS,path.join(project,'node_modules/typescript/lib/typescript.js')].filter(Boolean);
try {candidates.push(path.join(execFileSync('npm',['root','-g'],{encoding:'utf8',timeout:10000}).trim(),'typescript/lib/typescript.js'));} catch {}
const found=candidates.find(p=>fs.existsSync(p));
if(!found) throw new Error('BLOCKED_ENV: set TYPESCRIPT_JS or install the project-pinned TypeScript in the development environment');
const ts=require(found);let count=0;
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'package.json'),' {"type":"module"}\n');
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
 const p=path.join(dir,e.name);
 if(e.isSymbolicLink())throw new Error('Source symlinks require explicit review: '+p);
 if(e.isDirectory())walk(p);
 else if(e.name.endsWith('.ts')&&!e.name.endsWith('.d.ts')){
  const dest=path.join(out,path.relative(src,p)).replace(/\.ts$/,'.js');fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.writeFileSync(dest,ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);count++;
 }
}}
walk(src);console.log(JSON.stringify({files:count,typescript:ts.version,mode:'TRANSPILE_ONLY_NOT_TYPECHECK'}));
