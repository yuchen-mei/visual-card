"use strict";
const assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {test}=require("node:test"),T=require("./finances_transport.cjs"),D=require("./finances_daily.cjs"),U=require("./update_finances.cjs");
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
