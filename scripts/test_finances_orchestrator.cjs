"use strict";
const assert=require("node:assert/strict"),crypto=require("node:crypto");
const {test}=require("node:test");
const O=require("./finances_orchestrator.cjs");
const S=require("./finances_source.cjs");
const copy=x=>JSON.parse(JSON.stringify(x));
const hash=x=>crypto.createHash("sha256").update(x).digest("hex");
function fixture(){
 const head="a".repeat(40),content="synthetic-ciphertext",baseline={head,content:"synthetic-baseline",sha256:hash("synthetic-baseline")};
 const linked={institutions:[{accounts:[{account_id:"synthetic-a",type:"investment"},{account_id:"synthetic-b",type:"investment"},{account_id:"synthetic-bank",type:"depository"}]}]};
 const responses=[0,1].map(i=>({results:[{index:0,is_error:false,result:{has_more:false,next_cursor:null,items:[{id:`synthetic-item-${i}`,value:i+1}]}}]}));
 for(const account of ["synthetic-a","synthetic-b"])for(const page of [0,1])responses.push({results:[{index:0,query_type:"investment_transactions",is_error:false,result:{has_more:page===0,next_cursor:page===0?`${account}-next`:null,items:[{
  account_id:account,investment_transaction_id:`${account}-trade-${page}`,security_id:"synthetic-security",date:page===0?"2025-01-02":"2025-02-03",
  ticker_symbol:"DEMO",is_cash_equivalent:false,quantity:page===0?1:-1,price:10,amount:page===0?10:-10,fees:0,type:page===0?"buy":"sell",subtype:page===0?"buy":"sell",iso_currency_code:"USD"
 }]}}]});
 const request={operationId:"synthetic:daily",accountHashes:linked.institutions[0].accounts.map(a=>hash(a.account_id))};
 const prepared={operationId:request.operationId,expectedHead:head,baselineSha256:baseline.sha256,status:"validated",content,validatedSha256:hash(content)};
 const calls={queries:[],published:[],prepared:[],normalized:[],tradeNormalized:[]};let index=0;
 const deps={now:()=>Date.parse("2026-10-18T04:00:00Z"),hash:async value=>hash(value),publication:{},
  publisher:{readBaseline:async()=>baseline,publishData:async r=>{calls.published.push(copy(r));return {status:r.publish?"published":"dry_run"};}},
  finances:{getLinkedAccounts:async()=>linked,query:async args=>{calls.queries.push(copy(args));return responses[index++];}},
  source:{unwrapFinancesResponse:x=>x,normalizeAssetSnapshot:args=>{calls.normalized.push(copy(args));return {schemaVersion:2,mode:"assets",source:"Finances",fetchedAt:args.fetchedAt,policy:args.policy};},normalizeTradeUpdates:args=>{calls.tradeNormalized.push(copy(args));return S.normalizeTradeUpdates(args);}},
  local:{prepare:async args=>{calls.prepared.push(copy(args));return prepared;}}
 };
 return {request,deps,linked,responses,baseline,prepared,calls,run:()=>O.runIteration(request,deps)};
}
test("default dry-run has no publish authorization and needs no failure notice",async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.status,"dry_run");assert.equal(r.notify,false);assert.equal(f.calls.published.length,1);assert.equal(f.calls.published[0].publish,false);
 assert.equal(f.calls.prepared[0].snapshot.mode,"assets");assert.deepEqual(f.calls.prepared[0].policy,{accountIds:["synthetic-a","synthetic-b","synthetic-bank"]});
});
test("two investment accounts pass every transaction page to the real normalizer and exclude banks",async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.status,"dry_run");
 const queries=f.calls.queries.map(batch=>batch.queries[0]);
 assert.deepEqual(queries.map(q=>[q.query_type,q.account_id,q.cursor||null]),[
  ["investment_holdings","synthetic-a",null],["investment_holdings","synthetic-b",null],
  ["investment_transactions","synthetic-a",null],["investment_transactions","synthetic-a","synthetic-a-next"],
  ["investment_transactions","synthetic-b",null],["investment_transactions","synthetic-b","synthetic-b-next"]
 ]);
 assert.ok(queries.every(q=>q.account_id!=="synthetic-bank"));
 assert.ok(queries.slice(2).every(q=>q.limit===20&&q.order_by_field==="date"&&q.order_by_direction==="asc"));
 assert.equal(f.calls.tradeNormalized.length,1);const input=f.calls.tradeNormalized[0];
 assert.deepEqual(input.policy,{accountIds:["synthetic-a","synthetic-b"]});
 assert.equal(input.fetchedAt,"2026-10-18T04:00:00.000Z");
 assert.deepEqual(input.transactionResponses,f.responses.slice(2).map((response,i)=>({queries:[queries[i+2]],response})));
 const updates=f.calls.prepared[0].snapshot.tradeUpdates;
 assert.deepEqual(updates,S.normalizeTradeUpdates(input));assert.deepEqual(updates.accountIds,["synthetic-a","synthetic-b"]);
 assert.equal(updates.rows.length,4);assert.equal(updates.allPagesFetched,true);assert.equal(updates.historyFromInception,false);
 assert.equal(updates.sourceAsOf,null);assert.equal(updates.dateBasis,"provider-settlement-date");
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
test("transaction pages and query cursors remain stable across later connector mutations",async()=>{
 const f=fixture(),original=copy(f.responses[2]);let call=0;
 f.deps.finances.query=async args=>{
  const index=call++;
  if(index===3)f.responses[2].results[0].result.items[0].price=999;
  args.queries[0].account_id="mutated-query";args.queries[0].cursor="mutated-cursor";
  return f.responses[index];
 };
 const r=await f.run();assert.equal(r.status,"dry_run");
 const pages=f.calls.tradeNormalized[0].transactionResponses;
 assert.deepEqual(pages[0].response,original);assert.equal(pages[0].queries[0].account_id,"synthetic-a");
 assert.equal(Object.hasOwn(pages[0].queries[0],"cursor"),false);assert.equal(pages[1].queries[0].cursor,"synthetic-a-next");
 assert.equal(f.calls.prepared[0].snapshot.tradeUpdates.rows[0].price,10);
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
test("missing, failed or repeated transaction pages never reach local preparation",async()=>{
 for(const [mutate,code] of [
  [f=>{f.responses[3]={results:[]};},"E_TRANSACTIONS_QUERY"],
  [f=>{f.responses[3].results[0].is_error=true;},"E_TRANSACTIONS_QUERY"],
  [f=>{f.responses[3].results[0].result.has_more=true;f.responses[3].results[0].result.next_cursor="synthetic-a-next";},"E_PAGINATION"],
  [f=>{delete f.responses[3].results[0].result.has_more;},"E_PAGINATION"],
  [f=>{f.responses[5].results[0].result.items[0].account_id="synthetic-bank";},"SOURCE_TRANSACTION_ACCOUNT_MISMATCH"]
 ]){
  const f=fixture();mutate(f);const r=await f.run();
  assert.equal(r.status,"failed");assert.equal(r.code,code);assert.equal(r.phase,"finances_read");assert.equal(r.notify,true);assert.equal(r.productionPreserved,true);
  assert.equal(f.calls.prepared.length,0);assert.equal(f.calls.published.length,0);
 }
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
function positionFixture(){
 const f=fixture(),M=require("./finances_market.cjs");
 f.linked.institutions[0].accounts.splice(1,1);
 f.request.accountHashes=f.linked.institutions[0].accounts.map(a=>hash(a.account_id));
 f.responses.splice(4,2);f.responses.splice(1,1);
 f.request.publish=true;f.deps.positionAccountHashes=[hash("synthetic-a")];
 const ranges={DEMO:"2025-01-02",QQQ:"2025-01-02",SPY:"2025-01-02"};
 const market={asOf:"2026-10-16",source:"yahoo-chart",generatedAt:"2026-10-17T00:00:00Z",prices:Object.fromEntries(Object.keys(ranges).map(t=>[t,[{date:"2025-01-02",close:10},{date:"2026-10-16",close:11}]]))};
 const files=[["scripts/market_price_ranges.json",ranges],["market.prices.json",market]].map(([path,value])=>{const content=JSON.stringify(value,null,2)+"\n";return{path,content,sha256:hash(content)};});
 f.prepared.positionEvents=[{id:"d".repeat(64),kind:"opened",ticker:"NEW",date:"2026-10-16",firstKnownBuyDate:"2026-10-16"}];
 f.calls.releases=[];f.calls.market=[];
 f.deps.market={...M,readMarketBaseline:async head=>{assert.equal(head,f.baseline.head);return{head,ranges,market,files};}};
 f.deps.local.prepareMarket=async input=>{f.calls.market.push(copy(input));return{status:"validated",rangesContent:JSON.stringify(input.ranges,null,2)+"\n",marketContent:JSON.stringify({...market,prices:{...market.prices,NEW:[{date:"2026-10-16",close:12}]}},null,2)+"\n"};};
 f.deps.release={publishRelease:async request=>{f.calls.releases.push(copy(request));return{status:request.publish?"published":"dry_run"};}};
 return f;
}
test("position open publishes data and only changed public files atomically then exposes one stable event",async()=>{
 const f=positionFixture(),r=await f.run();assert.equal(r.status,"published");assert.equal(r.notify,true);assert.equal(r.eventsReady,true);assert.deepEqual(r.positionEvents,f.prepared.positionEvents);
 assert.equal(f.calls.published.length,0);assert.equal(f.calls.releases.length,1);
 assert.deepEqual(f.calls.releases[0].files.map(x=>x.path),["data.enc.json","scripts/market_price_ranges.json","market.prices.json"]);
 assert.equal(f.calls.releases[0].expectedHead,f.baseline.head);assert.deepEqual(f.calls.prepared[0].policy.positionAccountIds,["synthetic-a"]);
 assert.doesNotMatch(JSON.stringify(r),/synthetic-a|shares|amountCents|accountId/);
});
test("silent lifecycle bootstrap and no-op do not prepare market or announce current holdings",async()=>{
 for(const status of ["validated","unchanged"]){const f=positionFixture();f.prepared.positionEvents=[];f.prepared.status=status;
 const r=await f.run();assert.equal(r.notify,false);assert.equal(r.positionEvents,undefined);assert.equal(f.calls.market.length,0);assert.equal(f.calls.releases.length,0);}
});
test("dry-run event is explicitly not ready for notification",async()=>{
 const f=positionFixture();f.request.publish=false;const r=await f.run();assert.equal(r.status,"dry_run");assert.equal(r.notify,false);assert.equal(r.eventsReady,false);assert.equal(f.calls.releases[0].publish,false);
});
test("market fetch failure and history loss preserve all remote files and send no position event",async()=>{
 for(const bad of [async()=>{throw Error("private-network-text");},async request=>({status:"validated",rangesContent:JSON.stringify(request.ranges),marketContent:JSON.stringify({asOf:"2026-10-16",source:"yahoo-chart",generatedAt:"2026-10-17T00:00:00Z",prices:{NEW:[{date:"2026-10-16",close:10}]}})})]){
 const f=positionFixture();f.deps.local.prepareMarket=bad;const r=await f.run();assert.equal(r.status,"failed");assert.equal(r.phase,"market_preparation");assert.equal(r.productionPreserved,true);assert.equal(r.positionEvents,undefined);assert.equal(f.calls.published.length+f.calls.releases.length,0);assert.doesNotMatch(JSON.stringify(r),/private-network-text/);
 }
});
test("concurrent atomic publication failure cannot announce a successful position change",async()=>{
 const f=positionFixture();f.deps.release.publishRelease=async()=>({status:"conflict",code:"E_HEAD_CHANGED"});const r=await f.run();assert.equal(r.status,"conflict");assert.equal(r.eventsReady,undefined);assert.equal(r.positionEvents,undefined);assert.equal(f.calls.published.length,0);
});
test("protected benchmark event updates encrypted ledger without changing its public configuration",async()=>{
 const f=positionFixture();f.prepared.positionEvents[0]={...f.prepared.positionEvents[0],ticker:"SPY",kind:"closed"};const r=await f.run();assert.equal(r.status,"published");assert.equal(r.eventsReady,true);assert.equal(f.calls.market.length,0);assert.equal(f.calls.releases.length,0);assert.equal(f.calls.published.length,1);
});
