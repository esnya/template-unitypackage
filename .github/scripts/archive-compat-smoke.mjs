import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';

const project=path.resolve(process.argv[2]);
const callerFile=path.resolve(process.argv[3]);
const legacyProject=process.argv[4]?path.resolve(process.argv[4]):undefined;
const require=createRequire(path.join(project,'package.json'));
const attempts=[];
const deny=kind=>()=>{attempts.push(kind);throw new Error(`Hermetic archive check blocked ${kind}`);};
net.Socket.prototype.connect=deny('network socket');tls.connect=deny('TLS socket');
http.request=deny('HTTP request');https.request=deny('HTTPS request');globalThis.fetch=deny('fetch');
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[name]=deny('child process '+name);
const temporaryRoot=path.resolve(os.tmpdir());
const createdDirectories=new Set();
const mkdirTemp=fs.promises.mkdtemp.bind(fs.promises);
fs.promises.mkdtemp=async(...args)=>{const result=path.resolve(await mkdirTemp(...args));assert.ok(result.startsWith(temporaryRoot+path.sep));createdDirectories.add(result);return result;};
const remove=fs.promises.rm.bind(fs.promises);
fs.promises.rm=async(target,options)=>{
 if(options?.recursive){const absolute=path.resolve(String(target));assert.ok([...createdDirectories].some(p=>absolute===p||absolute.startsWith(p+path.sep)),'Recursive cleanup must stay inside a directory created by this fixture');}
 return remove(target,options);
};
syncBuiltinESMExports();
assert.equal(process.versions.node,'24.22.1');
const ts=require('typescript');
const source=fs.readFileSync(callerFile,'utf8');
const ast=ts.createSourceFile(callerFile,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const calls=[];
const visit=node=>{if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='archive')calls.push(node);ts.forEachChild(node,visit);};
visit(ast);assert.equal(calls.length,1);assert.equal(calls[0].arguments.length,1);assert.ok(ts.isObjectLiteralExpression(calls[0].arguments[0]));
const fixture=await fs.promises.mkdtemp(path.join(temporaryRoot,'unity-space-template-fixture-'));
const folder=path.join(fixture,'Assets','Fixture');const file=path.join(folder,'fixture.txt');
await fs.promises.mkdir(folder,{recursive:true});
const folderGuid='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',fileGuid='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const folderMeta=`fileFormatVersion: 2\nguid: ${folderGuid}\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n`;
const fileMeta=`fileFormatVersion: 2\nguid: ${fileGuid}\nTextScriptImporter:\n  externalObjects: {}\n`;
await fs.promises.writeFile(folder+'.meta',folderMeta);await fs.promises.writeFile(file+'.meta',fileMeta);await fs.promises.writeFile(file,'fixture payload\n');
const destination=path.join(fixture,'candidate.unitypackage');
const args=vm.runInNewContext('('+calls[0].arguments[0].getText(ast)+')',{metaFiles:[folder+'.meta',file+'.meta'],tmp:fixture,unitypackageName:destination,path},{timeout:1000});
assert.deepEqual(Array.from(args.files),[folder,file]);assert.ok(args.files.every(p=>path.isAbsolute(p)&&!p.endsWith('.meta')));
assert.equal(args.root,fixture);assert.equal(args.dest,destination);
const archive=require('@natsuneko-laboratory/unitypackage').archive;
await archive(args);
const tar=require('tar');
async function entries(archiveFile){
 const result=new Map(),pending=[];
 await tar.t({file:archiveFile,onentry:entry=>{const chunks=[];const key=entry.path.replace(/^\.\//,'').replace(/\/$/,'');pending.push(new Promise((resolve,reject)=>{entry.on('data',chunk=>chunks.push(chunk));entry.on('error',reject);entry.on('end',()=>{result.set(key,Buffer.concat(chunks));resolve();});}));entry.resume();}});
 await Promise.all(pending);return result;
}
const expected=new Map([
 [folderGuid+'/asset.meta',folderMeta],[folderGuid+'/pathname','Assets/Fixture'],
 [fileGuid+'/asset.meta',fileMeta],[fileGuid+'/pathname','Assets/Fixture/fixture.txt'],[fileGuid+'/asset','fixture payload\n'],
]);
const actual=await entries(destination);
assert.deepEqual([...fs.readFileSync(destination).subarray(0,2)],[0x1f,0x8b],'Keep the already-locked library gzip format');
for(const[key,value]of expected)assert.equal(actual.get(key)?.toString(),value,key);
assert.deepEqual([...new Set([...actual.keys()].map(k=>k.split('/')[0]))].sort(),[folderGuid,fileGuid]);
const contentHash=map=>createHash('sha256').update([...expected.keys()].sort().map(key=>key+'\0'+Buffer.from(map.get(key)).toString('base64')).join('\n')).digest('hex');
const archiveContentSha256=contentHash(actual);assert.equal(archiveContentSha256,contentHash(expected));
const controlDestination=path.join(fixture,'current-version-control.unitypackage');
await archive({files:[folder,file],root:fixture,dest:controlDestination});
const currentVersionControlSha256=contentHash(await entries(controlDestination));assert.equal(archiveContentSha256,currentVersionControlSha256);
let legacyCompared=false;
let legacyContentSha256;
if(legacyProject){
 const legacyRequire=createRequire(path.join(legacyProject,'package.json'));
 const legacyDestination=path.join(fixture,'legacy.unitypackage');
 await legacyRequire('@natsuneko-laboratory/unitypackage').archive([folder+'.meta',file+'.meta'].map(p=>path.relative(fixture,p)),fixture,legacyDestination);
 let legacyTar=legacyDestination;
 // The old library ZIP-wrapped its TAR; compare the actual Unity entries, not that obsolete wrapper.
 if((await fs.promises.readFile(legacyDestination)).subarray(0,2).toString()==='PK'){
  const Zip=legacyRequire('adm-zip');const zip=new Zip(legacyDestination);const entry=zip.getEntry('archtemp.tar');assert.ok(entry);
  legacyTar=path.join(fixture,'legacy-content.tar');await fs.promises.writeFile(legacyTar,entry.getData());
 }
 const previous=await entries(legacyTar);
 for(const[key]of expected)assert.deepEqual(actual.get(key),previous.get(key),'Preserve legacy Unity package entry '+key);
 legacyContentSha256=contentHash(previous);assert.equal(archiveContentSha256,legacyContentSha256);
 legacyCompared=true;
}
assert.deepEqual(attempts,[]);
console.log(JSON.stringify({node:process.version,fixtureOnly:true,callerArgumentsVerified:true,currentFormat:'gzip-tar',essentialEntries:expected.size,archiveContentSha256,currentVersionControlSha256,legacyContentSha256,legacyOutputCompared:legacyCompared,networkAttempts:0,childProcessAttempts:0,fixture,passed:true}));
