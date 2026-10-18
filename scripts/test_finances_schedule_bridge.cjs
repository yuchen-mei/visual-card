"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {PassThrough,Writable}=require("node:stream"),{spawn}=require("node:child_process"),{test}=require("node:test");
const B=require("./finances_schedule_bridge.cjs"),S=require("./finances_schedule.cjs");
const script=path.join(__dirname,"finances_schedule_bridge.cjs"),FIRST=Date.parse("2026-10-18T03:00:00Z"),START="2026-01-01T00:00:00Z";
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vc-schedule-bridge-"));return {dir,statePath:path.join(dir,"state.json"),cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};}
async function scoped(run){const f=fixture();try{await run(f);}finally{f.cleanup();}}
function rpc(f,{now=FIRST,respond,timeoutMs=500}={}){
 const input=new PassThrough(),messages=[];
 const output=new Writable({write(chunk,encoding,done){const row=JSON.parse(chunk.toString());messages.push(row);if(row.status==="run_requested")respond?.(row,input);done();}});
 const pending=B.bridge({statePath:f.statePath,notBefore:START},{input,output,clock:()=>now,timeoutMs});
 return {pending,input,messages};
}
const completed=(job,outcome="published")=>({status:"completed",idempotencyKey:job.idempotencyKey,outcome});
function subprocess(f,{notBefore=START,onRequest,args,kill=false}={}){
 const child=spawn(process.execPath,[script,...(args||["--state",f.statePath,"--not-before",notBefore])],{stdio:["pipe","pipe","pipe"]});
 const messages=[];let buffer="",stderr="";
 child.stdout.on("data",chunk=>{buffer+=chunk;while(buffer.includes("\n")){const at=buffer.indexOf("\n"),line=buffer.slice(0,at);buffer=buffer.slice(at+1);const row=JSON.parse(line);messages.push(row);if(row.status==="run_requested"){if(kill)child.kill("SIGKILL");else onRequest?.(row,child);}}});
 child.stderr.on("data",chunk=>{stderr+=chunk;});
 const timer=setTimeout(()=>child.kill("SIGKILL"),5000);
 const done=new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>{clearTimeout(timer);resolve({messages,code,signal,stderr});});});
 return {child,done};
}
test("real CLI holds durable pending and lock until a confirmed publication response",()=>scoped(async f=>{
 const processRun=subprocess(f,{onRequest:(job,child)=>{
  assert.equal(job.operationId,`visual-card-daily-${job.day}`);assert.equal(job.idempotencyKey,S.keyForDay(job.day));assert.equal(job.dueAt,S.dueForDay(job.day));
  const state=JSON.parse(fs.readFileSync(f.statePath));assert.equal(state.pending.idempotencyKey,job.idempotencyKey);assert.ok(fs.existsSync(`${f.statePath}.lock`));
  child.stdin.write(JSON.stringify(completed(job))+"\n");
 }});
 const result=await processRun.done;assert.equal(result.code,0);assert.equal(result.stderr,"");assert.deepEqual(result.messages.map(m=>m.status),["run_requested","completed"]);assert.equal(result.messages[1].type,"final");assert.equal(result.messages[1].notify,false);
 const state=JSON.parse(fs.readFileSync(f.statePath));assert.equal(state.lastCompletedDay,result.messages[0].day);assert.equal(state.pending,null);assert.equal(fs.existsSync(`${f.statePath}.lock`),false);assert.equal(fs.statSync(f.statePath).mode&0o777,0o600);
 const again=await subprocess(f).done;assert.equal(again.code,0);assert.equal(again.messages.length,1);assert.equal(again.messages[0].status,"already_completed");assert.equal(again.messages[0].notify,false);
}));
test("real CLI accepts verified unchanged and silently skips before activation",()=>scoped(async f=>{
 const future=new Date(Date.now()+2*86400000).toISOString(),skip=await subprocess(f,{notBefore:future}).done;
 assert.equal(skip.code,0);assert.equal(skip.messages.length,1);assert.equal(skip.messages[0].status,"not_due");assert.equal(skip.messages[0].notify,false);
 fs.unlinkSync(f.statePath);
 const result=await subprocess(f,{onRequest:(job,child)=>child.stdin.write(JSON.stringify(completed(job,"unchanged"))+"\n")}).done;
 assert.equal(result.code,0);assert.equal(result.messages.at(-1).status,"completed");
}));
test("EOF preserves pending and later invocation requests recovery without replay",()=>scoped(async f=>{
 const first=await subprocess(f,{onRequest:(job,child)=>child.stdin.end()}).done;
 assert.equal(first.code,2);assert.equal(first.messages.at(-1).status,"recovery_required");assert.equal(first.messages.at(-1).code,"E_BRIDGE_EOF");
 assert.ok(JSON.parse(fs.readFileSync(f.statePath)).pending);assert.equal(fs.existsSync(`${f.statePath}.lock`),false);
 const next=await subprocess(f).done;assert.equal(next.code,2);assert.equal(next.messages.length,1);assert.equal(next.messages[0].status,"recovery_required");
}));
test("process crash keeps the original claim and lock and never replays it",()=>scoped(async f=>{
 const first=await subprocess(f,{kill:true}).done;assert.equal(first.signal,"SIGKILL");assert.ok(JSON.parse(fs.readFileSync(f.statePath)).pending);assert.ok(fs.existsSync(`${f.statePath}.lock`));
 const next=await subprocess(f).done;assert.equal(next.code,3);assert.equal(next.messages.length,1);assert.equal(next.messages[0].status,"locked");assert.ok(fs.existsSync(`${f.statePath}.lock`));
}));
test("safe retry waits five minutes and keeps the exact operation ID",()=>scoped(async f=>{
 const first=rpc(f,{respond:(job,input)=>input.write(JSON.stringify({status:"retryable",idempotencyKey:job.idempotencyKey,safeToRetry:true,code:"E_SOURCE_UNAVAILABLE"})+"\n")});
 const result=await first.pending;assert.equal(result.status,"retry_scheduled");assert.equal(result.nextAt,new Date(FIRST+S.RETRY_MS).toISOString());assert.equal(result.notify,true);
 const early=rpc(f,{now:FIRST+S.RETRY_MS-1}),skip=await early.pending;assert.equal(skip.status,"waiting");assert.equal(skip.notify,false);assert.equal(early.messages.length,1);
 const retry=rpc(f,{now:FIRST+S.RETRY_MS,respond:(job,input)=>input.write(JSON.stringify(completed(job))+"\n")});assert.equal((await retry.pending).status,"completed");
 assert.equal(retry.messages[0].operationId,first.messages[0].operationId);assert.equal(retry.messages[0].idempotencyKey,first.messages[0].idempotencyKey);
}));
test("bridge holds the shared schedule lock across an outstanding RPC",()=>scoped(async f=>{
 let job;const first=rpc(f,{respond:row=>{job=row;}});await new Promise(resolve=>setImmediate(resolve));assert.ok(job);
 const parallel=rpc(f);assert.equal((await parallel.pending).status,"locked");assert.equal(parallel.messages.length,1);
 first.input.write(JSON.stringify(completed(job))+"\n");assert.equal((await first.pending).status,"completed");
}));
test("unknown, invalid, dry-run, wrong-key and duplicate-key responses never complete",async()=>{
 const answers=[job=>({...completed(job),outcome:"dry_run"}),job=>({...completed(job),idempotencyKey:"wrong"}),job=>({status:"retryable",idempotencyKey:job.idempotencyKey,safeToRetry:false}),job=>({...completed(job),sourceData:"untrusted"}),job=>`{"status":"failure","status":"completed","idempotencyKey":${JSON.stringify(job.idempotencyKey)},"outcome":"published"}`];
 for(const answer of answers)await scoped(async f=>{const r=rpc(f,{respond:(job,input)=>{const value=answer(job);input.write((typeof value==="string"?value:JSON.stringify(value))+"\n");}});const result=await r.pending;assert.equal(result.status,"recovery_required");const state=JSON.parse(fs.readFileSync(f.statePath));assert.equal(state.lastCompletedDay,null);assert.ok(state.pending);});
});
test("failure and uncertain responses preserve pending with only sanitized code",async()=>{
 for(const status of ["failure","recovery_required"])await scoped(async f=>{
  const run=rpc(f,{respond:(job,input)=>input.write(JSON.stringify({status,idempotencyKey:job.idempotencyKey,code:"E_REMOTE_UNCERTAIN"})+"\n")});const result=await run.pending;assert.equal(result.status,"recovery_required");assert.equal(result.code,"E_REMOTE_UNCERTAIN");assert.equal(result.notify,true);assert.ok(JSON.parse(fs.readFileSync(f.statePath)).pending);
 });
});
test("timeout preserves pending and does not invent completion",()=>scoped(async f=>{const run=rpc(f,{timeoutMs:10});const result=await run.pending;assert.equal(result.status,"recovery_required");assert.equal(result.code,"E_BRIDGE_TIMEOUT");assert.ok(JSON.parse(fs.readFileSync(f.statePath)).pending);}));
test("multi-day startup coalesces to latest LA due day with no pre-enable backfill",()=>scoped(async f=>{
 const later=Date.parse("2026-11-02T04:00:00Z"),run=rpc(f,{now:later,respond:(job,input)=>input.write(JSON.stringify(completed(job))+"\n")});await run.pending;
 assert.equal(run.messages[0].day,"2026-11-01");assert.equal(run.messages[0].dueAt,"2026-11-02T04:00:00.000Z");assert.equal(run.messages.filter(m=>m.status==="run_requested").length,1);
}));
test("CLI rejects injected clock or publication arguments without creating state",()=>scoped(async f=>{
 const result=await subprocess(f,{args:["--state",f.statePath,"--not-before",START,"--now",new Date(FIRST).toISOString()]}).done;
 assert.equal(result.code,1);assert.equal(result.messages[0].code,"E_BRIDGE_ARGUMENTS");assert.equal(fs.existsSync(f.statePath),false);
}));
