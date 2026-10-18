"use strict";

// Portable sealing client for the connector orchestration runtime. No filesystem,
// network, password, or financial values are logged. Entropy MUST come from the
// local bridge's CSPRNG response, kept in runtime memory and never displayed.
const FinancesTransport = (() => {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const hex = bytes => Array.from(bytes, n=>n.toString(16).padStart(2,"0")).join("");
  function fail(){ const error=Error("E_TRANSPORT");error.code="E_TRANSPORT";throw error; }
  function utf8(s){ return Uint8Array.from(unescape(encodeURIComponent(s)),c=>c.charCodeAt(0)); }
  function sha256(input) {
    const bytes=new Uint8Array(Math.ceil((input.length+9)/64)*64);bytes.set(input);bytes[input.length]=128;
    const dv=new DataView(bytes.buffer);dv.setUint32(bytes.length-4,input.length*8);
    const H=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const W=new Uint32Array(64),r=(x,n)=>(x>>>n)|(x<<(32-n));
    for(let pos=0;pos<bytes.length;pos+=64){
      for(let i=0;i<16;i++)W[i]=dv.getUint32(pos+i*4);
      for(let i=16;i<64;i++){const a=W[i-15],b=W[i-2];W[i]=(W[i-16]+(r(a,7)^r(a,18)^(a>>>3))+W[i-7]+(r(b,17)^r(b,19)^(b>>>10)))>>>0;}
      let[a,b,c,d,e,f,g,h]=H;
      for(let i=0;i<64;i++){const t1=(h+(r(e,6)^r(e,11)^r(e,25))+((e&f)^(~e&g))+K[i]+W[i])>>>0,t2=((r(a,2)^r(a,13)^r(a,22))+((a&b)^(a&c)^(b&c)))>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
      [a,b,c,d,e,f,g,h].forEach((v,i)=>H[i]=(H[i]+v)>>>0);
    }
    const result=new Uint8Array(32),out=new DataView(result.buffer);H.forEach((v,i)=>out.setUint32(i*4,v));return result;
  }
  function base64url(s){
    if(typeof s!=="string"||!/^[A-Za-z0-9_-]+$/.test(s))fail();
    const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";let acc=0,bits=0,out=[];
    for(const c of s){acc=(acc<<6)|alphabet.indexOf(c);bits+=6;if(bits>=8){bits-=8;out.push((acc>>>bits)&255);}}
    return Uint8Array.from(out);
  }
  function mgf(seed,length){const out=new Uint8Array(length);for(let i=0,offset=0;offset<length;i++,offset+=32){const a=new Uint8Array(seed.length+4);a.set(seed);new DataView(a.buffer).setUint32(seed.length,i);out.set(sha256(a).slice(0,Math.min(32,length-offset)),offset);}return out;}
  function power(base,exponent,modulus){let result=1n;while(exponent){if(exponent&1n)result=result*base%modulus;base=base*base%modulus;exponent>>=1n;}return result;}
  function seal(packet,header,{now=Date.now()}={}){
    if(header?.protocol!=="visual-card-rsa-oaep-sha256-v1"||header.publicKey?.kty!=="RSA"||header.publicKey.e!=="AQAB"||!Number.isFinite(Date.parse(header.expiresAt))||Date.parse(header.expiresAt)<now)fail();
    if(packet?.sessionId!==header.sessionId||packet.expectedHead!==header.expectedHead||packet.baselineSha256!==header.baselineSha256)fail();
    const nBytes=base64url(header.publicKey.n),k=nBytes.length;if(k!==384)fail();
    const bytes=utf8(JSON.stringify(packet));if(bytes.length>131072)fail();
    const digest=sha256(bytes),chunkSize=k-66-40,count=Math.ceil(bytes.length/chunkSize);
    if(!Array.isArray(header.seeds)||header.seeds.length<count)fail();
    const modulus=BigInt("0x"+hex(nBytes)),blocks=[];
    for(let i=0;i<count;i++){
      const encodedSeed=header.seeds[i];if(typeof encodedSeed!=="string"||!/^[a-f0-9]{64}$/.test(encodedSeed))fail();
      const seed=Uint8Array.from(encodedSeed.match(/../g),x=>parseInt(x,16));
      const chunk=bytes.slice(i*chunkSize,(i+1)*chunkSize),message=new Uint8Array(40+chunk.length);message.set(digest);
      const mv=new DataView(message.buffer);mv.setUint32(32,i);mv.setUint32(36,count);message.set(chunk,40);
      const db=new Uint8Array(k-33);db.set(sha256([]));db[db.length-message.length-1]=1;db.set(message,db.length-message.length);
      const dbMask=mgf(seed,db.length);for(let j=0;j<db.length;j++)db[j]^=dbMask[j];
      const seedMask=mgf(db,32),em=new Uint8Array(k);for(let j=0;j<32;j++)em[j+1]=seed[j]^seedMask[j];em.set(db,33);
      blocks.push(power(BigInt("0x"+hex(em)),65537n,modulus).toString(16).padStart(k*2,"0"));seed.fill(0);header.seeds[i]=null;
    }
    // Burn the entire one-use seed pool even when the packet used fewer blocks.
    header.seeds.fill(null);
    return {protocol:header.protocol,sessionId:header.sessionId,blocks};
  }
  return {seal,hash:text=>hex(sha256(utf8(text))),sha256};
})();
if(typeof module!=="undefined")module.exports=FinancesTransport;
