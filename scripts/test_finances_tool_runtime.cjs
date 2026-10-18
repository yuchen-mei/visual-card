"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const R=require("./finances_tool_runtime.cjs"),T=require("./finances_transport.cjs"),D=require("./finances_daily.cjs"),U=require("./update_finances.cjs"),IO=require("./finances_local_io.cjs");
const head="a".repeat(40),content=JSON.stringify(U.encrypt({synthetic:true},"synthetic-password"),null,2)+"\n",hash=T.hash(content);
const config={repositoryDirectory:"/private/repo",privateDirectory:"/private/state",journalDirectory:"/private/journal",nativeHelper:"/private/helper",nodeBinary:"/node"};
test("ciphertext IO permits only envelope data and private owned locations",()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vc-io-"));try{const p=IO.writeBaseline(dir,hash,content);assert.equal(IO.readEncrypted(dir,p),content);assert.equal(IO.writeBaseline(dir,hash,content),p);assert.throws(()=>IO.writeBaseline(dir,T.hash('{"secret":"synthetic"}'),'{"secret":"synthetic"}'));fs.chmodSync(p,0o644);assert.throws(()=>IO.readEncrypted(dir,p));}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test("real tool adapter sends only sealed data and preserves private header in memory",async()=>{
 const bridge=D.createSession({expectedHead:head,baselineSha256:hash}),calls=[];let received;
 const tools={exec_command:async args=>{calls.push(args);if(args.cmd.includes("--write-baseline"))return {exit_code:0,output:JSON.stringify({path:config.privateDirectory+"/baseline-"+hash+".enc.json"})};if(args.cmd.includes("--serve 4<<<"))return {session_id:10,output:JSON.stringify(bridge.header)+"\n"};if(args.cmd.includes("--read-encrypted"))return {exit_code:0,output:content};throw Error("unexpected");},write_stdin:async args=>{calls.push(args);received=bridge.open(JSON.parse(args.chars));return {exit_code:0,output:JSON.stringify({status:"validated",operationId:received.operationId,expectedHead:head,baselineSha256:hash,publication:"disabled",candidatePath:config.privateDirectory+"/candidate-"+"a".repeat(24)+".enc.json",validatedSha256:hash})};}};
 const runtime=R.createRuntime({tools,config,transport:T,source:{},publisher:{},orchestrator:{}});
 const result=await runtime.prepare({operationId:"synthetic:daily",baseline:{head,sha256:hash,content},snapshot:{privateField:"SYNTHETIC-PRIVATE-NEVER-IN-COMMAND"},policy:{accountIds:["SYNTHETIC-ACCOUNT-SECRET"]}});
 assert.equal(result.content,content);assert.equal(received.snapshot.privateField,"SYNTHETIC-PRIVATE-NEVER-IN-COMMAND");
 const observable=JSON.stringify(calls);assert(!observable.includes("SYNTHETIC-PRIVATE-NEVER-IN-COMMAND"));assert(!observable.includes("SYNTHETIC-ACCOUNT-SECRET"));assert(!observable.includes(bridge.header.seeds[0]));
 assert.equal(calls.find(c=>c.cmd?.includes("--serve 4<<<")).sandbox_permissions,"require_escalated");
});
test("tool runtime rejects returned encrypted candidate hash mismatch",async()=>{
 const bridge=D.createSession({expectedHead:head,baselineSha256:hash});
 const tools={exec_command:async a=>a.cmd.includes("--write-baseline")?{exit_code:0,output:JSON.stringify({path:config.privateDirectory+"/baseline-"+hash+".enc.json"})}:a.cmd.includes("--serve 4<<<")?{session_id:10,output:JSON.stringify(bridge.header)}:{exit_code:0,output:content},write_stdin:async a=>{const packet=bridge.open(JSON.parse(a.chars));return {exit_code:0,output:JSON.stringify({status:"validated",operationId:packet.operationId,expectedHead:head,baselineSha256:hash,candidatePath:config.privateDirectory+"/candidate-"+"a".repeat(24)+".enc.json",validatedSha256:"c".repeat(64)})};}};
 const runtime=R.createRuntime({tools,config,transport:T,source:{},publisher:{},orchestrator:{}});
 await assert.rejects(()=>runtime.prepare({operationId:"synthetic:day",baseline:{head,sha256:hash,content},snapshot:{},policy:{}}),{code:"E_CANDIDATE_RECEIPT"});
});
test("tool journal adapter holds global lock across callback and releases",async()=>{
 const actions=[];let record=null;
 const tools={exec_command:async()=>({session_id:12,output:'{"status":"ready","protocol":1,"pid":100}'}),write_stdin:async a=>{if(a.chars==="\u0003")return {exit_code:0,output:""};const q=JSON.parse(a.chars);actions.push(q.action);if(q.action==="save")record=q.record;return {session_id:12,output:JSON.stringify({id:q.id,status:({acquire:"acquired",save:"saved",load:"loaded",release:"released"})[q.action],...(q.action==="load"?{record}:{})})};}};
 const runtime=R.createRuntime({tools,config,transport:T,source:{},publisher:{},orchestrator:{}});
 await runtime.journal.withLock("visual-card-github-main",async()=>{assert.equal(await runtime.journal.load("synthetic"),null);await runtime.journal.save("synthetic",{phase:"synthetic"});assert.deepEqual(await runtime.journal.load("synthetic"),{phase:"synthetic"});});
 assert.deepEqual(actions,["acquire","load","save","load","release"]);
});
test("scheduled runtime skips completed state before any connector or credential use",async()=>{
 const runtime=R.createRuntime({tools:{exec_command:async()=>({exit_code:0,output:JSON.stringify({type:"final",status:"already_completed",notify:false})})},config:{...config,scheduleStatePath:"/private/state/schedule.json",notBefore:"2026-01-01T00:00:00Z"},transport:T,source:{},publisher:{},orchestrator:{runIteration:()=>{throw Error("must not run");}}});
 assert.equal((await runtime.runScheduled({accountHashes:["a".repeat(64)],publish:true})).status,"already_completed");
});
for(const [status,phase,expected]of [["unchanged",null,"completed"],["published",null,"completed"],["failed","finances_read","retryable"],["failed","local_validation","recovery_required"],["recovery_required","publication","recovery_required"]])test(`scheduled runtime records ${status}/${phase} safely`,async()=>{
 const key="visual-card:America/Los_Angeles:2026-10-18";let sent,run;
 const tools={exec_command:async()=>({session_id:21,output:JSON.stringify({status:"run_requested",idempotencyKey:key,operationId:"visual-card-daily-2026-10-18",day:"2026-10-18",dueAt:"2026-10-19T03:00:00Z"})}),write_stdin:async a=>{sent=JSON.parse(a.chars);return{exit_code:0,output:JSON.stringify({type:"final",status:sent.status==="completed"?"completed":sent.status==="retryable"?"retry_scheduled":"recovery_required",notify:sent.status!=="completed"})};}};
 const runtime=R.createRuntime({tools,config:{...config,scheduleStatePath:"/private/state/schedule.json",notBefore:"2026-01-01T00:00:00Z"},transport:T,source:{},publisher:{},orchestrator:{runIteration:async q=>{run=q;return {status,phase,code:"E_SYNTHETIC"};}}});
 const result=await runtime.runScheduled({accountHashes:["a".repeat(64)],publish:true});
 assert.equal(sent.status,expected);assert.equal(sent.idempotencyKey,key);assert.equal(run.publish,true);assert.equal(run.operationId,"visual-card-daily-2026-10-18");assert.equal(result.notify,expected!=="completed");
});
test("scheduled success forwards confirmed position events to the notification caller",async()=>{
 const key="visual-card:America/Los_Angeles:2026-10-18",event={id:"d".repeat(64),kind:"closed",ticker:"DEMO",date:"2026-10-16",firstKnownBuyDate:"2025-01-02"};
 const tools={exec_command:async()=>({session_id:21,output:JSON.stringify({status:"run_requested",idempotencyKey:key,operationId:"visual-card-daily-2026-10-18",day:"2026-10-18",dueAt:"2026-10-19T03:00:00Z"})}),write_stdin:async()=>({exit_code:0,output:JSON.stringify({type:"final",status:"completed",notify:false})})};
 const runtime=R.createRuntime({tools,config:{...config,scheduleStatePath:"/private/state/schedule.json",notBefore:"2026-01-01T00:00:00Z"},transport:T,source:{},publisher:{},orchestrator:{runIteration:async()=>({status:"published",notify:true,eventsReady:true,positionEvents:[event]})}});
 const result=await runtime.runScheduled({accountHashes:["a".repeat(64)],publish:true});
 assert.equal(result.notify,true);assert.equal(result.eventsReady,true);assert.deepEqual(result.positionEvents,[event]);
});
test("position feature requires one approved brokerage hash and both strict adapters",()=>{
 for(const overrides of [{positionEventsEnabled:"true"},{positionEventsEnabled:true},{positionEventsEnabled:true,positionAccountHashes:["a".repeat(64),"b".repeat(64)]}])assert.throws(()=>R.createRuntime({tools:{},config:{...config,...overrides},transport:T,source:{},publisher:{},orchestrator:{}}),{code:"E_POSITION_CONFIG"});
});
test("public market adapter sends small ranges/date input bound to the local public baseline hash",async()=>{
 const M=require('./finances_market.cjs'),market={asOf:'2026-10-16',source:'yahoo-chart',generatedAt:'2026-10-17T00:00:00Z',prices:{AAA:[{date:'2026-10-16',close:10}]}},existingContent=JSON.stringify(market),calls=[];
 const request={ranges:{AAA:'2026-10-16'},existingContent,end:'2026-10-18'};
 const tools={exec_command:async args=>{calls.push(args);return{session_id:22,output:JSON.stringify({status:'ready',protocol:1})};},write_stdin:async args=>{calls.push(args);return{exit_code:0,output:JSON.stringify({status:'validated',rangesContent:JSON.stringify(request.ranges),marketContent:existingContent})};}};
 const runtime=R.createRuntime({tools,config,transport:T,source:{},publisher:{},orchestrator:{},market:M});
 assert.equal((await runtime.prepareMarket(request)).status,'validated');
 assert(calls[0].cmd.includes('--baseline-sha'));assert(calls[0].cmd.includes(T.hash(existingContent)));
 assert.equal(calls[0].sandbox_permissions,'require_escalated');assert.doesNotMatch(calls[0].justification,/钥匙串/);
 assert.deepEqual(JSON.parse(calls[1].chars),{ranges:request.ranges,end:request.end});assert.equal(calls.length,2);
});
