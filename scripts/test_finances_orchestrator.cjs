"use strict";
const assert=require("node:assert/strict"),crypto=require("node:crypto");
const {test}=require("node:test");
const O=require("./finances_orchestrator.cjs");
const copy=x=>JSON.parse(JSON.stringify(x));
const hash=x=>crypto.createHash("sha256").update(x).digest("hex");
function fixture(){
 const head="a".repeat(40),content="synthetic-ciphertext",baseline={head,content:"synthetic-baseline",sha256:hash("synthetic-baseline")};
 const linked={institutions:[{accounts:[{account_id:"synthetic-a",type:"investment"},{account_id:"synthetic-b",type:"investment"}]}]};
 const responses=[0,1].map(i=>({results:[{index:0,is_error:false,result:{has_more:false,next_cursor:null,items:[{id:`synthetic-item-${i}`,value:i+1}]}}]}));
 const request={operationId:"synthetic:daily",accountHashes:linked.institutions[0].accounts.map(a=>hash(a.account_id))};
 const prepared={operationId:request.operationId,expectedHead:head,baselineSha256:baseline.sha256,status:"validated",content,validatedSha256:hash(content)};
 const calls={queries:[],published:[],prepared:[],normalized:[]};let index=0;
 const deps={now:()=>Date.parse("2026-10-18T04:00:00Z"),hash:async value=>hash(value),publication:{},
  publisher:{readBaseline:async()=>baseline,publishData:async r=>{calls.published.push(copy(r));return {status:r.publish?"published":"dry_run"};}},
  finances:{getLinkedAccounts:async()=>linked,query:async args=>{calls.queries.push(copy(args));return responses[index++];}},
  source:{unwrapFinancesResponse:x=>x,normalizeAssetSnapshot:args=>{calls.normalized.push(copy(args));return {schemaVersion:2,mode:"assets",source:"Finances",policy:args.policy};}},
  local:{prepare:async args=>{calls.prepared.push(copy(args));return prepared;}}
 };
 return {request,deps,linked,responses,baseline,prepared,calls,run:()=>O.runIteration(request,deps)};
}
test("default dry-run has no publish authorization and needs no failure notice",async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.status,"dry_run");assert.equal(r.notify,false);assert.equal(f.calls.published.length,1);assert.equal(f.calls.published[0].publish,false);
 assert.equal(f.calls.prepared[0].snapshot.mode,"assets");assert.deepEqual(f.calls.prepared[0].policy,{accountIds:["synthetic-a","synthetic-b"]});
});
test("explicit publish reaches only the injected publisher with validated hash",async()=>{
 const f=fixture();f.request.publish=true;const r=await f.run();assert.equal(r.status,"published");assert.equal(r.notify,false);assert.equal(f.calls.published[0].publish,true);assert.equal(f.calls.published[0].validatedSha256,hash(f.calls.published[0].content));
});
test("no-op returns silently and never calls publication",async()=>{
 const f=fixture();f.prepared.status="unchanged";const r=await f.run();assert.equal(r.status,"unchanged");assert.equal(r.notify,false);assert.equal(f.calls.published.length,0);
});
test("request and approved hashes are captured before the first await",async()=>{
 const f=fixture();f.request.publish=false;f.deps.publisher.readBaseline=async()=>{f.request.publish=true;f.request.operationId="synthetic:changed";f.request.accountHashes.fill("c".repeat(64));return f.baseline;};
 const r=await f.run();assert.equal(r.status,"dry_run");assert.equal(r.operationId,"synthetic:daily");assert.equal(f.calls.published[0].publish,false);
});
test("approvedScope hashes and returns one immutable account snapshot",async()=>{
 const linked={institutions:[{accounts:[{account_id:"synthetic-approved",type:"depository"}]}]},approved=[hash("synthetic-approved")];
 const accounts=await O.approvedScope(linked,approved,{unwrapFinancesResponse:x=>x},async value=>{linked.institutions[0].accounts[0].account_id="synthetic-unapproved";approved[0]=hash("synthetic-unapproved");return hash(value);});
 assert.equal(accounts[0].account_id,"synthetic-approved");
});
test("linked response mutation during scope hashing cannot change the policy",async()=>{
 const f=fixture();f.deps.hash=async value=>{if(value==="synthetic-a")f.linked.institutions[0].accounts[0].account_id="synthetic-unapproved";return hash(value);};
 const r=await f.run();assert.equal(r.status,"dry_run");assert.equal(f.calls.normalized[0].linkedAccounts.institutions[0].accounts[0].account_id,"synthetic-a");assert.equal(f.calls.prepared[0].policy.accountIds[0],"synthetic-a");
});
test("holdings results and exact submitted queries are copied immediately",async()=>{
 const f=fixture();let call=0;f.deps.finances.query=async args=>{const i=call++;if(i===1)f.responses[0].results[0].result.items[0].value=999;args.queries[0].account_id="mutated-query";return f.responses[i];};
 const r=await f.run();assert.equal(r.status,"dry_run");const responses=f.calls.normalized[0].holdingsResponses;assert.equal(responses[0].response.results[0].result.items[0].value,1);assert.equal(responses[0].queries[0].account_id,"synthetic-a");
});
test("baseline and local receipt references cannot change across later awaits",async()=>{
 const f=fixture(),originalHead=f.baseline.head;f.deps.finances.getLinkedAccounts=async()=>{f.baseline.head="c".repeat(40);return f.linked;};
 f.deps.hash=async value=>{if(value===f.prepared.content){f.prepared.content="mutated-ciphertext";f.prepared.validatedSha256=hash(f.prepared.content);}return hash(value);};
 const r=await f.run();assert.equal(r.status,"dry_run");assert.equal(f.calls.published[0].expectedHead,originalHead);assert.equal(f.calls.published[0].content,"synthetic-ciphertext");
});
test("local adapter cannot mutate the baseline used to authorize publication",async()=>{
 const f=fixture();f.deps.local.prepare=async args=>{args.baseline.head="c".repeat(40);return f.prepared;};const r=await f.run();assert.equal(r.status,"dry_run");assert.equal(f.calls.published[0].expectedHead,"a".repeat(40));
});
test("unapproved new or missing accounts fail before local work",async()=>{
 for(const mutate of [f=>f.linked.institutions[0].accounts.pop(),f=>f.linked.institutions[0].accounts.push({account_id:"synthetic-new",type:"depository"})]){
  const f=fixture();mutate(f);const r=await f.run();assert.equal(r.status,"failed");assert.equal(r.code,"E_ACCOUNT_SCOPE_CHANGED");assert.equal(r.notify,true);assert.equal(r.productionPreserved,true);assert.equal(f.calls.prepared.length,0);assert.equal(f.calls.published.length,0);
 }
});
test("malformed pagination and repeated cursor fail closed",async()=>{
 const f=fixture();f.deps.finances.query=async()=>({results:[{index:0,is_error:false,result:{has_more:true,next_cursor:"repeated",items:[]}}]});const r=await f.run();assert.equal(r.status,"failed");assert.equal(r.code,"E_PAGINATION");assert.equal(f.calls.prepared.length,0);
});
test("changed local receipt hash fails before any publisher invocation",async()=>{
 const f=fixture();f.prepared.validatedSha256="c".repeat(64);const r=await f.run();assert.equal(r.status,"failed");assert.equal(r.code,"E_LOCAL_RECEIPT");assert.equal(f.calls.published.length,0);
});
test("source failure reports a fixed code without private native error text",async()=>{
 const f=fixture();f.deps.finances.getLinkedAccounts=async()=>{throw Error("synthetic-private-detail");};const r=await f.run();assert.equal(r.status,"failed");assert.equal(r.code,"E_ORCHESTRATION");assert.equal(r.notify,true);assert.equal(r.productionPreserved,true);assert.doesNotMatch(JSON.stringify(r),/synthetic-private-detail/);
});
test("publisher uncertainty notifies and is not misreported as success",async()=>{
 const f=fixture();f.request.publish=true;f.deps.publisher.publishData=async()=>({status:"recovery_required",code:"E_REF_NOT_CONFIRMED"});const r=await f.run();assert.equal(r.status,"recovery_required");assert.equal(r.notify,true);assert.equal(r.phase,"publication");
});
test("unexpected request keys fail before reading any external data",async()=>{
 const f=fixture();f.request.mode="basis-revision";f.deps.publisher.readBaseline=async()=>{throw Error("must not read");};const r=await f.run();assert.equal(r.status,"failed");assert.equal(r.code,"E_REQUEST");assert.equal(r.phase,"preflight");
});
