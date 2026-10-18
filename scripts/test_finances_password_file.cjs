#!/usr/bin/env node
"use strict";

// Only temporary synthetic passwords and portfolios; no Keychain or real data.
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {spawn}=require("node:child_process"),{test}=require("node:test");
const D=require("./finances_daily.cjs"),U=require("./update_finances.cjs");
const head="a".repeat(40),password="synthetic-password-file-test-only";
const script=path.join(__dirname,"finances_daily.cjs");
async function temporary(run){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"vc-password-file-")));fs.chmodSync(dir,0o700);
 try{return await run(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}
}
function passwordFile(dir){const file=path.join(dir,"synthetic-password");fs.writeFileSync(file,password+"\n",{mode:0o600});return file;}
function seal(packet,header){
 const bytes=Buffer.from(JSON.stringify(packet)),digest=crypto.createHash("sha256").update(bytes).digest();
 const key=crypto.createPublicKey({key:header.publicKey,format:"jwk"}),size=278,count=Math.ceil(bytes.length/size),blocks=[];
 for(let index=0;index<count;index++){
  const prefix=Buffer.alloc(40);digest.copy(prefix);prefix.writeUInt32BE(index,32);prefix.writeUInt32BE(count,36);
  blocks.push(crypto.publicEncrypt({key,oaepHash:"sha256"},Buffer.concat([prefix,bytes.subarray(index*size,(index+1)*size)])).toString("hex"));
 }
 return {protocol:header.protocol,sessionId:header.sessionId,blocks};
}
function fixture(){
 const old={asOf:"2025-01-02",currency:"USD",holdings:[{ticker:"CASH",type:"cash",value:100}],performance:{totalCurrentValue:100,totalPrincipal:90,totalGain:10,totalReturnPct:100/9,items:[{label:"cash interest",kind:"cash_interest",gain:10}]}};
 const bytes=Buffer.from(JSON.stringify(U.encrypt(old,password))),hash=U.hash(bytes);
 const proof={complete:true,allPagesFetched:true,sourceDateStatus:"unknown",updatedAt:null};
 const snapshot={schemaVersion:2,mode:"assets",source:"Finances",currency:"USD",fetchedAt:new Date().toISOString(),previousCiphertextSha256:hash,
  coverage:{accountsComplete:true,allPagesFetched:true,accountIds:["synthetic-bank"]},
  accounts:[{id:"synthetic-bank",type:"checking",currency:"USD",cashCents:12000,securitiesCents:0,totalCents:12000,coverage:{balances:proof,holdings:proof}}],positions:[],
  reconciliation:{independentSourceTotals:true,totalValueCents:12000,cashCents:12000}};
 return {bytes,hash,snapshot};
}
async function runCli(dir,{fdMode=false,invalidMode=false,padding=0}={}){
 const file=passwordFile(dir),f=fixture(),baseline=path.join(dir,"baseline.enc.json");
 fs.writeFileSync(baseline,f.bytes,{mode:0o600});if(invalidMode)fs.chmodSync(file,0o644);
 const args=[script,fdMode?"--serve":"--serve-file","--expected-head",head,"--baseline",baseline,"--output-dir",dir];
 if(!fdMode)args.push("--password-file",file);
 const env={...process.env};delete env.VISUAL_CARD_PASSWORD_FD;
 const stdio=["pipe","pipe","pipe"];let fd;
 if(fdMode){fd=fs.openSync(file,"r");stdio.push(fd);env.VISUAL_CARD_PASSWORD_FD="3";}
 const child=spawn(process.execPath,args,{env,stdio});if(fd!==undefined)fs.closeSync(fd);
 return await new Promise((resolve,reject)=>{
  let output="",pending="",stderr="",headerSeen=false,received=[];
  const timer=setTimeout(()=>{child.kill();reject(Error("SYNTHETIC_CLI_TIMEOUT"));},15000);
  child.once("error",error=>{clearTimeout(timer);reject(error);});
  child.stdin.on("error",()=>{});
  child.stderr.on("data",chunk=>{stderr+=chunk;});
  child.stdout.on("data",chunk=>{
   output+=chunk;pending+=chunk;
   try{
    let index;while((index=pending.indexOf("\n"))>=0){
     const line=pending.slice(0,index);pending=pending.slice(index+1);if(!line)continue;
     const value=JSON.parse(line);received.push(value);
     if(!headerSeen){
      headerSeen=true;assert.equal(value.seeds.length,512);
      const packet={version:1,operationId:"synthetic:password-file",sessionId:value.sessionId,expectedHead:head,baselineSha256:f.hash,snapshot:f.snapshot,policy:{accountIds:["synthetic-bank"]}};
      if(padding)packet.snapshot.syntheticPadding="x".repeat(padding);
      child.stdin.end(JSON.stringify(seal(packet,value))+"\n");
     }
    }
   }catch(error){clearTimeout(timer);child.kill();reject(error);}
  });
  child.once("close",code=>{clearTimeout(timer);resolve({code,output,stderr,received,baseline,original:f.bytes});});
 });
}

