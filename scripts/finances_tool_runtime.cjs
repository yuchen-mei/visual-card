"use strict";

// The actual connected-tool adapter. Load reviewed source into functions.exec,
// create the runtime, and retain raw results only in that runtime's memory.
// This adapter NEVER text()/notify()/console.log()s tool results, finance inputs,
// OAEP entropy, or credentials. Only the caller's final sanitized status is public.
(function install(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.VisualCardToolRuntime=api;})(globalThis,function factory(){
 class RuntimeError extends Error{constructor(code){super(code);this.code=code;}}
 function fail(code){throw new RuntimeError(code);}
 const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
 const sessionId=value=>Number.isSafeInteger(value)&&value>0;
 // Only codes emitted by the reviewed native helper/preflight are public.
 // Unknown native output and arbitrary tool exceptions are never forwarded.
 const nativeCodes=new Set("E_ACCESS_OBJECT E_ACL_SCOPE E_BASELINE E_CHILD_IDENTITY E_CHILD_PROTOCOL E_CHILD_START E_CLOSED_VERB_REQUIRED E_CONFIG E_CORE_DUMP_POLICY E_ENROLLMENT_ACCESS E_ENROLLMENT_FAILED E_ENROLLMENT_RECOVERY_REQUIRED E_ENROLLMENT_ROLLED_BACK E_ENTITLEMENTS_REJECTED E_EXACT_IDENTITY_REQUIRED E_HARDENED_ADHOC_REQUIRED E_INTERACTION_POLICY E_ITEM_ALREADY_EXISTS E_KEYCHAIN_UNAVAILABLE E_NATIVE_PREFLIGHT E_PASSWORD_INPUT E_PREFLIGHT_ONLY E_PRIVATE_OUTPUT E_PRIVATE_PIPE E_RUNTIME_IDENTITY E_STATUS_OUTPUT E_TEST_ENROLLMENT_DISABLED E_TRUSTED_APPLICATION".split(" "));
 const prepareCodes={baseline_write:"E_PREPARE_BASELINE_WRITE",native_start:"E_PREPARE_NATIVE_START",native_header:"E_PREPARE_NATIVE_HEADER",seal:"E_PREPARE_SEAL",native_submit:"E_PREPARE_NATIVE_SUBMIT",native_result:"E_PREPARE_NATIVE_RESULT",candidate_read:"E_PREPARE_CANDIDATE_READ"};
 const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
 function createRuntime({tools,config,source,transport,publisher,orchestrator,release,market}){
  config=JSON.parse(JSON.stringify(config));
  for(const key of ["repositoryDirectory","privateDirectory","journalDirectory","nodeBinary",config.passwordFile?"passwordFile":"nativeHelper"]){if(typeof config[key]!=="string"||!config[key].startsWith("/")||/[\r\n\0]/.test(config[key]))fail("E_RUNTIME_CONFIG");}
  const script=name=>config.repositoryDirectory+"/scripts/"+name;
  const github={fetch:args=>tools.mcp__codex_apps__github_fetch(args),createBlob:args=>tools.mcp__codex_apps__github_create_blob(args),createTree:args=>tools.mcp__codex_apps__github_create_tree(args),createCommit:args=>tools.mcp__codex_apps__github_create_commit(args),updateRef:args=>tools.mcp__codex_apps__github_update_ref(args)};
  async function exec(cmd,{tty=false,privileged=false,maxTokens=12000,justification}={}){
   return tools.exec_command({cmd,workdir:config.repositoryDirectory,tty,yield_time_ms:1000,max_output_tokens:maxTokens,...(privileged?{sandbox_permissions:"require_escalated",justification:justification||"运行已授权的 visual-card 专用钥匙串程序，仅验证和加密投资数据；不授予其他程序钥匙串权限。"}:{})});
  }
  async function response(initial,{expectedSessionId,onExit,maxTokens=12000,attempts=30,maxChars=250000}={}){
   if(!object(initial))fail("E_RUNTIME_RESPONSE");
   const pinned=expectedSessionId===undefined?initial.session_id:expectedSessionId;
   if(pinned!==undefined&&!sessionId(pinned))fail("E_RUNTIME_SESSION");
   let r=initial,output="";
   for(let i=0;i<attempts;i++){
    if(!object(r)||(r.output!==undefined&&typeof r.output!=="string")||(r.exit_code!==undefined&&!Number.isInteger(r.exit_code)))fail("E_RUNTIME_RESPONSE");
    if(r.session_id!==undefined&&r.session_id!==pinned)fail("E_RUNTIME_SESSION");
    if(r.exit_code!==undefined&&onExit)onExit();
    output+=r.output||"";if(output.length>maxChars)fail("E_RUNTIME_OUTPUT");
    const lines=output.trim().split(/\r?\n/).filter(Boolean);
    if(lines.length===1){
     let value,parsed=false;try{value=JSON.parse(lines[0]);parsed=true;}catch{}
     if(parsed){if(!object(value))fail("E_RUNTIME_JSON_OBJECT");return {value,sessionId:pinned};}
    }
    if(r.exit_code!==undefined)fail("E_RUNTIME_PROCESS");
    if(pinned===undefined)fail("E_RUNTIME_PROCESS");
    r=await tools.write_stdin({session_id:pinned,chars:"",yield_time_ms:1000,max_output_tokens:maxTokens});
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
   let stage="baseline_write",nativeSession,exited=false,nativeAttempted=false;
   const noteExit=()=>{exited=true;};
   async function stopOwnSession(){
    if(exited)return "already_exited";
    if(nativeSession===undefined)return nativeAttempted?"unavailable":"not_started";
    try{
     // Terminate only this prepare call's PTY. Never adopt a returned session or
     // kill a PID/process name. Discard all cleanup output, which may be private.
     for(let i=0;i<3;i++){
      const result=await tools.write_stdin({session_id:nativeSession,chars:i===0?"\u0003":"",yield_time_ms:1000,max_output_tokens:100});
      if(!object(result)||(result.session_id!==undefined&&result.session_id!==nativeSession))return "uncertain";
      if(Number.isInteger(result.exit_code)){exited=true;return "terminated";}
     }
    }catch{}
    return "uncertain";
   }
   try{
    const command=[quote(config.nodeBinary),quote(script("finances_local_io.cjs")),"--write-baseline","--directory",quote(config.privateDirectory),"--sha",quote(baseline.sha256),"--content",quote(baseline.content)].join(" ");
    const saved=(await response(await exec(command))).value;
    if(typeof saved.path!=="string"||!saved.path.startsWith(config.privateDirectory+"/baseline-"))fail("E_BASELINE_PATH");
    const launchConfig={expectedHead:baseline.head,baselinePath:saved.path,outputDirectory:config.privateDirectory};
    stage="native_start";
    nativeAttempted=true;
    const startCommand=config.passwordFile
     ? "stty -echo -icanon && "+[quote(config.nodeBinary),quote(script("finances_daily.cjs")),"--serve-file","--expected-head",quote(baseline.head),"--baseline",quote(saved.path),"--output-dir",quote(config.privateDirectory),"--password-file",quote(config.passwordFile)].join(" ")
     : "stty -echo -icanon && "+quote(config.nativeHelper)+" --serve 4<<< "+quote(JSON.stringify(launchConfig));
    const started=await exec(startCommand,{tty:true,privileged:!config.passwordFile,maxTokens:24000});
    if(object(started)&&sessionId(started.session_id))nativeSession=started.session_id;
    stage="native_header";
    const header=(await response(started,{expectedSessionId:nativeSession,onExit:noteExit})).value;
    if(header.status==="failed")fail((config.passwordFile&&/^[A-Z][A-Z_0-9]{0,79}$/.test(header.code))||nativeCodes.has(header.code)?header.code:"E_NATIVE_VALIDATION");
    if(nativeSession===undefined||exited)fail("E_NATIVE_PROCESS");
    if(header.expectedHead!==baseline.head||header.baselineSha256!==baseline.sha256)fail("E_NATIVE_BASELINE");
    stage="seal";
    const sealed=transport.seal({version:1,operationId,sessionId:header.sessionId,expectedHead:baseline.head,baselineSha256:baseline.sha256,snapshot,policy},header);
    stage="native_submit";
    const submitted=await tools.write_stdin({session_id:nativeSession,chars:JSON.stringify(sealed)+"\n",yield_time_ms:1000,max_output_tokens:2000});
    stage="native_result";
    const result=(await response(submitted,{expectedSessionId:nativeSession,onExit:noteExit})).value;
    if(result.status==="failed")fail((config.passwordFile&&/^[A-Z][A-Z_0-9]{0,79}$/.test(result.code))||nativeCodes.has(result.code)?result.code:"E_NATIVE_VALIDATION");
    if(result.operationId!==operationId||result.expectedHead!==baseline.head||result.baselineSha256!==baseline.sha256)fail("E_NATIVE_RECEIPT");
    if(result.status==="unchanged")return result;
    if(result.status!=="validated"||typeof result.candidatePath!=="string"||!result.candidatePath.startsWith(config.privateDirectory+"/candidate-"))fail("E_NATIVE_RECEIPT");
    stage="candidate_read";
    const encrypted=await exec([quote(config.nodeBinary),quote(script("finances_local_io.cjs")),"--read-encrypted","--directory",quote(config.privateDirectory),"--path",quote(result.candidatePath)].join(" "),{maxTokens:24000});
    if(!object(encrypted)||encrypted.exit_code!==0||typeof encrypted.output!=="string"||transport.hash(encrypted.output)!==result.validatedSha256)fail("E_CANDIDATE_RECEIPT");
    return {...result,content:encrypted.output};
   }catch(error){
    const code=error instanceof RuntimeError
     ? (error.code.startsWith("E_RUNTIME_")?prepareCodes[stage]+error.code.slice("E_RUNTIME".length):error.code)
     : stage==="seal"&&error?.code==="E_TRANSPORT"?"E_TRANSPORT":prepareCodes[stage];
    const safe=new RuntimeError(code);safe.stage=stage;safe.cleanup=await stopOwnSession();
    // A stopped local process does not prove whether it wrote a candidate. No
    // safeToRetry/production/publication assertion is inferred from cleanup.
    throw safe;
   }
  }
  async function prepareMarket(request){
   let processId,done=false;
   try{
    market.validateRanges(request.ranges);market.validateMarketData(JSON.parse(request.existingContent));
    const started=await exec("stty -echo -icanon && "+[quote(config.nodeBinary),quote(script("finances_market_io.cjs")),"--serve","--directory",quote(config.privateDirectory),"--baseline-sha",quote(transport.hash(request.existingContent))].join(" "),{tty:true,privileged:true,justification:"按已授权的持仓配置更新请求，仅获取公开股票行情并在仓库外临时目录校验；不读取凭据、不直接发布。"});
    processId=started.session_id;
    const ready=(await response(started,{expectedSessionId:processId})).value;
    if(ready.status!=="ready"||!sessionId(processId))fail("E_MARKET_PREPARATION");
    const submitted=await tools.write_stdin({session_id:processId,chars:JSON.stringify({ranges:request.ranges,end:request.end})+"\n",yield_time_ms:1000,max_output_tokens:100000});
    const result=(await response(submitted,{expectedSessionId:processId,onExit:()=>{done=true;},maxTokens:100000,attempts:180,maxChars:2200000})).value;
    if(result.status!=="validated")fail("E_MARKET_PREPARATION");
    return result;
   }catch{throw new RuntimeError("E_MARKET_PREPARATION");}
   finally{if(processId&&!done)try{await tools.write_stdin({session_id:processId,chars:"\u0003",yield_time_ms:1000,max_output_tokens:100});}catch{}}
  }
  const publication={github,hash:text=>transport.hash(text),journal};
  if(config.positionEventsEnabled!==undefined&&typeof config.positionEventsEnabled!=="boolean")fail("E_POSITION_CONFIG");
  if(config.positionEventsEnabled===true&&(!Array.isArray(config.positionAccountHashes)||config.positionAccountHashes.length!==1||!config.positionAccountHashes.every(h=>/^[a-f0-9]{64}$/.test(h))||typeof release?.publishRelease!=="function"||typeof market?.readMarketBaseline!=="function"))fail("E_POSITION_CONFIG");
  const deps={finances:{getLinkedAccounts:args=>tools.mcp__codex_apps__finances_get_linked_accounts(args),query:args=>tools.mcp__codex_apps__finances_query(args)},source,publisher,publication,hash:text=>transport.hash(text),now:()=>Date.now(),local:{prepare,prepareMarket},...(config.positionEventsEnabled===true?{positionAccountHashes:config.positionAccountHashes,release,market}:{})};
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
   return {...final,notify:final.notify||result.notify===true,...(result.eventsReady?{positionEvents:result.positionEvents,eventsReady:true}:{}),iteration:result};
  }
  return {run:request=>orchestrator.runIteration(request,deps),runScheduled,prepare,prepareMarket,publication,journal,config};
 }
 return {createRuntime};
});
