#!/usr/bin/env node
"use strict";

// One tick over a private JSONL RPC. The trusted caller performs the job. This
// process holds the schedule's lock until a verified outcome is returned; it
// never installs a timer, queries Finances, obtains credentials or publishes.
const S=require("./finances_schedule.cjs");
const RESPONSE_TIMEOUT_MS=15*60*1000;
class BridgeError extends Error{constructor(code){super(code);this.code=code;}}
function check(ok,code){if(!ok)throw new BridgeError(code);}
function exactKeys(value,keys){return value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join(",")===keys.slice().sort().join(",");}
function operationForDay(day){return `visual-card-daily-${day}`;}
function parseOutcome(line,job){
 let value;try{value=JSON.parse(line);}catch{throw new BridgeError("E_BRIDGE_RESPONSE");}
 // A canonical single line rejects duplicate JSON keys and ignored text. The
 // caller uses JSON.stringify; no source payload or error prose is accepted.
 check(JSON.stringify(value)===line,"E_BRIDGE_RESPONSE");
 check(value?.idempotencyKey===job.idempotencyKey,"E_BRIDGE_KEY");
 if(value.status==="completed"){
  check(exactKeys(value,["status","idempotencyKey","outcome"])&&["published","unchanged"].includes(value.outcome),"E_BRIDGE_OUTCOME");
  return {status:"completed",idempotencyKey:job.idempotencyKey};
 }
 const optional=value.code===undefined?[]:["code"];
 if(optional.length)check(typeof value.code==="string"&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value.code),"E_BRIDGE_RESPONSE");
 if(value.status==="retryable"){
  check(exactKeys(value,["status","idempotencyKey","safeToRetry",...optional])&&value.safeToRetry===true,"E_BRIDGE_OUTCOME");
  return {status:"retryable",idempotencyKey:job.idempotencyKey,safeToRetry:true,...(optional.length?{code:value.code}:{})};
 }
 check(["failure","recovery_required"].includes(value.status)&&exactKeys(value,["status","idempotencyKey",...optional]),"E_BRIDGE_OUTCOME");
 return {status:value.status,idempotencyKey:job.idempotencyKey,...(optional.length?{code:value.code}:{})};
}
function writeLine(output,value){return new Promise((resolve,reject)=>{output.write(`${JSON.stringify(value)}\n`,error=>error?reject(new BridgeError("E_BRIDGE_OUTPUT")):resolve());});}
function requestRun(job,{input,output,timeoutMs}){
 return new Promise((resolve,reject)=>{
  let settled=false,buffer=Buffer.alloc(0);
  const cleanup=()=>{clearTimeout(timer);input.removeListener("data",onData);input.removeListener("end",onEnd);input.removeListener("close",onEnd);input.removeListener("error",onError);input.pause();};
  const finish=(error,value)=>{if(settled)return;settled=true;cleanup();if(error)reject(error);else resolve(value);};
  const onEnd=()=>finish(new BridgeError("E_BRIDGE_EOF"));
  const onError=()=>finish(new BridgeError("E_BRIDGE_INPUT"));
  const onData=chunk=>{
   try{
    buffer=Buffer.concat([buffer,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);
    check(buffer.length<=4096,"E_BRIDGE_RESPONSE");
    const newline=buffer.indexOf(10);if(newline<0)return;
    check(newline===buffer.length-1,"E_BRIDGE_RESPONSE");
    const line=buffer.subarray(0,newline).toString("utf8").replace(/\r$/,"");
    finish(null,parseOutcome(line,job));
   }catch(error){finish(error instanceof BridgeError?error:new BridgeError("E_BRIDGE_RESPONSE"));}
  };
  const timer=setTimeout(()=>finish(new BridgeError("E_BRIDGE_TIMEOUT")),timeoutMs);
  input.on("data",onData);input.once("end",onEnd);input.once("close",onEnd);input.once("error",onError);
  if(input.readableEnded||input.destroyed){onEnd();return;}
  writeLine(output,{status:"run_requested",idempotencyKey:job.idempotencyKey,operationId:operationForDay(job.day),day:job.day,dueAt:job.dueAt}).catch(finish);
  if(!settled)input.resume();
 });
}
async function bridge({statePath,notBefore},{input=process.stdin,output=process.stdout,clock=Date.now,timeoutMs=RESPONSE_TIMEOUT_MS}={}){
 let code;
 try{
  check(typeof clock==="function"&&Number.isSafeInteger(timeoutMs)&&timeoutMs>0,"E_BRIDGE_CONFIG");
  const result=await S.tick({now:clock(),statePath,notBefore},{
   // Execution of this local program proves only this Mac is online. The caller
   // must still verify connector availability and the remote publication result.
   isOnline:()=>true,clock,
   run:async job=>{
    try{const outcome=await requestRun(job,{input,output,timeoutMs});if(outcome.status!=="completed")code=outcome.code||(outcome.status==="retryable"?"E_JOB_RETRYABLE":"E_JOB_RECOVERY_REQUIRED");return outcome;}
    catch(error){code=error instanceof BridgeError?error.code:"E_BRIDGE_RESPONSE";throw error;}
   }
  });
  const final={type:"final",status:result.status,notify:["retry_scheduled","recovery_required","locked"].includes(result.status)};
  for(const key of ["idempotencyKey","day","dueAt","nextAt"])if(result[key]!==undefined)final[key]=result[key];
  if(result.day)final.operationId=operationForDay(result.day);
  if(code)final.code=code;
  await writeLine(output,final);return final;
 }catch(error){
  const final={type:"final",status:"failed",notify:true,code:error instanceof BridgeError||error instanceof S.ScheduleError?error.code:"E_SCHEDULE_BRIDGE"};
  await writeLine(output,final);return final;
 }
}
function argumentsFor(args){
 if(args.length===1&&args[0]==="--help")return null;
 check(args.length===4&&args[0]==="--state"&&args[2]==="--not-before","E_BRIDGE_ARGUMENTS");
 check(typeof args[3]==="string"&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(args[3]),"E_BRIDGE_ARGUMENTS");
 return {statePath:args[1],notBefore:args[3]};
}
async function main(args){
 let options;try{options=argumentsFor(args);}catch(error){await writeLine(process.stdout,{type:"final",status:"failed",notify:true,code:"E_BRIDGE_ARGUMENTS"});return 1;}
 if(options===null){process.stdout.write("Usage: node scripts/finances_schedule_bridge.cjs --state PRIVATE_STATE_PATH --not-before ISO_TIMESTAMP\nOne JSONL schedule tick using the real clock. Respond to run_requested with one canonical JSON line. Completed requires outcome published or unchanged; retryable requires safeToRetry:true. EOF, timeout, invalid input or unknown outcomes keep pending. No scheduler is installed.\n");return 0;}
 const final=await bridge(options);
 return final.status==="failed"?1:final.status==="recovery_required"?2:final.status==="locked"?3:0;
}
if(require.main===module)main(process.argv.slice(2)).then(code=>{process.stdin.destroy();process.exitCode=code;}).catch(()=>{process.stdin.destroy();process.exitCode=1;});
module.exports={bridge,parseOutcome,operationForDay,argumentsFor,main,BridgeError,RESPONSE_TIMEOUT_MS};
