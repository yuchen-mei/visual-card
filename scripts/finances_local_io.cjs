#!/usr/bin/env node
"use strict";
// Ciphertext and schema-validated public-market filesystem boundary. No credential
// or decrypted portfolio is accepted; all diagnostics are fixed codes.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),U=require("./update_finances.cjs");
const ROOT=fs.realpathSync(path.join(__dirname,".."));
function check(ok){if(!ok)throw Error("E_CIPHERTEXT_IO");}
function directory(dir){const real=fs.realpathSync(dir),s=fs.statSync(real);check(real!==ROOT&&!real.startsWith(ROOT+path.sep)&&s.isDirectory()&&s.uid===process.getuid()&&(s.mode&0o077)===0);return real;}
function readEncrypted(dir,file){dir=directory(dir);check(path.dirname(file)===dir);const st=fs.lstatSync(file);check(st.isFile()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o077)===0&&st.size<24*1024*1024);const content=fs.readFileSync(file,"utf8");U.validateEnvelope(JSON.parse(content));return content;}
function writeBaseline(dir,sha,content){dir=directory(dir);check(/^[a-f0-9]{64}$/.test(sha)&&U.hash(content)===sha);U.validateEnvelope(JSON.parse(content));const target=path.join(dir,`baseline-${sha}.enc.json`);if(fs.existsSync(target)){check(U.hash(readEncrypted(dir,target))===sha);return target;}
 const temporary=path.join(dir,`.baseline-${crypto.randomUUID()}.tmp`);try{const fd=fs.openSync(temporary,"wx",0o600);try{fs.writeFileSync(fd,content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.linkSync(temporary,target);return target;}finally{try{fs.unlinkSync(temporary);}catch{}}
}
function writePublicMarket(dir,sha,content){
 dir=directory(dir);check(/^[a-f0-9]{64}$/.test(sha)&&typeof content==="string"&&content.length<24*1024*1024&&U.hash(content)===sha);
 const M=require("./finances_market.cjs");M.validateMarketData(M.parsePublicJSON(content));
 const target=path.join(dir,`market-${sha}.json`);
 if(fs.existsSync(target)){const st=fs.lstatSync(target);check(st.isFile()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o077)===0);check(U.hash(fs.readFileSync(target))===sha);return target;}
 const temporary=path.join(dir,`.market-${crypto.randomUUID()}.tmp`);try{const fd=fs.openSync(temporary,"wx",0o600);try{fs.writeFileSync(fd,content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.linkSync(temporary,target);return target;}finally{try{fs.unlinkSync(temporary);}catch{}}
}
function main(args){
 if(args.length===7&&args[0]==="--write-public-market"&&args[1]==="--directory"&&args[3]==="--sha"&&args[5]==="--content"){console.log(JSON.stringify({path:writePublicMarket(args[2],args[4],args[6])}));return;}
 if(args.length===7&&args[0]==="--write-baseline"&&args[1]==="--directory"&&args[3]==="--sha"&&args[5]==="--content"){console.log(JSON.stringify({path:writeBaseline(args[2],args[4],args[6])}));return;}
 if(args.length===5&&args[0]==="--read-encrypted"&&args[1]==="--directory"&&args[3]==="--path"){process.stdout.write(readEncrypted(args[2],args[4]));return;}
 throw Error("E_CIPHERTEXT_IO");
}
if(require.main===module){try{main(process.argv.slice(2));}catch{console.error("E_CIPHERTEXT_IO");process.exitCode=1;}}
module.exports={readEncrypted,writeBaseline,writePublicMarket};
