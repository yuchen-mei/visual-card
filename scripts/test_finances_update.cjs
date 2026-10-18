#!/usr/bin/env node
"use strict";
// Entirely invented accounts and transactions; no real financial files are read.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const {test} = require("node:test");
const U = require("./update_finances.cjs");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const now = Date.parse("2026-10-18T03:00:00Z");
const password = "synthetic-test-password-only";
const policy = {historicalCashInterestCents:4215,accountIds:["demo-broker","demo-check","demo-save"]};
const copy = x => JSON.parse(JSON.stringify(x));
function fixture(historicalCents = 4215) {
  const stamp = "2026-10-18T02:00:00Z";
  const coverage = Object.fromEntries(["balances", "holdings", "transactions", "interest"].map(k => [k, {complete: true, allPagesFetched: true, fromInception: true, updatedAt: stamp}]));
  const accounts = [
    {id:"demo-broker",type:"brokerage",currency:"USD",cashCents:167000,securitiesCents:72000,totalCents:239000,coverage:copy(coverage)},
    {id:"demo-check",type:"checking",currency:"USD",cashCents:30000,securitiesCents:0,totalCents:30000,coverage:copy(coverage)},
    {id:"demo-save",type:"savings",currency:"USD",cashCents:historicalCents+10100,securitiesCents:0,totalCents:historicalCents+10100,coverage:copy(coverage)}
  ];
  let sequence = 0;
  const tx = (accountId, id, date, kind, amountCents, extra={}) => ({accountId,id,date,kind,amountCents,status:"posted",sequence:sequence++,...extra});
  const transactions = [
    tx("demo-broker","deposit","2025-01-02","external_in",200000),
    tx("demo-broker","buy","2025-01-03","buy",-50000,{ticker:"DEMO",shares:10}),
    tx("demo-check","deposit","2025-01-02","external_in",40000),
    tx("demo-save","deposit","2025-01-02","external_in",10000),
    tx("demo-save","legacy-interest","2025-06-30","cash_interest",historicalCents),
    tx("demo-broker","interest","2026-08-31","cash_interest",1000),
    tx("demo-broker","dividend","2026-09-01","dividend",2000),
    tx("demo-broker","sale","2026-09-02","sell",24000,{ticker:"DEMO",shares:4,disposedCostBasisCents:20000}),
    tx("demo-broker","withdrawal","2026-09-03","external_out",-20000),
    tx("demo-check","move-out","2026-10-01","transfer_out",-10000,{transferId:"demo-transfer"}),
    tx("demo-broker","move-in","2026-10-01","transfer_in",10000,{transferId:"demo-transfer"}),
    tx("demo-save","interest","2026-09-30","cash_interest",100)
  ];
  return {
    schemaVersion:1,source:"Finances",currency:"USD",asOf:"2026-10-17",fetchedAt:stamp,
    coverage:{accountsComplete:true,allPagesFetched:true,historyFromInception:true,accountIds:accounts.map(a=>a.id)},accounts,
    positions:[{accountId:"demo-broker",ticker:"DEMO",type:"stock",shares:6,valueCents:72000,costBasisCents:30000}],transactions,
    historicalCashInterest:{amountCents:historicalCents,transactionKeys:["demo-save:legacy-interest"]},
    migration:{historicalPerformanceItemIndexes:[0]},
    prices:{DEMO:[{date:"2025-01-03",close:50},{date:"2025-12-31",close:80},{date:"2026-10-16",close:120}]},
    reconciliation:{independentSourceTotals:true,totalValueCents:279100+historicalCents,cashCents:207100+historicalCents,principalCents:230000,totalGainCents:49100+historicalCents,realizedGainCents:4000,cashInterestCents:1100+historicalCents,dividendCents:2000,
      annual:[{year:2025,stockPnlCents:30000,incomeCents:historicalCents,pnlCents:30000+historicalCents},{year:2026,stockPnlCents:16000,incomeCents:3100,pnlCents:19100}]}
  };
}
function legacy(amount = 4215) { return {asOf:"2025-06-30",performance:{items:[{label:"CD interest",kind:"cash_interest",gain:amount/100}]}}; }
function build(f = fixture(), old = legacy(), market) { return U.buildPayload(f, old, {html,now,market,policy}); }
function rejectsMutation(name, mutate, code) { test(name, () => {const f=fixture();mutate(f);assert.throws(()=>build(f),{message:code});}); }
test("balances, realized and cumulative gains reconcile independently", () => {
  const data=build();
  assert.equal(data.holdings.length,2);
  assert.equal(data.holdings[0].value,2113.15);
  assert.equal(data.performance.totalCurrentValue,2833.15);
  assert.equal(data.performance.totalPrincipal,2300);
  assert.equal(data.performance.totalGain,533.15);
  assert.equal(data.performance.items.find(i=>i.kind==="cash_interest").gain,53.15);
});
test("internal transfers never become income or trades; sources stay out of display", () => {
  const data=build();
  assert.equal(data.income.length,4);
  assert.equal(data.trading.DEMO.orders.length,2);
  const visible=copy(data);delete visible.updateAudit;
  assert.doesNotMatch(JSON.stringify(visible),/demo-broker|demo-check|demo-save|CD|Checking|Savings|Robinhood/);
  assert.deepEqual(data.holdings[0],{ticker:"CASH",nameZh:"现金",type:"cash",value:2113.15});
});
test("historical interest is included once and remains idempotent", () => {
  const first=build();const next=build(fixture(),first);
  assert.equal(U.canonical(first),U.canonical(next));
  assert.equal(first.income.filter(i=>i.amount===42.15).length,1);
  assert.equal(first.updateAudit.historicalCashInterest.amountCents,4215);
});
test("full updates preserve approved names in holdings and trading across repeated updates",()=>{
  const old=legacy(),f=fixture();
  old.holdings=[{ticker:" demo ",type:"stock",nameZh:" 原有合成证券 "}];
  old.trading={DEMO:{nameZh:"旧交易别名"}};
  f.positions[0].nameZh="Provider security alias";f.transactions[1].nameZh="Institution alias";
  const beforeOld=copy(old),beforeSource=copy(f),first=build(f,old),second=build(f,first),baseline=build();
  for(const data of [first,second]){
    assert.equal(data.holdings[1].nameZh," 原有合成证券 ");assert.equal(data.trading.DEMO.nameZh," 原有合成证券 ");
    assert.deepEqual(data.performance,baseline.performance);assert.deepEqual(data.trading.DEMO.orders,baseline.trading.DEMO.orders);
    assert.deepEqual(data.trading.DEMO.prices,baseline.trading.DEMO.prices);
    assert.deepEqual({...data.holdings[1],nameZh:"DEMO"},baseline.holdings[1]);
  }
  assert.deepEqual(old,beforeOld);assert.deepEqual(f,beforeSource);assert.deepEqual(second,first);
});
test("full holdings and trading share current-to-history name recovery and ticker fallback",()=>{
  for(const [currentTrading,historyHolding,historyTrading,expected] of [
    ["交易名称","历史持仓","历史交易","交易名称"],
    [" demo ","历史持仓","历史交易","历史持仓"],
    ["DEMO","DEMO","历史交易","历史交易"],
    [null," ",42,"DEMO"]
  ]){
    const old=legacy();old.holdings=[{ticker:"DEMO",type:"stock",nameZh:"DEMO"}];
    old.trading=[{ticker:"demo",nameZh:currentTrading}];
    old.historySnapshot={holdings:[{ticker:"demo",type:"stock",nameZh:historyHolding}],trading:{DEMO:{nameZh:historyTrading}}};
    const before=copy(old),data=build(fixture(),old);
    assert.equal(data.holdings[1].nameZh,expected);assert.equal(data.trading.DEMO.nameZh,expected);
    assert.deepEqual(old,before);
  }
});
test("full update ignores cash names and source aliases for a real USD security",()=>{
  const f=fixture(),old=legacy();f.positions[0].ticker="USD";f.positions[0].type="etf";f.positions[0].nameZh="Provider alias";
  f.transactions.forEach(t=>{if(t.ticker)t.ticker="USD";});f.prices.USD=f.prices.DEMO;delete f.prices.DEMO;
  old.holdings=[{ticker:"USD",type:"cash",nameZh:"现金账户"}];old.trading={USD:{nameZh:"现金交易"}};
  old.historySnapshot={holdings:[{ticker:"USD",type:"etf",nameZh:"合成美元基金"}]};
  const data=build(f,old);assert.equal(data.holdings[1].nameZh,"合成美元基金");assert.equal(data.trading.USD.nameZh,"合成美元基金");
  delete old.historySnapshot;const unknown=build(f,old);assert.equal(unknown.holdings[1].nameZh,"USD");assert.equal(unknown.trading.USD.nameZh,"USD");
});
test("actual frontend annual totals, with and without matching public prices", () => {
  const data=build(), ui=U.browserContract(html);
  ui.state.raw=data;ui.state.data=ui.normalizeData(data);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.computeAnnualSummary().years.map(y=>[y.year,y.stockPnl,y.income,y.pnl]))),[[2025,300,42.15,342.15],[2026,160,31,191]]);
  assert.equal(U.canonical(build(fixture(),legacy(),{prices:fixture().prices})),U.canonical(data));
});
rejectsMutation("null balance source timestamp fails closed",f=>f.accounts[0].coverage.balances.updatedAt=null,"MISSING_SOURCE_TIMESTAMP");
rejectsMutation("unknown history is not silently zero interest",f=>f.accounts[2].coverage.interest.complete=false,"INCOMPLETE_ACCOUNT_DATASET");
rejectsMutation("truncated transaction pages fail closed",f=>f.coverage.allPagesFetched=false,"INCOMPLETE_SOURCE_COVERAGE");
rejectsMutation("duplicate income transaction rejected",f=>f.transactions.push(copy(f.transactions[4])),"DUPLICATE_TRANSACTION");
rejectsMutation("duplicate historical mapping rejected",f=>f.historicalCashInterest.transactionKeys.push(f.historicalCashInterest.transactionKeys[0]),"DUPLICATE_HISTORICAL_REFERENCE");
rejectsMutation("undated historical interest rejected",f=>f.transactions[4].date=null,"INVALID_DATE");
rejectsMutation("future cash income rejected",f=>f.transactions[4].date="2027-01-01","INVALID_TRANSACTION_DATE_OR_ORDER");
rejectsMutation("unpaired internal transfer rejected",f=>f.transactions=f.transactions.filter(t=>t.id!=="move-in"),"UNPAIRED_INTERNAL_TRANSFER");
rejectsMutation("incorrect cash balance rejected",f=>{f.accounts[0].cashCents++;f.accounts[0].totalCents++;},"CASH_LEDGER_MISMATCH");
rejectsMutation("incorrect position quantity rejected",f=>f.positions[0].shares++,"POSITION_QUANTITY_MISMATCH");
rejectsMutation("independent cumulative discrepancy rejected",f=>f.reconciliation.totalGainCents++,"SOURCE_TOTALS_MISMATCH");
rejectsMutation("independent annual discrepancy rejected",f=>f.reconciliation.annual[0].pnlCents++,"ANNUAL_RECONCILIATION_MISMATCH");
rejectsMutation("missing historical year-end mark rejected",f=>f.prices.DEMO.splice(1,1),"MISSING_YEAR_END_OR_LATEST_PRICE");
rejectsMutation("missing real orders rejected rather than synthesizing previews",f=>f.transactions=f.transactions.filter(t=>t.kind!=="buy"),"INCOMPLETE_POSITION_HISTORY");
rejectsMutation("unsupported corporate action rejected",f=>f.transactions[1].kind="split","UNSUPPORTED_TRANSACTION");
rejectsMutation("stale source rejected",f=>f.accounts[0].coverage.balances.updatedAt="2026-10-01T00:00:00Z","STALE_OR_FUTURE_SOURCE");
test("public prices cannot silently change reconciled annual returns",()=>{
  const prices=copy(fixture().prices);prices.DEMO[1].close=90;
  assert.throws(()=>build(fixture(),legacy(),{prices}),{message:"PUBLIC_MARK_MISMATCH"});
});
test("historical record correction or removal requires explicit review",()=>{
  const old=build();old.updateAudit.transactions[0].digest="altered";
  assert.throws(()=>build(fixture(),old),{message:"HISTORY_REMOVED_OR_CORRECTED_REQUIRES_REVIEW"});
});
test("roundtrip works with existing browser WebCrypto and rejects wrong password/tampering",async()=>{
  const data=build();const encrypted=U.encrypt(data,password);
  assert.equal(U.canonical(U.decrypt(encrypted,password)),U.canonical(data));
  assert.equal(U.canonical(await U.browserContract(html).decryptPayload(encrypted,password)),U.canonical(data));
  assert.throws(()=>U.decrypt(encrypted,"incorrect"),{message:"DECRYPTION_FAILED"});
  const bad=copy(encrypted),bytes=Buffer.from(bad.ciphertext,"base64");bytes[0]^=1;bad.ciphertext=bytes.toString("base64");
  assert.throws(()=>U.decrypt(bad,password),{message:"DECRYPTION_FAILED"});
});
test("unchanged financial content does not call encryption, even on a new run date",async()=>{
  const previous=build();previous.asOf="2026-10-16";
  const existingBytes=Buffer.from(JSON.stringify(U.encrypt(previous,password)));
  const snapshot=fixture();snapshot.previousCiphertextSha256=U.hash(existingBytes);
  snapshot.accounts.reverse();snapshot.positions.reverse();snapshot.transactions.reverse();
  const result=await U.prepareUpdate({snapshot,existingBytes,password,html,now,policy,encryptFn:()=>{throw Error("must not encrypt");}});
  assert.equal(result.status,"unchanged");assert.equal(result.bytes,undefined);
});
test("changed update encrypts and is browser-readable before any write",async()=>{
  const existingBytes=Buffer.from(JSON.stringify(U.encrypt(legacy(),password)));
  const snapshot=fixture();snapshot.previousCiphertextSha256=U.hash(existingBytes);
  const result=await U.prepareUpdate({snapshot,existingBytes,password,html,now,policy});
  assert.equal(result.status,"changed");
  assert.equal(U.decrypt(JSON.parse(result.bytes),password).performance.totalGain,533.15);
});
test("baseline race fails before encryption or write",async()=>{
  const snapshot=fixture();snapshot.previousCiphertextSha256="wrong";
  await assert.rejects(U.prepareUpdate({snapshot,existingBytes:Buffer.from("old"),password,html,now}),{message:"BASELINE_CHANGED"});
});
test("atomic write preserves old bytes on concurrent baseline change",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"visual-card-test-")),file=path.join(dir,"data.enc.json");
  try {fs.writeFileSync(file,"newer");assert.throws(()=>U.writeAtomically(file,Buffer.from("old"),Buffer.from("candidate")),{message:"BASELINE_CHANGED_DURING_RUN"});assert.equal(fs.readFileSync(file,"utf8"),"newer");assert.deepEqual(fs.readdirSync(dir),["data.enc.json"]);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test("private input requires restrictive permissions and location outside repository",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"visual-card-test-")),file=path.join(dir,"input.json");
  try{fs.writeFileSync(file,"{}",{mode:0o644});assert.throws(()=>U.readPrivateInput(file,path.resolve(__dirname,"..")),{message:"PRIVATE_INPUT_PERMISSIONS_REQUIRED"});fs.chmodSync(file,0o600);assert.deepEqual(U.readPrivateInput(file,path.resolve(__dirname,"..")),{});assert.throws(()=>U.readPrivateInput(file,dir),{message:"PRIVATE_INPUT_MUST_BE_OUTSIDE_REPOSITORY"});}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test("CLI errors do not echo unknown private input or secret values",()=>{
  const r=spawnSync(process.execPath,[path.join(__dirname,"update_finances.cjs"),"--private-secret-marker"],{encoding:"utf8",env:{...process.env,VISUAL_CARD_PASSWORD_FD:""}});
  assert.equal(r.status,1);assert.equal(r.stdout,"");assert.doesNotMatch(r.stderr,/private-secret-marker/);assert.match(r.stderr,/INVALID_ARGUMENTS/);
});
test("private reviewed historical amount and account scope are mandatory",()=>{
  assert.throws(()=>U.buildPayload(fixture(),legacy(),{html,now,policy:{...policy,historicalCashInterestCents:5000}}),{message:"APPROVED_HISTORICAL_INTEREST_MISMATCH"});
  assert.throws(()=>U.buildPayload(fixture(),legacy(),{html,now,policy:{...policy,accountIds:[...policy.accountIds,"missing-account"]}}),{message:"APPROVED_ACCOUNT_SCOPE_MISMATCH"});
});
test("snapshot date cannot regress or public prices run ahead of the snapshot",()=>{
  const old=legacy();old.asOf="2026-10-18";
  assert.throws(()=>build(fixture(),old),{message:"SNAPSHOT_DATE_REGRESSION"});
  const prices=copy(fixture().prices);prices.DEMO.push({date:"2026-10-18",close:120});
  assert.throws(()=>build(fixture(),legacy(),{prices}),{message:"INVALID_PUBLIC_PRICE"});
});
test("same-day trades across accounts have stable ordering",()=>{
  const f=fixture(), extra=copy(f.accounts[0]);extra.id="demo-broker-2";extra.cashCents=50000;extra.securitiesCents=120000;extra.totalCents=170000;
  f.accounts.push(extra);f.coverage.accountIds.push(extra.id);f.positions.push({accountId:extra.id,ticker:"DEMO",type:"stock",shares:10,valueCents:120000,costBasisCents:50000});
  f.transactions.push({id:"deposit",accountId:extra.id,date:"2025-01-02",sequence:0,kind:"external_in",amountCents:100000,status:"posted"},{id:"buy",accountId:extra.id,date:"2025-01-03",sequence:1,kind:"buy",amountCents:-50000,shares:10,ticker:"DEMO",status:"posted"});
  f.reconciliation.totalValueCents+=170000;f.reconciliation.cashCents+=50000;f.reconciliation.principalCents+=100000;f.reconciliation.totalGainCents+=70000;
  f.reconciliation.annual[0].stockPnlCents+=30000;f.reconciliation.annual[0].pnlCents+=30000;f.reconciliation.annual[1].stockPnlCents+=40000;f.reconciliation.annual[1].pnlCents+=40000;
  const opts={html,now,policy:{...policy,accountIds:[...policy.accountIds,extra.id]}};
  const first=U.buildPayload(f,legacy(),opts);f.transactions.reverse();
  assert.equal(U.canonical(U.buildPayload(f,legacy(),opts)),U.canonical(first));
});
test("CLI synthetic dry-run/write/no-op/failure preserves encrypted bytes correctly",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"visual-card-cli-"));
  const repo=path.join(dir,"repo"),input=path.join(dir,"snapshot.private.json"),policyFile=path.join(dir,"policy.private.json"),secret=path.join(dir,"password");
  fs.mkdirSync(path.join(repo,"scripts"),{recursive:true});
  fs.copyFileSync(path.join(__dirname,"update_finances.cjs"),path.join(repo,"scripts","update_finances.cjs"));
  fs.copyFileSync(path.join(__dirname,"finances_trades.cjs"),path.join(repo,"scripts","finances_trades.cjs"));
  fs.copyFileSync(path.join(__dirname,"finances_positions.cjs"),path.join(repo,"scripts","finances_positions.cjs"));
  fs.writeFileSync(path.join(repo,"index.html"),html);
  fs.writeFileSync(path.join(repo,"market.prices.json"),JSON.stringify({prices:fixture().prices}));
  fs.writeFileSync(path.join(dir,"clock.cjs"),`Date.now = () => ${now};`);
  fs.writeFileSync(policyFile,JSON.stringify(policy),{mode:0o600});
  fs.writeFileSync(secret,password,{mode:0o600});
  const target=path.join(repo,"data.enc.json");
  const original=Buffer.from(JSON.stringify(U.encrypt(legacy(),password)));
  fs.writeFileSync(target,original);
  const f=fixture();
  const saveInput=()=>{f.previousCiphertextSha256=U.hash(fs.readFileSync(target));fs.writeFileSync(input,JSON.stringify(f),{mode:0o600});};
  function run(write=false,inspect=false){
    const fd=fs.openSync(secret,"r");
    try{
      const stdio=["ignore","pipe","pipe"];while(stdio.length<=fd)stdio.push("ignore");stdio[fd]=fd;
      const args=inspect?["--inspect"]:["--input",input,"--policy",policyFile,...(write?["--write"]:[])];
      return spawnSync(process.execPath,["--require",path.join(dir,"clock.cjs"),path.join(repo,"scripts","update_finances.cjs"),...args],{encoding:"utf8",stdio,env:{...process.env,VISUAL_CARD_PASSWORD_FD:String(fd)}});
    }finally{fs.closeSync(fd);}
  }
  try{
    saveInput();const dry=run();assert.equal(dry.status,0,dry.stderr);assert.equal(JSON.parse(dry.stdout).status,"validated");assert.ok(fs.readFileSync(target).equals(original));
    const inspection=run(false,true);assert.equal(inspection.status,0,inspection.stderr);assert.equal(JSON.parse(inspection.stdout).decrypted,true);assert.doesNotMatch(inspection.stdout,/42\.15|demo-|synthetic-test-password|CD interest/);assert.ok(fs.readFileSync(target).equals(original));
    const write=run(true);assert.equal(write.status,0,write.stderr);assert.equal(JSON.parse(write.stdout).encryptedSha256,U.hash(fs.readFileSync(target)));
    const changed=fs.readFileSync(target),mtime=fs.statSync(target).mtimeMs;
    saveInput();const noOp=run(true);assert.equal(noOp.status,0,noOp.stderr);assert.equal(noOp.stdout,"");assert.equal(noOp.stderr,"");assert.equal(fs.statSync(target).mtimeMs,mtime);assert.ok(fs.readFileSync(target).equals(changed));
    f.accounts[0].coverage.balances.updatedAt=null;saveInput();const failure=run(true);assert.equal(failure.status,1);assert.match(failure.stderr,/MISSING_SOURCE_TIMESTAMP/);assert.ok(fs.readFileSync(target).equals(changed));assert.doesNotMatch(failure.stderr,/demo-broker|synthetic-test-password/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
module.exports={fixture,legacy,html,now,policy};
