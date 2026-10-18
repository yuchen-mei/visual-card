"use strict";

// The actual connected-tool adapter. Load reviewed source into functions.exec,
// create the runtime, and retain raw results only in that runtime's memory.
// This adapter NEVER text()/notify()/console.log()s tool results, finance inputs,
// OAEP entropy, or credentials. Only the caller's final sanitized status is public.
(function install(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.VisualCardToolRuntime=api;})(globalThis,function factory(){
 function fail(code){const e=Error(code);e.code=code;throw e;}
 const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
 function createRuntime({tools,config,source,transport,publisher,orchestrator}){
  config=JSON.parse(JSON.stringify(config));
  for(const key of ["repositoryDirectory","privateDirectory","journalDirectory","nativeHelper","nodeBinary"]){if(typeof config[key]!=="string"||!config[key].startsWith("/")||/[\r\n\0]/.test(config[key]))fail("E_RUNTIME_CONFIG");}
  const script=name=>config.repositoryDirectory+"/scripts/"+name;
  const github={fetch:args=>tools.mcp__codex_apps__github_fetch(args),createBlob:args=>tools.mcp__codex_apps__github_create_blob(args),createTree:args=>tools.mcp__codex_apps__github_create_tree(args),createCommit:args=>tools.mcp__codex_apps__github_create_commit(args),updateRef:args=>tools.mcp__codex_apps__github_update_ref(args)};
  async function exec(cmd,{tty=false,privileged=false,maxTokens=12000}={}){
   return tools.exec_command({cmd,workdir:config.repositoryDirectory,tty,yield_time_ms:1000,max_output_tokens:maxTokens,...(privileged?{sandbox_permissions:"require_escalated",justification:"运行已授权的 visual-card 专用钥匙串程序，仅验证和加密投资数据；不授予其他程序钥匙串权限。"}:{})});
  }
  async function response(initial){
   let r=initial,output="";
   for(let i=0;i<30;i++){
    output+=r.output||"";if(output.length>250000)fail("E_RUNTIME_OUTPUT");
    const lines=output.trim().split(/\r?\n/).filter(Boolean);
    if(lines.length===1){try{return {value:JSON.parse(lines[0]),sessionId:r.session_id||initial.session_id};}catch{}}
    if(r.exit_code!==undefined)fail("E_RUNTIME_PROCESS");
    if(!r.session_id&&!initial.session_id)fail("E_RUNTIME_PROCESS");
    r=await tools.write_stdin({session_id:r.session_id||initial.session_id,chars:"",yield_time_ms:1000,max_output_tokens:12000});
   }
   fail("E_RUNTIME_TIMEOUT");
  }
  let journalProcess=null,journalSequence=0;
  async function rpc(action,extra={}){
   if(!journalProcess)fail("E_JOURNAL_PROCESS");const id=++journalSequence;
   const r=await response(await tools.write_stdin({session_id:journalProcess,chars:JSON.stringify({id,action,...extra})+"\n",yield_time_ms:1000,max_output_tokens:12000}));
   if(r.value.id!==id||r.value.status==="error"||r.value.ok===false)fail(r.value.code||"E_JOURNAL_RPC");return r.value;
  }
  const journal={
   async withLock(key,fn){
    if(key!=="visual-card-github-main"||journalProcess!==null)fail("E_JOURNAL_LOCK");
    const started=await exec("stty -echo -icanon && "+quote(config.nodeBinary)+" "+quote(script("finances_journal.cjs"))+" --serve --directory "+quote(config.journalDirectory),{tty:true});
    const ready=await response(started);if(ready.value.status!=="ready"||!started.session_id)fail("E_JOURNAL_PROCESS");journalProcess=started.session_id;journalSequence=0;
    let locked=false;
    try{const result=await rpc("acquire");if(result.status==="locked")fail("E_JOURNAL_LOCK");locked=true;return await fn();}
    finally{if(locked)await rpc("release");if(journalProcess)await tools.write_stdin({session_id:journalProcess,chars:"\u0003",yield_time_ms:1000,max_output_tokens:100});journalProcess=null;}
   },
   async load(operationId){const r=await rpc("load",{operationId});return r.record===undefined?r.result:r.record;},
   async save(operationId,record){await rpc("save",{operationId,record});}
  };
  async function prepare({operationId,baseline,snapshot,policy}){
   const command=[quote(config.nodeBinary),quote(script("finances_local_io.cjs")),"--write-baseline","--directory",quote(config.privateDirectory),"--sha",quote(baseline.sha256),"--content",quote(baseline.content)].join(" ");
   const saved=(await response(await exec(command))).value;
   if(typeof saved.path!=="string"||!saved.path.startsWith(config.privateDirectory+"/baseline-"))fail("E_BASELINE_PATH");
   const launchConfig={expectedHead:baseline.head,baselinePath:saved.path,outputDirectory:config.privateDirectory};
   const started=await exec("stty -echo -icanon && "+quote(config.nativeHelper)+" --serve 4<<< "+quote(JSON.stringify(launchConfig)),{tty:true,privileged:true});
   const session=await response(started);if(!started.session_id)fail("E_NATIVE_PROCESS");
   const header=session.value;
   if(header.status==="failed")fail(typeof header.code==="string"&&/^[A-Z_0-9]{1,80}$/.test(header.code)?header.code:"E_NATIVE_VALIDATION");
   if(header.expectedHead!==baseline.head||header.baselineSha256!==baseline.sha256)fail("E_NATIVE_BASELINE");
   const sealed=transport.seal({version:1,operationId,sessionId:header.sessionId,expectedHead:baseline.head,baselineSha256:baseline.sha256,snapshot,policy},header);
   const result=(await response(await tools.write_stdin({session_id:started.session_id,chars:JSON.stringify(sealed)+"\n",yield_time_ms:1000,max_output_tokens:2000}))).value;
   if(result.status==="failed")fail(result.code||"E_NATIVE_VALIDATION");
   if(result.status==="unchanged")return result;
   if(result.status!=="validated"||typeof result.candidatePath!=="string"||!result.candidatePath.startsWith(config.privateDirectory+"/candidate-"))fail("E_NATIVE_RECEIPT");
   const encrypted=await exec([quote(config.nodeBinary),quote(script("finances_local_io.cjs")),"--read-encrypted","--directory",quote(config.privateDirectory),"--path",quote(result.candidatePath)].join(" "),{maxTokens:24000});
   if(encrypted.exit_code!==0||transport.hash(encrypted.output)!==result.validatedSha256)fail("E_CANDIDATE_RECEIPT");
   return {...result,content:encrypted.output};
  }
  const publication={github,hash:text=>transport.hash(text),journal};
  const deps={finances:{getLinkedAccounts:args=>tools.mcp__codex_apps__finances_get_linked_accounts(args),query:args=>tools.mcp__codex_apps__finances_query(args)},source,publisher,publication,hash:text=>transport.hash(text),now:()=>Date.now(),local:{prepare}};
  async function runScheduled(request){
   request=JSON.parse(JSON.stringify(request));
   if(Object.keys(request).sort().join(",")!=="accountHashes,publish"||request.publish!==true||!Array.isArray(request.accountHashes)||!request.accountHashes.length||request.accountHashes.some(h=>typeof h!=="string"||!/^[a-f0-9]{64}$/.test(h)))fail("E_SCHEDULE_REQUEST");
   if(typeof config.scheduleStatePath!=="string"||!config.scheduleStatePath.startsWith(config.privateDirectory+"/")||/[\r\n\0]/.test(config.scheduleStatePath)||typeof config.notBefore!=="string"||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(config.notBefore)||!Number.isFinite(Date.parse(config.notBefore)))fail("E_SCHEDULE_CONFIG");
   const started=await exec("stty -echo -icanon && "+quote(config.nodeBinary)+" "+quote(script("finances_schedule_bridge.cjs"))+" --state "+quote(config.scheduleStatePath)+" --not-before "+quote(config.notBefore),{tty:true});
   const first=await response(started);
   if(first.value.type==="final")return first.value;
   const job=first.value;
   if(job.status!=="run_requested"||!started.session_id||!/^\d{4}-\d{2}-\d{2}$/.test(job.day)||job.operationId!=="visual-card-daily-"+job.day||job.idempotencyKey!=="visual-card:America/Los_Angeles:"+job.day)fail("E_SCHEDULE_PROTOCOL");
   let result;
   try{result=await orchestrator.runIteration({operationId:job.operationId,accountHashes:request.accountHashes,publish:true},deps);}catch{result={status:"failed",phase:"unknown",code:"E_ORCHESTRATION"};}
   let outcome;
   if(["published","unchanged"].includes(result.status))outcome={status:"completed",idempotencyKey:job.idempotencyKey,outcome:result.status};
   else if(result.status==="failed"&&["preflight","github_read","finances_read"].includes(result.phase))outcome={status:"retryable",idempotencyKey:job.idempotencyKey,safeToRetry:true};
   else outcome={status:"recovery_required",idempotencyKey:job.idempotencyKey};
   if(outcome.status!=="completed"&&typeof result.code==="string"&&/^[A-Z][A-Z0-9_]{0,79}$/.test(result.code))outcome.code=result.code;
   const final=(await response(await tools.write_stdin({session_id:started.session_id,chars:JSON.stringify(outcome)+"\n",yield_time_ms:1000,max_output_tokens:2000}))).value;
   if(final.type!=="final")fail("E_SCHEDULE_PROTOCOL");
   return {...final,iteration:result};
  }
  return {run:request=>orchestrator.runIteration(request,deps),runScheduled,prepare,publication,journal,config};
 }
 return {createRuntime};
});
