"use strict";

// Runtime coordinator: inject the authenticated connector tools and the local
// fixed-program transport. This file cannot activate schedules or mint Git tokens.
(function install(root,factory){
 const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.VisualCardOrchestrator=api;
})(globalThis,function factory(){
 class OrchestrationError extends Error{constructor(code){super(code);this.code=code;}}
 function requireThat(ok,code){if(!ok)throw new OrchestrationError(code);}
 function errorCode(error){return typeof error?.code==="string"&&/^[A-Z_0-9]{1,80}$/.test(error.code)?error.code:"E_ORCHESTRATION";}
 const copy=value=>JSON.parse(JSON.stringify(value));
 const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
 const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(",")}]`:object(value)?`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonical(value[key])).join(",")}}`:JSON.stringify(value);
 const same=(a,b)=>canonical(a)===canonical(b);
 const pretty=value=>JSON.stringify(value,null,2)+"\n";
 const MARKET_PATH="market.prices.json",RANGES_PATH="scripts/market_price_ranges.json";
 function openingComparison(snapshot){
  const compared=copy(snapshot);
  // Brokerage summary balances are separately dated diagnostics. Holdings
  // valuation and every other account/coverage field still compare exactly.
  if(Array.isArray(compared.accounts))for(const account of compared.accounts)if(object(account)&&account.type==="brokerage")delete account.reportedBalance;
  return compared;
 }
 function openingOptions(deps){
  const authorization=deps.openingPositionAuthorization===undefined?undefined:copy(deps.openingPositionAuthorization);
  const ranges=deps.openingMarketRanges===undefined?undefined:copy(deps.openingMarketRanges);
  if(authorization===undefined){requireThat(ranges===undefined,"E_OPENING_AUTHORIZATION_REQUIRED");return {};}
  requireThat(object(authorization)&&Object.keys(authorization).sort().join(",")==="authorizationRef,historySha256,version"&&authorization.version===1
   &&typeof authorization.authorizationRef==="string"&&authorization.authorizationRef.trim().length>0&&authorization.authorizationRef.length<=512&&!/[\x00-\x1f\x7f]/.test(authorization.authorizationRef)
   &&typeof authorization.historySha256==="string"&&/^[a-f0-9]{64}$/.test(authorization.historySha256),"E_OPENING_AUTHORIZATION_INVALID");
  for(const name of ["readMarketBaseline","validateRanges","validateMarketData","parsePublicJSON","planRanges"])requireThat(typeof deps.market?.[name]==="function","E_OPENING_MARKET_DEPENDENCIES");
  if(ranges!==undefined)deps.market.validateRanges(ranges);
  return {authorization,ranges};
 }
 async function prepareOpeningMarket(baseline,requiredRanges,deps){
  const M=deps.market,base=copy(await M.readMarketBaseline(baseline.head,deps.publication));
  requireThat(base.head===baseline.head&&Array.isArray(base.files)&&base.files.length===2,"E_MARKET_BASELINE");
  const files=new Map();
  for(const file of base.files){
   requireThat(object(file)&&[MARKET_PATH,RANGES_PATH].includes(file.path)&&!files.has(file.path)&&typeof file.content==="string"
    &&typeof file.sha256==="string"&&/^[a-f0-9]{64}$/.test(file.sha256)&&await deps.hash(file.content)===file.sha256,"E_MARKET_BASELINE");
   files.set(file.path,file);
  }
  const oldMarket=files.get(MARKET_PATH),oldRanges=files.get(RANGES_PATH);
  const market=M.validateMarketData(M.parsePublicJSON(oldMarket.content)),ranges=M.validateRanges(M.parsePublicJSON(oldRanges.content));
  requireThat(same(market,base.market)&&same(ranges,base.ranges),"E_MARKET_BASELINE");
  const subset={};
  for(const [ticker,start] of Object.entries(requiredRanges||{}).sort(([a],[b])=>a<b?-1:a>b?1:0)){
   requireThat(start<=market.asOf,"E_OPENING_MARKET_RANGE");
   if(["SPY","QQQ"].includes(ticker)){
    requireThat(Object.hasOwn(ranges,ticker),"E_OPENING_PROTECTED_BENCHMARK");
    if(!Object.hasOwn(market.prices,ticker)||market.prices[ticker][0].date>start)subset[ticker]=start;
   }else if(!Object.hasOwn(ranges,ticker)||ranges[ticker]>start||!Object.hasOwn(market.prices,ticker))subset[ticker]=start;
  }
  const finalMarket=copy(market),finalRanges=copy(ranges);
  if(Object.keys(subset).length){
   requireThat(typeof deps.local.prepareMarket==="function","E_OPENING_MARKET_DEPENDENCIES");
   const refreshed=copy(await deps.local.prepareMarket({ranges:copy(subset),existingContent:oldMarket.content,end:market.asOf}));
   requireThat(refreshed.status==="validated"&&typeof refreshed.rangesContent==="string"&&typeof refreshed.marketContent==="string","E_OPENING_MARKET_RECEIPT");
   const observedRanges=M.validateRanges(M.parsePublicJSON(refreshed.rangesContent)),observed=M.validateMarketData(M.parsePublicJSON(refreshed.marketContent));
   requireThat(same(observedRanges,subset)&&observed.asOf===market.asOf,"E_OPENING_MARKET_RECEIPT");
   requireThat(Object.keys(observed.prices).every(ticker=>Object.hasOwn(market.prices,ticker)||Object.hasOwn(subset,ticker)),"E_OPENING_MARKET_SCOPE");
   for(const [ticker,rows] of Object.entries(market.prices))if(!Object.hasOwn(subset,ticker))requireThat(same(observed.prices[ticker],rows),"E_OPENING_MARKET_SCOPE");
   for(const [ticker,start] of Object.entries(subset)){
    requireThat(Array.isArray(observed.prices[ticker]),"E_OPENING_MARKET_RECEIPT");
    const oldRows=market.prices[ticker]||[],first=oldRows[0]?.date;
    // Provider overlap may be restated. Keep every stored date and close, and
    // accept only explicitly requested earlier history from this fetch.
    const earlier=observed.prices[ticker].filter(row=>row.date>=start&&(!first||row.date<first));
    finalMarket.prices[ticker]=[...earlier,...copy(oldRows)];
    if(!["SPY","QQQ"].includes(ticker))finalRanges[ticker]=Object.hasOwn(ranges,ticker)&&ranges[ticker]<start?ranges[ticker]:start;
   }
  }
  M.validateMarketData(finalMarket);M.validateRanges(finalRanges);
  const marketContent=same(finalMarket,market)?oldMarket.content:pretty(finalMarket);
  const rangesContent=same(finalRanges,ranges)?oldRanges.content:pretty(finalRanges);
  const marketSha256=await deps.hash(marketContent),rangesSha256=await deps.hash(rangesContent);
  requireThat(typeof marketSha256==="string"&&/^[a-f0-9]{64}$/.test(marketSha256)&&typeof rangesSha256==="string"&&/^[a-f0-9]{64}$/.test(rangesSha256),"E_OPENING_MARKET_HASH");
  return {market:finalMarket,ranges:finalRanges,marketContent,
   marketBinding:{baselineSha256:oldMarket.sha256,candidateSha256:marketSha256},
   changed:marketContent!==oldMarket.content||rangesContent!==oldRanges.content,
   files:[{path:RANGES_PATH,content:rangesContent,sha256:rangesSha256},{path:MARKET_PATH,content:marketContent,sha256:marketSha256}]};
 }
 // Private raw IDs come from the live response only after matching an independent
 // approved hash set. New/missing asset accounts require review, never auto-adopt.
 async function approvedScope(linked,accountHashes,source,hash){
  requireThat(Array.isArray(accountHashes)&&accountHashes.length>0&&new Set(accountHashes).size===accountHashes.length&&accountHashes.every(h=>/^[a-f0-9]{64}$/.test(h)),"E_APPROVED_SCOPE_REQUIRED");
  accountHashes=[...accountHashes];
  const raw=copy(source.unwrapFinancesResponse(linked,"institutions"));
  const accounts=raw.institutions.flatMap(i=>i.accounts||[]).filter(a=>["investment","depository"].includes(a.type));
  const observed=await Promise.all(accounts.map(a=>hash(a.account_id)));
  requireThat(new Set(observed).size===observed.length&&observed.length===accountHashes.length&&observed.every(h=>accountHashes.includes(h)),"E_ACCOUNT_SCOPE_CHANGED");
  return accounts;
 }
 async function readHoldings(accounts,deps){
  const holdingsResponses=[];
  for(const account of accounts.filter(a=>a.type==="investment")){
   let cursor;const seen=new Set();
   for(let page=0;page<50;page++){
    const query={query_type:"investment_holdings",account_id:account.account_id,limit:500,...(cursor?{cursor}:{})};
    const submitted=copy(query);
    const response=copy(await deps.finances.query({queries:[copy(query)]}));holdingsResponses.push({queries:[submitted],response});
    const result=deps.source.unwrapFinancesResponse(response,"results").results;
    requireThat(result.length===1&&result[0].index===0&&!result[0].is_error,"E_HOLDINGS_QUERY");
    const payload=result[0].result;
    if(payload?.has_more===false){requireThat(payload.next_cursor===null||payload.next_cursor===undefined,"E_PAGINATION");cursor=null;break;}
    requireThat(payload?.has_more===true&&typeof payload.next_cursor==="string"&&payload.next_cursor.length>0&&!seen.has(payload.next_cursor),"E_PAGINATION");
    seen.add(payload.next_cursor);cursor=payload.next_cursor;
   }
   requireThat(cursor===null,"E_PAGINATION_LIMIT");
  }
  return holdingsResponses;
 }
 async function runIteration(request,deps){
  let phase="preflight";
  try{
   requireThat(request&&Object.keys(request).every(k=>["operationId","accountHashes","publish"].includes(k)),"E_REQUEST");
   request=copy(request);
   requireThat(typeof request.operationId==="string"&&/^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/.test(request.operationId),"E_OPERATION_ID");
   requireThat(request.publish===undefined||typeof request.publish==="boolean","E_PUBLISH_FLAG");
   for(const name of ["hash","now"])requireThat(typeof deps?.[name]==="function","E_DEPENDENCIES");
   requireThat(typeof deps?.finances?.getLinkedAccounts==="function"&&typeof deps.finances.query==="function"&&typeof deps.local?.prepare==="function"&&typeof deps.source?.normalizeAssetSnapshot==="function"&&typeof deps.source?.normalizeTradeUpdates==="function"&&typeof deps.publisher?.readBaseline==="function"&&typeof deps.publisher.publishData==="function","E_DEPENDENCIES");
   const opening=openingOptions(deps);
   phase="github_read";
   const baseline=copy(await deps.publisher.readBaseline(deps.publication));
   phase="finances_read";
   const linked=copy(await deps.finances.getLinkedAccounts({}));
   const accounts=await approvedScope(linked,request.accountHashes,deps.source,deps.hash);
   const holdingsResponses=await readHoldings(accounts,deps);
   const policy={accountIds:accounts.map(a=>a.account_id)};
   if(opening.authorization!==undefined)policy.openingPositionAuthorization=copy(opening.authorization);
   if(deps.positionAccountHashes!==undefined){
    const scope=copy(deps.positionAccountHashes),investment=accounts.filter(a=>a.type==="investment");
    requireThat(Array.isArray(scope)&&scope.length===1&&scope.every(h=>/^[a-f0-9]{64}$/.test(h)),"E_POSITION_SCOPE");
    requireThat(investment.length===1&&await deps.hash(investment[0].account_id)===scope[0],"E_POSITION_SCOPE");
    policy.positionAccountIds=investment.map(a=>a.account_id);
   }
   const snapshot=deps.source.normalizeAssetSnapshot({linkedAccounts:linked,holdingsResponses,fetchedAt:new Date(deps.now()).toISOString(),baselineSha256:baseline.sha256,policy});
   const openingStartSnapshot=opening.authorization===undefined?undefined:openingComparison(snapshot);
   const transactionResponses=[];
   const investmentAccounts=accounts.filter(a=>a.type==="investment");
   for(const account of investmentAccounts){
    let cursor;const seen=new Set();
    for(let page=0;page<500;page++){
     const query={query_type:"investment_transactions",account_id:account.account_id,limit:20,order_by_field:"date",order_by_direction:"asc",...(cursor?{cursor}:{})};
     const response=copy(await deps.finances.query({queries:[copy(query)]}));
     transactionResponses.push({queries:[copy(query)],response});
     const results=deps.source.unwrapFinancesResponse(response,"results").results;
     requireThat(results.length===1&&results[0].index===0&&!results[0].is_error,"E_TRANSACTIONS_QUERY");
     const payload=results[0].result;
     if(payload?.has_more===false){requireThat(payload.next_cursor===null||payload.next_cursor===undefined,"E_PAGINATION");cursor=null;break;}
     requireThat(payload?.has_more===true&&typeof payload.next_cursor==="string"&&payload.next_cursor.length>0&&!seen.has(payload.next_cursor),"E_PAGINATION");
     seen.add(payload.next_cursor);cursor=payload.next_cursor;
    }
    requireThat(cursor===null,"E_PAGINATION_LIMIT");
   }
   snapshot.tradeUpdates=deps.source.normalizeTradeUpdates({transactionResponses,policy:{accountIds:investmentAccounts.map(a=>a.account_id)},fetchedAt:snapshot.fetchedAt});
   let openingMarket;
   if(opening.authorization!==undefined){
    const endingLinked=copy(await deps.finances.getLinkedAccounts({}));
    const endingAccounts=await approvedScope(endingLinked,request.accountHashes,deps.source,deps.hash);
    const endingHoldings=await readHoldings(endingAccounts,deps);
    const endingSnapshot=deps.source.normalizeAssetSnapshot({linkedAccounts:endingLinked,holdingsResponses:endingHoldings,fetchedAt:snapshot.fetchedAt,baselineSha256:baseline.sha256,policy:copy(policy)});
    // This detects changes between reads; it is not evidence of a source time.
    requireThat(same(openingStartSnapshot,openingComparison(endingSnapshot)),"E_SOURCE_SNAPSHOT_CHANGED_DURING_READ");
    phase="market_preparation";openingMarket=await prepareOpeningMarket(baseline,opening.ranges,deps);
   }
   phase="local_validation";
   const prepared=copy(await deps.local.prepare({operationId:request.operationId,baseline:copy(baseline),snapshot:copy(snapshot),policy:copy(policy),
    ...(openingMarket?{marketContent:openingMarket.marketContent,marketBinding:copy(openingMarket.marketBinding)}:{})}));
   requireThat(prepared?.operationId===request.operationId&&prepared.expectedHead===baseline.head&&prepared.baselineSha256===baseline.sha256,"E_LOCAL_RECEIPT");
   if(openingMarket)requireThat(prepared.validatedMarketSha256===openingMarket.marketBinding.candidateSha256,"E_OPENING_MARKET_BINDING");
   let events=[];
   if(deps.positionAccountHashes!==undefined){
    requireThat(typeof deps.market?.validateEvents==="function"&&typeof deps.release?.publishRelease==="function"&&Array.isArray(prepared.positionEvents),"E_POSITION_RECEIPT");
    events=copy(deps.market.validateEvents(prepared.positionEvents));
   }else requireThat(prepared.positionEvents===undefined,"E_POSITION_SCOPE");
   if(prepared.status==="unchanged"){
    requireThat(events.length===0,"E_POSITION_RECEIPT");
    requireThat(!openingMarket?.changed,"E_OPENING_MARKET_WITHOUT_DATA_CHANGE");
    return {status:"unchanged",notify:false,operationId:request.operationId};
   }
   requireThat(prepared.status==="validated"&&typeof prepared.content==="string"&&await deps.hash(prepared.content)===prepared.validatedSha256,"E_LOCAL_RECEIPT");
   requireThat(!openingMarket?.changed||(prepared.content!==baseline.content&&prepared.validatedSha256!==baseline.sha256),"E_OPENING_MARKET_WITHOUT_DATA_CHANGE");
   let files;
   if(openingMarket?.changed){
    requireThat(typeof deps.release?.publishRelease==="function","E_OPENING_MARKET_DEPENDENCIES");
    files=[{path:"data.enc.json",content:prepared.content,sha256:prepared.validatedSha256},...openingMarket.files];
   }
   if(events.length&&openingMarket){
    phase="market_preparation";
    const plan=deps.market.planRanges({ranges:copy(openingMarket.ranges),prices:copy(openingMarket.market.prices),events:copy(events)});
    requireThat(plan.changed===false,"E_OPENING_EVENT_MARKET_REVALIDATION_REQUIRED");
   }else if(events.length){
    phase="market_preparation";
    const marketBase=copy(await deps.market.readMarketBaseline(baseline.head,deps.publication));
    requireThat(marketBase.head===baseline.head,"E_MARKET_BASELINE");
    const plan=deps.market.planRanges({ranges:copy(marketBase.ranges),prices:copy(marketBase.market.prices),events:copy(events)});
    if(plan.changed){
     requireThat(typeof deps.local.prepareMarket==="function","E_DEPENDENCIES");
     const refreshed=copy(await deps.local.prepareMarket({ranges:copy(plan.ranges),existingContent:marketBase.files.find(f=>f.path==="market.prices.json").content,end:snapshot.fetchedAt.slice(0,10)}));
     requireThat(refreshed.status==="validated"&&typeof refreshed.rangesContent==="string"&&typeof refreshed.marketContent==="string","E_MARKET_RECEIPT");
     const ranges=deps.market.validateRanges(JSON.parse(refreshed.rangesContent)),market=deps.market.validateMarketData(JSON.parse(refreshed.marketContent));
     requireThat(JSON.stringify(Object.entries(ranges).sort())===JSON.stringify(Object.entries(plan.ranges).sort()),"E_MARKET_RECEIPT");
     // Retain every known historical date, including all closed securities.
     for(const [ticker,rows] of Object.entries(marketBase.market.prices)){
      const dates=new Set((market.prices[ticker]||[]).map(row=>row.date));
      requireThat(rows.every(row=>dates.has(row.date)),"E_MARKET_HISTORY_LOSS");
     }
     files=[{path:"data.enc.json",content:prepared.content,sha256:prepared.validatedSha256}];
     for(const [path,content] of [["scripts/market_price_ranges.json",refreshed.rangesContent],["market.prices.json",refreshed.marketContent]]){
      const old=marketBase.files.find(file=>file.path===path);
      requireThat(old&&await deps.hash(old.content)===old.sha256,"E_MARKET_BASELINE");
      if(content!==old.content)files.push({path,content,sha256:await deps.hash(content)});
     }
    }
   }
   phase=request.publish===true?"publication":"publication_preflight";
   const result=files
    ? await deps.release.publishRelease({operationId:request.operationId,expectedHead:baseline.head,expectedSourceHashes:Object.fromEntries(files.map(file=>[file.path,file.sha256])),files,publish:request.publish===true},deps.publication)
    : await deps.publisher.publishData({operationId:request.operationId,expectedHead:baseline.head,expectedCipherSha256:baseline.sha256,content:prepared.content,validatedSha256:prepared.validatedSha256,publish:request.publish===true},deps.publication);
   if(["published","validated","dry_run","unchanged"].includes(result.status))return {...result,operationId:request.operationId,notify:result.status==="published"&&events.length>0,...(events.length?{positionEvents:events,eventsReady:result.status==="published"}:{})};
   return {...result,operationId:request.operationId,phase,notify:true};
  }catch(error){return {status:"failed",operationId:request?.operationId,phase,code:errorCode(error),notify:true,productionPreserved:!["publication"].includes(phase)};}
 }
 return {runIteration,approvedScope,OrchestrationError};
});
