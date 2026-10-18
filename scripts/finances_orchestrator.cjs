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
 async function runIteration(request,deps){
  let phase="preflight";
  try{
   requireThat(request&&Object.keys(request).every(k=>["operationId","accountHashes","publish"].includes(k)),"E_REQUEST");
   request=copy(request);
   requireThat(typeof request.operationId==="string"&&/^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/.test(request.operationId),"E_OPERATION_ID");
   requireThat(request.publish===undefined||typeof request.publish==="boolean","E_PUBLISH_FLAG");
   for(const name of ["hash","now"])requireThat(typeof deps?.[name]==="function","E_DEPENDENCIES");
   requireThat(typeof deps?.finances?.getLinkedAccounts==="function"&&typeof deps.finances.query==="function"&&typeof deps.local?.prepare==="function"&&typeof deps.source?.normalizeAssetSnapshot==="function"&&typeof deps.source?.normalizeTradeUpdates==="function"&&typeof deps.publisher?.readBaseline==="function"&&typeof deps.publisher.publishData==="function","E_DEPENDENCIES");
   phase="github_read";
   const baseline=copy(await deps.publisher.readBaseline(deps.publication));
   phase="finances_read";
   const linked=copy(await deps.finances.getLinkedAccounts({}));
   const accounts=await approvedScope(linked,request.accountHashes,deps.source,deps.hash);
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
   const policy={accountIds:accounts.map(a=>a.account_id)};
   const snapshot=deps.source.normalizeAssetSnapshot({linkedAccounts:linked,holdingsResponses,fetchedAt:new Date(deps.now()).toISOString(),baselineSha256:baseline.sha256,policy});
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
   phase="local_validation";
   const prepared=copy(await deps.local.prepare({operationId:request.operationId,baseline:copy(baseline),snapshot:copy(snapshot),policy:copy(policy)}));
   requireThat(prepared?.operationId===request.operationId&&prepared.expectedHead===baseline.head&&prepared.baselineSha256===baseline.sha256,"E_LOCAL_RECEIPT");
   if(prepared.status==="unchanged")return {status:"unchanged",notify:false,operationId:request.operationId};
   requireThat(prepared.status==="validated"&&typeof prepared.content==="string"&&await deps.hash(prepared.content)===prepared.validatedSha256,"E_LOCAL_RECEIPT");
   phase=request.publish===true?"publication":"publication_preflight";
   const result=await deps.publisher.publishData({operationId:request.operationId,expectedHead:baseline.head,expectedCipherSha256:baseline.sha256,content:prepared.content,validatedSha256:prepared.validatedSha256,publish:request.publish===true},deps.publication);
   if(["published","validated","dry_run","unchanged"].includes(result.status))return {...result,operationId:request.operationId,notify:false};
   return {...result,operationId:request.operationId,phase,notify:true};
  }catch(error){return {status:"failed",operationId:request?.operationId,phase,code:errorCode(error),notify:true,productionPreserved:!["publication"].includes(phase)};}
 }
 return {runIteration,approvedScope,OrchestrationError};
});
