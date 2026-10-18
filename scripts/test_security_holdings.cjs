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
function harness(previewMode = false) {
  const ui = U.browserContract(html), elements = new Map();
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
  vm.runInContext(names.map(name=>{const match=html.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`,"m"));assert.ok(match,name);return match[0];}).join("\n"),ui);
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
  assert.equal(el("heroValue").textContent,"$12600.00");
  assert.equal(el("securitiesValue").textContent,"$3600.00");
  assert.equal(el("cashValue").textContent,"$9000.00");
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
  assert.equal(el("cashValue").textContent,"$2600.00");
  assert.equal(ui.state.data.assetHoldings.filter(ui.isCashHolding).length,1);
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
    assert.equal(el("heroValue").textContent,`$${Number(cash||0).toFixed(2)}`);
    assert.equal(el("holdingCount").textContent,"0 个");
    assert.equal(el("largestHolding").textContent,"–");
    assert.equal(el("holdingsChart").querySelectorAll(".donut-slice").length,0);
    assert.equal(el("holdingList").querySelectorAll(".holding").length,0);
    assert.equal(el("holdingList").children[0].textContent,"暂无证券持仓");
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

test("refresh from cash only to securities clamps selection and keeps the total",async()=>{
  const {ui,el,activate}=harness();activate(fixture(700,0));ui.state.selectedHolding=-1;
  ui.nextRaw=fixture(800,2);await ui.refreshData();
  assert.equal(ui.state.selectedHolding,0);
  assert.equal(el("holdingCount").textContent,"2 个");
  assert.equal(el("holdingsChartTitle").textContent,"EX1");
  assert.equal(el("heroValue").textContent,"$1100.00");
  ui.nextRaw=fixture(900,0);await ui.refreshData();
  assert.equal(ui.state.selectedHolding,0);
  assert.equal(el("holdingCount").textContent,"0 个");
  assert.equal(el("heroValue").textContent,"$900.00");
});

test("unlock and preview refresh share the same cash/securities boundary",async()=>{
  const {ui,el}=harness();ui.nextRaw=fixture(700,2);await ui.unlockWith("synthetic");
  assert.equal(el("holdingCount").textContent,"2 个");assert.equal(el("heroValue").textContent,"$1000.00");
  const preview=harness(true);await preview.ui.refreshData();
  assert.equal(preview.el("holdingCount").textContent,"8 个");assert.equal(preview.el("heroValue").textContent,"$12600.00");
});
