#!/usr/bin/env node
"use strict";
// Synthetic values only. No portfolio or credential files are read by these tests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const U = require("./update_finances.cjs");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const now = Date.parse("2026-10-18T03:00:00Z");
const copy = x => JSON.parse(JSON.stringify(x));
function oldData() {
  return {asOf:"2026-10-09",currency:"USD",holdings:[{ticker:"CASH",type:"cash",value:950},{ticker:"DEMO",type:"stock",shares:5,value:150,costBasis:80}],
    performance:{totalCurrentValue:1100,totalPrincipal:1000,totalGain:100,totalReturnPct:10,items:[
      {label:"legacy CD interest",principal:100,currentValue:125,gain:25,returnPct:25},
      {label:"separate cash interest",kind:"cash_interest",gain:5},
      {label:"stock gain",kind:"unrealized_gain",principal:80,currentValue:150,gain:70,returnPct:87.5}
    ]},
    trading:{DEMO:{orders:[],prices:[]}},income:[{id:"other-income",date:"2025-02-03",kind:"cash_interest",amount:5}],
    historyReview:{state:"awaiting_dated_evidence",previouslyIncludedCents:2500,maturityTotalCents:2800,unallocatedDifferenceCents:300,includedInIncome:false,additionalIncomeDate:null}
  };
}
function revision() { return {cashInterestReplacement:{itemIndex:0,expectedPreviousCents:2500,replacementCents:1800,incomeDate:null},capital:{principalCents:90000,principalIncreaseCents:17000,scope:"brokerage",effectiveDate:null}}; }
function snapshot(r=revision()) { return {schemaVersion:2,mode:"basis-revision",source:"user-confirmed",basisRevision:r}; }
const build = (r=revision(), old=oldData(), policy={basisRevision:r}) => U.buildBasisRevisionPayload(snapshot(r),old,{html,policy});
function assetSnapshot() {
  const proof={complete:true,allPagesFetched:true,sourceDateStatus:"unknown",updatedAt:null};
  return {schemaVersion:2,mode:"assets",source:"Finances",currency:"USD",fetchedAt:"2026-10-18T02:00:00Z",coverage:{accountsComplete:true,allPagesFetched:true,accountIds:["synthetic-broker","synthetic-bank"]},
    accounts:[{id:"synthetic-broker",type:"brokerage",currency:"USD",cashCents:100000,securitiesCents:15000,totalCents:115000,coverage:{balances:copy(proof),holdings:copy(proof)}},{id:"synthetic-bank",type:"checking",currency:"USD",cashCents:50000,securitiesCents:0,totalCents:50000,coverage:{balances:copy(proof),holdings:copy(proof)}}],
    positions:[{accountId:"synthetic-broker",ticker:"DEMO",type:"stock",shares:5,valueCents:15000,priceAsOf:"2026-10-17"}],reconciliation:{independentSourceTotals:true,totalValueCents:165000,cashCents:150000}};
}
function updateAssets(s, previous) { return U.buildAssetPayload(s,previous,{html,now,policy:{accountIds:s.coverage.accountIds}}); }

