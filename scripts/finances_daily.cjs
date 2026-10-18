#!/usr/bin/env node
"use strict";

// Local one-shot candidate builder. Deliberately has no publication or scheduler
// activation option. The native launcher must pin this complete program and HTML.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),readline=require("node:readline");
const U=require("./update_finances.cjs");
const ROOT=path.resolve(__dirname,"..");
const PROTOCOL="visual-card-rsa-oaep-sha256-v1";
function check(ok,code){if(!ok)throw new U.ValidationError(code);}
function privateDirectory(dir){
 const real=fs.realpathSync(dir),st=fs.statSync(real);
 check(real!==ROOT&&!real.startsWith(ROOT+path.sep)&&st.isDirectory()&&st.uid===process.getuid()&&(st.mode&0o077)===0,"PRIVATE_OUTPUT_DIRECTORY_REQUIRED");return real;
}
function createSession({expectedHead,baselineSha256,now=Date.now()}){
 check(/^[a-f0-9]{40}$/.test(expectedHead)&&/^[a-f0-9]{64}$/.test(baselineSha256),"INVALID_BASELINE_BINDING");
 const keys=crypto.generateKeyPairSync("rsa",{modulusLength:3072}),sessionId=crypto.randomUUID(),expiresAt=new Date(now+300000).toISOString();
 let consumed=false;
 const header={protocol:PROTOCOL,sessionId,expectedHead,baselineSha256,expiresAt,publicKey:keys.publicKey.export({format:"jwk"}),seeds:Array.from({length:128},()=>crypto.randomBytes(32).toString("hex"))};
 function open(sealed,{now=Date.now()}={}){
  check(!consumed,"TRANSPORT_ALREADY_CONSUMED");consumed=true;
  check(now<=Date.parse(expiresAt)&&sealed?.protocol===PROTOCOL&&sealed.sessionId===sessionId,"TRANSPORT_SESSION_MISMATCH");
  check(Array.isArray(sealed.blocks)&&sealed.blocks.length>0&&sealed.blocks.length<=128,"INVALID_SEALED_INPUT");
  const chunks=[];let digest;
  try{
   for(let i=0;i<sealed.blocks.length;i++){
    const b=sealed.blocks[i];check(typeof b==="string"&&/^[a-f0-9]{768}$/.test(b),"INVALID_SEALED_INPUT");
    const plain=crypto.privateDecrypt({key:keys.privateKey,oaepHash:"sha256"},Buffer.from(b,"hex"));
    check(plain.length>40&&plain.readUInt32BE(32)===i&&plain.readUInt32BE(36)===sealed.blocks.length,"TRANSPORT_BLOCK_MISMATCH");
    if(!digest)digest=Buffer.from(plain.subarray(0,32));else check(digest.equals(plain.subarray(0,32)),"TRANSPORT_BLOCK_MISMATCH");
    chunks.push(Buffer.from(plain.subarray(40)));plain.fill(0);
   }
   const bytes=Buffer.concat(chunks);check(bytes.length<=32768&&crypto.createHash("sha256").update(bytes).digest().equals(digest),"TRANSPORT_DIGEST_MISMATCH");
   const packet=JSON.parse(bytes.toString("utf8"));bytes.fill(0);
   check(packet.sessionId===sessionId&&packet.expectedHead===expectedHead&&packet.baselineSha256===baselineSha256,"TRANSPORT_BASELINE_MISMATCH");
   return packet;
  }catch(e){if(e instanceof U.ValidationError)throw e;throw new U.ValidationError("SEALED_INPUT_REJECTED");}
  finally{chunks.forEach(b=>b.fill(0));}
 }
 return {header,open};
}
function syncDirectory(dir){const fd=fs.openSync(dir,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function privateBytes(file){
 const st=fs.lstatSync(file);
 check(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o077)===0&&st.size<=24*1024*1024,"E_RECOVERY_REQUIRED");
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const actual=fs.fstatSync(fd);check(actual.dev===st.dev&&actual.ino===st.ino,"E_RECOVERY_REQUIRED");return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
function exists(file){try{fs.lstatSync(file);return true;}catch(error){if(error.code==="ENOENT")return false;throw error;}}
function writeMetadata(file,value){
 const temporary=`${file}.${crypto.randomUUID()}.tmp`,dir=path.dirname(file);
 let fd;
 try{
  fd=fs.openSync(temporary,"wx",0o600);fs.writeFileSync(fd,JSON.stringify(value)+"\n");fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  // Hard-link installation is atomic and cannot replace an existing receipt.
  fs.linkSync(temporary,file);fs.unlinkSync(temporary);syncDirectory(dir);
 }finally{if(fd!==undefined)fs.closeSync(fd);if(exists(temporary))fs.unlinkSync(temporary);}
}
async function prepareCandidate({packet,existingBytes,password,html,outputDirectory,now=Date.now()}){
 packet=JSON.parse(JSON.stringify(packet));existingBytes=Buffer.from(existingBytes);
 check(packet?.version===1&&typeof packet.operationId==="string"&&/^[a-zA-Z0-9:._-]{1,120}$/.test(packet.operationId),"INVALID_OPERATION");
 check(Object.keys(packet).every(k=>["version","operationId","sessionId","expectedHead","baselineSha256","snapshot","policy"].includes(k)),"UNEXPECTED_PACKET_FIELDS");
 check(packet.snapshot?.mode==="assets","DAILY_MODE_MUST_BE_ASSETS");
 check(/^[a-f0-9]{40}$/.test(packet.expectedHead)&&/^[a-f0-9]{64}$/.test(packet.baselineSha256),"INVALID_BASELINE_BINDING");
 check(packet.baselineSha256===U.hash(existingBytes)&&packet.snapshot.previousCiphertextSha256===packet.baselineSha256,"BASELINE_CHANGED");
 const base={operationId:packet.operationId,expectedHead:packet.expectedHead,baselineSha256:packet.baselineSha256,publication:"disabled"};
 const dir=privateDirectory(outputDirectory),operationHash=U.hash(packet.operationId),stem=path.join(dir,`candidate-${operationHash.slice(0,24)}`);
 const candidatePath=`${stem}.enc.json`,bindingPath=`${stem}.binding.json`,receiptPath=`${stem}.receipt.json`,lockPath=`${stem}.lock`;
 // Never reclaim a lock by PID/age: an interrupted owner requires explicit
 // recovery, and a concurrent run must not overwrite an uncertain candidate.
 try{fs.mkdirSync(lockPath,{mode:0o700});}catch{throw new U.ValidationError("E_RECOVERY_REQUIRED");}
 const lockToken=crypto.randomUUID(),ownerPath=path.join(lockPath,"owner.json");
 try{
  writeMetadata(ownerPath,{version:1,pid:process.pid,token:lockToken});syncDirectory(dir);
  const oldEnvelope=JSON.parse(existingBytes),previous=U.decrypt(oldEnvelope,password);
  const desired=U.buildAssetPayload(packet.snapshot,previous,{html,now,policy:packet.policy});
  const desiredBusiness=U.canonical(U.businessData(desired));
  const binding={version:1,operationHash,expectedHead:packet.expectedHead,baselineSha256:packet.baselineSha256,businessSha256:U.hash(desiredBusiness)};
  const hasCandidate=exists(candidatePath),hasBinding=exists(bindingPath),hasReceipt=exists(receiptPath);
  if(hasCandidate||hasBinding||hasReceipt){
   try{
    check(hasBinding&&hasCandidate,"E_RECOVERY_REQUIRED");
    check(U.canonical(JSON.parse(privateBytes(bindingPath)))===U.canonical(binding),"E_RECOVERY_REQUIRED");
    const bytes=privateBytes(candidatePath),envelope=JSON.parse(bytes);U.validateEnvelope(envelope);
    for(const key of ["version","kdf","iterations","cipher"])check(envelope[key]===oldEnvelope[key],"E_RECOVERY_REQUIRED");
    const candidate=U.decrypt(envelope,password);
    check(U.canonical(U.businessData(candidate))===desiredBusiness,"E_RECOVERY_REQUIRED");
    check(U.canonical(await U.browserContract(html).decryptPayload(envelope,password))===U.canonical(candidate),"E_RECOVERY_REQUIRED");
    const receipt={...binding,candidateSha256:U.hash(bytes)};
    if(hasReceipt)check(U.canonical(JSON.parse(privateBytes(receiptPath)))===U.canonical(receipt),"E_RECOVERY_REQUIRED");
    else writeMetadata(receiptPath,receipt);
    return {...base,status:"validated",candidatePath,validatedSha256:receipt.candidateSha256};
   }catch{throw new U.ValidationError("E_RECOVERY_REQUIRED");}
  }
  if(U.canonical(U.businessData(previous))===desiredBusiness)return {...base,status:"unchanged"};
  // Persist the original binding before creating ciphertext. A receipt-less
  // candidate can only be recovered with this independently saved baseline.
  writeMetadata(bindingPath,binding);
  const result=await U.prepareUpdate({snapshot:packet.snapshot,policy:packet.policy,existingBytes,password,html,now});
  check(result.status==="changed","E_RECOVERY_REQUIRED");
  const fd=fs.openSync(candidatePath,"wx",0o600);try{fs.writeFileSync(fd,result.bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  syncDirectory(dir);
  const receipt={...binding,candidateSha256:U.hash(result.bytes)};writeMetadata(receiptPath,receipt);
  return {...base,status:"validated",candidatePath,validatedSha256:receipt.candidateSha256};
 }finally{
  // Remove only the lock this call created. Anything unexpected stays for review.
  try{const owner=JSON.parse(privateBytes(ownerPath));if(owner.token===lockToken){fs.unlinkSync(ownerPath);fs.rmdirSync(lockPath);syncDirectory(dir);}}catch{}
 }
}
async function main(args){
 if(args.length===1&&args[0]==="--help"){console.log("Usage: node scripts/finances_daily.cjs --serve --expected-head SHA40 --baseline ENCRYPTED_JSON --output-dir PRIVATE_DIRECTORY\nPassword: inherited VISUAL_CARD_PASSWORD_FD. Reads one sealed stdin line, writes only a validated encrypted candidate. Never publishes. Treat the entire transport header as private runtime data: never display or persist it.");return;}
 check(args.length===7&&args[0]==="--serve"&&args[1]==="--expected-head"&&args[3]==="--baseline"&&args[5]==="--output-dir","INVALID_ARGUMENTS");
 const expectedHead=args[2],baselinePath=fs.realpathSync(args[4]),outputDirectory=privateDirectory(args[6]);
 check(fs.statSync(baselinePath).isFile(),"INVALID_BASELINE_FILE");
 const existingBytes=fs.readFileSync(baselinePath);U.validateEnvelope(JSON.parse(existingBytes));
 const fd=Number(process.env.VISUAL_CARD_PASSWORD_FD);check(Number.isInteger(fd)&&fd>=3&&fd<=1024,"PASSWORD_FD_REQUIRED");
 const secret=fs.readFileSync(fd);check(secret.length>0&&secret.length<=4096,"INVALID_PASSWORD_INPUT");
 const password=new TextDecoder("utf-8",{fatal:true}).decode(secret).replace(/\r?\n$/,"");secret.fill(0);
 const session=createSession({expectedHead,baselineSha256:U.hash(existingBytes)});
 process.stdout.write(JSON.stringify(session.header)+"\n");
 const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
 const timer=setTimeout(()=>{rl.close();process.stderr.write('{"status":"failed","code":"TRANSPORT_EXPIRED","productionPreserved":true}\n');process.exit(1);},300000);
 let sawLine=false;
 rl.once("line",async line=>{sawLine=true;clearTimeout(timer);try{
  check(line.length<=110000,"INVALID_SEALED_INPUT");
  const packet=session.open(JSON.parse(line));
  check(U.hash(fs.readFileSync(baselinePath))===U.hash(existingBytes),"BASELINE_CHANGED");
  const result=await prepareCandidate({packet,existingBytes,password,html:fs.readFileSync(path.join(ROOT,"index.html"),"utf8"),outputDirectory});
  process.stdout.write(JSON.stringify(result)+"\n");
 }catch(error){process.stderr.write(JSON.stringify({status:"failed",code:error instanceof U.ValidationError?error.message:"DAILY_PREPARATION_FAILED",productionPreserved:true})+"\n");process.exitCode=1;}finally{rl.close();process.exit(process.exitCode||0);}});
 rl.once("close",()=>{if(!sawLine){clearTimeout(timer);process.exitCode=1;}});
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(JSON.stringify({status:"failed",code:error instanceof U.ValidationError?error.message:"DAILY_PREPARATION_FAILED",productionPreserved:true}));process.exitCode=1;});
module.exports={createSession,prepareCandidate,main};
