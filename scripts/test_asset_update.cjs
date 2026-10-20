#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {test}=require("node:test");
const U=require("./update_finances.cjs");
const {positionEffects}=require("./finances_positions.cjs");
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
function openingFixture(){
 const previous=oldData();previous.trading.DEMO.orders[0].shares=3;
 previous.income=[{date:"2025-06-30",amount:25,kind:"cash_interest"}];
 previous.historySnapshot=copy(previous);
 previous.historyStatus={state:"preserved",asOf:previous.asOf};
 previous.tradeSync={version:1,baselineCutoff:previous.asOf,accountHashes:[U.hash("synthetic-broker")],transactions:[],allPagesFetched:true,dateBasis:"provider-settlement-date",historyFromInception:false};
 const approved={...copy(policy),openingPositionAuthorization:{version:1,authorizationRef:"synthetic-approved-opening",historySha256:U.hash(U.canonical(previous.historySnapshot))}};
 const market={asOf:"2026-10-17",source:"yahoo-chart",generatedAt:"2026-10-18T00:00:00Z",prices:{DEMO:[{date:"2024-12-31",close:14},{date:"2025-01-02",close:15},{date:"2025-12-31",close:18},{date:"2026-10-17",close:30}]}};
 return {previous,approved,market};
}
function openingSnapshot(){const s=snapshot();s.tradeUpdates={version:1,accountIds:["synthetic-broker"],allPagesFetched:true,dateBasis:"provider-settlement-date",historyFromInception:false,sourceAsOf:null,queriedFrom:null,rows:[]};return s;}
test("opening assets run actual annual functions and preserve history, income and current return method",()=>{
 const {previous,approved,market}=openingFixture(),s=openingSnapshot();
 const data=U.buildAssetPayload(s,previous,{html,now,policy:approved,market});
 assert.equal(data.trading.DEMO.openingPosition.shares,2);assert.deepEqual(data.trading.DEMO.orders,previous.trading.DEMO.orders);assert.deepEqual(data.income,previous.income);assert.deepEqual(data.performance,previous.performance);assert.deepEqual(data.historySnapshot,previous.historySnapshot);
 const ui=U.browserContract(html);ui.state.raw=data;ui.state.data=ui.normalizeData(data);ui.state.marketPrices=market;
 const years=ui.computeAnnualSummary().years;assert.equal(years[0].startValue,28);assert.equal(years[0].buys,45);assert.equal(years[0].income,25);assert.equal(years[0].stockPnl,17);
});
test("opening assets reject missing prices or a post-anchor quantity gap",()=>{
 const {previous,approved,market}=openingFixture();
 assert.throws(()=>U.buildAssetPayload(openingSnapshot(),previous,{html,now,policy:approved}),{message:"OPENING_MARKET_REQUIRED"});
 market.prices.DEMO.shift();assert.throws(()=>U.buildAssetPayload(openingSnapshot(),previous,{html,now,policy:approved,market}),{message:"OPENING_PRICE_COVERAGE_REQUIRED"});
 const s=openingSnapshot();s.positions[0].shares++;assert.throws(()=>U.buildAssetPayload(s,previous,{html,now,policy:approved,market}),{message:"OPENING_CURRENT_QUANTITY_MISMATCH"});
});
test("opening roundtrip and repeat business content never re-encrypt",async()=>{
 const {previous,approved,market}=openingFixture(),s=openingSnapshot(),password="synthetic-opening-update";
 const bytes=Buffer.from(JSON.stringify(U.encrypt(previous,password)));s.previousCiphertextSha256=U.hash(bytes);
 const first=await U.prepareUpdate({snapshot:s,existingBytes:bytes,password,html,now,policy:approved,market});assert.equal(first.status,"changed");
 s.previousCiphertextSha256=U.hash(first.bytes);
 const second=await U.prepareUpdate({snapshot:s,existingBytes:first.bytes,password,html,now,policy:approved,market,encryptFn(){assert.fail("unchanged must not encrypt");}});assert.equal(second.status,"unchanged");
});
test("opening rejects future market dates and quotes before encryption",async()=>{
 for(const addQuote of [false,true]){
  const {previous,approved,market}=openingFixture(),s=openingSnapshot(),password="synthetic-future-market";
  market.asOf="2026-10-30";if(addQuote)market.prices.DEMO.push({date:market.asOf,close:40});
  const bytes=Buffer.from(JSON.stringify(U.encrypt(previous,password)));s.previousCiphertextSha256=U.hash(bytes);
  await assert.rejects(()=>U.prepareUpdate({snapshot:s,existingBytes:bytes,password,html,now,policy:approved,market,encryptFn(){assert.fail("future quote must never encrypt");}}),{message:"OPENING_MARKET_AFTER_SNAPSHOT"});
 }
});
test("opening annual validation cannot silently drop another unpriced security",()=>{
 const {previous,approved,market}=openingFixture(),s=openingSnapshot();
 for(const data of [previous,previous.historySnapshot]){data.trading.EXTRA={orders:[{date:"2025-02-03",side:"buy",shares:1,price:10}]};data.holdings.push({ticker:"EXTRA",type:"stock",shares:1,value:10});}
 approved.openingPositionAuthorization.historySha256=U.hash(U.canonical(previous.historySnapshot));
 s.positions.push({accountId:"synthetic-broker",ticker:"EXTRA",type:"stock",shares:1,valueCents:1000,priceAsOf:"2026-10-17"});s.accounts[0].securitiesCents+=1000;s.accounts[0].totalCents+=1000;s.reconciliation.totalValueCents+=1000;
 assert.throws(()=>U.buildAssetPayload(s,previous,{html,now,policy:approved,market}),{message:"OPENING_MARKET_SECURITY_REQUIRED"});
});
function eventOpeningFixture(){
 const f=openingFixture(),s=openingSnapshot();
 f.approved.positionAccountIds=["synthetic-broker"];
 s.positions[0].securityId="synthetic-demo-security";
 const previous=U.buildAssetPayload(s,f.previous,{html,now,policy:f.approved,market:f.market});
 return {...f,previous,snapshot:s};
}
function eventOrder(side="buy",sourceId="synthetic-new-buy",date="2026-10-10"){
 return {accountId:"synthetic-broker",securityId:"synthetic-new-security",sourceId,date,ticker:"NEW",side,shares:2,price:30,amountCents:side==="buy"?6000:-6000,feesCents:0};
}
function eventSnapshot(s,row){
 s.tradeUpdates.rows.push(row);
 s.positions=s.positions.filter(p=>p.ticker!=="NEW");
 if(row.side==="buy")s.positions.push({accountId:row.accountId,securityId:row.securityId,ticker:row.ticker,type:"stock",shares:row.shares,valueCents:6000,priceAsOf:"2026-10-17"});
 s.accounts[0].cashCents-=row.amountCents;
 s.accounts[0].securitiesCents=s.positions.reduce((sum,p)=>sum+p.valueCents,0);
 s.accounts[0].totalCents=s.accounts[0].cashCents+s.accounts[0].securitiesCents;
 s.reconciliation.cashCents=s.accounts.reduce((sum,a)=>sum+a.cashCents,0);
 s.reconciliation.totalValueCents=s.accounts.reduce((sum,a)=>sum+a.totalCents,0);
 return s;
}
test("plan-only opening output matches a fully valued payload without needing market prices",()=>{
 const {previous,approved,market}=openingFixture(),s=openingSnapshot(),saved=U.canonical({previous,s,approved});
 const plan=U.buildAssetPayload(s,previous,{html,now,policy:approved,planOnly:true});
 const final=U.buildAssetPayload(s,previous,{html,now,policy:approved,market,planOnly:false});
 assert.deepEqual(plan,final);assert.equal(U.canonical({previous,s,approved}),saved);
 assert.equal(plan.planOnly,undefined);assert.equal(plan.status,undefined);
 assert.deepEqual(plan.historySnapshot,previous.historySnapshot);assert.deepEqual(plan.performance,previous.performance);
 assert.deepEqual(plan.trading.DEMO.orders,previous.trading.DEMO.orders);
});
test("planning open, close and reopen events precedes quotes but final valuation still requires them",()=>{
 const f=eventOpeningFixture(),s=f.snapshot,fullMarket=copy(f.market);
 fullMarket.prices.NEW=[{date:"2026-10-10",close:30},{date:"2026-10-17",close:30}];
 let previous=f.previous;
 const steps=[[eventOrder(),"opened"],[eventOrder("sell","synthetic-new-sale","2026-10-11"),"closed"],[eventOrder("buy","synthetic-new-rebuy","2026-10-12"),"reopened"]];
 for(const [row,kind] of steps){
  eventSnapshot(s,row);
  const before=U.canonical({previous,s}),plan=U.buildAssetPayload(s,previous,{html,now,policy:f.approved,planOnly:true});
  const events=positionEffects(previous,plan);
  assert.equal(events.length,1);assert.equal(events[0].kind,kind);assert.equal(events[0].date,row.date);
  assert.equal(events[0].firstKnownBuyDate,"2026-10-10");assert.equal(U.canonical({previous,s}),before);
  assert.throws(()=>U.buildAssetPayload(s,previous,{html,now,policy:f.approved,market:f.market}),{message:"OPENING_MARKET_SECURITY_REQUIRED"});
  const final=U.buildAssetPayload(s,previous,{html,now,policy:f.approved,market:fullMarket});
  assert.deepEqual(final,plan);assert.deepEqual(positionEffects(previous,final),events);
  assert.deepEqual(final.historySnapshot,previous.historySnapshot);assert.deepEqual(final.income,previous.income);
  previous=final;
 }
 const repeated=U.buildAssetPayload(s,previous,{html,now,policy:f.approved,planOnly:true});
 assert.deepEqual(repeated,previous);assert.deepEqual(positionEffects(previous,repeated),[]);
});
test("planning retains scope, coverage, balances, trade, opening and identity checks",()=>{
 for(const [mutate,code] of [
  [(s)=>{s.coverage.allPagesFetched=false;},"INCOMPLETE_ASSET_COVERAGE"],
  [(s,p)=>{p.accountIds.push("synthetic-missing-account");},"APPROVED_ACCOUNT_SCOPE_MISMATCH"],
  [(s)=>{s.accounts[0].totalCents++;},"ACCOUNT_BALANCE_MISMATCH"],
  [(s)=>{s.tradeUpdates.allPagesFetched=false;},"TRADES_INCOMPLETE_SOURCE"],
  [(s)=>{s.positions[0].shares++;},"OPENING_CURRENT_QUANTITY_MISMATCH"],
  [(s)=>{s.positions[0].securityId="synthetic-replaced-identity";},"POSITION_SECURITY_CHANGED"]
 ]){
  const {previous,approved,snapshot:s}=eventOpeningFixture();mutate(s,approved);
  const saved=U.canonical({previous,s,approved});
  assert.throws(()=>U.buildAssetPayload(s,previous,{html,now,policy:approved,planOnly:true}),{message:code});
  assert.equal(U.canonical({previous,s,approved}),saved);
 }
 const f=openingFixture();f.approved.openingPositionAuthorization.historySha256="0".repeat(64);
 assert.throws(()=>U.buildAssetPayload(openingSnapshot(),f.previous,{html,now,policy:f.approved,planOnly:true}),{message:"OPENING_HISTORY_HASH_MISMATCH"});
});
test("planning only skips the annual market block and not subsequent browser balance checks",()=>{
 const {previous,approved}=openingFixture(),s=openingSnapshot();
 const changed=html.replace("function normalizeData(data) {","function normalizeData(data) {\n      data.holdings.find(h => h.ticker === 'CASH').value += 1;");
 assert.ok(changed!==html);
 assert.throws(()=>U.buildAssetPayload(s,previous,{html:changed,now,policy:approved,planOnly:true}),{message:"BROWSER_BALANCE_MISMATCH"});
});
test("plan-only accepts exact booleans and remains unavailable to preparation or encryption",async()=>{
 const {previous,approved}=openingFixture(),s=openingSnapshot(),password="synthetic-planned-update";
 for(const planOnly of [null,1,"true",{}])assert.throws(()=>U.buildAssetPayload(s,previous,{html,now,policy:approved,planOnly}),{message:"INVALID_PLAN_ONLY_OPTION"});
 const bytes=Buffer.from(JSON.stringify(U.encrypt(previous,password)));s.previousCiphertextSha256=U.hash(bytes);const saved=Buffer.from(bytes);
 const plan=U.buildAssetPayload(s,previous,{html,now,policy:approved,planOnly:true});assert.ok(plan.openingPositionAudit);
 await assert.rejects(()=>U.prepareUpdate({snapshot:s,existingBytes:bytes,password,html,now,policy:approved,planOnly:true,encryptFn(){assert.fail("planning must not encrypt");}}),{message:"PLAN_ONLY_NOT_ALLOWED_FOR_PREPARE"});
 await assert.rejects(()=>U.prepareUpdate({snapshot:s,existingBytes:bytes,password,html,now,policy:approved,encryptFn(){assert.fail("missing final prices must not encrypt");}}),{message:"OPENING_MARKET_REQUIRED"});
 assert.ok(bytes.equals(saved));
});
function separatedReturnFixture(){
 const f=openingFixture(),s=openingSnapshot();
 f.approved.currentSnapshotLedgerSeparation={version:1,authorizationRef:"synthetic-current-holdings-separation"};
 f.previous.userConfirmedCapital={principalCents:112000,scope:"brokerage",effectiveDate:null,source:"user-confirmed",updatePolicy:"explicit-user-only"};
 f.previous.userConfirmedReturnMethod={version:1,method:"principal-minus-buying-power",source:"user-confirmed",sourceMessageId:"synthetic-return-method",
  totalPrincipalCents:112000,providerCashCents:100000,buyingPowerSupplementCents:0,supplementState:"reflected-in-provider-snapshot",
  effectiveBuyingPowerCents:100000,investedPrincipalCents:12000,holdingCostBasisCents:12500,unrealizedGainCents:2500,nonHoldingIncomeCents:500,
  confirmedCdInterestIncludedCents:2500,classification:"user-approved-approximation",incomeDatesInvented:false};
 f.previous.performance.items.unshift({label:"股票 / ETF 浮盈",gain:25,principal:125,currentValue:150,returnPct:20});
 s.positions[0].costBasisCents=12500;
 return {...f,snapshot:s};
}
function sourceQuantityGap(s){
 s.positions[0].shares=6;s.positions[0].valueCents=18000;s.positions[0].costBasisCents=15000;
 s.accounts[0].securitiesCents=18000;s.accounts[0].totalCents=s.accounts[0].cashCents+18000;
 s.reconciliation.totalValueCents=s.accounts.reduce((sum,a)=>sum+a.totalCents,0);
}
test("authorized current holdings and returns remain independent of the fixed real-order annual ledger",()=>{
 const f=separatedReturnFixture(),s=f.snapshot;
 const aligned=U.buildAssetPayload(s,f.previous,{html,now,policy:f.approved,market:f.market});
 sourceQuantityGap(s);const previousBytes=U.canonical(f.previous);
 const next=U.buildAssetPayload(s,f.previous,{html,now,policy:f.approved,market:f.market});
 const h=next.holdings.find(h=>h.ticker==="DEMO");assert.equal(h.shares,6);assert.equal(h.value,180);assert.equal(h.costBasis,150);
 assert.equal(next.performance.totalCurrentValue,180);assert.equal(next.performance.totalPrincipal,120);assert.equal(next.performance.totalGain,60);
 assert.deepEqual(next.userConfirmedCapital,f.previous.userConfirmedCapital);
 assert.deepEqual(next.quantityReconciliation.differences,[{ticker:"DEMO",ledgerShares:5,holdingShares:6}]);
 assert.equal(next.quantityReconciliation.sourceAsOf,null);assert.equal(next.quantityReconciliation.sourceDateStatus,"unknown");
 assert.equal(next.trading.DEMO.openingPosition.shares,2);assert.deepEqual(next.trading.DEMO.orders,f.previous.trading.DEMO.orders);
 assert.deepEqual(next.historySnapshot,f.previous.historySnapshot);assert.deepEqual(next.income,f.previous.income);
 const annual=data=>{const ui=U.browserContract(html);ui.state.raw=data;ui.state.data=ui.normalizeData(data);ui.state.marketPrices=f.market;
  return ui.computeAnnualSummary().years.map(y=>({year:y.year,startValue:y.startValue,endValue:y.endValue,stockPnl:y.stockPnl,income:y.income,pnl:y.pnl}));};
 assert.equal(U.canonical(annual(next)),U.canonical(annual(aligned)));assert.equal(annual(next).at(-1).endValue,150);
 assert.equal(U.canonical(f.previous),previousBytes);
 const unauthorized=copy(f.approved);delete unauthorized.currentSnapshotLedgerSeparation;
 assert.throws(()=>U.buildAssetPayload(s,f.previous,{html,now,policy:unauthorized,market:f.market}),{message:"OPENING_CURRENT_QUANTITY_MISMATCH"});
});
test("separation planning produces the same private audit but final annual prices remain mandatory",()=>{
 const f=separatedReturnFixture();sourceQuantityGap(f.snapshot);
 const plan=U.buildAssetPayload(f.snapshot,f.previous,{html,now,policy:f.approved,planOnly:true});
 const final=U.buildAssetPayload(f.snapshot,f.previous,{html,now,policy:f.approved,market:f.market});
 assert.deepEqual(plan,final);
 assert.throws(()=>U.buildAssetPayload(f.snapshot,f.previous,{html,now,policy:f.approved}),{message:"OPENING_MARKET_REQUIRED"});
 const broken=copy(f.snapshot);broken.accounts[0].totalCents++;
 assert.throws(()=>U.buildAssetPayload(broken,f.previous,{html,now,policy:f.approved,planOnly:true}),{message:"ACCOUNT_BALANCE_MISMATCH"});
});
test("encrypted separation authorization survives roundtrip and repeat retrieval never re-encrypts",async()=>{
 const f=separatedReturnFixture();sourceQuantityGap(f.snapshot);const password="synthetic-separated-ledger";
 const bytes=Buffer.from(JSON.stringify(U.encrypt(f.previous,password)));f.snapshot.previousCiphertextSha256=U.hash(bytes);
 const first=await U.prepareUpdate({snapshot:f.snapshot,existingBytes:bytes,password,html,now,policy:f.approved,market:f.market});
 assert.equal(first.status,"changed");const decoded=U.decrypt(JSON.parse(first.bytes),password);
 assert.equal(decoded.quantityReconciliation.matched,false);assert.equal(decoded.holdings.find(h=>h.ticker==="DEMO").shares,6);
 const dailyPolicy=copy(policy);f.snapshot.previousCiphertextSha256=U.hash(first.bytes);f.snapshot.fetchedAt="2026-10-19T02:00:00Z";
 const next=await U.prepareUpdate({snapshot:f.snapshot,existingBytes:first.bytes,password,html,now:now+86400000,policy:dailyPolicy,market:f.market,
  encryptFn(){assert.fail("unchanged quantities and audit must not encrypt");}});
 assert.equal(next.status,"unchanged");
});
test("late real orders reconcile already-current shares without rolling opening or repeating current gain",()=>{
 const f=separatedReturnFixture();sourceQuantityGap(f.snapshot);
 const previous=U.buildAssetPayload(f.snapshot,f.previous,{html,now,policy:f.approved,market:f.market});
 f.snapshot.tradeUpdates.rows=[{accountId:"synthetic-broker",securityId:"synthetic-demo-security",sourceId:"synthetic-late-real-buy",date:"2026-10-10",
  ticker:"DEMO",side:"buy",shares:1,price:30,amountCents:3000,feesCents:0}];
 const next=U.buildAssetPayload(f.snapshot,previous,{html,now,policy,market:f.market});
 assert.equal(previous.quantityReconciliation.matched,false);assert.equal(next.quantityReconciliation.matched,true);
 assert.deepEqual(next.quantityReconciliation.differences,[]);assert.deepEqual(next.holdings,previous.holdings);
 assert.deepEqual(next.performance,previous.performance);assert.deepEqual(next.trading.DEMO.openingPosition,previous.trading.DEMO.openingPosition);
 assert.deepEqual(next.trading.DEMO.orders.slice(0,-1),previous.trading.DEMO.orders);assert.equal(next.trading.DEMO.orders.length,previous.trading.DEMO.orders.length+1);
 assert.deepEqual(next.historySnapshot,previous.historySnapshot);
 assert.deepEqual(U.buildAssetPayload(f.snapshot,next,{html,now,policy,market:f.market}),next);
});
test("actual asset pipeline defers unproved source changes and emits delayed open, close and reopen once",()=>{
 const f=separatedReturnFixture(),s=f.snapshot;sourceQuantityGap(s);
 f.approved.positionAccountIds=["synthetic-broker"];s.positions[0].securityId="synthetic-demo-security";
 let previous=U.buildAssetPayload(s,f.previous,{html,now,policy:f.approved,market:f.market});
 assert.deepEqual(positionEffects(f.previous,previous),[]);
 s.tradeUpdates.rows.push({accountId:"synthetic-broker",securityId:"synthetic-demo-security",sourceId:"synthetic-baseline-catchup",date:"2026-10-10",
  ticker:"DEMO",side:"buy",shares:1,price:30,amountCents:3000,feesCents:0});
 const baseline=U.buildAssetPayload(s,previous,{html,now,policy:f.approved,market:f.market});
 assert.deepEqual(positionEffects(previous,baseline),[]);assert.equal(baseline.quantityReconciliation.matched,true);previous=baseline;
 const market=copy(f.market);market.prices.NEW=[{date:"2026-10-11",close:30},{date:"2026-10-17",close:30}];
 for(const [row,kind] of [[eventOrder("buy","synthetic-delayed-open","2026-10-11"),"opened"],
  [eventOrder("sell","synthetic-delayed-close","2026-10-12"),"closed"],[eventOrder("buy","synthetic-delayed-reopen","2026-10-13"),"reopened"]]){
  eventSnapshot(s,row);s.tradeUpdates.rows.pop();
  for(const p of s.positions)if(p.ticker==="NEW")p.costBasisCents=5000;
  const observed=U.buildAssetPayload(s,previous,{html,now,policy:f.approved,market});
  assert.deepEqual(positionEffects(previous,observed),[]);assert.equal(observed.quantityReconciliation.matched,false);
  assert.deepEqual(observed.trading,previous.trading);
  s.tradeUpdates.rows.push(row);
  const plan=U.buildAssetPayload(s,observed,{html,now,policy:f.approved,planOnly:true});
  const events=positionEffects(observed,plan);assert.equal(events.length,1);assert.equal(events[0].kind,kind);assert.equal(events[0].date,row.date);
  assert.equal(plan.quantityReconciliation.matched,true);assert.deepEqual(plan.performance,observed.performance);
  assert.throws(()=>U.buildAssetPayload(s,observed,{html,now,policy:f.approved,market:f.market}),{message:"OPENING_MARKET_SECURITY_REQUIRED"});
  const final=U.buildAssetPayload(s,observed,{html,now,policy:f.approved,market});assert.deepEqual(final,plan);
  assert.deepEqual(final.trading.DEMO.openingPosition,baseline.trading.DEMO.openingPosition);
  assert.deepEqual(final.historySnapshot,baseline.historySnapshot);
  const repeated=U.buildAssetPayload(s,final,{html,now,policy:f.approved,market});assert.deepEqual(repeated,final);assert.deepEqual(positionEffects(final,repeated),[]);
  previous=final;
 }
});
function holdingsSnapshot(){
 const s=snapshot();s.schemaVersion=3;
 s.reconciliation={...s.reconciliation,basis:"holdings-and-depository-balances",independentSourceTotals:false};
 for(const a of s.accounts){
  a.valuationBasis=a.type==="brokerage"?"institution-holdings":"account-balance";
  if(a.type==="brokerage"){
   a.reportedBalance={totalCents:1,coverage:{...copy(a.coverage.balances),updatedAt:"2020-01-01T00:00:00Z",sourceDateStatus:"known"}};
   a.coverage.balances.basis="complete_holdings_cash";
   a.coverage.holdings.basis="observed_complete_holdings";
  }
 }
 return s;
}
test("holdings valuation uses component amounts and never promotes a cached account balance or its date",()=>{
 const s=holdingsSnapshot(),data=build(s),expected=build();
 assert.deepEqual(data,expected);
 s.accounts[0].reportedBalance.totalCents=99999999;
 s.accounts[0].reportedBalance.coverage.updatedAt="2026-10-17T00:00:00Z";
 assert.deepEqual(build(s),data);
 assert.equal(data.assetSnapshot.sourceAsOf,null);
 assert.ok(!JSON.stringify(data).includes("reportedBalance"));
});
test("holdings valuation requires its explicit non-independent contract and account basis",()=>{
 for(const change of [
  s=>{s.reconciliation.independentSourceTotals=true;},
  s=>{delete s.reconciliation.basis;},
  s=>{s.reconciliation.basis="account-balances";}
 ]){const s=holdingsSnapshot();change(s);assert.throws(()=>build(s),{message:"INVALID_ASSET_RECONCILIATION_BASIS"});}
 for(const change of [
  s=>{delete s.accounts[0].valuationBasis;},
  s=>{s.accounts[1].valuationBasis="institution-holdings";},
  s=>{s.accounts[0].coverage.balances.basis="observed_account_coverage";},
  s=>{delete s.accounts[0].coverage.holdings.basis;}
 ]){const s=holdingsSnapshot();change(s);assert.throws(()=>build(s),{message:"INVALID_ASSET_VALUATION_BASIS"});}
 const legacy=snapshot();legacy.reconciliation.independentSourceTotals=false;
 assert.throws(()=>build(legacy),{message:"INDEPENDENT_RECONCILIATION_REQUIRED"});
});
test("holdings valuation cannot borrow account or price timestamps for a complete snapshot",()=>{
 for(const name of ["balances","holdings"]){
  const s=holdingsSnapshot();s.accounts[0].coverage[name].updatedAt=s.fetchedAt;s.accounts[0].coverage[name].sourceDateStatus="known";
  assert.throws(()=>build(s),{message:"INVALID_HOLDINGS_SNAPSHOT_DATE"});
 }
 const bank=holdingsSnapshot();bank.accounts[1].coverage.balances.updatedAt="2020-01-01T00:00:00Z";bank.accounts[1].coverage.balances.sourceDateStatus="known";
 assert.throws(()=>build(bank),{message:"STALE_OR_FUTURE_SOURCE"});
});
test("holdings valuation still rejects broken arithmetic, partial coverage and mismatched scope",()=>{
 for(const [change,code] of [
  [s=>{s.accounts[0].totalCents++;},"ACCOUNT_BALANCE_MISMATCH"],
  [s=>{s.positions[0].valueCents++;},"SECURITIES_BALANCE_MISMATCH"],
  [s=>{s.reconciliation.cashCents++;},"SOURCE_TOTALS_MISMATCH"],
  [s=>{s.accounts[0].coverage.holdings.allPagesFetched=false;},"INCOMPLETE_ASSET_DATASET"],
  [s=>{s.coverage.accountIds.pop();},"ACCOUNT_COVERAGE_MISMATCH"]
 ]){const s=holdingsSnapshot();change(s);assert.throws(()=>build(s),{message:code});}
});
test("changing only diagnostic account balances never re-encrypts holdings data",async()=>{
 const s=holdingsSnapshot(),data=build(s),password="synthetic-holdings-only";
 const bytes=Buffer.from(JSON.stringify(U.encrypt(data,password)));
 s.previousCiphertextSha256=U.hash(bytes);s.accounts[0].reportedBalance.totalCents=7654321;
 const result=await U.prepareUpdate({snapshot:s,existingBytes:bytes,password,html,now,policy,encryptFn(){assert.fail("diagnostic-only change must not encrypt");}});
 assert.equal(result.status,"unchanged");
});
test("reconciled assets update independently while old history stays exact",()=>{
 const old=oldData(),data=build();
 assert.equal(data.holdings.reduce((n,h)=>n+h.value,0),1650);
 for(const key of ["performance","trading","income"])assert.deepEqual(data[key],old[key]);
 assert.equal(data.asOf,snapshot().fetchedAt.slice(0,10));assert.equal(data.historySnapshot.asOf,old.asOf);
 assert.deepEqual(data.historySnapshot.performance,old.performance);
 assert.equal(data.historyStatus.asOf,old.asOf);assert.equal(data.historyStatus.state,"preserved");
});
test("nine raw asset rows render as eight securities plus separate reconciled cash",()=>{
 const s=snapshot();
 s.positions=Array.from({length:8},(_,i)=>({accountId:"synthetic-broker",ticker:`DEMO${String.fromCharCode(65+i)}`,type:i%2?"etf":"stock",shares:1,valueCents:10000+i*100,priceAsOf:"2026-10-17"}));
 s.accounts[0].securitiesCents=s.positions.reduce((n,p)=>n+p.valueCents,0);
 s.accounts[0].totalCents=s.accounts[0].cashCents+s.accounts[0].securitiesCents;
 s.reconciliation.totalValueCents=s.accounts.reduce((n,a)=>n+a.totalCents,0);
 const data=build(s),ui=U.browserContract(html),normalized=ui.normalizeData(data);
 assert.equal(data.holdings.length,9);assert.equal(data.holdings.filter(h=>h.type==="cash").length,1);
 assert.equal(normalized.holdings.length,8);assert.ok(normalized.holdings.every(h=>!ui.isCashHolding(h)));
 assert.equal(normalized.equityValue*100,s.accounts[0].securitiesCents);
 assert.equal(normalized.cashValue*100,s.reconciliation.cashCents);
 assert.equal(normalized.totalAssetValue*100,s.reconciliation.totalValueCents);
 assert.equal(normalized.totalAssetValue,normalized.equityValue+normalized.cashValue);
 assert.ok(Math.abs(normalized.holdings.reduce((n,h)=>n+h.weight,0)-100)<1e-9);
 assert.equal(data.holdings.find(h=>h.type==="cash").value,normalized.cashValue);
});
test("eight saved security names survive consecutive asset updates without mutating inputs",()=>{
 const s=snapshot(),old=oldData();
 s.positions=Array.from({length:8},(_,i)=>({accountId:"synthetic-broker",ticker:`DEMO${String.fromCharCode(65+i)}`,type:i%2?"etf":"stock",shares:1,valueCents:10000+i*100,nameZh:"Provider alias",name:"Institution alias"}));
 s.accounts[0].securitiesCents=s.positions.reduce((n,p)=>n+p.valueCents,0);
 s.accounts[0].totalCents=s.accounts[0].cashCents+s.accounts[0].securitiesCents;
 s.reconciliation.totalValueCents=s.accounts.reduce((n,a)=>n+a.totalCents,0);
 old.holdings=[old.holdings[0],...s.positions.map((p,i)=>({ticker:p.ticker,type:p.type,value:1,nameZh:`合成证券${i+1}`}))];
 const beforeOld=copy(old),beforeSource=copy(s),first=build(s,old),second=build(s,first);
 for(const data of [first,second])for(const p of s.positions){
  const row=data.holdings.find(h=>h.ticker===p.ticker);
  assert.equal(row.nameZh,old.holdings.find(h=>h.ticker===p.ticker).nameZh);
  assert.equal(row.type,p.type);assert.equal(row.shares,p.shares);assert.equal(row.value,p.valueCents/100);
 }
 assert.deepEqual(old,beforeOld);assert.deepEqual(s,beforeSource);
 assert.deepEqual(second,first);assert.deepEqual(first.trading,old.trading);
});
test("asset names prefer current metadata then recover ticker placeholders from saved history",()=>{
 for(const [currentHolding,currentTrading,historyHolding,historyTrading,expected] of [
  [" 当前名称 ","交易名称","历史持仓","历史交易"," 当前名称 "],
  [" demo ","交易名称","历史持仓","历史交易","交易名称"],
  ["DEMO"," demo ","历史持仓","历史交易","历史持仓"],
  ["DEMO","DEMO","DEMO","历史交易","历史交易"],
  [" ",null,42,"demo","DEMO"]
 ]){
  const old=oldData();old.holdings[1].nameZh=currentHolding;old.trading.DEMO.nameZh=currentTrading;
  old.historyStatus={state:"preserved",asOf:old.asOf,reason:"incomplete_history"};
  old.historySnapshot={holdings:[{ticker:" demo ",type:"stock",nameZh:historyHolding}],trading:[{ticker:"demo",nameZh:historyTrading}]};
  const before=copy(old),first=build(snapshot(),old),second=build(snapshot(),first);
  assert.equal(first.holdings[1].nameZh,expected);assert.equal(second.holdings[1].nameZh,expected);
  assert.deepEqual(old,before);assert.deepEqual(first.historySnapshot,old.historySnapshot);assert.deepEqual(first.trading,old.trading);
 }
});
test("cash metadata cannot lend its name to a real USD security",()=>{
 for(const cash of [{type:"cash"},{type:"etf",is_cash_equivalent:true},{type:"etf",isCashEquivalent:true}]){
  const s=snapshot(),old=oldData();s.positions[0].ticker="USD";s.positions[0].type="etf";
  old.holdings=[{ticker:"USD",nameZh:"现金账户",value:100,...cash}];old.trading={USD:{nameZh:"现金交易"}};
  old.historyStatus={state:"preserved",asOf:old.asOf,reason:"incomplete_history"};
  old.historySnapshot={holdings:[{ticker:"USD",type:"etf",nameZh:"合成美元基金"}]};
  assert.equal(build(s,old).holdings[1].nameZh,"合成美元基金");
  delete old.historySnapshot;assert.equal(build(s,old).holdings[1].nameZh,"USD");
 }
});
test("first asset freeze records unreviewed history without asserting missing history",()=>{
 const old=oldData();old.historyStatus={state:"verified",coverage:{transactions:"complete"},evidence:"synthetic-review"};
 const before=copy(old),data=build(snapshot(),old);
 assert.equal(data.historyStatus.state,"preserved");assert.equal(data.historyStatus.reason,"history_not_revalidated");
 assert.deepEqual(data.historyStatus.coverage,old.historyStatus.coverage);assert.equal(data.historyStatus.evidence,"synthetic-review");
 assert.deepEqual(old,before);
});
test("asset refresh retains existing history reasons and coverage evidence",()=>{
 for(const reason of ["incomplete_history","history_not_revalidated"]){
  const first=build();first.historyStatus={...first.historyStatus,reason,coverage:{transactions:"partial",income:"unknown"},evidence:"synthetic-review"};
  const before=copy(first),next=build(snapshot(),first);
  assert.deepEqual(next.historyStatus,first.historyStatus);assert.deepEqual(next.historySnapshot,first.historySnapshot);
  assert.deepEqual(first,before);
 }
});
test("first asset freeze cannot upgrade an explicitly incomplete history status",()=>{
 const old=oldData();old.historyStatus={state:"incomplete",reason:"incomplete_history",coverage:{transactions:"partial"}};
 const before=copy(old),data=build(snapshot(),old),ui=U.browserContract(html);
 assert.deepEqual(data.historyStatus,{...old.historyStatus,state:"preserved",asOf:old.asOf});
 assert.deepEqual(old,before);
 ui.state.raw=data;ui.state.data=ui.normalizeData(data);
 assert.equal(ui.computeAnnualSummary().annualUnavailable,undefined);
 assert.ok(ui.computeAnnualSummary().years.length>0);
});
test("unknown balance date remains null and is distinct from retrieval",()=>{
 const data=build();assert.deepEqual(data.assetSnapshot,{retrievedAt:"2026-10-18T02:00:00Z",asOfBasis:"snapshot-calculation-date",sourceAsOf:null,sourceDateStatus:"unknown"});
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
 assert.ok(ui.computeAnnualSummary().years.length>0);
});
test("repeated asset updates keep the original historical snapshot",()=>{
 const first=build();const s=snapshot();s.positions[0].valueCents+=100;s.accounts[0].securitiesCents+=100;s.accounts[0].totalCents+=100;s.reconciliation.totalValueCents+=100;
 const second=build(s,first);assert.deepEqual(second.historySnapshot,first.historySnapshot);assert.equal(second.historyStatus.asOf,"2026-10-09");
});
test("retrieval-only changes across UTC days do not re-encrypt an unchanged snapshot",async()=>{
 const data=build(), password="synthetic-only";
 const existingBytes=Buffer.from(JSON.stringify(U.encrypt(data,password)));
 const s=snapshot();s.fetchedAt="2026-10-19T02:30:00Z";s.previousCiphertextSha256=U.hash(existingBytes);s.accounts.reverse();
 const next=U.buildAssetPayload(s,data,{html,now:now+86400000,policy});
 assert.equal(next.asOf,"2026-10-19");assert.deepEqual(next.historySnapshot,data.historySnapshot);
 const result=await U.prepareUpdate({snapshot:s,existingBytes,password,html,now:now+86400000,policy,encryptFn:()=>{throw Error("must not encrypt");}});
 assert.equal(result.status,"unchanged");assert.equal(result.bytes,undefined);
});
test("changed assets advance computation date while historical and income dates stay exact",async()=>{
 const old=oldData();old.income=[{date:"2025-06-30",amount:2,kind:"cash_interest"}];
 const first=build(snapshot(),old),password="synthetic-only";
 const existingBytes=Buffer.from(JSON.stringify(U.encrypt(first,password))),s=snapshot();
 s.fetchedAt="2026-10-19T02:00:00Z";s.previousCiphertextSha256=U.hash(existingBytes);
 s.positions[0].valueCents+=100;s.accounts[0].securitiesCents+=100;s.accounts[0].totalCents+=100;s.reconciliation.totalValueCents+=100;
 const result=await U.prepareUpdate({snapshot:s,existingBytes,password,html,now:now+86400000,policy});
 assert.equal(result.status,"changed");const next=U.decrypt(JSON.parse(result.bytes),password);
 assert.equal(next.asOf,"2026-10-19");assert.deepEqual(next.historySnapshot,first.historySnapshot);
 assert.deepEqual(next.income,old.income);assert.equal(next.historySnapshot.asOf,old.asOf);
 assert.equal(next.assetSnapshot.sourceAsOf,null);assert.equal(next.assetSnapshot.sourceDateStatus,"unknown");
 assert.equal(next.assetSnapshot.asOfBasis,"snapshot-calculation-date");
});
test("calculation-date semantics migrate once even when asset amounts are unchanged",async()=>{
 const previous=build(),password="synthetic-only";previous.asOf=previous.historySnapshot.asOf;
 delete previous.assetSnapshot.asOfBasis;
 const existingBytes=Buffer.from(JSON.stringify(U.encrypt(previous,password))),s=snapshot();s.previousCiphertextSha256=U.hash(existingBytes);
 const changed=await U.prepareUpdate({snapshot:s,existingBytes,password,html,now,policy});
 assert.equal(changed.status,"changed");const migrated=U.decrypt(JSON.parse(changed.bytes),password);
 assert.equal(migrated.asOf,"2026-10-18");assert.equal(migrated.assetSnapshot.asOfBasis,"snapshot-calculation-date");
 assert.deepEqual(migrated.historySnapshot,previous.historySnapshot);
 s.previousCiphertextSha256=U.hash(changed.bytes);
 const unchanged=await U.prepareUpdate({snapshot:s,existingBytes:changed.bytes,password,html,now,policy,
  encryptFn:()=>{throw Error("migration must not repeat");}});
 assert.equal(unchanged.status,"unchanged");
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
