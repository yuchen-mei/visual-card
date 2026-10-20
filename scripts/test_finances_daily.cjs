"use strict";
const assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {test}=require("node:test"),T=require("./finances_transport.cjs"),D=require("./finances_daily.cjs"),U=require("./update_finances.cjs");
const {spawn}=require("node:child_process");
const now=Date.parse("2026-10-18T04:00:00Z"),head="a".repeat(40),hash="b".repeat(64);
const copy=x=>JSON.parse(JSON.stringify(x));
function session(){return D.createSession({expectedHead:head,baselineSha256:hash,now});}
function packet(s){return {version:1,operationId:"synthetic:2026-10-17",sessionId:s.header.sessionId,expectedHead:head,baselineSha256:hash,snapshot:{text:"合成测试".repeat(1000)},policy:{}};}
test("portable SHA256 agrees with Node for UTF8, block boundaries and long input",()=>{for(const n of [0,1,55,56,63,64,65,1000,32768]){const text="测x".repeat(n);assert.equal(T.hash(text),crypto.createHash("sha256").update(text).digest("hex"));}});
test("sealed source roundtrip uses Node OAEP and burns client seed pool",()=>{const s=session(),p=packet(s),header=copy(s.header),cipher=T.seal(p,header,{now});assert.deepEqual(s.open(cipher,{now}),p);assert(header.seeds.every(v=>v===null));assert(!JSON.stringify(cipher).includes("合成测试"));});
test("transport refuses expired and mismatched sessions",()=>{const s=session(),p=packet(s);assert.throws(()=>T.seal(p,copy(s.header),{now:now+300001}));p.expectedHead="c".repeat(40);assert.throws(()=>T.seal(p,copy(s.header),{now}));});
test("receiver is single-use including rejected inputs",()=>{const s=session(),cipher=T.seal(packet(s),copy(s.header),{now});s.open(cipher,{now});assert.throws(()=>s.open(cipher,{now}),{message:"TRANSPORT_ALREADY_CONSUMED"});});
test("reordered, omitted, changed and foreign chunks fail closed",()=>{for(const mutation of [b=>b.reverse(),b=>b.pop(),b=>b[0]="0".repeat(768)]){const s=session(),cipher=T.seal(packet(s),copy(s.header),{now});mutation(cipher.blocks);assert.throws(()=>s.open(cipher,{now}));}});
test("oversized source packet is rejected before sealing",()=>{const s=session(),p=packet(s);p.snapshot.text="x".repeat(131073);assert.throws(()=>T.seal(p,copy(s.header),{now}));});
function fixture(){
 const old={asOf:"2026-10-09",currency:"USD",holdings:[{ticker:"CASH",type:"cash",value:100}],performance:{totalCurrentValue:100,totalPrincipal:90,totalGain:10,totalReturnPct:100/9,items:[{label:"cash interest",kind:"cash_interest",gain:10}]}};
 const password="synthetic-bridge-only",bytes=Buffer.from(JSON.stringify(U.encrypt(old,password)));
 const proof={complete:true,allPagesFetched:true,sourceDateStatus:"unknown",updatedAt:null};
 const snapshot={schemaVersion:2,mode:"assets",source:"Finances",currency:"USD",fetchedAt:new Date(now).toISOString(),previousCiphertextSha256:U.hash(bytes),coverage:{accountsComplete:true,allPagesFetched:true,accountIds:["synthetic-bank"]},accounts:[{id:"synthetic-bank",type:"checking",currency:"USD",cashCents:12000,securitiesCents:0,totalCents:12000,coverage:{balances:proof,holdings:proof}}],positions:[],reconciliation:{independentSourceTotals:true,totalValueCents:12000,cashCents:12000}};
 const packet={version:1,operationId:"synthetic:daily",sessionId:"synthetic",expectedHead:head,baselineSha256:U.hash(bytes),snapshot,policy:{accountIds:["synthetic-bank"]}};
 return {packet,existingBytes:bytes,password,html:fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8"),now};
}
test("daily entry writes only encrypted candidate and binds receipt",async()=>{const outputDirectory=fs.mkdtempSync(path.join(os.tmpdir(),"vc-daily-"));try{const f=fixture(),r=await D.prepareCandidate({...f,outputDirectory});assert.equal(r.status,"validated");assert.equal(r.publication,"disabled");const bytes=fs.readFileSync(r.candidatePath);assert.equal(U.hash(bytes),r.validatedSha256);U.validateEnvelope(JSON.parse(bytes));assert.equal(fs.statSync(r.candidatePath).mode&0o777,0o600);assert.equal(U.decrypt(JSON.parse(bytes),f.password).holdings[0].value,120);}finally{fs.rmSync(outputDirectory,{recursive:true,force:true});}});
test("a later daily operation skips unchanged data without a candidate write",async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vc-noop-"));try{const f=fixture(),r=await D.prepareCandidate({...f,outputDirectory:dir});f.existingBytes=fs.readFileSync(r.candidatePath);f.packet.baselineSha256=U.hash(f.existingBytes);f.packet.snapshot.previousCiphertextSha256=f.packet.baselineSha256;f.packet.operationId="synthetic:next-day";const before=fs.readdirSync(dir);const second=await D.prepareCandidate({...f,outputDirectory:dir});assert.equal(second.status,"unchanged");assert.deepEqual(fs.readdirSync(dir),before);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test("daily entry rejects basis edits, invalid baseline and scope without writing",async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vc-bad-"));try{for(const mutate of [f=>f.packet.snapshot.mode="basis-revision",f=>f.packet.baselineSha256=hash,f=>f.packet.policy.accountIds=[]]){const f=fixture();mutate(f);await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}));assert.deepEqual(fs.readdirSync(dir),[]);}}finally{fs.rmSync(dir,{recursive:true,force:true});}});
async function privateRun(run){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vc-recovery-"));try{await run(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}}
const sibling=(candidate,suffix)=>candidate.replace(/\.enc\.json$/,suffix);
test("same operation reuses verified ciphertext without another encryption",()=>privateRun(async dir=>{
 const f=fixture(),first=await D.prepareCandidate({...f,outputDirectory:dir}),bytes=fs.readFileSync(first.candidatePath),mtime=fs.statSync(first.candidatePath).mtimeMs;
 const prepare=U.prepareUpdate;U.prepareUpdate=async()=>{throw Error("must not encrypt again");};
 try{const second=await D.prepareCandidate({...f,outputDirectory:dir});assert.deepEqual(second,first);}finally{U.prepareUpdate=prepare;}
 assert.ok(fs.readFileSync(first.candidatePath).equals(bytes));assert.equal(fs.statSync(first.candidatePath).mtimeMs,mtime);
}));
test("receipt-less completed candidate recovers against its original binding",()=>privateRun(async dir=>{
 const f=fixture(),first=await D.prepareCandidate({...f,outputDirectory:dir}),receiptPath=sibling(first.candidatePath,".receipt.json"),bytes=fs.readFileSync(first.candidatePath);
 const expected=JSON.parse(fs.readFileSync(receiptPath));fs.unlinkSync(receiptPath);
 f.packet.snapshot.fetchedAt=new Date(now+60000).toISOString();
 const restored=await D.prepareCandidate({...f,outputDirectory:dir,now:now+60000});
 assert.deepEqual(restored,first);assert.deepEqual(JSON.parse(fs.readFileSync(receiptPath)),expected);assert.ok(fs.readFileSync(first.candidatePath).equals(bytes));
}));
test("recovery metadata contains only binding hashes and restricts permissions",()=>privateRun(async dir=>{
 const f=fixture(),first=await D.prepareCandidate({...f,outputDirectory:dir});
 for(const suffix of [".binding.json",".receipt.json"]){const file=sibling(first.candidatePath,suffix),text=fs.readFileSync(file,"utf8"),record=JSON.parse(text);assert.equal(fs.statSync(file).mode&0o777,0o600);assert.doesNotMatch(text,/synthetic-bank|synthetic-bridge-only|cashCents|snapshot|policy/);assert.ok(Object.entries(record).every(([k,v])=>k==="version"?v===1:typeof v==="string"&&/^[a-f0-9]{40,64}$/.test(v)));}
}));
test("new source business data cannot overwrite an existing operation",()=>privateRun(async dir=>{
 const f=fixture(),first=await D.prepareCandidate({...f,outputDirectory:dir}),bytes=fs.readFileSync(first.candidatePath);
 f.packet.snapshot.accounts[0].cashCents+=100;f.packet.snapshot.accounts[0].totalCents+=100;f.packet.snapshot.reconciliation.cashCents+=100;f.packet.snapshot.reconciliation.totalValueCents+=100;
 await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}),{message:"E_RECOVERY_REQUIRED"});assert.ok(fs.readFileSync(first.candidatePath).equals(bytes));
}));
test("a new ciphertext baseline or Git head is never used to prove an old candidate",()=>privateRun(async dir=>{
 const f=fixture(),first=await D.prepareCandidate({...f,outputDirectory:dir}),original=Buffer.from(f.existingBytes),bytes=fs.readFileSync(first.candidatePath);
 f.existingBytes=Buffer.from(JSON.stringify(U.encrypt(U.decrypt(JSON.parse(original),f.password),f.password)));f.packet.baselineSha256=U.hash(f.existingBytes);f.packet.snapshot.previousCiphertextSha256=f.packet.baselineSha256;
 await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}),{message:"E_RECOVERY_REQUIRED"});
 f.existingBytes=original;f.packet.baselineSha256=U.hash(original);f.packet.snapshot.previousCiphertextSha256=f.packet.baselineSha256;f.packet.expectedHead="c".repeat(40);
 await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}),{message:"E_RECOVERY_REQUIRED"});assert.ok(fs.readFileSync(first.candidatePath).equals(bytes));
}));
test("partial candidate, missing binding, orphan receipt and bad receipt fail closed",async()=>{
 for(const mutation of [r=>fs.writeFileSync(r.candidatePath,"partial"),r=>fs.unlinkSync(sibling(r.candidatePath,".binding.json")),r=>fs.unlinkSync(r.candidatePath),r=>fs.writeFileSync(sibling(r.candidatePath,".receipt.json"),"{}")])await privateRun(async dir=>{
  const f=fixture(),first=await D.prepareCandidate({...f,outputDirectory:dir});mutation(first);const names=fs.readdirSync(dir),before=names.map(n=>fs.readFileSync(path.join(dir,n)).toString("hex"));
  await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}),{message:"E_RECOVERY_REQUIRED"});assert.deepEqual(fs.readdirSync(dir),names);assert.deepEqual(names.map(n=>fs.readFileSync(path.join(dir,n)).toString("hex")),before);
 });
});
test("candidate mismatch is checked by fresh desired data even with matching file hash",()=>privateRun(async dir=>{
 const f=fixture(),first=await D.prepareCandidate({...f,outputDirectory:dir}),data=U.decrypt(JSON.parse(fs.readFileSync(first.candidatePath)),f.password);data.holdings[0].value++;
 const bytes=Buffer.from(JSON.stringify(U.encrypt(data,f.password)));fs.writeFileSync(first.candidatePath,bytes);
 const receiptPath=sibling(first.candidatePath,".receipt.json"),receipt=JSON.parse(fs.readFileSync(receiptPath));receipt.candidateSha256=U.hash(bytes);fs.writeFileSync(receiptPath,JSON.stringify(receipt));
 await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}),{message:"E_RECOVERY_REQUIRED"});
}));
test("concurrent writer is rejected and a stale owner is never reclaimed",()=>privateRun(async dir=>{
 const f=fixture(),pending=D.prepareCandidate({...f,outputDirectory:dir});
 await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}),{message:"E_RECOVERY_REQUIRED"});const first=await pending;
 const lock=sibling(first.candidatePath,".lock");fs.mkdirSync(lock,{mode:0o700});fs.writeFileSync(path.join(lock,"owner.json"),JSON.stringify({pid:999999,token:"stale-owner"}),{mode:0o600});
 await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}),{message:"E_RECOVERY_REQUIRED"});assert.ok(fs.existsSync(lock));
}));
test("caller mutations cannot change the packet after candidate work begins",()=>privateRun(async dir=>{
 const f=fixture(),expectedOperation=f.packet.operationId,pending=D.prepareCandidate({...f,outputDirectory:dir});f.packet.operationId="synthetic:changed";f.packet.snapshot.accounts[0].cashCents=999;
 const result=await pending;assert.equal(result.operationId,expectedOperation);assert.equal(U.decrypt(JSON.parse(fs.readFileSync(result.candidatePath)),f.password).holdings[0].value,120);
}));
function withMarket(f=fixture()){
 const market={asOf:"2026-10-16",source:"yahoo-chart",generatedAt:"2026-10-17T00:00:00Z",prices:{DEMO:[{date:"2024-12-31",close:10},{date:"2026-10-16",close:12}]}};
 f.marketContent=JSON.stringify(market,null,2)+"\n";
 f.packet.marketBinding={baselineSha256:"c".repeat(64),candidateSha256:U.hash(f.marketContent)};
 return f;
}
test("bound public market is supplied to both actual candidate calculations",()=>privateRun(async dir=>{
 const f=withMarket(),expected=JSON.parse(f.marketContent),seen=[];
 const build=U.buildAssetPayload,prepare=U.prepareUpdate;
 U.buildAssetPayload=(snapshot,previous,options)=>{seen.push(["build",copy(options.market)]);return build(snapshot,previous,options);};
 U.prepareUpdate=async options=>{seen.push(["prepare",copy(options.market)]);return prepare(options);};
 let result;try{result=await D.prepareCandidate({...f,outputDirectory:dir});}finally{U.buildAssetPayload=build;U.prepareUpdate=prepare;}
 assert.deepEqual(seen,[["build",expected],["prepare",expected]]);
 assert.equal(result.validatedMarketSha256,f.packet.marketBinding.candidateSha256);
 const receipt=JSON.parse(fs.readFileSync(sibling(result.candidatePath,".receipt.json")));
 assert.deepEqual(receipt.marketBinding,f.packet.marketBinding);
 assert.equal(receipt.candidateSha256,result.validatedSha256);
 assert.equal(U.decrypt(JSON.parse(fs.readFileSync(result.candidatePath)),f.password).holdings[0].value,120);
 assert.doesNotMatch(JSON.stringify(receipt),/yahoo-chart|DEMO|prices|close/);
}));
test("market content and exact sealed binding are required together and fail before writes",()=>privateRun(async dir=>{
 const mutations=[
  f=>delete f.marketContent,
  f=>delete f.packet.marketBinding,
  f=>f.packet.marketBinding=null,
  f=>f.packet.marketBinding.baselineSha256="bad",
  f=>f.packet.marketBinding.candidateSha256="d".repeat(64),
  f=>f.packet.marketBinding.extra="unexpected",
  f=>{f.marketContent="{}";f.packet.marketBinding.candidateSha256=U.hash(f.marketContent);},
  f=>{const market=JSON.parse(f.marketContent);market.secret="synthetic-private-marker";f.marketContent=JSON.stringify(market);f.packet.marketBinding.candidateSha256=U.hash(f.marketContent);},
 ];
 for(const mutate of mutations){const f=withMarket();mutate(f);await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}));assert.deepEqual(fs.readdirSync(dir),[]);}
}));
test("opening authorization or an existing opening audit cannot use the legacy unbound path",()=>privateRun(async dir=>{
 for(const existingAudit of [false,true]){
  const f=fixture();
  if(existingAudit){const old=U.decrypt(JSON.parse(f.existingBytes),f.password);old.openingPositionAudit={version:1};f.existingBytes=Buffer.from(JSON.stringify(U.encrypt(old,f.password)));f.packet.baselineSha256=U.hash(f.existingBytes);f.packet.snapshot.previousCiphertextSha256=f.packet.baselineSha256;}
  else f.packet.policy.openingPositionAuthorization={version:1};
  await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}),{message:"MARKET_BINDING_REQUIRED"});assert.deepEqual(fs.readdirSync(dir),[]);
 }
}));
test("a newly derived opening audit also requires an explicit market binding",()=>privateRun(async dir=>{
 const f=fixture(),build=U.buildAssetPayload;
 U.buildAssetPayload=(...args)=>({...build(...args),openingPositionAudit:{version:1}});
 try{await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}),{message:"MARKET_BINDING_REQUIRED"});}finally{U.buildAssetPayload=build;}
 assert.deepEqual(fs.readdirSync(dir),[]);
}));
test("recovery reuses ciphertext only for the same public market content and baseline binding",()=>privateRun(async dir=>{
 const f=withMarket(),first=await D.prepareCandidate({...f,outputDirectory:dir}),bytes=fs.readFileSync(first.candidatePath);
 assert.deepEqual(await D.prepareCandidate({...f,outputDirectory:dir}),first);
 const originalBinding=copy(f.packet.marketBinding),originalContent=f.marketContent;
 f.packet.marketBinding.baselineSha256="d".repeat(64);
 await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}),{message:"E_RECOVERY_REQUIRED"});
 f.packet.marketBinding=originalBinding;const changed=JSON.parse(f.marketContent);changed.prices.DEMO[0].close++;
 f.marketContent=JSON.stringify(changed);f.packet.marketBinding.candidateSha256=U.hash(f.marketContent);
 await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}),{message:"E_RECOVERY_REQUIRED"});
 assert.ok(fs.readFileSync(first.candidatePath).equals(bytes));
 f.marketContent=originalContent;f.packet.marketBinding.candidateSha256=U.hash(originalContent);
 assert.deepEqual(await D.prepareCandidate({...f,outputDirectory:dir}),first);
}));
test("market validation precedes no-change detection and caller binding mutations are isolated",()=>privateRun(async dir=>{
 const f=withMarket(),expectedHash=f.packet.marketBinding.candidateSha256,pending=D.prepareCandidate({...f,outputDirectory:dir});
 f.packet.marketBinding.candidateSha256="d".repeat(64);
 const first=await pending;assert.equal(first.validatedMarketSha256,expectedHash);
 f.packet.marketBinding.candidateSha256=expectedHash;f.existingBytes=fs.readFileSync(first.candidatePath);
 f.packet.baselineSha256=U.hash(f.existingBytes);f.packet.snapshot.previousCiphertextSha256=f.packet.baselineSha256;f.packet.operationId="synthetic:bound-noop";
 const second=await D.prepareCandidate({...f,outputDirectory:dir});assert.equal(second.status,"unchanged");assert.equal(second.validatedMarketSha256,expectedHash);
 f.marketContent+=" ";await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}),{message:"MARKET_CANDIDATE_CHANGED"});
}));
async function nativeMarketRun(f,dir,{marketMode=0o600,includeMarket=true}={}){
 const baseline=path.join(dir,"baseline.enc.json"),passwordFile=path.join(dir,"password.txt"),marketFile=path.join(dir,"public-market.json");
 fs.writeFileSync(baseline,f.existingBytes,{mode:0o600});fs.writeFileSync(passwordFile,f.password+"\n",{mode:0o600});fs.writeFileSync(marketFile,f.marketContent,{mode:marketMode});
 f.packet.snapshot.fetchedAt=new Date().toISOString();
 const args=[path.join(__dirname,"finances_daily.cjs"),"--serve-file","--expected-head",head,"--baseline",baseline,"--output-dir",dir,"--password-file",passwordFile,...(includeMarket?["--market",marketFile]:[])];
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{stdio:["pipe","pipe","pipe"]});let stdout="",stderr="",sent=false;
  const timer=setTimeout(()=>{child.kill();reject(new Error("synthetic native market timeout"));},30000);
  child.on("error",()=>{clearTimeout(timer);reject(new Error("synthetic native market start failed"));});
  child.stdout.on("data",chunk=>{stdout+=chunk.toString();if(!sent&&stdout.includes("\n")){
   try{const end=stdout.indexOf("\n"),header=JSON.parse(stdout.slice(0,end));stdout=stdout.slice(end+1);sent=true;const packet=copy(f.packet);packet.sessionId=header.sessionId;child.stdin.end(JSON.stringify(T.seal(packet,header))+"\n");}
   catch{child.kill();clearTimeout(timer);reject(new Error("synthetic native market transport failed"));}
  }});
  child.stderr.on("data",chunk=>{stderr+=chunk.toString();});
  child.on("close",code=>{clearTimeout(timer);try{resolve({code,result:JSON.parse((stdout.trim()||stderr.trim()))});}catch{reject(new Error("synthetic native market result invalid"));}});
 });
}
test("CLI reads only an explicitly provided private market file bound by the sealed packet",()=>privateRun(async dir=>{
 const f=withMarket(),result=await nativeMarketRun(f,dir);
 assert.equal(result.code,0);assert.equal(result.result.status,"validated");assert.equal(result.result.validatedMarketSha256,f.packet.marketBinding.candidateSha256);
}));
test("CLI refuses public permissions or a missing explicit market file",async()=>{
 for(const options of [{marketMode:0o644},{includeMarket:false}])await privateRun(async dir=>{
  const result=await nativeMarketRun(withMarket(),dir,options);assert.notEqual(result.code,0);assert.equal(result.result.status,"failed");
  assert.equal(fs.readdirSync(dir).some(name=>name.startsWith("candidate-")),false);
 });
});
function openingFixture(){
 const f=withMarket(),account="synthetic-bank",cutoff="2025-06-30",old=U.decrypt(JSON.parse(f.existingBytes),f.password);
 old.asOf=cutoff;old.holdings.push({ticker:"DEMO",type:"stock",shares:10,value:100,costBasis:100});
 old.performance={...old.performance,totalCurrentValue:200,totalPrincipal:190,totalReturnPct:100/19};
 old.trading={DEMO:{orders:[{date:"2025-01-15",side:"buy",shares:2,price:10}],prices:[]}};
 old.historySnapshot=copy(old);old.historyStatus={state:"preserved",asOf:cutoff};
 old.tradeSync={version:1,baselineCutoff:cutoff,accountHashes:[U.hash(account)],transactions:[],queriedFrom:cutoff,sourceAsOf:null,allPagesFetched:true,dateBasis:"provider-settlement-date",historyFromInception:false};
 f.existingBytes=Buffer.from(JSON.stringify(U.encrypt(old,f.password)));f.packet.baselineSha256=U.hash(f.existingBytes);f.packet.snapshot.previousCiphertextSha256=f.packet.baselineSha256;
 f.packet.policy.openingPositionAuthorization={version:1,authorizationRef:"synthetic-opening-user-message",historySha256:U.hash(U.canonical(old.historySnapshot))};
 const snapshot=f.packet.snapshot;snapshot.accounts[0].type="brokerage";snapshot.accounts[0].securitiesCents=12000;snapshot.accounts[0].totalCents=24000;
 snapshot.positions=[{accountId:account,ticker:"DEMO",type:"stock",shares:10,valueCents:12000,costBasisCents:10000}];snapshot.reconciliation.totalValueCents=24000;
 snapshot.tradeUpdates={version:1,accountIds:[account],allPagesFetched:true,dateBasis:"provider-settlement-date",queriedFrom:cutoff,sourceAsOf:null,rows:[]};
 const market=JSON.parse(f.marketContent);market.prices.DEMO.splice(1,0,{date:"2025-12-31",close:11});
 f.marketContent=JSON.stringify(market,null,2)+"\n";f.packet.marketBinding.candidateSha256=U.hash(f.marketContent);
 return f;
}
test("complete opening candidate passes the production annual calculation before encryption",()=>privateRun(async dir=>{
 const f=openingFixture(),r=await D.prepareCandidate({...f,outputDirectory:dir});
 const next=U.decrypt(JSON.parse(fs.readFileSync(r.candidatePath)),f.password),ui=U.browserContract(f.html);
 assert.equal(next.openingPositionAudit.version,1);assert.deepEqual(next.trading.DEMO.openingPosition,{version:1,asOf:"2024-12-31",shares:8});
 ui.state.raw=next;ui.state.data=ui.normalizeData(copy(next));ui.state.marketPrices=JSON.parse(f.marketContent);
 assert.deepEqual(copy(ui.computeAnnualSummary().years.map(year=>[year.year,year.startValue,year.endValue,year.buys,year.sells,year.stockPnl])),[[2025,80,110,20,0,10],[2026,110,120,0,0,10]]);
 assert.equal(r.validatedMarketSha256,f.packet.marketBinding.candidateSha256);
}));
test("real annual price coverage rejects future and eight-day-old opening marks without any candidate",async()=>{
 for(const date of ["2025-01-02","2024-12-23"])await privateRun(async dir=>{
  const f=openingFixture(),market=JSON.parse(f.marketContent);market.prices.DEMO[0].date=date;
  f.marketContent=JSON.stringify(market);f.packet.marketBinding.candidateSha256=U.hash(f.marketContent);
  await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}),{message:"OPENING_PRICE_COVERAGE_REQUIRED"});assert.deepEqual(fs.readdirSync(dir),[]);
 });
 await privateRun(async dir=>{
  const f=openingFixture(),market=JSON.parse(f.marketContent);market.prices.DEMO[0].date="2024-12-24";
  f.marketContent=JSON.stringify(market);f.packet.marketBinding.candidateSha256=U.hash(f.marketContent);
  assert.equal((await D.prepareCandidate({...f,outputDirectory:dir})).status,"validated");
 });
});
test("recovery reruns the actual browser annual contract before reusing ciphertext",()=>privateRun(async dir=>{
 const f=openingFixture(),first=await D.prepareCandidate({...f,outputDirectory:dir}),bytes=fs.readFileSync(first.candidatePath);
 f.html=f.html.replace("function computeAnnualSummary() {",'function computeAnnualSummary() { throw new Error("SYNTHETIC_ANNUAL_REJECTION");');
 await assert.rejects(()=>D.prepareCandidate({...f,outputDirectory:dir}),{message:"SYNTHETIC_ANNUAL_REJECTION"});assert.ok(fs.readFileSync(first.candidatePath).equals(bytes));
}));