test("private password reader accepts only the exact file and directory permissions",()=>temporary(dir=>{
 const file=passwordFile(dir),secret=D.readPasswordFile(file);
 assert.equal(secret.toString(),password+"\n");secret.fill(0);
 for(const mode of [0o644,0o400,0o1600]){fs.chmodSync(file,mode);assert.throws(()=>D.readPasswordFile(file),{message:"E_PASSWORD_FILE"});}
 fs.chmodSync(file,0o600);fs.chmodSync(dir,0o755);
 assert.throws(()=>D.readPasswordFile(file),{message:"E_PASSWORD_FILE"});fs.chmodSync(dir,0o700);
 assert.throws(()=>D.readPasswordFile(__filename),{message:"E_PASSWORD_FILE"});
 for(const text of ["","x".repeat(4097)]){fs.writeFileSync(file,text);assert.throws(()=>D.readPasswordFile(file),{message:"E_PASSWORD_FILE"});}
}));

test("symlink, hardlink and replacement during open are rejected",()=>temporary(dir=>{
 const file=passwordFile(dir),link=path.join(dir,"alias");
 fs.symlinkSync(file,link);assert.throws(()=>D.readPasswordFile(link),{message:"E_PASSWORD_FILE"});fs.unlinkSync(link);
 fs.linkSync(file,link);assert.throws(()=>D.readPasswordFile(file),{message:"E_PASSWORD_FILE"});fs.unlinkSync(link);
 const originalOpen=fs.openSync;let replaced=false;
 fs.openSync=function(target,...args){
  if(target===file&&!replaced){replaced=true;fs.renameSync(file,file+".old");fs.writeFileSync(file,"synthetic-replacement",{mode:0o600});}
  return originalOpen.call(fs,target,...args);
 };
 try{assert.throws(()=>D.readPasswordFile(file),{message:"E_PASSWORD_FILE"});}finally{fs.openSync=originalOpen;}
}));

test("file-password CLI accepts a large sealed packet and produces decryptable ciphertext only",()=>temporary(async dir=>{
 const result=await runCli(dir,{padding:50000});
 assert.equal(result.code,0);assert.equal(result.stderr,"");
 const receipt=result.received.at(-1);assert.equal(receipt.status,"validated");assert.equal(receipt.publication,"disabled");
 const bytes=fs.readFileSync(receipt.candidatePath);
 assert.equal(U.hash(bytes),receipt.validatedSha256);assert.equal(U.decrypt(JSON.parse(bytes),password).holdings[0].value,120);
 assert.equal(fs.statSync(receipt.candidatePath).mode&0o777,0o600);
 assert.ok(fs.readFileSync(result.baseline).equals(result.original));
 assert.doesNotMatch(result.output+result.stderr,/synthetic-password-file-test-only|synthetic-bank|cashCents|syntheticPadding/);
}));

test("legacy inherited password descriptor remains compatible",()=>temporary(async dir=>{
 const result=await runCli(dir,{fdMode:true});assert.equal(result.code,0);assert.equal(result.stderr,"");
 const receipt=result.received.at(-1);assert.equal(receipt.status,"validated");
 assert.equal(U.decrypt(JSON.parse(fs.readFileSync(receipt.candidatePath)),password).holdings[0].value,120);
 assert.doesNotMatch(result.output+result.stderr,/synthetic-password-file-test-only|synthetic-bank|cashCents/);
}));

test("invalid file permissions fail with a fixed code before producing a session header",()=>temporary(async dir=>{
 const result=await runCli(dir,{invalidMode:true});assert.equal(result.code,1);assert.equal(result.output,"");
 assert.deepEqual(JSON.parse(result.stderr),{status:"failed",code:"E_PASSWORD_FILE",productionPreserved:true});
 assert.ok(fs.readFileSync(result.baseline).equals(result.original));
 assert.doesNotMatch(result.stderr,/synthetic-password-file-test-only|vc-password-file|synthetic-bank/);
}));

test("sealed packet accepts 128 KiB and rejects larger plaintext or more than 512 blocks",()=>{
 for(const length of [131072,131073]){
  const session=D.createSession({expectedHead:head,baselineSha256:"b".repeat(64)});
  const packet={sessionId:session.header.sessionId,expectedHead:head,baselineSha256:"b".repeat(64),payload:""};
  packet.payload="x".repeat(length-Buffer.byteLength(JSON.stringify(packet)));
  assert.equal(Buffer.byteLength(JSON.stringify(packet)),length);assert.equal(session.header.seeds.length,512);
  const sealed=seal(packet,session.header);assert.ok(sealed.blocks.length>128&&sealed.blocks.length<=512);
  if(length===131072)assert.deepEqual(session.open(sealed),packet);
  else assert.throws(()=>session.open(sealed),{message:"TRANSPORT_DIGEST_MISMATCH"});
 }
 const session=D.createSession({expectedHead:head,baselineSha256:"b".repeat(64)});
 assert.throws(()=>session.open({protocol:session.header.protocol,sessionId:session.header.sessionId,blocks:Array(513).fill("0".repeat(768))}),{message:"INVALID_SEALED_INPUT"});
});
