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
function openingFixture(withPositions=false){
 const f=withPositions?positionFixture():fixture(),M=require("./finances_market.cjs");
 f.request.publish=true;if(withPositions)f.prepared.positionEvents=[];
 const investmentCount=f.linked.institutions[0].accounts.filter(account=>account.type==="investment").length;
 f.responses.push(...copy(f.responses.slice(0,investmentCount)));
 f.calls.linkedReads=0;f.deps.finances.getLinkedAccounts=async()=>{f.calls.linkedReads++;return f.linked;};
 const normalize=f.deps.source.normalizeAssetSnapshot;
 f.deps.source.normalizeAssetSnapshot=input=>({...normalize(input),syntheticAssetState:{linkedAccounts:copy(input.linkedAccounts),holdingsResponses:copy(input.holdingsResponses)}});
 f.deps.openingPositionAuthorization={version:1,authorizationRef:"synthetic-user-opening",historySha256:"e".repeat(64)};
 f.deps.openingMarketRanges={DEMO:"2024-12-31"};
 const ranges={DEMO:"2025-01-02",OTHER:"2025-01-02",QQQ:"2025-01-02",SPY:"2025-01-02"};
 const market={asOf:"2026-10-16",source:"yahoo-chart",generatedAt:"2026-10-17T00:00:00Z",prices:Object.fromEntries(Object.keys(ranges).map(ticker=>[ticker,[{date:"2025-01-02",close:10},{date:"2026-10-16",close:11}]]))};
 f.marketBase={head:f.baseline.head,ranges,market,files:[]};
 f.repackMarket=()=>{f.marketBase.files=[["scripts/market_price_ranges.json",f.marketBase.ranges],["market.prices.json",f.marketBase.market]].map(([path,value])=>{const content=JSON.stringify(value,null,2)+"\n";return{path,content,sha256:hash(content)};});};
 f.repackMarket();f.calls.market=[];f.calls.marketReads=[];f.calls.releases=[];
 f.fetched=copy(market);f.fetched.generatedAt="2026-10-19T00:00:00Z";
 f.fetched.prices.DEMO=[{date:"2024-12-30",close:7},{date:"2024-12-31",close:8},{date:"2025-01-02",close:999},{date:"2026-05-01",close:25},{date:"2026-10-16",close:999}];
 f.deps.market={...M,readMarketBaseline:async head=>{f.calls.marketReads.push(head);return f.marketBase;}};
 f.deps.local.prepareMarket=async input=>{
  f.calls.market.push(copy(input));let market=f.fetched;
  if(input.end!==f.marketBase.market.asOf){
   market=JSON.parse(input.existingContent);market.asOf=input.end;market.generatedAt="2026-10-18T04:00:00Z";
   for(const [ticker,start]of Object.entries(input.ranges))market.prices[ticker]=[{date:start,close:12},{date:input.end,close:13}];
  }
  return{status:"validated",rangesContent:JSON.stringify(input.ranges),marketContent:JSON.stringify(market)};
 };
 const prepare=f.deps.local.prepare;
 f.deps.local.prepare=async input=>{
  const result={...await prepare(input),validatedMarketSha256:hash(input.marketContent)};
  if(input.planOnly){delete result.content;delete result.validatedSha256;return{...result,status:"planned",publishable:false,candidateCreated:false};}
  return result;
 };
 f.deps.release={publishRelease:async request=>{f.calls.releases.push(copy(request));return{status:request.publish?"published":"dry_run"};}};
 return f;
}
test("opening history is bound before encryption and atomically published with empty position events",async()=>{
 const f=openingFixture(true),baseBefore=copy(f.marketBase),r=await f.run();
 assert.equal(r.status,"published");assert.equal(r.notify,false);assert.equal(r.positionEvents,undefined);
 assert.deepEqual(f.calls.marketReads,[f.baseline.head]);assert.equal(f.calls.market.length,1);
 assert.equal(f.calls.linkedReads,2);assert.equal(f.calls.normalized.length,2);
 assert.equal(f.calls.normalized[1].fetchedAt,f.calls.normalized[0].fetchedAt);
 assert.equal(f.calls.normalized[1].baselineSha256,f.calls.normalized[0].baselineSha256);
 assert.deepEqual(f.calls.normalized[1].policy,f.calls.normalized[0].policy);
 assert.deepEqual(f.calls.market[0],{ranges:{DEMO:"2024-12-31"},existingContent:baseBefore.files.find(file=>file.path==="market.prices.json").content,end:baseBefore.market.asOf});
 const prepared=f.calls.prepared[0],candidate=JSON.parse(prepared.marketContent);
 assert.deepEqual(prepared.policy.openingPositionAuthorization,f.deps.openingPositionAuthorization);
 assert.deepEqual(prepared.marketBinding,{baselineSha256:baseBefore.files.find(file=>file.path==="market.prices.json").sha256,candidateSha256:hash(prepared.marketContent)});
 assert.deepEqual(candidate.prices.DEMO,[{date:"2024-12-31",close:8},...baseBefore.market.prices.DEMO]);
 for(const ticker of ["OTHER","SPY","QQQ"])assert.deepEqual(candidate.prices[ticker],baseBefore.market.prices[ticker]);
 assert.equal(candidate.asOf,baseBefore.market.asOf);assert.equal(candidate.generatedAt,baseBefore.market.generatedAt);
 assert.deepEqual(f.marketBase,baseBefore);assert.equal(f.calls.published.length,0);assert.equal(f.calls.releases.length,1);
 const release=f.calls.releases[0];assert.equal(release.expectedHead,f.baseline.head);
 assert.deepEqual(release.files.map(file=>file.path),["data.enc.json","scripts/market_price_ranges.json","market.prices.json"]);
 assert.equal(release.files.find(file=>file.path==="market.prices.json").content,prepared.marketContent);
 assert.deepEqual(JSON.parse(release.files.find(file=>file.path==="scripts/market_price_ranges.json").content),{...baseBefore.ranges,DEMO:"2024-12-31"});
 for(const file of release.files){assert.equal(file.sha256,hash(file.content));assert.equal(release.expectedSourceHashes[file.path],file.sha256);}
});
test("opening authorization alone always binds the exact pinned market bytes without fetching",async()=>{
 const f=openingFixture();delete f.deps.openingMarketRanges;
 const file=f.marketBase.files.find(file=>file.path==="market.prices.json");file.content=JSON.stringify(f.marketBase.market);file.sha256=hash(file.content);
 const r=await f.run();assert.equal(r.status,"published");assert.equal(f.calls.marketReads.length,1);assert.equal(f.calls.market.length,0);
 assert.equal(f.calls.prepared[0].marketContent,file.content);
 assert.deepEqual(f.calls.prepared[0].marketBinding,{baselineSha256:file.sha256,candidateSha256:file.sha256});
 assert.equal(f.calls.published.length,1);assert.equal(f.calls.releases.length,0);
});
test("already covered opening range is not fetched again and a no-op stays silent",async()=>{
 const f=openingFixture();f.marketBase.ranges.DEMO="2024-12-31";f.marketBase.market.prices.DEMO.unshift({date:"2024-12-31",close:8});f.repackMarket();f.prepared.status="unchanged";
 const r=await f.run();assert.equal(r.status,"unchanged");assert.equal(r.notify,false);assert.equal(f.calls.market.length,0);
 assert.equal(f.calls.prepared[0].marketContent,f.marketBase.files.find(file=>file.path==="market.prices.json").content);
 assert.equal(f.calls.published.length+f.calls.releases.length,0);
});
test("configured historical range cannot bypass core quote coverage validation or cause repeated fetch",async()=>{
 const f=openingFixture();f.marketBase.ranges.DEMO="2024-12-31";f.repackMarket();
 f.deps.local.prepare=async()=>{throw Object.assign(Error("synthetic-private-detail"),{code:"OPENING_PRICE_COVERAGE_REQUIRED"});};
 const r=await f.run();assert.equal(r.code,"OPENING_PRICE_COVERAGE_REQUIRED");assert.equal(r.phase,"local_validation");
 assert.equal(f.calls.market.length,0);assert.equal(f.calls.published.length+f.calls.releases.length,0);
});
test("opening inputs are captured before asynchronous baseline reads",async()=>{
 const f=openingFixture(),authorization=copy(f.deps.openingPositionAuthorization);
 f.deps.publisher.readBaseline=async()=>{f.deps.openingPositionAuthorization.authorizationRef="mutated-ref";f.deps.openingMarketRanges.DEMO="2020-01-02";return f.baseline;};
 const r=await f.run();assert.equal(r.status,"published");
 assert.deepEqual(f.calls.prepared[0].policy.openingPositionAuthorization,authorization);
 assert.deepEqual(f.calls.market[0].ranges,{DEMO:"2024-12-31"});
});
test("opening scope refuses missing authorization and malformed policy before reads",async()=>{
 for(const [change,code]of [
  [f=>{delete f.deps.openingPositionAuthorization;},"E_OPENING_AUTHORIZATION_REQUIRED"],
  [f=>{f.deps.openingPositionAuthorization.authorizationRef=" ";},"E_OPENING_AUTHORIZATION_INVALID"],
  [f=>{f.deps.openingPositionAuthorization.extra=true;},"E_OPENING_AUTHORIZATION_INVALID"]
 ]){
  const f=openingFixture();change(f);const r=await f.run();assert.equal(r.code,code);assert.equal(r.phase,"preflight");
  assert.equal(f.calls.queries.length+f.calls.marketReads.length+f.calls.prepared.length+f.calls.releases.length+f.calls.published.length,0);
 }
});
test("opening baseline head, file hashes and parsed objects must agree before any fetch or encryption",async()=>{
 for(const change of [
  f=>{f.marketBase.head="b".repeat(40);},
  f=>{f.marketBase.files[0].sha256="b".repeat(64);},
  f=>{f.marketBase.files[1].sha256="b".repeat(64);},
  f=>{f.marketBase.market.prices.DEMO[0].close+=1;},
  f=>{f.marketBase.ranges.DEMO="2020-01-02";},
  f=>{f.marketBase.files=[f.marketBase.files[0],copy(f.marketBase.files[0])];}
 ]){
  const f=openingFixture();change(f);const r=await f.run();assert.equal(r.code,"E_MARKET_BASELINE");
  assert.equal(f.calls.market.length+f.calls.prepared.length+f.calls.published.length+f.calls.releases.length,0);
 }
});
test("fetched opening result cannot change untouched tickers, add unrelated tickers or advance asOf",async()=>{
 for(const [change,code]of [
  [f=>{f.fetched.prices.QQQ[0].close+=1;},"E_OPENING_MARKET_SCOPE"],
  [f=>{delete f.fetched.prices.OTHER;},"E_OPENING_MARKET_SCOPE"],
  [f=>{f.fetched.prices.EXTRA=[{date:"2024-12-31",close:1}];},"E_OPENING_MARKET_SCOPE"],
  [f=>{f.fetched.asOf="2026-10-17";},"E_OPENING_MARKET_RECEIPT"]
 ]){
  const f=openingFixture();change(f);const r=await f.run();assert.equal(r.code,code);assert.equal(r.productionPreserved,true);
  assert.equal(f.calls.prepared.length+f.calls.published.length+f.calls.releases.length,0);
 }
});
test("fetched range receipt must contain exactly the requested historical subset",async()=>{
 const f=openingFixture();f.deps.local.prepareMarket=async input=>({status:"validated",rangesContent:JSON.stringify({...input.ranges,SPY:"2020-01-02"}),marketContent:JSON.stringify(f.fetched)});
 const r=await f.run();assert.equal(r.code,"E_OPENING_MARKET_RECEIPT");assert.equal(f.calls.prepared.length+f.calls.published.length+f.calls.releases.length,0);
});
test("both validated and unchanged data require the exact market validation receipt",async()=>{
 for(const status of ["validated","unchanged"])for(const value of [undefined,"f".repeat(64)]){
  const f=openingFixture();delete f.deps.openingMarketRanges;f.prepared.status=status;
  f.deps.local.prepare=async input=>{f.calls.prepared.push(copy(input));return{...f.prepared,...(value===undefined?{}:{validatedMarketSha256:value})};};
  const r=await f.run();assert.equal(r.code,"E_OPENING_MARKET_BINDING");assert.equal(r.phase,"local_validation");
  assert.equal(f.calls.published.length+f.calls.releases.length,0);
 }
});
test("unchanged encrypted data cannot publish a standalone opening market update",async()=>{
 for(const status of ["unchanged","validated"]){
  const f=openingFixture();f.prepared.status=status;f.prepared.content=f.baseline.content;f.prepared.validatedSha256=f.baseline.sha256;const r=await f.run();
  assert.equal(r.code,"E_OPENING_MARKET_WITHOUT_DATA_CHANGE");assert.equal(r.productionPreserved,true);
  assert.equal(f.calls.published.length+f.calls.releases.length,0);
 }
});
test("opening dry-run uses one atomic release and an uncertain release never falls back to data-only",async()=>{
 const dry=openingFixture();dry.request.publish=false;const dryResult=await dry.run();
 assert.equal(dryResult.status,"dry_run");assert.equal(dry.calls.releases.length,1);assert.equal(dry.calls.releases[0].publish,false);assert.equal(dry.calls.published.length,0);
 const f=openingFixture();let releaseCalls=0;f.deps.release.publishRelease=async()=>{releaseCalls++;return{status:"recovery_required",code:"E_REF_NOT_CONFIRMED"};};
 const r=await f.run();assert.equal(r.status,"recovery_required");assert.equal(r.phase,"publication");assert.equal(r.notify,true);
 assert.equal(releaseCalls,1);assert.equal(f.calls.published.length,0);
});
test("opening market fetch failure has no encryption or partial publication",async()=>{
 const f=openingFixture();f.deps.local.prepareMarket=async()=>{throw Error("synthetic-private-network-detail");};
 const r=await f.run();assert.equal(r.status,"failed");assert.equal(r.phase,"market_preparation");assert.equal(r.productionPreserved,true);
 assert.doesNotMatch(JSON.stringify(r),/synthetic-private-network-detail/);assert.equal(f.calls.prepared.length+f.calls.published.length+f.calls.releases.length,0);
});
test("opening plans complete new-position quotes before the only publishable preparation",async()=>{
 const f=openingFixture(true);f.prepared.positionEvents=[{id:"d".repeat(64),kind:"opened",ticker:"NEW",date:"2026-10-17",firstKnownBuyDate:"2026-10-17"}];
 const pinned=f.marketBase.files.find(file=>file.path==="market.prices.json"),fetch=f.deps.local.prepareMarket;
 f.deps.local.prepareMarket=async input=>{assert.equal(input.existingContent,pinned.content);assert.equal(hash(input.existingContent),pinned.sha256);return fetch(input);};
 const r=await f.run();assert.equal(r.status,"published");assert.equal(r.eventsReady,true);
 assert.equal(f.calls.market.length,2);assert.equal(f.calls.prepared.length,2);assert.equal(f.calls.published.length,0);assert.equal(f.calls.releases.length,1);
 const [plan,final]=f.calls.prepared;assert.equal(plan.planOnly,true);assert.equal(final.planOnly,undefined);
 for(const key of ["operationId","baseline","snapshot","policy"])assert.deepEqual(final[key],plan[key]);
 assert.deepEqual(f.calls.market[1].ranges,{NEW:"2026-10-17"});assert.equal(f.calls.market[1].end,"2026-10-18");
 assert.notEqual(plan.marketContent,pinned.content);assert.equal(f.calls.market[1].existingContent,pinned.content);
 const market=JSON.parse(final.marketContent);assert.equal(market.asOf,"2026-10-18");assert.deepEqual(market.prices.NEW,[{date:"2026-10-17",close:12},{date:"2026-10-18",close:13}]);
 assert.equal(final.marketBinding.baselineSha256,plan.marketBinding.baselineSha256);assert.notEqual(final.marketBinding.candidateSha256,plan.marketBinding.candidateSha256);
 for(const ticker of Object.keys(f.marketBase.market.prices))assert.deepEqual(market.prices[ticker],JSON.parse(plan.marketContent).prices[ticker]);
 const files=f.calls.releases[0].files;assert.equal(files.find(file=>file.path==="market.prices.json").content,final.marketContent);
 assert.equal(JSON.parse(files.find(file=>file.path==="scripts/market_price_ranges.json").content).NEW,"2026-10-17");
});
test("a second bound fetch retains earlier opening additions even for the same requested ticker",async()=>{
 const f=openingFixture(true);f.prepared.positionEvents=[{id:"d".repeat(64),kind:"reopened",ticker:"DEMO",date:"2026-10-17",firstKnownBuyDate:"2025-01-02"}];
 const r=await f.run();assert.equal(r.status,"published");assert.equal(f.calls.market.length,2);
 assert.equal(f.calls.market[1].existingContent,f.marketBase.files.find(file=>file.path==="market.prices.json").content);
 assert.deepEqual(f.calls.market[1].ranges,{DEMO:"2024-12-31"});
 const final=JSON.parse(f.calls.prepared[1].marketContent);
 assert.deepEqual(final.prices.DEMO,[{date:"2024-12-31",close:8},...f.marketBase.market.prices.DEMO,{date:"2026-10-18",close:13}]);
 assert.equal(f.calls.releases[0].files.find(file=>file.path==="market.prices.json").content,f.calls.prepared[1].marketContent);
});
test("an event already covered by the final opening plan can publish the same validated prices",async()=>{
 const f=openingFixture(true);f.prepared.positionEvents=[{id:"d".repeat(64),kind:"reopened",ticker:"DEMO",date:"2026-10-16",firstKnownBuyDate:"2025-01-02"}];
 const r=await f.run();assert.equal(r.status,"published");assert.equal(r.eventsReady,true);assert.equal(f.calls.market.length,1);
 assert.equal(f.calls.releases[0].files.find(file=>file.path==="market.prices.json").content,f.calls.prepared[0].marketContent);
});
test("opening rejects holdings or linked asset changes across transaction reads before market work",async()=>{
 for(const change of [
  f=>{f.responses.at(-1).results[0].result.items[0].value+=1;},
  f=>{f.deps.finances.getLinkedAccounts=async()=>{f.calls.linkedReads++;const linked=copy(f.linked);if(f.calls.linkedReads===2)linked.institutions[0].accounts.at(-1).balance=2;return linked;};}
 ]){
  const f=openingFixture();change(f);const r=await f.run();
  assert.equal(r.code,"E_SOURCE_SNAPSHOT_CHANGED_DURING_READ");assert.equal(r.phase,"finances_read");assert.equal(r.productionPreserved,true);
  assert.equal(f.calls.marketReads.length+f.calls.market.length+f.calls.prepared.length+f.calls.published.length+f.calls.releases.length,0);
 }
});
test("opening comparison ignores only brokerage reportedBalance and does not mutate either snapshot",async()=>{
 const f=openingFixture(),normalize=f.deps.source.normalizeAssetSnapshot,observed=[];
 f.deps.source.normalizeAssetSnapshot=input=>{
  const snapshot=normalize(input),ending=observed.length===1;
  snapshot.schemaVersion=3;snapshot.accounts=[
   {id:"synthetic-a",type:"brokerage",cashCents:100,securitiesCents:200,totalCents:300,reportedBalance:{totalCents:ending?450:400,coverage:{updatedAt:ending?"2026-10-18T04:01:00Z":"2026-10-18T04:00:00Z"}}},
   {id:"synthetic-bank",type:"checking",cashCents:100,securitiesCents:0,totalCents:100}
  ];observed.push(snapshot);return snapshot;
 };
 const r=await f.run();assert.equal(r.status,"published");assert.equal(observed.length,2);
 assert.equal(observed[0].accounts[0].reportedBalance.totalCents,400);assert.equal(observed[1].accounts[0].reportedBalance.totalCents,450);
 assert.deepEqual(f.calls.prepared[0].snapshot.accounts,observed[0].accounts);
});
test("brokerage assets, bank diagnostics and coverage remain strict during opening bookends",async()=>{
 for(const change of [
  snapshot=>{snapshot.accounts[0].cashCents+=1;},
  snapshot=>{snapshot.accounts[1].cashCents+=1;},
  snapshot=>{snapshot.accounts[1].reportedBalance.totalCents+=1;},
  snapshot=>{snapshot.accounts[0].coverage.holdings.updatedAt="2026-10-18T04:01:00Z";}
 ]){
  const f=openingFixture(),normalize=f.deps.source.normalizeAssetSnapshot;let count=0;
  f.deps.source.normalizeAssetSnapshot=input=>{
   const snapshot=normalize(input);snapshot.schemaVersion=3;snapshot.accounts=[
    {id:"synthetic-a",type:"brokerage",cashCents:100,securitiesCents:200,totalCents:300,reportedBalance:{totalCents:400},coverage:{holdings:{complete:true,updatedAt:null}}},
    {id:"synthetic-bank",type:"checking",cashCents:100,securitiesCents:0,totalCents:100,reportedBalance:{totalCents:100}}
   ];if(++count===2)change(snapshot);return snapshot;
  };
  const r=await f.run();assert.equal(r.code,"E_SOURCE_SNAPSHOT_CHANGED_DURING_READ");assert.equal(r.phase,"finances_read");
  assert.equal(f.calls.marketReads.length+f.calls.market.length+f.calls.prepared.length+f.calls.published.length+f.calls.releases.length,0);
 }
});
test("opening end-read repeats every brokerage holding query with the original pagination guards",async()=>{
 const f=openingFixture(),r=await f.run();assert.equal(r.status,"published");
 const queries=f.calls.queries.map(batch=>batch.queries[0]);
 assert.deepEqual(queries.slice(-2),queries.slice(0,2));assert.equal(queries.length,8);
 assert.ok(queries.slice(-2).every(query=>query.query_type==="investment_holdings"&&query.account_id!=="synthetic-bank"));
 const missing=openingFixture();missing.responses.at(-1).results=[];const failed=await missing.run();
 assert.equal(failed.code,"E_HOLDINGS_QUERY");assert.equal(failed.phase,"finances_read");
 assert.equal(missing.calls.marketReads.length+missing.calls.prepared.length+missing.calls.published.length+missing.calls.releases.length,0);
});
test("benchmark opening quotes extend fetch coverage while retaining the active ticker set",async()=>{
 for(const ticker of ["SPY","QQQ"]){
  const f=openingFixture();f.deps.openingMarketRanges={[ticker]:"2024-12-31"};f.fetched=copy(f.marketBase.market);
  f.fetched.prices[ticker]=[{date:"2024-12-31",close:8},...f.fetched.prices[ticker].map(row=>({...row,close:999}))];
  const oldRanges=copy(f.marketBase.ranges),oldPrices=copy(f.marketBase.market.prices);
  const r=await f.run();assert.equal(r.status,"published");assert.deepEqual(f.calls.market[0].ranges,{[ticker]:"2024-12-31"});
  const release=f.calls.releases[0],market=JSON.parse(release.files.find(file=>file.path==="market.prices.json").content);
  const ranges=JSON.parse(release.files.find(file=>file.path==="scripts/market_price_ranges.json").content);
  assert.deepEqual(ranges,{...oldRanges,[ticker]:"2024-12-31"});
  assert.deepEqual(market.prices[ticker],[{date:"2024-12-31",close:8},...oldPrices[ticker]]);
  for(const other of Object.keys(oldPrices).filter(symbol=>symbol!==ticker))assert.deepEqual(market.prices[other],oldPrices[other]);
  const again=openingFixture();again.deps.openingMarketRanges={[ticker]:"2024-12-31"};again.marketBase.market=market;again.marketBase.ranges=ranges;again.repackMarket();
  const second=await again.run();assert.equal(second.status,"published");assert.equal(again.calls.market.length,0);
  assert.equal(again.calls.releases.length,0);assert.equal(again.calls.published.length,1);
 }
});
test("opening benchmark quote requests cannot add a missing monitoring configuration",async()=>{
 for(const ticker of ["SPY","QQQ"]){
  const f=openingFixture();f.deps.openingMarketRanges={[ticker]:"2024-12-31"};delete f.marketBase.ranges[ticker];f.repackMarket();
  const r=await f.run();assert.equal(r.code,"E_OPENING_PROTECTED_BENCHMARK");assert.equal(r.phase,"market_preparation");
  assert.equal(f.calls.market.length+f.calls.prepared.length+f.calls.published.length+f.calls.releases.length,0);
 }
});
test("stored earlier quotes repair fetch coverage without refetching or reactivating archived tickers",async()=>{
 const f=openingFixture(true);delete f.deps.openingMarketRanges;
 f.marketBase.market.prices.QQQ.unshift({date:"2024-12-31",close:8});
 delete f.marketBase.ranges.OTHER;f.repackMarket();
 const before=copy(f.marketBase),r=await f.run();
 assert.equal(r.status,"published");assert.equal(f.calls.market.length,0);
 const files=f.calls.releases[0].files;
 assert.deepEqual(JSON.parse(files.find(file=>file.path==="scripts/market_price_ranges.json").content),{...before.ranges,QQQ:"2024-12-31"});
 assert.equal(files.find(file=>file.path==="market.prices.json").content,before.files.find(file=>file.path==="market.prices.json").content);
 assert.deepEqual(f.marketBase,before);
});
test("opening close removes only monitoring and never reinstates its opening range",async()=>{
 const f=openingFixture(true);f.prepared.positionEvents=[{id:"d".repeat(64),kind:"closed",ticker:"DEMO",date:"2026-10-17",firstKnownBuyDate:"2025-01-02"}];
 const r=await f.run();assert.equal(r.status,"published");assert.equal(f.calls.market.length,1);assert.equal(f.calls.prepared.length,2);
 const files=f.calls.releases[0].files,ranges=JSON.parse(files.find(file=>file.path==="scripts/market_price_ranges.json").content),market=JSON.parse(files.find(file=>file.path==="market.prices.json").content);
 assert.equal(Object.hasOwn(ranges,"DEMO"),false);assert.deepEqual(market.prices.DEMO,[{date:"2024-12-31",close:8},...f.marketBase.market.prices.DEMO]);
 for(const ticker of ["SPY","QQQ"]){assert.equal(ranges[ticker],f.marketBase.ranges[ticker]);assert.deepEqual(market.prices[ticker],f.marketBase.market.prices[ticker]);}
 assert.equal(market.asOf,f.marketBase.market.asOf);
});
test("opening reopen preserves stored prices and only appends scoped real quote dates",async()=>{
 const f=openingFixture(true);delete f.deps.openingMarketRanges;delete f.marketBase.ranges.DEMO;f.repackMarket();
 f.prepared.positionEvents=[{id:"d".repeat(64),kind:"reopened",ticker:"DEMO",date:"2026-10-17",firstKnownBuyDate:"2025-01-02"}];
 const r=await f.run();assert.equal(r.status,"published");assert.deepEqual(f.calls.market[0].ranges,{DEMO:"2025-01-02"});
 const final=JSON.parse(f.calls.prepared[1].marketContent);assert.deepEqual(final.prices.DEMO,[...f.marketBase.market.prices.DEMO,{date:"2026-10-18",close:13}]);
 for(const ticker of ["OTHER","SPY","QQQ"])assert.deepEqual(final.prices[ticker],f.marketBase.market.prices[ticker]);
 assert.equal(JSON.parse(f.calls.releases[0].files.find(file=>file.path==="scripts/market_price_ranges.json").content).DEMO,"2025-01-02");
});
test("opening benchmark lifecycle keeps monitoring active and fetches all retained quote history",async()=>{
 for(const kind of ["opened","reopened","closed"]){
  const f=openingFixture(true);delete f.deps.openingMarketRanges;
  f.prepared.positionEvents=[{id:"d".repeat(64),kind,ticker:"SPY",date:"2026-10-17",firstKnownBuyDate:"2024-12-31"}];
  const r=await f.run();assert.equal(r.status,"published");
  if(kind==="closed"){assert.equal(f.calls.market.length,0);assert.equal(f.calls.releases.length,0);assert.equal(f.calls.published.length,1);}
  else{
   assert.equal(f.calls.market.length,1);assert.deepEqual(f.calls.market[0].ranges,{SPY:"2024-12-31"});const files=f.calls.releases[0].files;
   assert.deepEqual(JSON.parse(files.find(file=>file.path==="scripts/market_price_ranges.json").content),{...f.marketBase.ranges,SPY:"2024-12-31"});
   assert.deepEqual(JSON.parse(f.calls.prepared[1].marketContent).prices.SPY,[{date:"2024-12-31",close:12},...f.marketBase.market.prices.SPY,{date:"2026-10-18",close:13}]);
  }
 }
 const missing=openingFixture(true);delete missing.deps.openingMarketRanges;delete missing.marketBase.ranges.SPY;missing.repackMarket();
 missing.prepared.positionEvents=[{id:"d".repeat(64),kind:"opened",ticker:"SPY",date:"2026-10-17",firstKnownBuyDate:"2026-10-17"}];
 const r=await missing.run();assert.equal(r.code,"E_OPENING_PROTECTED_BENCHMARK");assert.equal(missing.calls.prepared.length,1);assert.equal(missing.calls.published.length+missing.calls.releases.length,0);
});
test("planning receipts cannot contain a candidate and final events must match the proven plan",async()=>{
 for(const change of [
  result=>{result.publishable=true;},result=>{result.candidateCreated=true;},result=>{result.content="synthetic-ciphertext";},result=>{result.candidatePath="synthetic-path";},result=>{result.validatedSha256="f".repeat(64);}
 ]){
  const f=openingFixture(true),prepare=f.deps.local.prepare;f.deps.local.prepare=async input=>{const result=await prepare(input);if(input.planOnly)change(result);return result;};
  const r=await f.run();assert.equal(r.code,"E_POSITION_PLAN_RECEIPT");assert.equal(f.calls.prepared.length,1);assert.equal(f.calls.published.length+f.calls.releases.length,0);
 }
 const f=openingFixture(true),prepare=f.deps.local.prepare;
 f.deps.local.prepare=async input=>{const result=await prepare(input);if(!input.planOnly)result.positionEvents=[{id:"d".repeat(64),kind:"closed",ticker:"DEMO",date:"2026-10-17",firstKnownBuyDate:"2025-01-02"}];return result;};
 const r=await f.run();assert.equal(r.code,"E_POSITION_PLAN_CHANGED");assert.equal(f.calls.prepared.length,2);assert.equal(f.calls.published.length+f.calls.releases.length,0);
});
test("event market tamper or final market receipt failure cannot publish the planned candidate",async()=>{
 for(const failure of ["unrequested","extra","asOf","range","finalhash","finalvalidation"]){
  const f=openingFixture(true);delete f.deps.openingMarketRanges;
  f.prepared.positionEvents=[{id:"d".repeat(64),kind:"opened",ticker:"NEW",date:"2026-10-17",firstKnownBuyDate:"2026-10-17"}];
  const fetch=f.deps.local.prepareMarket,prepare=f.deps.local.prepare;
  f.deps.local.prepareMarket=async input=>{const result=await fetch(input),market=JSON.parse(result.marketContent);
   if(failure==="unrequested")market.prices.QQQ[0].close+=1;
   if(failure==="extra")market.prices.EXTRA=[{date:"2026-10-17",close:1}];
   if(failure==="asOf")market.asOf="2026-10-19";
   if(failure==="range")result.rangesContent=JSON.stringify({...input.ranges,EXTRA:"2026-10-17"});
   result.marketContent=JSON.stringify(market);return result;
  };
  f.deps.local.prepare=async input=>{const result=await prepare(input);if(!input.planOnly){if(failure==="finalhash")result.validatedMarketSha256="f".repeat(64);if(failure==="finalvalidation")throw Object.assign(Error("synthetic-private-detail"),{code:"OPENING_PRICE_COVERAGE_REQUIRED"});}return result;};
  const r=await f.run();assert.equal(r.status,"failed");assert.equal(f.calls.published.length+f.calls.releases.length,0);assert.equal(r.positionEvents,undefined);
  assert.equal(f.calls.prepared.length,["finalhash","finalvalidation"].includes(failure)?2:1);assert.doesNotMatch(JSON.stringify(r),/synthetic-private-detail/);
 }
});
test("explicit current snapshot separation is copied into both plans without source-wait mode",async()=>{
 const f=openingFixture(true),authorization={version:1,authorizationRef:"synthetic-current-snapshot-authorization"};
 f.deps.currentSnapshotLedgerSeparation=copy(authorization);
 f.deps.publisher.readBaseline=async()=>{f.deps.currentSnapshotLedgerSeparation.authorizationRef="synthetic-mutated";return f.baseline;};
 const r=await f.run();assert.equal(r.status,"published");assert.equal(f.calls.prepared.length,2);
 for(const input of f.calls.prepared){assert.deepEqual(input.policy.currentSnapshotLedgerSeparation,authorization);assert.equal(input.recordSourceWait,undefined);}
});
test("malformed current snapshot separation authorization fails before connector reads",async()=>{
 for(const authorization of [{version:2,authorizationRef:"synthetic"},{version:1,authorizationRef:" "},{version:1,authorizationRef:"synthetic",extra:true}]){
  const f=openingFixture();f.deps.currentSnapshotLedgerSeparation=authorization;const r=await f.run();
  assert.equal(r.code,"E_CURRENT_SNAPSHOT_AUTHORIZATION_INVALID");assert.equal(r.phase,"preflight");assert.equal(f.calls.queries.length+f.calls.prepared.length,0);
 }
});
