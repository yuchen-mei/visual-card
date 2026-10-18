#!/usr/bin/env python3
"""Seal reviewed updater sources into an ad-hoc signed native helper; no enrollment."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
NATIVE = Path(__file__).resolve().parent
NODE = Path("/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node")

BOOTSTRAP = r"""'use strict';
const fs=require('node:fs'),vm=require('node:vm'),readline=require('node:readline');
const sources=__SOURCES__;
const html=__HTML__;
const allowed=new Set(['node:fs','node:path','node:crypto','node:vm','node:readline']);
const cache=new Map();
function embedded(name){
 if(cache.has(name))return cache.get(name).exports;
 if(!Object.hasOwn(sources,name))throw Error('MODULE_REJECTED');
 const module={exports:{}};cache.set(name,module);
 function restricted(id){if(id==='./update_finances.cjs')return embedded('update_finances.cjs');if(allowed.has(id))return require(id);throw Error('MODULE_REJECTED');}
 restricted.main=null;
 vm.runInThisContext('(function(require,module,exports,__filename,__dirname){'+sources[name]+'\n})',{filename:'sealed-'+name})(restricted,module,module.exports,'/__visual_card_sealed__/scripts/'+name,'/__visual_card_sealed__/scripts');
 return module.exports;
}
const U=embedded('update_finances.cjs'),D=embedded('finances_daily.cjs');
function reject(){process.stderr.write('E_SEALED_PREPARATION\n');process.exit(1);}
process.on('uncaughtException',reject);process.on('unhandledRejection',reject);
function fixedKeys(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');}
async function start(){
 const configBytes=fs.readFileSync(4);if(configBytes.length>8192)throw Error('CONFIG');
 const config=JSON.parse(configBytes);configBytes.fill(0);
 if(!fixedKeys(config,['expectedHead','baselinePath','outputDirectory'])||!/^[a-f0-9]{40}$/.test(config.expectedHead)||typeof config.baselinePath!=='string'||typeof config.outputDirectory!=='string')throw Error('CONFIG');
 const baseline=fs.realpathSync(config.baselinePath),stat=fs.statSync(baseline);
 if(!stat.isFile()||stat.size>24*1024*1024)throw Error('BASELINE');
 const bytes=fs.readFileSync(baseline);U.validateEnvelope(JSON.parse(bytes));
 const secret=fs.readFileSync(3);if(secret.length<1||secret.length>4096)throw Error('SECRET');
 let password=new TextDecoder('utf-8',{fatal:true}).decode(secret).replace(/\r?\n$/,'');secret.fill(0);
 const session=D.createSession({expectedHead:config.expectedHead,baselineSha256:U.hash(bytes)});
 process.stdout.write(JSON.stringify(session.header)+'\n');
 let sawLine=false;
 const reader=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
 const timeout=setTimeout(reject,300000);
 reader.once('line',async line=>{sawLine=true;clearTimeout(timeout);try{
  if(line.length>110000)throw Error('PACKET');const packet=session.open(JSON.parse(line));
  if(U.hash(fs.readFileSync(baseline))!==U.hash(bytes))throw Error('BASELINE');
  const result=await D.prepareCandidate({packet,existingBytes:bytes,password,html,outputDirectory:config.outputDirectory});
  password='';process.stdout.write(JSON.stringify(result)+'\n');reader.close();process.exit(0);
 }catch{password='';reject();}});
 reader.once('close',()=>{if(!sawLine)reject();});
}
start().catch(reject);
"""


def command(args):
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError("BUILD_OR_SIGNATURE_CHECK_FAILED")
    return result.stdout + result.stderr


def literal(value):
    return json.dumps(value, ensure_ascii=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-directory", required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--test-only", action="store_true", help="Mock secret only; enrollment is compiled out of the command path")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", args.account):
        raise RuntimeError("ACCOUNT_IDENTIFIER_REQUIRED")
    if args.test_only and args.account != "synthetic-test-only":
        raise RuntimeError("TEST_ACCOUNT_REQUIRED")
    output = Path(args.output_directory).resolve(strict=True)
    st = output.stat()
    if output == ROOT or ROOT in output.parents or not output.is_dir() or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise RuntimeError("PRIVATE_BUILD_DIRECTORY_REQUIRED")
    binary = output / "visual-card-keychain-helper"
    manifest = output / "build-manifest.json"
    if binary.exists() or manifest.exists():
        raise RuntimeError("BUILD_OUTPUT_EXISTS")
    command(["/usr/bin/codesign", "--verify", "--strict", "-R", '=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2" and identifier "node"', str(NODE)])
    node_info = command(["/usr/bin/codesign", "-d", "--verbose=4", str(NODE)])
    node_hash = re.search(r"^CDHash=([a-f0-9]{40})$", node_info, re.M)
    if not node_hash or "TeamIdentifier=2DC432GLL2" not in node_info or "(runtime)" not in node_info:
        raise RuntimeError("PINNED_RUNTIME_REQUIRED")
    sources = {}
    digests = {}
    for name in ["update_finances.cjs", "finances_daily.cjs"]:
        data = (ROOT / "scripts" / name).read_bytes()
        digests["scripts/" + name] = hashlib.sha256(data).hexdigest()
        sources[name] = re.sub(r"^#![^\n]*\n", "", data.decode("utf-8"))
    html_data = (ROOT / "index.html").read_bytes()
    digests["index.html"] = hashlib.sha256(html_data).hexdigest()
    replacements = {"SOURCES": literal(sources), "HTML": literal(html_data.decode("utf-8"))}
    bootstrap = re.sub(r"__(SOURCES|HTML)__", lambda match: replacements[match.group(1)], BOOTSTRAP)
    with tempfile.TemporaryDirectory(prefix="visual-card-native-build-") as directory:
        for name in ["keychain_helper.m", "keychain_preflight.c"]:
            data = (NATIVE / name).read_bytes()
            digests["scripts/native/" + name] = hashlib.sha256(data).hexdigest()
            (Path(directory) / name).write_bytes(data)
        header = Path(directory) / "sealed_resources.h"
        header.write_text("static const char VC_BOOTSTRAP[] = " + literal(bootstrap) + ";\n"
                          "static const char VC_NODE[] = " + literal(str(NODE)) + ";\n"
                          "static const char VC_NODE_REQUIREMENT[] = " + literal('cdhash H"' + node_hash.group(1) + '"') + ";\n"
                          "static const char VC_ACCOUNT[] = " + literal(args.account) + ";\n", encoding="utf-8")
        command(["/usr/bin/xcrun", "clang", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-Wno-overlength-strings", *( ["-DVC_NATIVE_TEST=1"] if args.test_only else []), "-I", directory, str(Path(directory) / "keychain_helper.m"), "-framework", "Foundation", "-framework", "Security", "-o", str(binary)])
    command(["/usr/bin/codesign", "--force", "--sign", "-", "--options", "runtime", "--identifier", "local.visual-card.update.test" if args.test_only else "local.visual-card.update", str(binary)])
    command(["/usr/bin/codesign", "--verify", "--strict", str(binary)])
    command([str(binary), "--preflight"])
    info = command(["/usr/bin/codesign", "-d", "--verbose=4", str(binary)])
    helper_hash = re.search(r"^CDHash=([a-f0-9]{40})$", info, re.M)
    if not helper_hash:
        raise RuntimeError("HELPER_IDENTITY_REQUIRED")
    record = {"version": 1, "testOnly": args.test_only, "credentialStorageEnabled": False, "nodeCdhash": node_hash.group(1), "helperCdhash": helper_hash.group(1), "sources": digests}
    with manifest.open("x", encoding="utf-8") as file:
        json.dump(record, file, indent=2)
        file.write("\n")
    os.chmod(manifest, 0o600)
    print(json.dumps({"status": "built", "credentialStorageEnabled": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("NATIVE_HELPER_BUILD_FAILED")