test("explicit correction replaces only the selected cumulative interest",()=>{
  const old=oldData(),data=build();
  assert.equal(data.performance.items[0].gain,18);
  assert.equal(data.performance.totalGain,93);
  assert.deepEqual(data.performance.items.slice(1),old.performance.items.slice(1));
  assert.deepEqual(data.income,old.income);
  assert.equal(data.income.length,1);
  assert.equal(data.performance.totalPrincipal,old.performance.totalPrincipal);
  assert.equal(data.performance.totalCurrentValue,old.performance.totalCurrentValue);
  assert.equal(data.performance.totalReturnPct,null);
  assert.deepEqual(data.historySnapshot.performance,old.performance);
  assert.equal(data.historySnapshot.asOf,old.asOf);
});
test("manual principal is independent of the legacy all-asset basis",()=>{
  const data=build();
  assert.equal(data.userConfirmedCapital.principalCents,90000);
  assert.equal(data.userConfirmedCapital.updatePolicy,"explicit-user-only");
  assert.equal(data.userConfirmedCapital.source,"user-confirmed");
  assert.equal(data.userConfirmedCapital.effectiveDate,null);
  assert.equal(data.basisRevision.transferSettlement,"unverified");
  assert.equal(data.basisRevision.incomeDate,null);
});
test("replacement creates no cash, settlement, trades or dated income",()=>{
  const old=oldData(),data=build();
  for(const key of ["holdings","trading","income","asOf"])assert.deepEqual(data[key],old[key]);
  assert.equal(data.holdings.reduce((n,h)=>n+h.value,0),1100);
  assert.equal(Object.hasOwn(data,"historyReview"),false);
  assert.deepEqual(data.basisRevision.supersededHistoryReview,old.historyReview);
});
test("browser shows corrected cash interest with no source and no annual allocation",()=>{
  const old=oldData();
  old.historyStatus={state:"preserved",asOf:old.asOf,reason:"incomplete_history"};
  const data=build(revision(),old),ui=U.browserContract(html);
  ui.state.raw=data;ui.state.data=ui.normalizeData(data);
  assert.equal(ui.state.data.performance.totalGain,93);
  assert.equal(ui.state.data.performance.items.find(i=>i.kind==="cash_interest").gain,23);
  assert.equal(ui.state.data.performance.items.find(i=>i.kind==="cash_interest").label,"现金利息/已止盈收益");
  assert.equal(ui.state.data.performance.totalReturnPct,null);
  assert.doesNotMatch(JSON.stringify(ui.state.data.performance.items),/legacy CD|separate cash/);
  assert.equal(ui.computeAnnualSummary().annualUnavailable,true);
  assert.equal(ui.computeAnnualSummary().incomeCount,1);
});
test("same user statement is idempotent and never re-encrypts",async()=>{
  const data=build(),password="synthetic-password-only";
  const existingBytes=Buffer.from(JSON.stringify(U.encrypt(data,password)));
  const s=snapshot();s.previousCiphertextSha256=U.hash(existingBytes);
  const result=await U.prepareUpdate({snapshot:s,existingBytes,password,html,now,policy:{basisRevision:revision()},encryptFn:()=>{throw Error("must not encrypt");}});
  assert.equal(result.status,"unchanged");
});
test("correction survives real browser encryption roundtrip",async()=>{
  const password="synthetic-password-only",existingBytes=Buffer.from(JSON.stringify(U.encrypt(oldData(),password))),s=snapshot();
  s.previousCiphertextSha256=U.hash(existingBytes);
  const result=await U.prepareUpdate({snapshot:s,existingBytes,password,html,now,policy:{basisRevision:revision()}});
  assert.equal(result.status,"changed");
  const restored=await U.browserContract(html).decryptPayload(JSON.parse(result.bytes),password);
  assert.equal(restored.performance.totalGain,93);assert.equal(restored.userConfirmedCapital.principalCents,90000);
});
test("unapproved or incorrectly mapped replacements fail closed",()=>{
  assert.throws(()=>build(revision(),oldData(),{}),{message:"APPROVED_BASIS_REVISION_REQUIRED"});
  const changed=revision();changed.cashInterestReplacement.replacementCents++;
  assert.throws(()=>build(changed,oldData(),{basisRevision:revision()}),{message:"BASIS_REVISION_POLICY_MISMATCH"});
  const wrong=revision();wrong.cashInterestReplacement.itemIndex=2;
  assert.throws(()=>build(wrong),{message:"LEGACY_HISTORICAL_MAPPING_REQUIRED"});
  const stale=revision();stale.cashInterestReplacement.expectedPreviousCents++;
  assert.throws(()=>build(stale),{message:"LEGACY_HISTORICAL_INTEREST_MISMATCH"});
});
test("correction cannot silently assign dates or settlement",()=>{
  const dated=revision();dated.cashInterestReplacement.incomeDate="2026-10-17";
  assert.throws(()=>build(dated),{message:"INVALID_INTEREST_REPLACEMENT"});
  const capital=revision();capital.capital.effectiveDate="2026-10-17";
  assert.throws(()=>build(capital),{message:"MANUAL_CAPITAL_DATE_NOT_CONFIRMED"});
  const settled=revision();settled.transferSettlement="settled";
  assert.throws(()=>build(settled),{message:"UNEXPECTED_BASIS_REVISION_FIELDS"});
});
test("old undated maturity review cannot become active again",()=>{
  const data=build(),review={previouslyIncludedCents:2500,maturityTotalCents:2800,additionalIncomeDate:null};
  assert.throws(()=>U.buildHistoricalReviewPayload({schemaVersion:2,mode:"history-review",source:"user-confirmed",historicalInterestReview:review},data,{html,policy:{historicalInterestReview:review,historicalPerformanceItemIndexes:[0]}}),{message:"SUPERSEDED_HISTORICAL_REVIEW"});
});
test("deposit and withdrawal change assets while manual principal remains exact",()=>{
  const old=build();
  for(const change of [12000,-8000]){
    const s=assetSnapshot();s.accounts[0].cashCents+=change;s.accounts[0].totalCents+=change;s.reconciliation.totalValueCents+=change;s.reconciliation.cashCents+=change;
    const next=updateAssets(s,old);
    assert.deepEqual(next.userConfirmedCapital,old.userConfirmedCapital);
    assert.equal(next.holdings.reduce((n,h)=>n+h.value,0),(165000+change)/100);
    assert.equal(next.performance.totalGain,93);
    assert.deepEqual(next.historySnapshot,old.historySnapshot);
  }
});
test("internal transfer reallocates existing cash without changing income or capital",()=>{
  const old=build(),s=assetSnapshot();
  s.accounts[0].cashCents+=16000;s.accounts[0].totalCents+=16000;
  s.accounts[1].cashCents-=16000;s.accounts[1].totalCents-=16000;
  const next=updateAssets(s,old);
  assert.deepEqual(next.userConfirmedCapital,old.userConfirmedCapital);
  assert.equal(next.holdings.find(h=>h.ticker==="CASH").value,1500);
  assert.deepEqual(next.income,old.income);assert.equal(next.performance.totalGain,93);
});
test("market movement changes holdings without changing user principal",()=>{
  const old=build(),s=assetSnapshot();s.positions[0].valueCents+=650;s.accounts[0].securitiesCents+=650;s.accounts[0].totalCents+=650;s.reconciliation.totalValueCents+=650;
  const next=updateAssets(s,old);
  assert.deepEqual(next.userConfirmedCapital,old.userConfirmedCapital);
  assert.equal(next.holdings.find(h=>h.ticker==="DEMO").value,156.5);
});
test("only a later explicit capital statement changes the authoritative principal",()=>{
  const old=build(),r={capital:{principalCents:84000,principalIncreaseCents:-6000,scope:"brokerage",effectiveDate:null}};
  const next=build(r,old);
  assert.equal(next.userConfirmedCapital.principalCents,84000);
  assert.deepEqual(next.performance,old.performance);assert.deepEqual(next.historySnapshot,old.historySnapshot);
  assert.deepEqual(next.holdings,old.holdings);assert.equal(next.basisRevision.cumulativeGainCorrected,true);
  const bad=copy(r);bad.capital.principalCents++;
  assert.throws(()=>build(bad,old),{message:"MANUAL_CAPITAL_CHANGE_MISMATCH"});
});
function fullSnapshot(change=0,internal=0) {
  const stamp="2026-10-18T02:00:00Z",coverage=Object.fromEntries(["balances","holdings","transactions","interest"].map(k=>[k,{complete:true,allPagesFetched:true,fromInception:true,updatedAt:stamp}]));
  const accounts=["brokerage","checking","savings"].map((type,i)=>({id:`synthetic-${i}`,type,currency:"USD",cashCents:10000+(i===0?change+internal:i===1?-internal:1800),securitiesCents:0,totalCents:10000+(i===0?change+internal:i===1?-internal:1800),coverage:copy(coverage)}));
  const transactions=accounts.map((a,i)=>({accountId:a.id,id:"initial",date:"2026-01-02",kind:"external_in",amountCents:10000,status:"posted",sequence:i}));
  transactions.push({accountId:accounts[2].id,id:"interest",date:"2026-02-03",kind:"cash_interest",amountCents:1800,status:"posted",sequence:3});
  if(change)transactions.push({accountId:accounts[0].id,id:"change",date:"2026-03-04",kind:change>0?"external_in":"external_out",amountCents:change,status:"posted",sequence:4});
  if(internal)for(const [i,sign] of [[0,1],[1,-1]])transactions.push({accountId:accounts[i].id,id:"transfer",date:"2026-04-05",kind:sign===1?"transfer_in":"transfer_out",amountCents:internal*sign,transferId:"synthetic-transfer",status:"posted",sequence:5+i});
  return {schemaVersion:1,source:"Finances",currency:"USD",asOf:"2026-10-17",fetchedAt:stamp,coverage:{accountsComplete:true,allPagesFetched:true,historyFromInception:true,accountIds:accounts.map(a=>a.id)},accounts,positions:[],transactions,historicalCashInterest:{amountCents:1800,transactionKeys:["synthetic-2:interest"]},migration:{historicalPerformanceItemIndexes:[0]},prices:{},reconciliation:{independentSourceTotals:true,totalValueCents:31800+change,cashCents:31800+change,principalCents:30000+change,totalGainCents:1800,realizedGainCents:0,cashInterestCents:1800,dividendCents:0,annual:[{year:2026,stockPnlCents:0,incomeCents:1800,pnlCents:1800}]}};
}
test("full-history deposits withdrawals and transfers cannot overwrite manual capital",()=>{
  const old=build();
  for(const [change,internal] of [[0,0],[1200,0],[-700,0],[0,600]]){
    const s=fullSnapshot(change,internal);
    const next=U.buildPayload(s,old,{html,now,policy:{accountIds:s.coverage.accountIds,historicalCashInterestCents:1800}});
    assert.deepEqual(next.userConfirmedCapital,old.userConfirmedCapital);
    assert.equal(next.updateAudit.ledgerPrincipalCents,30000+change);
    assert.equal(next.performance.totalGain,18);
    assert.equal(next.income.length,1);
    assert.equal(next.holdings[0].value,(31800+change)/100);
  }
});
test("full-history migration retains correction audit on later unchanged runs",()=>{
  const s=fullSnapshot(),policy={accountIds:s.coverage.accountIds,historicalCashInterestCents:1800};
  const first=U.buildPayload(s,build(),{html,now,policy});
  const second=U.buildPayload(s,first,{html,now,policy});
  assert.deepEqual(second,first);
  assert.equal(second.updateAudit.previousBasisRevision.cumulativeGainCorrected,true);
});
test("rendered principal uses user value and clearly separates old basis",()=>{
  const ui=U.browserContract(html),data=build(),elements=new Map();
  const el=id=>{if(!elements.has(id))elements.set(id,{textContent:"",hidden:false,classList:{toggle(){}}});return elements.get(id);};
  Object.assign(ui,{$:el,setText:(id,s)=>{el(id).textContent=s;},formatCurrency:v=>`$${v}`,formatSignedCurrency:v=>`$${v}`,formatPct:v=>`${v}%`,formatSignedPct:v=>`${v}%`,finiteOrNull:v=>v==null?null:Number(v)});
  vm.runInContext(["renderSummary","renderHero"].map(name=>html.match(new RegExp(`^    function ${name}\\([^]*?^    }`,"m"))[0]).join("\n"),ui);
  ui.state.raw=data;ui.state.data=ui.normalizeData(data);ui.renderSummary();
  assert.equal(el("totalPrincipal").textContent,"$900");
  assert.equal(el("principalLabel").textContent,"场内本金");
  assert.match(el("principalNote").textContent,/用户确认.*日期未知.*仅由用户更新/);
  assert.match(el("totalGainSub").textContent,/历史本金.*历史原市值/);
  assert.equal(el("totalReturn").textContent,"–");
  assert.doesNotMatch(el("heroDeltaValue").textContent,/%/);
  assert.match(el("historyNotice").textContent,/现金利息已按用户确认更正/);
  assert.doesNotMatch(el("historyNotice").textContent,/待确认日期的现金利息调整|CD|银行|Robinhood/);
  assert.equal(el("heroValue").textContent,"$1100");
});
