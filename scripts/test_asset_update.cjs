#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {test}=require("node:test");
const U=require("./update_finances.cjs");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const now=Date.parse("2026-10-18T03:00:00Z");
const copy=x=>JSON.parse(JSON.stringify(x));
const policy={accountIds:["synthetic-broker","synthetic-bank"]};
function oldData(){return {asOf:"2026-10-09",currency:"USD",holdings:[{ticker:"CASH",type:"cash",value:1000},{ticker:"DEMO",type:"stock",shares:5,value:100,costBasis:75}],performance:{totalCurrentValue:1100,totalPrincipal:1000,totalGain:100,totalReturnPct:10,items:[{label:"CD interest",kind:"cash_interest",gain:25},{label:"other legacy",kind:"other_income",gain:75}]},trading:{DEMO:{prices:[{date:"2025-01-02",close:15},{date:"2025-12-31",close:18},{date:"2026-10-09",close:20}],orders:[{date:"2025-01-02",side:"buy",shares:5,price:15}]}}};}
function snapshot(){
 const proof={complete:true,allPagesFetched:true,sourceDateStatus:"unknown",updatedAt:null};
 return {schemaVersion:2,mode:"assets",source:"Finances",currency:"USD",fetchedAt:"2026-10-18T02:00:00Z",coverage:{accountsComplete:true,allPagesFetched:true,accountIds:copy(policy.accountIds)},accounts:[{id:"synthetic-broker",type:"brokerage",currency:"USD",cashCents:100000,securitiesCents:15000,totalCents:115000,coverage:{balances:copy(proof),holdings:copy(proof)}},{id:"synthetic-bank",type:"checking",currency:"USD",cashCents:50000,securitiesCents:0,totalCents:50000,coverage:{balances:copy(proof),holdings:copy(proof)}}],positions:[{accountId:"synthetic-broker",ticker:"DEMO",type:"stock",shares:5,valueCents:15000,priceAsOf:"2026-10-17"}],reconciliation:{independentSourceTotals:true,totalValueCents:165000,cashCents:150000}};
}
const build=(s=snapshot(),old=oldData(),p=policy)=>U.buildAssetPayload(s,old,{html,now,policy:p});
test("reconciled assets update independently while old history stays exact",()=>{
 const old=oldData(),data=build();
 assert.equal(data.holdings.reduce((n,h)=>n+h.value,0),1650);
 for(const key of ["performance","trading","income","asOf"])assert.deepEqual(data[key],old[key]);
 assert.deepEqual(data.historySnapshot.performance,old.performance);
 assert.equal(data.historyStatus.asOf,old.asOf);assert.equal(data.historyStatus.state,"preserved");
});
test("unknown balance date remains null and is distinct from retrieval",()=>{
 const data=build();assert.deepEqual(data.assetSnapshot,{retrievedAt:"2026-10-18T02:00:00Z",sourceAsOf:null,sourceDateStatus:"unknown"});
 assert.ok(data.assetAudit.accountSourceDates.every(a=>a.balanceSourceAsOf===null));
});
test("missing historical transactions and income are retained as missing",()=>{
 const old=oldData();delete old.trading;
 const data=build(snapshot(),old);assert.equal(Object.hasOwn(data,"income"),false);assert.equal(Object.hasOwn(data,"trading"),false);
 assert.equal(Object.hasOwn(data.historySnapshot,"income"),false);
 const ui=U.browserContract(html);assert.equal(ui.normalizeData(data).trading.length,0);
});
test("missing current cost basis remains missing, never zero profit",()=>{
 const stock=build().holdings.find(h=>h.ticker==="DEMO");assert.equal(Object.hasOwn(stock,"costBasis"),false);assert.equal(Object.hasOwn(stock,"unrealizedGain"),false);
});
test("source/account totals must reconcile without historical gates",()=>{
 const f=snapshot();f.accounts[0].totalCents++;assert.throws(()=>build(f),{message:"ACCOUNT_BALANCE_MISMATCH"});
 const g=snapshot();g.positions[0].valueCents++;assert.throws(()=>build(g),{message:"SECURITIES_BALANCE_MISMATCH"});
 const h=snapshot();h.reconciliation.totalValueCents++;assert.throws(()=>build(h),{message:"SOURCE_TOTALS_MISMATCH"});
});
test("asset scope or coverage missing still fails closed",()=>{
 const f=snapshot();f.coverage.accountsComplete=false;assert.throws(()=>build(f),{message:"INCOMPLETE_ASSET_COVERAGE"});
 const g=snapshot();g.accounts[0].coverage.holdings.complete=false;assert.throws(()=>build(g),{message:"INCOMPLETE_ASSET_DATASET"});
 assert.throws(()=>build(snapshot(),oldData(),{accountIds:[...policy.accountIds,"missing"]}),{message:"APPROVED_ACCOUNT_SCOPE_MISMATCH"});
});
test("source dates must explicitly distinguish known and unknown",()=>{
 const f=snapshot();delete f.accounts[0].coverage.balances.sourceDateStatus;assert.throws(()=>build(f),{message:"UNKNOWN_SOURCE_DATE_MUST_BE_EXPLICIT"});
 const g=snapshot();g.accounts[0].coverage.balances.updatedAt=g.fetchedAt;assert.throws(()=>build(g),{message:"KNOWN_SOURCE_DATE_MUST_BE_EXPLICIT"});
});
test("known source timestamps validate and old known timestamp does not regress silently",()=>{
 const f=snapshot();for(const a of f.accounts)for(const proof of Object.values(a.coverage)){proof.updatedAt="2026-10-17T20:00:00Z";proof.sourceDateStatus="known";}
 assert.equal(build(f).assetSnapshot.sourceAsOf,"2026-10-17");
 f.accounts[0].coverage.balances.updatedAt="2026-10-01T20:00:00Z";assert.throws(()=>build(f),{message:"STALE_OR_FUTURE_SOURCE"});
});
test("known source time cannot regress relative to saved observations even after an unknown date",()=>{
 const f=snapshot();for(const a of f.accounts)for(const p of Object.values(a.coverage)){p.updatedAt="2026-10-18T01:00:00Z";p.sourceDateStatus="known";}
 const first=build(f);const unknown=build(snapshot(),first);
 f.accounts[0].coverage.balances.updatedAt="2026-10-18T00:00:00Z";
 assert.throws(()=>build(f,first),{message:"ASSET_SOURCE_TIMESTAMP_REGRESSION"});
 assert.throws(()=>build(f,unknown),{message:"ASSET_SOURCE_TIMESTAMP_REGRESSION"});
});
test("unknown old historical cutoff does not block independently verified assets",()=>{
 const old=oldData();delete old.asOf;
 const data=build(snapshot(),old);assert.equal(data.historyStatus.asOf,null);assert.equal(data.historySnapshot.asOf,null);
 const ui=U.browserContract(html);ui.state.raw=data;ui.state.data=ui.normalizeData(data);
 assert.equal(ui.computeAnnualSummary().years.length,0);
});
test("repeated asset updates keep the original historical snapshot",()=>{
 const first=build();const s=snapshot();s.positions[0].valueCents+=100;s.accounts[0].securitiesCents+=100;s.accounts[0].totalCents+=100;s.reconciliation.totalValueCents+=100;
 const second=build(s,first);assert.deepEqual(second.historySnapshot,first.historySnapshot);assert.equal(second.historyStatus.asOf,"2026-10-09");
});
test("retrieval-only changes do not re-encrypt an unchanged snapshot",async()=>{
 const data=build(), password="synthetic-only";
 const existingBytes=Buffer.from(JSON.stringify(U.encrypt(data,password)));
 const s=snapshot();s.fetchedAt="2026-10-18T02:30:00Z";s.previousCiphertextSha256=U.hash(existingBytes);s.accounts.reverse();
 const result=await U.prepareUpdate({snapshot:s,existingBytes,password,html,now,policy,encryptFn:()=>{throw Error("must not encrypt");}});
 assert.equal(result.status,"unchanged");
});
function review(){return {previouslyIncludedCents:2500,maturityTotalCents:2800,additionalIncomeDate:null};}
function reviewPolicy(){return {historicalInterestReview:review(),historicalPerformanceItemIndexes:[0]};}
function reviewSnapshot(){return {schemaVersion:2,mode:"history-review",source:"user-confirmed",historicalInterestReview:review()};}
test("undated historical difference is recorded once but never added to profits or income",()=>{
 const old=oldData(),data=U.buildHistoricalReviewPayload(reviewSnapshot(),old,{html,policy:reviewPolicy()});
 assert.equal(data.historyReview.unallocatedDifferenceCents,300);assert.equal(data.historyReview.includedInIncome,false);assert.equal(data.historyReview.additionalIncomeDate,null);
 for(const key of ["holdings","performance","trading","income","asOf"])assert.deepEqual(data[key],old[key]);
 assert.equal(U.canonical(U.buildHistoricalReviewPayload(reviewSnapshot(),data,{html,policy:reviewPolicy()})),U.canonical(data));
});
test("historical review cannot substitute the maturity total for the already included amount",()=>{
 const s=reviewSnapshot();s.historicalInterestReview.previouslyIncludedCents=2800;
 const p=reviewPolicy();p.historicalInterestReview=copy(s.historicalInterestReview);
 assert.throws(()=>U.buildHistoricalReviewPayload(s,oldData(),{html,policy:p}),{message:"LEGACY_HISTORICAL_INTEREST_MISMATCH"});
});
test("unknown historical interest date cannot be invented in review mode",()=>{
 const s=reviewSnapshot();s.historicalInterestReview.additionalIncomeDate="2026-10-17";
 const p=reviewPolicy();p.historicalInterestReview=copy(s.historicalInterestReview);
 assert.throws(()=>U.buildHistoricalReviewPayload(s,oldData(),{html,policy:p}),{message:"INVALID_UNDATED_HISTORICAL_REVIEW"});
});
test("asset update plus review produces only permitted metadata difference",()=>{
 const s=snapshot();s.historicalInterestReview=review();
 const data=build(s,oldData(),{...policy,...reviewPolicy()});
 assert.equal(data.historyReview.unallocatedDifferenceCents,300);assert.equal(data.performance.totalGain,100);assert.equal(Object.hasOwn(data,"income"),false);
});
test("history-review uses the existing browser encryption contract",async()=>{
 const password="synthetic-only",existingBytes=Buffer.from(JSON.stringify(U.encrypt(oldData(),password)));
 const s=reviewSnapshot();s.previousCiphertextSha256=U.hash(existingBytes);
 const result=await U.prepareUpdate({snapshot:s,existingBytes,password,html,now,policy:reviewPolicy()});
 assert.equal(result.status,"changed");const next=await U.browserContract(html).decryptPayload(JSON.parse(result.bytes),password);
 assert.equal(next.performance.totalGain,100);assert.equal(next.historyReview.includedInIncome,false);
});
