import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
export const corpus=JSON.parse(await readFile(new URL('./corpus.json',import.meta.url),'utf8'));
const code=await readFile(new URL(process.env.VV_GTM_SEMANTICS ? './sandbox-gtm.js' : './sandbox.js',import.meta.url),'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
export function sandbox(v,post,runtime=code){
 const store=new Map(),logs=[],requests=[];
 const api={getType:v=>v===null?'null':Array.isArray(v)?'array':typeof v,JSON:{stringify:JSON.stringify,parse:s=>{try{return JSON.parse(s);}catch{return undefined;}}},Math,makeNumber:Number,
 getTimestampMillis:()=>corpus.start,getRemoteAddress:()=>v.ip,getRequestHeader:k=>v.headers[k],getRequestMethod:()=>v.method,getRequestPath:()=>v.path,getEventData:k=>v.event[k],logToConsole:s=>logs.push(s),sha256Sync:sha,
 templateDataStorage:{getItemCopy:k=>structuredClone(store.get(k) ?? null),setItemCopy:(k,x)=>store.set(k,structuredClone(x))},sendHttpGet:async()=>({statusCode:200,body:JSON.stringify(v.feed)}),
 sendHttpRequest:async(url,opts,raw)=>{requests.push(JSON.parse(raw));if(v.axes.response==='timeout')throw Error('fixture timeout');if(v.axes.response==='tolerated')return {statusCode:200,body:'{"v":2}'};if(v.axes.response!=='200')return {statusCode:Number(v.axes.response),body:'{"error":"fixture"}'};return post(JSON.parse(raw),v);}};
 return {logs,requests,run:async()=>JSON.parse(JSON.stringify(await vm.runInNewContext('(function(data){'+runtime+'\n})(data)',{data:{apiKey:'corpus-key',...v.config},require:k=>{assert.ok(k in api,k);return api[k];}})))};
}
export async function runCorpus({packageUrl,post,onlySandbox=false}={}){
 let lib,AgentCache,compilePrefixes;
 if(packageUrl){lib=await import(packageUrl);({AgentCache}=await import(new URL('./cache.js',packageUrl)));({compilePrefixes}=await import(new URL('./ip.js',packageUrl)));}
 const errors=[];
 for(const v of corpus.vectors){
  let verifier,cache;
  if(lib){
   class SnapshotCache extends AgentCache {
    async load(url,kind,now,decode,mode='request',trace){
     if(kind==='directory')return super.load(url,kind,now,decode,mode,trace);
     const name=url.endsWith('/peer')?'peer':'one',g=v.feed.groups.find(g=>g.list===name),source=v.feed.sources?.find(s=>s.list===name);
     if(!g||source && !source.available)throw Error('fixture missing source');
     if(trace){trace.successfulRefreshAt=source?.fetched_at_ms/1000;trace.refreshOk=source?.refresh_ok===true;}
     const prefixes=g.v4.length?[{ipv4Prefix:name==='one'?'192.0.2.0/24':'198.51.100.0/24'}]:[];
     const block=compilePrefixes(prefixes);
     if(kind==='sail'){block.shared=compilePrefixes(g.shared_v4?.length?[{ipv4Prefix:'203.0.113.0/24'}]:[]);return new Map([['peer',block]]);}
     return block;
    }
    serviceStatus(){const source=v.feed.sources?.find(s=>s.list==='peer');return {at:source?.fetched_at_ms/1000,ok:source?.refresh_ok===true,available:source ? source.available : true};}
   }
   cache=new SnapshotCache(async url=>Response.json({keys:[corpus.owners.find(o=>o.directoryUrl===url).jwk]}),100,{now:()=>corpus.start/1000,staleMaxSeconds:86400});
   verifier=lib.createVerifier({registry:v.registry,authorities:['example.com'],now:()=>corpus.start/1000,flagSpoofedClaims:v.config.flagSpoofed,reverseDns:{enabled:false}},cache);
   await verifier.warm();
  }
  // The API context/transport adapter applies the same public contract as sGTM.
  // It supplies absent path rather than guessing a public prefix. Core crypto,
  // candidate policy, IP union, certainty and label selection remain real code.
  // Raw method/host context is also exercised below. The native API accepts HTTP
  // token methods (M-SEARCH); the service profile accepts only A-Z. Local unsigned
  // IP evidence does not depend on that service reconstruction policy.
  const core=async(body,remote=true)=>{
   const validContext=v.axes.context==='valid',remoteOk=v.axes.response==='200';
   return verifier.verify({host:'example.com',method:'GET',target:body?.path,secure:true,headerDiagnostics:false,clientIp:remote?undefined:v.axes.proxy==='custom_short'?undefined:v.ip,ipTrusted:['none','custom'].includes(v.axes.proxy),headers:remote?{signature:body.signature,'signature-input':body.signature_input,'signature-agent':body.signature_agent}:v.headers},
    {signatureFilter:()=>v.axes.signatures==='nonwba'||(validContext&&remoteOk&&v.axes.crypto!=='config_suspect'),...(v.axes.crypto==='replay'?{acceptSignature:()=>false}:{})});
  };
  let answer;
  const tpl=sandbox(v,post||(async body=>{
   if(!lib){const [operator,verification,purpose,claim]=v.expected.vv_detail.split('|');return {statusCode:200,body:JSON.stringify({v:1,operator,...(verification==='config_suspect'?{diagnostic:'config_suspect'}:{}),verification:['signature_valid','signature_invalid'].includes(verification)?verification:'none',purpose,claim,expires_at:null})};}const verdict=await core(body);answer=verdict;return {statusCode:200,body:JSON.stringify({v:1,...(v.axes.crypto==='config_suspect'?{diagnostic:'config_suspect'}:{}),verification:['signature_valid','signature_invalid'].includes(verdict.verification)?verdict.verification:'none',operator:verdict.verified?.operator||'none',purpose:verdict.agent_purpose,claim:'signature_agent',expires_at:verdict.verified?.expiresAt??null})};}));
  try{
   if(verifier && v.axes.context!=='valid') {
    const raw=await verifier.verify({host:v.headers.host,method:v.method,headers:v.headers,secure:true,headerDiagnostics:false,clientIp:v.ip,ipTrusted:['none','custom'].includes(v.axes.proxy)});
    if(v.axes.context==='bad_host'){assert.equal(raw.verification,'none','raw invalid host '+v.id);assert.equal(raw.verified,undefined);}
    else if(!['unsigned','nonwba'].includes(v.axes.signatures))assert.notEqual(raw.verification,'signature_valid','M-SEARCH cannot verify a signature over GET '+v.id);
   }
   const actual=await tpl.run();assert.deepEqual(actual,v.expected,'sandbox '+v.id+' '+JSON.stringify(v.axes));
   if(verifier&&!onlySandbox){
    const pathOk=v.config.pathMode==='root'||(v.config.pathMode==='prefix'&&v.config.publicPath==='/metrics');
    const body={signature:v.headers.signature,signature_input:v.headers['signature-input'],signature_agent:v.headers['signature-agent'],...(pathOk?{path:(v.config.pathMode==='prefix'?'/metrics':'')+v.path}:{})};
    const verdict=await core(body,false);
    const diagnostic=tpl.requests.length ? (v.axes.response==='200'&&v.axes.crypto==='config_suspect'?'config_suspect':['400','401','403','429'].includes(v.axes.response)?'rejected':['500','timeout'].includes(v.axes.response)?'service_unavailable':undefined) : undefined;
    const pair=lib.visitorLabels({verdict,diagnostic,browserClass:v.event.traffic_class,browserPhase:v.event.traffic_phase,browserAgent:v.event.traffic_agent,browserAgentClaim:v.event.traffic_agent_claim});
    assert.deepEqual(pair,v.expected,'library '+v.id+' '+JSON.stringify(v.axes)+' reason='+verdict.reason);
   }
   if(!['none','custom'].includes(v.axes.proxy) && v.expected.vv_detail.includes('|ip_mismatch|') && v.expected.vv_type==='bot_spoofed')throw Error('uncertain IP invariant');
  }catch(e){errors.push(e.message+'\n'+JSON.stringify({expected:e.expected,actual:e.actual}));}
  finally{verifier?.close();cache?.close();}
 }
 assert.equal(errors.length,0,errors.slice(0,12).join('\n\n'));
 // Recompute all pair coverage from the checked-in rows rather than trust metadata.
 const axes=Object.entries(corpus.axes),seen=new Set();
 for(const v of corpus.vectors)for(let a=0;a<axes.length;a++)for(let b=a+1;b<axes.length;b++)seen.add(`${a}:${axes[a][1].indexOf(v.axes[axes[a][0]])}/${b}:${axes[b][1].indexOf(v.axes[axes[b][0]])}`);
 assert.equal(seen.size,corpus.pairCount);assert.equal(corpus.uncovered,0);
 return {vectors:corpus.vectors.length,pairs:seen.size};
}
