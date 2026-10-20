#!/usr/bin/env node
"use strict";

// Synthetic values only. Exercise the shipped browser functions; never read data.enc.json.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const U = require("./update_finances.cjs");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const previewHtml = fs.readFileSync(path.join(__dirname, "..", "index.preview.html"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const prices = [{date:"2024-01-10",close:10},{date:"2024-06-30",close:12}];
const orders = [{date:"2024-01-10",side:"buy",shares:1,price:10}];
const trade = extra => ({prices,orders,...extra});
function fixture(cash = 9000, count = 8) {
  const holdings = Array.from({length:count}, (_,i) => ({ticker:`EX${i}`,type:i%2?"etf":"stock",value:(i+1)*100,costBasis:(i+1)*90}));
  if (cash !== null) holdings.unshift({ticker:"CASH",type:"cash",nameZh:"现金",value:cash});
  return {asOf:"2024-06-30",currency:"USD",holdings,performance:{totalGain:0,totalCurrentValue:12345,totalPrincipal:12345,totalReturnPct:0,items:[]},trading:{}};
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function harness(previewMode = false, sourceHtml = html) {
  const ui = U.browserContract(sourceHtml), elements = new Map();
  class Element {
    constructor(tag="div") { this.tag=tag;this.children=[];this.attributes={};this.dataset={};this.style={};this.className="";this.textContent="";this._html="";
      this.classList={toggle:(name,on)=>{const set=new Set(this.className.split(/\s+/).filter(Boolean));if(on)set.add(name);else set.delete(name);this.className=[...set].join(" ");}};
    }
    set innerHTML(value) { this._html=value;this.children=[]; }
    get innerHTML() { return this._html; }
    setAttribute(name,value) {this.attributes[name]=String(value);if(name==="class")this.className=String(value);if(name==="id")elements.set(value,this);}
    appendChild(child) {this.children.push(child);return child;}
    querySelectorAll(selector) {const name=selector.slice(1), found=[];for(const child of this.children){if(child.className.split(/\s+/).includes(name))found.push(child);found.push(...child.querySelectorAll(selector));}return found;}
    addEventListener() {}
  }
  const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  Object.assign(ui, {
    $:el,document:{createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag)},
    preview:{holding:null},PREVIEW_MODE:previewMode,marketResult:null,EMBEDDED_DATA:fixture(),
    formatCurrency:value=>`$${Number(value).toFixed(2)}`,formatSignedCurrency:value=>`$${Number(value).toFixed(2)}`,
    formatPct:value=>`${Number(value).toFixed(1)}%`,formatSignedPct:value=>`${Number(value).toFixed(1)}%`,
    finiteOrNull:value=>Number.isFinite(Number(value))?Number(value):null,
    escapeHtml:value=>String(value||""),setText:(id,text)=>{el(id).textContent=text;},
    tweenText:(element,value,format)=>{element.textContent=format(value);},
    bindPreview:(element,kind,index)=>{element.preview={kind,index};},bindActivate:(element,activate)=>{element.activate=activate;},
    dropPreview:()=>{ui.preview.holding=null;},clearPreviews:()=>{ui.preview.holding=null;},
    applyMarketData:()=>{},setRefreshBusy:()=>{},showToast:()=>{},requestMarketPrices:async()=>null,
    settleWithin:async promise=>promise,requestEncrypted:async()=>ui.nextRaw,
    decryptPayload:async data=>data
  });
  Object.assign(ui.state,{selectedHolding:0,selectedPerformance:0,dataVersion:0,password:"synthetic-test-only",selectedTradingTicker:""});
  const names=["shownHolding","activateData","refreshData","unlockWith","polar","donutPath","svgEl","centerLabel","holdingCenterLabel","renderDonut","addSvgText","setSvgText","updateDonutSelection","updateRowSelection","renderHoldingsChart","updateHoldingSelection","selectHolding","formatHoldingType","renderHoldingList","renderSummary","renderHero","renderRanking","renderTickerSelector"];
  vm.runInContext(names.map(name=>{const match=sourceHtml.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`,"m"));assert.ok(match,name);return match[0];}).join("\n"),ui);
  ui.render=()=>{ui.renderSummary();ui.renderHoldingsChart();ui.renderHoldingList();ui.renderRanking();ui.renderTickerSelector();};
  return {ui,el,activate:raw=>ui.activateData(raw,null)};
}

test("nine raw assets become eight securities, with cash counted exactly once",()=>{
  const {ui,el,activate}=harness(), raw=freeze(fixture()), before=JSON.stringify(raw);
  activate(raw);
  assert.equal(ui.state.data.holdings.length,8);
  assert.equal(ui.state.data.equityValue,3600);
  assert.equal(ui.state.data.cashValue,9000);
  assert.equal(ui.state.data.totalAssetValue,12600);
  assert.ok(Math.abs(ui.state.data.holdings.reduce((n,i)=>n+i.weight,0)-100)<1e-10);
  assert.equal(el("heroValue").textContent,"$3600.00");
  assert.equal(el("meta").textContent,"2024-06-30 · USD · 现金 + 股票 / ETF");
  assert.equal(el("holdingCount").textContent,"8 个");
  assert.equal(el("largestHolding").textContent,"EX7 22.2%");
  assert.equal(el("holdingsChart").querySelectorAll(".donut-slice").length,8);
  assert.equal(el("holdingList").querySelectorAll(".holding").length,8);
  assert.equal(el("rankList").children.length,8);
  for(const row of el("holdingList").children)assert.doesNotMatch(row.innerHTML,/CASH|现金|NaN/);
  assert.equal(JSON.stringify(raw),before);
  assert.deepEqual(plain(ui.normalizeData(ui.state.data)),plain(ui.state.data));
});

test("multiple cash accounts merge only in the cash subtotal",()=>{
  const {ui,el,activate}=harness(), raw=fixture(null,1);
  raw.holdings.push({ticker:"CHECK",type:"checking",value:500},{ticker:"SAVE",type:"savings",value:600},{ticker:"SWEEP",type:"cash sweep",value:700},{ticker:"CD",type:"cd",value:800});
  activate(raw);
  assert.equal(ui.state.data.cashValue,2600);
  assert.equal(ui.state.data.totalAssetValue,2700);
  assert.equal(el("holdingCount").textContent,"1 个");
  assert.equal(el("largestHolding").textContent,"EX0 100.0%");
  assert.equal(el("heroValue").textContent,"$100.00");
  assert.equal(el("meta").textContent,"2024-06-30 · USD · 现金 + 股票 / ETF");
  assert.equal(ui.normalizeCashHoldings(ui.state.data.assetHoldings).filter(ui.isCashHolding).length,1);
  assert.deepEqual(plain(ui.normalizeData(ui.state.data)),plain(ui.state.data));
});

test("USD cash equivalents require explicit metadata and do not swallow a genuine USD ETF",()=>{
  const {ui,activate}=harness(), raw=fixture(null,0);
  raw.holdings=[{ticker:"USD",type:"cash",is_cash_equivalent:true,value:700},{ticker:"USD",type:"etf",is_cash_equivalent:false,value:300}];
  raw.trading={USD:trade({type:"etf"})};
  activate(raw);
  assert.equal(ui.state.data.cashValue,700);
  assert.equal(ui.state.data.equityValue,300);
  assert.deepEqual(plain(ui.state.data.holdings.map(i=>i.ticker)),["USD"]);
  assert.deepEqual(plain(ui.state.data.trading.map(i=>i.ticker)),["USD"]);
  assert.deepEqual(plain(ui.annualPositions(raw).map(i=>i.ticker)),["USD"]);
  assert.equal(ui.isCashHolding({ticker:"USD",type:"equity",isCashEquivalent:true}),true);
  assert.equal(ui.isCashHolding({ticker:"USD",type:"etf"}),false);
});

test("cash-only and empty snapshots render zero securities without NaN or stale selection",()=>{
  for(const cash of [700,0,null]){
    const {ui,el,activate}=harness();activate(fixture());ui.state.selectedHolding=7;
    activate(fixture(cash,0));
    assert.equal(ui.state.data.equityValue,0);
    assert.equal(ui.state.data.cashValue,cash||0);
    assert.equal(ui.state.data.totalAssetValue,cash||0);
    assert.equal(el("heroValue").textContent,"$0.00");
    assert.equal(el("holdingCount").textContent,"0 个");
    assert.equal(el("largestHolding").textContent,"–");
    assert.equal(el("holdingsChart").querySelectorAll(".donut-slice").length,0);
    assert.equal(el("holdingList").querySelectorAll(".holding").length,0);
    assert.equal(el("holdingList").children.length,0);
    assert.equal(el("holdingList").innerHTML,"");
    ui.selectHolding(-1);assert.equal(ui.state.selectedHolding,0);
    assert.deepEqual(plain(ui.normalizeData(ui.state.data)),plain(ui.state.data));
  }
});

test("cash absent or zero does not alter security weights or assets",()=>{
  for(const cash of [null,0]){const {ui,activate}=harness();activate(fixture(cash,2));assert.equal(ui.state.data.totalAssetValue,300);assert.equal(ui.state.data.cashValue,0);assert.ok(Math.abs(ui.state.data.holdings[0].weight-200/3)<1e-10);assert.deepEqual(plain(ui.normalizeData(ui.state.data)),plain(ui.state.data));}
});

test("known cash aliases and explicit cash trading rows cannot enter trading or annual securities",()=>{
  const {ui,el,activate}=harness(),raw=fixture(null,1);
  raw.holdings.push({ticker:"SWEEP",type:"cash",value:300});
  raw.trading={EX0:trade(),SWEEP:trade(),CASH:trade(),CD:trade(),CURRENCY:trade({is_cash_equivalent:true}),SOLD:trade()};
  activate(raw);
  assert.deepEqual(plain(ui.state.data.trading.map(i=>i.ticker)),["EX0","SOLD"]);
  assert.deepEqual(plain(ui.annualPositions(raw).map(i=>i.ticker)),["EX0","SOLD"]);
  assert.deepEqual(plain(ui.computeAnnualSummary().tickers.map(i=>i.ticker)).sort(),["EX0","SOLD"]);
  assert.equal(el("tickerSelector").children.length,2);
  assert.deepEqual(plain(ui.normalizeData(ui.state.data).trading),plain(ui.state.data.trading));
});

test("preserved history still filters cash aliases without dropping closed securities",()=>{
  const {ui,activate}=harness(),raw=fixture(800,1);
  raw.historyStatus={state:"preserved",asOf:"2024-05-31",reason:"incomplete_history"};
  raw.historySnapshot={holdings:[{ticker:"OLD_SWEEP",type:"cash",value:100}],trading:{OLD_SWEEP:trade(),SOLD:trade()},performance:raw.performance};
  activate(raw);
  assert.deepEqual(plain(ui.state.data.trading.map(i=>i.ticker)),["SOLD"]);
  assert.equal(ui.state.data.totalAssetValue,900);
});

test("chart, rows, hover previews and selection use the same securities indexes",()=>{
  const {ui,el,activate}=harness();activate(fixture());
  ui.selectHolding(1);
  assert.equal(el("holdingsChartTitle").textContent,"EX6");
  assert.equal(el("holdingList").querySelectorAll(".active")[0].dataset.index,"1");
  ui.preview.holding=2;ui.updateHoldingSelection();
  assert.equal(el("holdingsChartTitle").textContent,"EX5");
  assert.equal(el("holdingsChartPct").textContent,"16.7%");
  assert.equal(el("holdingsChartValue").textContent,"$600.00");
  assert.equal(el("holdingsChart").querySelectorAll(".active")[0].dataset.index,"2");
  ui.selectHolding(100);assert.equal(ui.state.selectedHolding,7);
  assert.equal(el("holdingsChartTitle").textContent,"EX0");
});

test("refresh clamps selection, displays securities and retains cash in the asset total",async()=>{
  const {ui,el,activate}=harness();activate(fixture(700,0));ui.state.selectedHolding=-1;
  ui.nextRaw=fixture(800,2);await ui.refreshData();
  assert.equal(ui.state.selectedHolding,0);
  assert.equal(el("holdingCount").textContent,"2 个");
  assert.equal(el("holdingsChartTitle").textContent,"EX1");
  assert.equal(el("heroValue").textContent,"$300.00");
  assert.equal(ui.state.data.cashValue,800);assert.equal(ui.state.data.totalAssetValue,1100);
  ui.nextRaw=fixture(900,0);await ui.refreshData();
  assert.equal(ui.state.selectedHolding,0);
  assert.equal(el("holdingCount").textContent,"0 个");
  assert.equal(el("heroValue").textContent,"$0.00");
  assert.equal(ui.state.data.cashValue,900);assert.equal(ui.state.data.totalAssetValue,900);
});

test("production unlock and embedded preview mode share the same cash/securities boundary",async()=>{
  const {ui,el}=harness();ui.nextRaw=fixture(700,2);await ui.unlockWith("synthetic");
  assert.equal(el("holdingCount").textContent,"2 个");assert.equal(el("heroValue").textContent,"$300.00");
  assert.equal(ui.state.data.cashValue,700);assert.equal(ui.state.data.totalAssetValue,1000);
  const preview=harness(true);await preview.ui.refreshData();
  assert.equal(preview.el("holdingCount").textContent,"8 个");assert.equal(preview.el("heroValue").textContent,"$3600.00");
  assert.equal(preview.ui.state.data.cashValue,9000);assert.equal(preview.ui.state.data.totalAssetValue,12600);
});

test("standalone preview displays eight securities and retains the reconciled asset total",()=>{
  const {ui,el,activate}=harness(false,previewHtml),raw=freeze(fixture()),before=JSON.stringify(raw);
  activate(raw);
  assert.equal(ui.state.data.holdings.length,8);
  assert.equal(ui.state.data.equityValue,3600);
  assert.equal(ui.state.data.cashValue,9000);
  assert.equal(ui.state.data.totalAssetValue,12600);
  assert.equal(el("heroValue").textContent,"$3600.00");
  assert.equal(el("meta").textContent,"2024-06-30 · USD · 现金 + 股票 / ETF");
  assert.equal(el("holdingCount").textContent,"8 个");
  assert.equal(el("largestHolding").textContent,"EX7 22.2%");
  assert.equal(el("holdingsChart").querySelectorAll(".donut-slice").length,8);
  assert.equal(el("holdingList").querySelectorAll(".holding").length,8);
  assert.equal(el("rankList").children.length,8);
  assert.ok(Math.abs(ui.state.data.holdings.reduce((n,i)=>n+i.weight,0)-100)<1e-10);
  for(const row of el("holdingList").children)assert.doesNotMatch(row.innerHTML,/CASH|现金|NaN/);
  assert.equal(JSON.stringify(raw),before);
  assert.deepEqual(plain(ui.normalizeData(ui.state.data)),plain(ui.state.data));
});

test("standalone preview merges source cash while retaining genuine USD ETF",()=>{
  const {ui,el,activate}=harness(false,previewHtml),raw=fixture(null,0);
  raw.holdings=[{ticker:"USD",type:"cash",is_cash_equivalent:true,value:300},{ticker:"USD",type:"etf",is_cash_equivalent:false,value:200},{ticker:"CHECK",type:"checking",value:100},{ticker:"SAVE",type:"savings",value:150}];
  raw.trading={USD:trade({type:"etf"}),CHECK:trade(),SAVE:trade()};
  activate(raw);
  assert.deepEqual(plain(ui.state.data.holdings.map(i=>i.ticker)),["USD"]);
  assert.equal(ui.state.data.cashValue,550);
  assert.equal(ui.state.data.totalAssetValue,750);
  assert.equal(el("largestHolding").textContent,"USD 100.0%");
  assert.deepEqual(plain(ui.state.data.trading.map(i=>i.ticker)),["USD"]);
  assert.deepEqual(plain(ui.annualPositions(raw).map(i=>i.ticker)),["USD"]);
  assert.equal(ui.isCashHolding({ticker:"USD",isCashEquivalent:true}),true);
});

test("standalone preview default route never fabricates trades or accepts sample entries",()=>{
  const {ui,el,activate}=harness(false,previewHtml),raw=fixture(700,1);
  raw.holdings.push({ticker:"SWEEP",type:"cash sweep",value:300});
  raw.trading={CASH:trade(),SWEEP:trade(),CURRENCY:trade({is_cash_equivalent:true}),SOLD:trade(),SAMPLE:trade({priceSource:"preview"})};
  activate(raw);
  assert.deepEqual(plain(ui.state.data.trading.map(i=>i.ticker)),["SOLD"]);
  assert.deepEqual(plain(ui.annualPositions(raw).map(i=>i.ticker)),["SOLD"]);
  assert.deepEqual(plain(ui.computeAnnualSummary().tickers.map(i=>i.ticker)),["SOLD"]);
  assert.equal(el("tickerSelector").children.length,1);
  assert.deepEqual(plain(ui.normalizeData(ui.state.data).trading),plain(ui.state.data.trading));
});

test("standalone preview keeps real transaction ordering by current security value",()=>{
  const {ui,activate}=harness(false,previewHtml),raw=fixture(700,3);
  raw.trading={EX0:trade(),EX1:trade(),EX2:trade()};
  raw.holdings.push({ticker:"ZERO",type:"stock",value:0});activate(raw);
  assert.deepEqual(plain(ui.state.data.trading.map(i=>i.ticker)),["EX2","EX1","EX0"]);
  ui.state.data.trading.forEach((item)=>{
    assert.deepEqual(plain(item.prices.map(({date,close})=>({date,close}))),prices);
    assert.deepEqual(plain(item.orders.map(({date,side,shares,price})=>({date,side,shares,price}))),orders);
  });
});

test("standalone preview preserves supplied real prices and orders",()=>{
  const {ui,activate}=harness(false,previewHtml),raw=fixture(700,1);
  raw.trading={EX0:trade()};activate(raw);
  const item=ui.state.data.trading[0];
  assert.equal(item.priceSource,"encrypted");
  assert.deepEqual(plain(item.prices.map(({date,close})=>({date,close}))),prices);
  assert.deepEqual(plain(item.orders.map(({date,side,shares,price})=>({date,side,shares,price}))),orders);
  assert.deepEqual(plain(ui.annualPositions(raw).map(i=>i.ticker)),["EX0"]);
});

test("standalone preview cash only, empty and zero cash preserve all asset totals",()=>{
  for(const [cash,count] of [[700,0],[0,0],[null,0],[0,2],[null,2]]){
    const {ui,el,activate}=harness(false,previewHtml);activate(fixture(cash,count));
    assert.equal(ui.state.data.totalAssetValue,(cash||0)+(count?300:0));
    assert.equal(ui.state.data.cashValue,cash||0);
    assert.equal(el("heroValue").textContent,count?"$300.00":"$0.00");
    assert.equal(el("holdingCount").textContent,`${count} 个`);
    assert.equal(el("holdingsChart").querySelectorAll(".donut-slice").length,count);
    assert.deepEqual(plain(ui.normalizeData(ui.state.data)),plain(ui.state.data));
    if(!count){assert.equal(el("largestHolding").textContent,"–");assert.equal(el("holdingList").children.length,0);assert.equal(el("holdingList").innerHTML,"");assert.equal(ui.state.data.trading.length,0);}
  }
});

test("standalone preview refresh, unlock, selection and embedded mode execute its own functions",async()=>{
  const {ui,el,activate}=harness(false,previewHtml);activate(fixture(700,0));ui.state.selectedHolding=-1;
  ui.nextRaw=fixture(800,2);await ui.refreshData();
  assert.equal(ui.state.selectedHolding,0);assert.equal(el("heroValue").textContent,"$300.00");
  assert.equal(ui.state.data.cashValue,800);assert.equal(ui.state.data.totalAssetValue,1100);
  ui.preview.holding=1;ui.updateHoldingSelection();assert.equal(el("holdingsChartTitle").textContent,"EX0");
  assert.equal(el("holdingsChartPct").textContent,"33.3%");
  ui.selectHolding(100);assert.equal(ui.state.selectedHolding,1);
  ui.nextRaw=fixture(900,0);await ui.unlockWith("synthetic");
  assert.equal(el("holdingCount").textContent,"0 个");assert.equal(el("heroValue").textContent,"$0.00");
  assert.equal(ui.state.data.cashValue,900);assert.equal(ui.state.data.totalAssetValue,900);
  const embedded=harness(true,previewHtml);await embedded.ui.refreshData();
  assert.equal(embedded.el("holdingCount").textContent,"8 个");assert.equal(embedded.el("heroValue").textContent,"$3600.00");
  assert.equal(embedded.ui.state.data.cashValue,9000);assert.equal(embedded.ui.state.data.totalAssetValue,12600);
});

test("standalone preview groups cash income without changing totals, kinds or principal",()=>{
  const {ui,activate}=harness(false,previewHtml),raw=fixture(700,1);
  raw.performance={totalGain:37,totalPrincipal:540,totalCurrentValue:577,totalReturnPct:6.85,items:[
    {kind:"cash_interest",label:"示例银行 CD 利息",gain:12},
    {kind:"other_income",label:"其他收益",gain:8},
    {kind:"realized_gain",label:"股票已实现收益",gain:10},
    {kind:"dividend",label:"股息",gain:7}
  ]};
  freeze(raw);const before=JSON.stringify(raw);activate(raw);
  const perf=ui.state.data.performance,group=perf.items.find(i=>i.kind==="cash_income_group");
  assert.equal(group.label,"现金利息/已止盈收益");assert.equal(group.gain,30);
  assert.deepEqual(plain(group.components),[{kind:"cash_interest",gain:12},{kind:"other_income",gain:8},{kind:"realized_gain",gain:10}]);
  assert.equal(perf.items.reduce((n,i)=>n+i.gain,0),37);
  for(const key of ["totalGain","totalPrincipal","totalCurrentValue","totalReturnPct"])assert.equal(perf[key],raw.performance[key]);
  assert.doesNotMatch(perf.items.map(i=>i.label).join(" "),/银行|CD/);
  assert.deepEqual(plain(ui.normalizeData(ui.state.data).performance),plain(perf));
  assert.equal(JSON.stringify(raw),before);
});

for (const [page, sourceHtml] of [["production",html],["standalone preview",previewHtml]]) {
  test(`${page} retains the stable two-item summary and interaction hint`,()=>{
    const summary=sourceHtml.match(/<div class="summary-strip holdings-summary">([\s\S]*?)<section class="list-card">/)[1];
    assert.equal((summary.match(/class="summary-item"/g)||[]).length,2);
    assert.match(summary,/>最大仓位</);assert.match(summary,/>持仓数</);
    assert.match(sourceHtml,/<strong>持仓明细<\/strong>\s*<span>悬停预览 · 点击固定<\/span>/);
    assert.doesNotMatch(sourceHtml,/id="(?:securitiesValue|cashValue)"/);
    assert.doesNotMatch(sourceHtml,/\.history-notice\s*\{/);
  });

  test(`${page} restores saved Chinese names and current-value trading order without changing data`,()=>{
    const {ui,el,activate}=harness(false,sourceHtml),raw=fixture(null,0);
    raw.holdings=[{ticker:"AAA",type:"stock",nameZh:"AAA",value:100},{ticker:"BBB",type:"etf",nameZh:"当前乙",value:900},{ticker:"CASH",type:"cash",nameZh:"现金",value:600}];
    raw.trading={AAA:trade({nameZh:"AAA"}),BBB:trade({nameZh:"BBB"}),SOLD:trade({nameZh:"SOLD"})};
    raw.historySnapshot={holdings:[{ticker:"AAA",type:"stock",nameZh:"原有甲",value:700},{ticker:"BBB",type:"etf",nameZh:"原有乙",value:200}],trading:{AAA:trade({nameZh:"旧交易甲"}),BBB:trade(),SOLD:trade({nameZh:"原有已卖出"})}};
    raw.userConfirmedCapital={source:"user-confirmed",updatePolicy:"explicit-user-only",principalCents:87000};
    freeze(raw);const before=JSON.stringify(raw);activate(raw);
    assert.deepEqual(plain(ui.state.data.holdings.map(i=>[i.ticker,i.nameZh,i.value])),[["BBB","当前乙",900],["AAA","原有甲",100]]);
    assert.deepEqual(plain(ui.state.data.trading.map(i=>[i.ticker,i.nameZh])),[["BBB","当前乙"],["AAA","原有甲"],["SOLD","原有已卖出"]]);
    assert.equal(ui.state.data.totalAssetValue,1600);assert.equal(ui.state.data.cashValue,600);
    assert.match(el("holdingList").children[0].innerHTML,/当前乙/);
    assert.equal(JSON.stringify(raw),before);
    assert.deepEqual(plain(ui.normalizeData(ui.state.data)),plain(ui.state.data));
  });

  test(`${page} names follow saved source priority and never borrow cash labels`,()=>{
    const {ui,activate}=harness(false,sourceHtml),raw=fixture(null,0);
    raw.holdings=[{ticker:"AAA",type:"stock",nameZh:" aaa ",value:100},{ticker:"USD",type:"etf",nameZh:"USD",value:300}];
    raw.trading={AAA:trade({nameZh:"当前已保存交易名"}),USD:trade()};
    raw.historySnapshot={holdings:[{ticker:"AAA",type:"stock",nameZh:"历史甲",value:20},{ticker:"USD",type:"cash",nameZh:"示例银行现金",value:40}],trading:{USD:trade({type:"cash",nameZh:"示例银行现金"})}};
    activate(raw);
    assert.equal(ui.state.data.holdings.find(i=>i.ticker==="AAA").nameZh,"当前已保存交易名");
    assert.equal(ui.state.data.holdings.find(i=>i.ticker==="USD").nameZh,"USD");
    assert.doesNotMatch(JSON.stringify(ui.state.data.holdings),/示例银行/);
    assert.equal(ui.state.data.cashValue,0);assert.equal(ui.state.data.totalAssetValue,400);
  });
}

test("preserved historical trading uses current security sort order and separate cash metadata",()=>{
  const {ui,activate}=harness(),raw=fixture(null,0);
  raw.holdings=[{ticker:"AAA",type:"stock",nameZh:"AAA",value:100},{ticker:"BBB",type:"stock",nameZh:"BBB",value:900},{ticker:"CASH",type:"cash",value:500}];
  raw.historyStatus={state:"preserved",asOf:"2024-06-30",reason:"incomplete_history"};
  raw.historySnapshot={holdings:[{ticker:"AAA",type:"stock",nameZh:"原有甲",value:500},{ticker:"SWEEP",type:"cash",value:600},{ticker:"BBB",type:"stock",nameZh:"原有乙",value:100}],performance:raw.performance,trading:{AAA:trade(),SWEEP:trade(),BBB:trade(),SOLD:trade()}};
  activate(raw);
  assert.deepEqual(plain(ui.state.data.trading.map(i=>i.ticker)),["BBB","AAA","SOLD"]);
  assert.deepEqual(plain(ui.state.data.holdings.map(i=>i.nameZh)),["原有乙","原有甲"]);
  assert.equal(ui.state.data.totalAssetValue,1500);
});

test("standalone preview remains byte-identical to production as in the stable version",()=>{
  assert.equal(previewHtml,html);
});

for (const [page, sourceHtml] of [["production",html],["standalone preview",previewHtml]]) {
  test(`${page} annual closed-security canonical name and real orders survive a single price point`,()=>{
    for(const nameField of ["nameZh","name"]){
      const {ui,activate}=harness(false,sourceHtml),raw=fixture(700,0);
      raw.historyStatus={state:"preserved",asOf:"2024-06-30",reason:"history_not_revalidated"};
      raw.historySnapshot={asOf:"2024-06-30",holdings:[],performance:raw.performance,trading:{SOLD:{
        [nameField]:"已卖出证券中文",
        prices:[{date:"2024-01-10",close:10}],
        orders:[{date:"2024-01-10",side:"buy",shares:1,price:10},{date:"2024-06-15",side:"sell",shares:1,price:12}]
      }}};
      // Annual math consumes the current raw ledger; the archived copy remains
      // available for saved names and preserved trading presentation.
      raw.trading=plain(raw.historySnapshot.trading);
      const control=plain(raw);delete control.historySnapshot.trading.SOLD[nameField];delete control.trading.SOLD[nameField];
      const expected=harness(false,sourceHtml);expected.activate(control);
      const expectedSummary=plain(expected.ui.computeAnnualSummary());
      freeze(raw);const before=JSON.stringify(raw);activate(raw);
      assert.equal(ui.state.data.trading.length,1);
      assert.equal(ui.state.data.trading[0].prices.length,1);
      assert.equal(ui.state.data.trading[0].orders.length,2);
      assert.equal(ui.state.data.trading[0].returnPct,null);
      const summary=plain(ui.computeAnnualSummary());
      assert.equal(summary.tickers.length,1);
      // The committed label contract uses nameZh for a trading-only security;
      // a name-only alias must not affect its quantities or annual result.
      assert.equal(summary.tickers[0].name,nameField==="nameZh"?"已卖出证券中文":"");
      assert.equal(summary.tickers[0].total,2);
      assert.deepEqual(summary.years,expectedSummary.years);
      assert.deepEqual(summary.tickers[0].byYear,expectedSummary.tickers[0].byYear);
      assert.equal(ui.state.data.totalAssetValue,700);
      assert.equal(JSON.stringify(raw),before);
    }
  });

  test(`${page} annual USD security name excludes same-ticker cash and keeps financial results`,()=>{
    for(const currentName of ["USD","已确认基金中文"]){
      const {ui,activate}=harness(false,sourceHtml),raw=fixture(700,0);
      raw.holdings.push({ticker:"USD",type:"etf",nameZh:currentName,value:300});
      raw.historyStatus={state:"preserved",asOf:"2024-06-30",reason:"history_not_revalidated"};
      raw.historySnapshot={asOf:"2024-06-30",performance:raw.performance,holdings:[
        {ticker:"USD",type:"cash",is_cash_equivalent:true,nameZh:"合成银行来源",value:600},
        {ticker:"USD",type:"etf",nameZh:"基金中文",value:12}
      ],trading:{USD:trade({nameZh:"USD"})}};
      raw.trading={USD:trade({nameZh:"USD"})};
      const archiveOnly=plain(raw);archiveOnly.trading={};
      const archiveHarness=harness(false,sourceHtml);archiveHarness.activate(archiveOnly);
      assert.deepEqual(plain(archiveHarness.ui.computeAnnualSummary().tickers),[]);
      const control=plain(raw);control.historySnapshot.holdings.shift();
      const expected=harness(false,sourceHtml);expected.activate(control);
      const expectedSummary=plain(expected.ui.computeAnnualSummary());
      freeze(raw);const before=JSON.stringify(raw);activate(raw);
      const summary=plain(ui.computeAnnualSummary());
      assert.equal(summary.tickers.length,1);assert.equal(summary.tickers[0].ticker,"USD");
      assert.equal(summary.tickers[0].name,currentName==="USD"?"基金中文":currentName);
      assert.doesNotMatch(JSON.stringify(summary.tickers),/合成银行来源/);
      assert.deepEqual(summary,expectedSummary);
      assert.equal(summary.years[0].stockPnl,2);
      assert.equal(ui.state.data.totalAssetValue,1000);
      assert.equal(JSON.stringify(raw),before);
    }
  });

  test(`${page} keeps raw cash identity across repeated normalization of preserved history`,()=>{
    const {ui,activate}=harness(false,sourceHtml),raw=fixture(null,1);
    raw.holdings.push({ticker:"SWEEP",type:"cash",value:800});
    raw.historyStatus={state:"preserved",asOf:"2024-06-30",reason:"incomplete_history"};
    raw.historySnapshot={holdings:[],performance:raw.performance,trading:{SWEEP:trade(),EX0:trade()}};
    freeze(raw);const before=JSON.stringify(raw);activate(raw);
    const once=plain(ui.state.data);
    for(let i=0;i<3;i++){
      ui.state.data=ui.normalizeData(ui.state.data);
      assert.deepEqual(plain(ui.state.data),once);
      assert.deepEqual(plain(ui.state.data.trading.map(item=>item.ticker)),["EX0"]);
      assert.equal(ui.state.data.cashValue,800);assert.equal(ui.state.data.totalAssetValue,900);
    }
    assert.equal(JSON.stringify(raw),before);
  });

  test(`${page} explicit embedded mode accepts injected data but never generates missing orders`,async()=>{
    const {ui}=harness(true,sourceHtml);
    ui.EMBEDDED_DATA=fixture(700,2);
    ui.EMBEDDED_DATA.trading={EX0:{prices},EX1:{prices,orders}};
    await ui.refreshData();
    assert.equal(ui.state.data.trading.find(i=>i.ticker==="EX0").orders.length,0);
    assert.equal(ui.state.data.trading.find(i=>i.ticker==="EX1").orders.length,1);
    assert.equal(ui.state.data.trading.some(i=>i.priceSource==="preview"),false);
  });
}
