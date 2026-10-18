"use strict";
// Uses only the native binary's compile-time synthetic secret, never Keychain.
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),readline=require("node:readline");
const {spawn,spawnSync}=require("node:child_process");
const U=require("../update_finances.cjs"),T=require("../finances_transport.cjs");
const helper=process.argv[2];
assert(helper&&path.isAbsolute(helper));
const manifest=JSON.parse(fs.readFileSync(path.join(path.dirname(helper),"build-manifest.json")));
assert.equal(manifest.testOnly,true,"Production helper must never be exercised by synthetic credential tests");
const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"visual-card-native-test-")));
const password="native-synthetic-password-only",head="a".repeat(40);
async function runSession(baselinePath,operationId,hostile=false){
 const configPath=path.join(dir,`config-${operationId}.json`),outputDirectory=path.join(dir,`out-${operationId}`);fs.mkdirSync(outputDirectory,{mode:0o700});
 fs.writeFileSync(configPath,JSON.stringify({expectedHead:head,baselinePath,outputDirectory}),{mode:0o600});
 const fd=fs.openSync(configPath,"r"),marker=path.join(dir,"injected-marker"),injected=path.join(dir,"injected.cjs");
 fs.writeFileSync(injected,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'injected');process.exit(12);`);
 const child=spawn(helper,["--serve"],{cwd:dir,env:{...process.env,...(hostile?{NODE_OPTIONS:`--require ${injected}`,NODE_PATH:dir,PATH:dir}: {})},stdio:["pipe","pipe","pipe","ignore",fd]});fs.closeSync(fd);
 let stderr="",header,receipt,lines=0;child.stderr.on("data",d=>stderr+=d.toString());
 const ended=new Promise((resolve,reject)=>{child.on("error",reject);child.on("close",(code,signal)=>resolve({code,signal}));});
 const reader=readline.createInterface({input:child.stdout});
 reader.on("line",line=>{
  lines++;assert(!line.includes(password));
  if(lines===1){header=JSON.parse(line);const bytes=fs.readFileSync(baselinePath),proof={complete:true,allPagesFetched:true,sourceDateStatus:"unknown",updatedAt:null};
   const snapshot={schemaVersion:2,mode:"assets",source:"Finances",currency:"USD",fetchedAt:new Date().toISOString(),previousCiphertextSha256:U.hash(bytes),coverage:{accountsComplete:true,allPagesFetched:true,accountIds:["synthetic-bank"]},accounts:[{id:"synthetic-bank",type:"checking",currency:"USD",cashCents:12000,securitiesCents:0,totalCents:12000,coverage:{balances:proof,holdings:proof}}],positions:[],reconciliation:{independentSourceTotals:true,totalValueCents:12000,cashCents:12000}};
   const packet={version:1,operationId,sessionId:header.sessionId,expectedHead:head,baselineSha256:U.hash(bytes),snapshot,policy:{accountIds:["synthetic-bank"]}};
   child.stdin.end(JSON.stringify(T.seal(packet,header))+"\n");
  }else receipt=JSON.parse(line);
 });
 const timer=setTimeout(()=>child.kill("SIGKILL"),30000);const exit=await ended;clearTimeout(timer);
 if(exit.code!==0)throw new Error(`NATIVE_CHILD_${String(exit.code)}_${/^E_[A-Z_]+\n$/.test(stderr)?stderr.trim():"REDACTED"}`);
 assert.equal(exit.signal,null);assert.equal(stderr,"");assert.equal(lines,2);assert.equal(fs.existsSync(marker),false);assert.equal(receipt.publication,"disabled");
 return receipt;
}
(async()=>{try{
 const old={asOf:"2026-10-09",currency:"USD",holdings:[{ticker:"CASH",type:"cash",value:100}],performance:{totalCurrentValue:100,totalPrincipal:90,totalGain:10,totalReturnPct:100/9,items:[{label:"cash interest",kind:"cash_interest",gain:10}]}};
 const baseline=path.join(dir,"baseline.enc.json");fs.writeFileSync(baseline,JSON.stringify(U.encrypt(old,password)),{mode:0o600});
 fs.writeFileSync(path.join(dir,"index.html"),"throw new Error('MUTABLE_HTML_EXECUTED')");fs.writeFileSync(path.join(dir,"update_finances.cjs"),"throw new Error('MUTABLE_SCRIPT_EXECUTED')");
 for(const args of [["--read"],["--serve","anything.js"],["--enroll"]]){const r=spawnSync(helper,args,{encoding:"utf8"});assert.notEqual(r.status,0);assert.equal(r.stdout,"");assert(!r.stderr.includes(password));}
 const first=await runSession(baseline,"native-synthetic-first",true);assert.equal(first.status,"validated");
 const data=U.decrypt(JSON.parse(fs.readFileSync(first.candidatePath)),password);assert.equal(data.holdings[0].value,120);assert.deepEqual(data.performance,old.performance);assert.equal(fs.statSync(first.candidatePath).mode&0o777,0o600);
 const second=await runSession(first.candidatePath,"native-synthetic-repeat");assert.equal(second.status,"unchanged");
 console.log(JSON.stringify({status:"passed",checks:8,keychainItemsAccessed:false,credentialStorageEnabled:false}));
}finally{fs.rmSync(dir,{recursive:true,force:true});}})().catch(error=>{console.error(/^NATIVE_CHILD_[A-Z_0-9]+$/.test(error.message)?error.message:"NATIVE_HELPER_TEST_FAILED");process.exitCode=1;});
