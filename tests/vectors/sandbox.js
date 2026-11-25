var getType = require('getType');
// Selectors read a supplied pair; variable reevaluation is bounded by the short cache.
if(data.role==='selector' || (data.role!=='result' && data.labelPair!==undefined && data.labelPair!=='')) {
  if(validPair(data.labelPair)) {require('logToConsole')('Visitor Verdict: selector_pair_ready');return select(data.labelPair);}
  require('logToConsole')('Visitor Verdict: pair_unavailable source_'+getType(data.labelPair));
  return select({vv_type:'pending',vv_detail:'none|pair_unavailable|unknown|none|-|-'});
}
var getEventData = require('getEventData');
var readRequestHeader = require('getRequestHeader');
var headerNames=[], headerValues=[], headerPresent=[];
function getRequestHeader(name) {
  var index=headerNames.indexOf(name);
  if(index>=0) return headerValues[index];
  var value=readRequestHeader(name);
  var present=getType(value)==='string';
  if(!present) value='';
  headerNames.push(name); headerValues.push(value); headerPresent.push(present); return value;
}
var getRemoteAddress = require('getRemoteAddress');
var sendHttpGet = require('sendHttpGet');
var storage = require('templateDataStorage');
var now = require('getTimestampMillis')();
var JSON = require('JSON');
var makeNumber = require('makeNumber');
var Math = require('Math');
var SERVICE_URL = 'https://visitor-verdict.narrativva.com/v1';
var service = data.serviceUrl || SERVICE_URL;
var apiKey = getType(data.apiKey)==='string' ? data.apiKey.trim() : '';
var url = data.rulesUrl || service+'/rules.json';
var rulesKey=url===SERVICE_URL+'/rules.json' ? 'vv_rules_v1' : 'vv_rules_v1_'+require('sha256Sync')(url,{outputEncoding:'hex'});
var flightKey=url===SERVICE_URL+'/rules.json' ? 'vv_rules_flight' : rulesKey+'_flight';
function debug(message) { require('logToConsole')('Visitor Verdict: '+message); }
// Retry-After permits delta-seconds or an IMF-fixdate, without a calendar API.
function retrySeconds(raw) {
  if(getType(raw)!=='string' || raw.length>128) return 0;
  raw=raw.trim();
  function decimal(value) {
    if(!value) return -1;
    for(var i=0;i<value.length;i++) if('0123456789'.indexOf(value.charAt(i))<0) return -1;
    return makeNumber(value);
  }
  var delta=decimal(raw);
  if(delta>=0) return delta;
  var parts=raw.split(' ');
  if(parts.length!==6 || ['Mon,','Tue,','Wed,','Thu,','Fri,','Sat,','Sun,'].indexOf(parts[0])<0 || parts[5]!=='GMT') return 0;
  var month=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(parts[2]);
  var year=decimal(parts[3]),day=decimal(parts[1]),time=parts[4].split(':');
  if(month<0 || parts[3].length!==4 || year<1970 || time.length!==3) return 0;
  var hour=decimal(time[0]),minute=decimal(time[1]),second=decimal(time[2]);
  var leap=year%4===0 && (year%100!==0 || year%400===0);
  var lengths=[31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  if(day<1 || day>lengths.slice(month,month+1)[0] || hour<0 || hour>23 || minute<0 || minute>59 || second<0 || second>59) return 0;
  var days=365*(year-1970)+Math.floor((year-1)/4)-492-Math.floor((year-1)/100)+19+Math.floor((year-1)/400)-4;
  days+=lengths.slice(0,month).reduce(function(sum,n) {return sum+n;},0)+day-1;
  var wait=((days*24+hour)*60+minute)*60000+second*1000-require('getTimestampMillis')();
  return Math.max(0,Math.floor((wait+999)/1000));
}
var TEMPLATE_VERSION = '2.1.5';
// Request APIs can fail during sGTM internal evaluations with no incoming request.
// This fixed phase lets Preview distinguish a source failure from a malformed pair.
debug('request_context_read');
var requestIp=getRemoteAddress();
if(getType(requestIp)!=='string') requestIp='';
var empty = {schema:2,operators:[],tokens:["ChatGPT-User","OAI-SearchBot","OAI-AdsBot","GPTBot","Claude-Agent","Claude-User","Claude-SearchBot","ClaudeBot","Perplexity-User","PerplexityBot","Google-Agent","Google-CloudVertexBot","Google-GeminiNotebook","Google-NotebookLM","Gemini-Deep-Research","MistralAI-User","MistralAI-Index","MistralAI-Training","DuckAssistBot","Applebot","Bytespider","meta-externalagent","meta-externalfetcher","meta-webindexer","CCBot","Amazonbot","Amzn-SearchBot","KimiBot","Kimi-SearchBot","Kimi-User","SeznamBot","Yeti","Ads-Naver","Blueno","Kagibot","Baiduspider","PetalBot","YandexBot","YandexAdditional","Amzn-User","AmazonAdBot","YouBot","Sogou","TikTokSpider","DeepSeekBot","ChatGLM-Spider","YisouSpider","360Spider","Diffbot","Timpibot","bingbot","AdIdxBot","BingPreview","MicrosoftPreview","BingVideoPreview","Googlebot","Googlebot-Image","Googlebot-Video","Storebot-Google","Google-InspectionTool","GoogleOther","GoogleOther-Image","GoogleOther-Video","Google-Pinpoint","Google-Read-Aloud","GoogleProducer","Google-Site-Verification","Google-CWS","FeedFetcher-Google"],groups:[]};
// GTM sandbox strings have no char-code methods: printable ASCII is checked against this list (24. 11.).
var PRINTABLE = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
function printable(c) { return c.length===1 && PRINTABLE.indexOf(c)>=0; }
function oneOf(x, values, fallback) { return values.indexOf(x) >= 0 ? x : fallback; }
function ipv4(ip) {
  var p = ip.split('.'); if (p.length !== 4) return -1;
  var n = 0;
  for (var i=0;i<4;i++) {
    if (!p[i] || p[i].length>3 || (p[i].length>1 && p[i].charAt(0)==='0')) return -1;
    for (var j=0;j<p[i].length;j++) if ('0123456789'.indexOf(p[i].charAt(j))<0) return -1;
    var v = makeNumber(p[i]); if (v>255) return -1; n = n*256+v;
  }
  return n;
}
function ipv6(ip) {
  if (ip.indexOf('.')>=0) {
    var last = ip.lastIndexOf(':'), n = ipv4(ip.slice(last+1)); if(n<0) return '';
    ip = ip.slice(0,last+1) + Math.floor(n/65536).toString(16)+':'+(n%65536).toString(16);
  }
  var halves = ip.toLowerCase().split('::'); if(halves.length>2) return '';
  var left = halves[0] ? halves[0].split(':') : [], right = halves.length===2 && halves[1] ? halves[1].split(':') : [];
  var count = left.length+right.length;
  if ((halves.length===1 && count!==8) || (halves.length===2 && count>=8)) return '';
  var words = left;
  if (halves.length===2) for(var i=count;i<8;i++) words.push('0');
  words = words.concat(right); var hex='';
  for(var i=0;i<words.length;i++) {
    var word=words[i]; if(!word || word.length>4) return '';
    for(var j=0;j<word.length;j++) if('0123456789abcdef'.indexOf(word.charAt(j))<0) return '';
    hex += ('0000'+word).slice(-4);
  }
  return hex;
}
function v4Match(n, rows) {
  var lo=0,hi=rows.length-1;
  while(lo<=hi) { var mid=Math.floor((lo+hi)/2), row=rows[mid]; if(n<row[0]) hi=mid-1; else if(n>row[1]) lo=mid+1; else return true; }
  return false;
}
function v6Match(hex, rows) {
  if (!hex) return false;
  for(var i=0;i<rows.length;i++) {
    var bits=rows[i][1], full=Math.floor(bits/4), rem=bits%4;
    if(hex.slice(0,full)!==rows[i][0].slice(0,full)) continue;
    if(!rem) return true;
    var a='0123456789abcdef'.indexOf(hex.charAt(full)), b='0123456789abcdef'.indexOf(rows[i][0].charAt(full));
    if(Math.floor(a/Math.pow(2,4-rem))===Math.floor(b/Math.pow(2,4-rem))) return true;
  }
  return false;
}
function tokenChar(c) { return c && 'abcdefghijklmnopqrstuvwxyz0123456789_-'.indexOf(c)>=0; }
function uaHas(ua, token) {
  token=token.toLowerCase(); var pos=ua.indexOf(token);
  while(pos>=0) { if(!tokenChar(ua.charAt(pos-1)) && !tokenChar(ua.charAt(pos+token.length))) return true; pos=ua.indexOf(token,pos+1); }
  return false;
}
function safeOperator(id) {
  if(getType(id)!=='string' || !id || id.length>24 || 'abcdefghijklmnopqrstuvwxyz'.indexOf(id.charAt(0))<0) return 'none';
  for(var i=1;i<id.length;i++) if('abcdefghijklmnopqrstuvwxyz0123456789_'.indexOf(id.charAt(i))<0) return 'none';
  return id;
}
// Bounded RFC 8941 reader. Unsupported values never become covered components.
// Keep raw member slices so forwarding never reserializes a signature base.
function sf(raw, single) {
  if(getType(raw)!=='string' || !raw || raw.length>16384) return undefined;
  var pos=0, bad=false;
  function spaces() { while(raw.charAt(pos)===' ' || raw.charAt(pos)==='\t') pos++; }
  function key() {
    var start=pos;
    if(!raw.charAt(pos) || 'abcdefghijklmnopqrstuvwxyz*'.indexOf(raw.charAt(pos))<0) {bad=true; return '';}
    pos++;
    while(raw.charAt(pos) && 'abcdefghijklmnopqrstuvwxyz0123456789_.*-'.indexOf(raw.charAt(pos))>=0) pos++;
    return raw.slice(start,pos);
  }
  function bare() {
    var c=raw.charAt(pos), start=pos; pos++;
    if(c==='"') {
      var value='';
      while(pos<raw.length) {
        var ch=raw.charAt(pos++);
        if(ch==='"') return {kind:'string',value:value};
        if(ch==='\\') { ch=raw.charAt(pos++); if(ch!=='"' && ch!=='\\') {bad=true; break;} }
        if(!printable(ch)) {bad=true; break;}
        value+=ch;
      }
      bad=true; return {};
    }
    if(c===':') {
      while(pos<raw.length && raw.charAt(pos)!==':') {if('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='.indexOf(raw.charAt(pos))<0) bad=true; pos++;}
      var encoded=raw.slice(start+1,pos), pad=encoded.indexOf('=');
      if(encoded.length%4!==0 || (pad>=0 && (pad<encoded.length-2 || encoded.slice(pad)!=='=' && encoded.slice(pad)!=='=='))) bad=true;
      if(raw.charAt(pos++)!==':') bad=true;
      return {kind:'bytes',value:raw.slice(start,pos)};
    }
    if(c==='?') {var v=raw.charAt(pos++); if(v!=='0' && v!=='1') bad=true; return {kind:'boolean',value:v==='1'};}
    if(c==='-' || '0123456789'.indexOf(c)>=0 && c) {
      while(raw.charAt(pos) && '0123456789.'.indexOf(raw.charAt(pos))>=0) pos++;
      var number=raw.slice(start,pos), pieces=number.split('.');
      if(pieces.length>2 || pieces[0]==='-' || pieces[0].length>(c==='-' ? 16 : 15) || (pieces.length===2 && (!pieces[1] || pieces[1].length>3))) bad=true;
      return {kind:pieces.length===1 ? 'integer' : 'decimal',value:makeNumber(number)};
    }
    if(!c || 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ*'.indexOf(c)<0) {bad=true; return {};}
    while(raw.charAt(pos) && "!#$%&'*+-.^_`|~:/0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".indexOf(raw.charAt(pos))>=0) pos++;
    return {kind:'token',value:raw.slice(start,pos)};
  }
  function params() {
    var list=[];
    while(raw.charAt(pos)===';') {
      pos++; while(raw.charAt(pos)===' ') pos++;
      var name=key();
      for(var i=0;i<list.length;i++) if(list[i].name===name) bad=true;
      var value={kind:'boolean',value:true};
      if(raw.charAt(pos)==='=') {pos++; value=bare();}
      list.push({name:name,kind:value.kind,value:value.value});
      if(bad) break;
    }
    return list;
  }
  function item() {var b=bare();return {kind:b.kind,value:b.value,params:params()};}
  spaces();
  if(single) {var value=item();spaces();return !bad && pos===raw.length ? value : undefined;}
  var members=[];
  while(pos<raw.length && !bad) {
    var start=pos, name=key();
    for(var i=0;i<members.length;i++) if(members[i].name===name) bad=true;
    var value;
    if(raw.charAt(pos)!=='=') value={kind:'boolean',value:true,params:params()};
    else {
      pos++;
      if(raw.charAt(pos)!=='(') value=item();
      else {
        pos++; var components=[];
        while(pos<raw.length && !bad) {
          while(raw.charAt(pos)===' ') pos++;
          if(raw.charAt(pos)===')') break;
          components.push(item());
          if(components.length>32 || (raw.charAt(pos)!==' ' && raw.charAt(pos)!==')')) bad=true;
        }
        if(raw.charAt(pos++)!==')') bad=true;
        value={kind:'list',value:components,params:params()};
      }
    }
    members.push({name:name,kind:value.kind,value:value.value,params:value.params,raw:raw.slice(start,pos)});
    spaces(); if(pos===raw.length) break;
    if(raw.charAt(pos++)!==',') {bad=true; break;}
    spaces(); if(pos===raw.length) bad=true;
    if(members.length>=128) bad=true;
  }
  return !bad && members.length ? members : undefined;
}
function parameter(member,name) {
  for(var i=0;i<member.params.length;i++) if(member.params[i].name===name) return member.params[i];
  return undefined;
}
function agents(raw) {
  if(getType(raw)!=='string' || raw.length>16384) return undefined;
  var legacy=raw.trim().charAt(0)==='"';
  var parsed=sf(raw,legacy);
  return parsed ? {legacy:legacy ? parsed : undefined,members:legacy ? [] : parsed} : undefined;
}
function knownIdentity(identity,rules) {
  for(var i=0;i<rules.operators.length;i++) if(identity && rules.operators[i].signatureAgent===identity) return true;
  return false;
}
function identityAt(agent,key) {
  if(agent.legacy) return !key && !agent.legacy.params.length && agent.legacy.kind==='string' ? agent.legacy.value : undefined;
  for(var i=0;i<agent.members.length;i++) {
    var member=agent.members[i];
    if(member.name===key && member.kind==='string' && !member.params.length) return member.value;
  }
  return undefined;
}
// Bare IP evidence is deliberately stricter than per-signature dictionary attribution.
function trustedAgent(raw,rules) {
  var parsed=agents(raw); if(!parsed) return false;
  if(parsed.legacy) {var id=identityAt(parsed);return knownIdentity(id,rules) ? id : false;}
  var id=false;
  for(var i=0;i<parsed.members.length;i++) {
    var next=identityAt(parsed,parsed.members[i].name);
    if(!knownIdentity(next,rules) || (id && id!==next)) return false;
    id=next;
  }
  return id;
}
function signatureInputs() {
  var raw=getRequestHeader('signature-input');
  var members=sf(raw,false);
  if(!members || members.length>4) return undefined;
  return members;
}
function nonWbaOnly() {
  var rawAgent=getRequestHeader('signature-agent').trim();
  if(rawAgent) {
    var parsedAgent=agents(rawAgent);
    if(!parsedAgent || (parsedAgent.legacy && (parsedAgent.legacy.kind!=='string' || parsedAgent.legacy.params.length))) return false;
  }
  var members=signatureInputs(), signatures=sf(getRequestHeader('signature'),false);
  if(!members || !signatures) return false;
  for(var i=0;i<members.length;i++) {
    if(members[i].kind!=='list') return false;
    var tag=parameter(members[i],'tag');
    if(tag && tag.kind==='string' && tag.value==='web-bot-auth') return false;
  }
  // Non-WBA members are ignored before WBA signature policy (including params
  // and missing signatures). Orphan Signature labels are malformed, not ignored.
  for(var i=0;i<signatures.length;i++) {
    var found=false;
    for(var j=0;j<members.length;j++) if(signatures[i].name===members[j].name) found=true;
    if(!found) return false;
  }
  return true;
}
function nonempty(g) {return !!(g.v4.length || g.v6.length || (g.shared_v4 && g.shared_v4.length) || (g.shared_v6 && g.shared_v6.length));}
function presentUnion(r,operator) {
  if(getType(r.sources)!=='array') return false;
  var count=0;
  for(var i=0;i<r.sources.length;i++) {
    var source=r.sources[i];if(source.operator!==r.operators[operator].id) continue;
    count++;if(!source.available) return false;
    var found=false;
    for(var j=0;j<r.groups.length;j++) if(r.groups[j].operator===operator && r.groups[j].list===source.list && nonempty(r.groups[j])) found=true;
    if(!found) return false;
  }
  return count>0;
}
function hasHeader(name) {getRequestHeader(name);return headerPresent[headerNames.indexOf(name)];}
function validSignatureEnvelope() {
  var names=['signature','signature-input','signature-agent'], bytes=0;
  for(var i=0;i<names.length;i++) {
    var raw=getRequestHeader(names[i]);
    if(!hasHeader(names[i])) continue;
    bytes+=names[i].length+4;
    for(var j=0;j<raw.length;j++) {
      var c=raw.charAt(j);
      // The common header profile is HTAB/SP/VCHAR/obs-text. Reject controls
      // and U+0100+ before any claim, matching the library headers reader.
      if(c!=='\t' && (c<' ' || c==='\u007f' || c>'\u00ff')) return false;
      bytes+=c<='\u007f' ? 1 : 2;
    }
  }
  return bytes<=16384;
}
function eligibleUnavailable(rules,matches) {
  if(getType(rules.sources)!=='array') return false;
  for(var i=0;i<rules.sources.length;i++) {
    var source=rules.sources[i];if(source.available) continue;
    if(source.tokens===null) return true;
    if(getType(source.tokens)==='array') for(var j=0;j<source.tokens.length;j++) if(matches.indexOf(source.tokens[j])>=0) return true;
  }
  return false;
}
function validUa() {
  var raw=getRequestHeader('user-agent') || '';var bytes=0;
  for(var i=0;i<raw.length;i++) {
    var c=raw.charAt(i);
    if(c>'\u00ff' || (c<' ' && c!=='\t') || c==='\u007f') return false;
    bytes+=c<='\u007f' ? 1 : 2;
  }
  return bytes<=1024;
}
// Epoch milliseconds avoid calendar parsing differences in the GTM sandbox.
function contentFresh(r) {
  var at=r.generated_at_ms;
  return timestamp(at) && at<=now+300000 && now-at<1209600000;
}
function timestamp(at) {return getType(at)==='number' && at%1===0 && at>=0 && at<=9007199254740991;}
function freshAt(at) {var t=require('getTimestampMillis')();return timestamp(at) && at<=t && t-at<=7200000;}
// Negative proof needs every list, including unavailable/omitted peer lists.
// Return its absolute reuse deadline, or zero when certainty is unavailable.
function negativeWindow(r,operator) {
  if(cached && cached.url===url && cached.refreshFailed) return 0;
  if(getType(r.sources)!=='array' || !r.sources.length) return 0;
  var count=0, until=9007199254740991;
  for(var i=0;i<r.sources.length;i++) {
    var source=r.sources[i];
    if(operator!==undefined && source.operator!==r.operators[operator].id) continue;
    count++;
    if(!source.available || !source.refresh_ok || !freshAt(source.fetched_at_ms)) return 0;
    until=Math.min(until,source.fetched_at_ms+7200001);
    var found=false;
    for(var j=0;j<r.groups.length;j++) {
      var g=r.groups[j];
      if(r.operators[g.operator].id===source.operator && g.list===source.list) {
        if(!nonempty(g) || !freshAt(g.fetched_at_ms) || g.fetched_at_ms!==source.fetched_at_ms) return 0;
        found=true;
      }
    }
    if(!found) return 0;
  }
  // A group without its source cannot establish a complete union either.
  for(var i=0;i<r.groups.length;i++) {
    var g=r.groups[i]; if(g.source_key==='static' || (operator!==undefined && g.operator!==operator)) continue;
    var found=false;
    for(var j=0;j<r.sources.length;j++) if(r.sources[j].operator===r.operators[g.operator].id && r.sources[j].list===g.list) found=true;
    if(!found) return 0;
  }
  return count>0 ? until : 0;
}
var resultSlot, reserved=false, mismatchUntil=0, reservationGeneration=0;
function sharedSlot() {
  if(resultSlot) return resultSlot;
  var stateKey='vv_service_'+require('sha256Sync')(service+'\n'+apiKey,{outputEncoding:'hex'});
  // Feed changes must not split recipients of the same result during its reuse window.
  // Its version is stored once on download; never serialize/hash the feed on a hit.
  var context=[getRequestHeader('signature'),getRequestHeader('signature-input'),getRequestHeader('signature-agent'),hasHeader('signature'),hasHeader('signature-input'),hasHeader('signature-agent'),getRequestHeader('user-agent'),requestIp,getRequestHeader('x-forwarded-for'),require('getRequestMethod')(),getRequestHeader('host'),require('getRequestPath')(),url,data.pathMode || '',data.publicPath || '',data.proxyMode || 'none',data.proxyCount || '',!!data.flagSpoofed,getEventData('traffic_class'),getEventData('traffic_phase'),getEventData('traffic_agent'),getEventData('traffic_agent_claim')];
  resultSlot={cacheKey:stateKey+'_results',hash:require('sha256Sync')(JSON.stringify(context),{outputEncoding:'hex'})};
  return resultSlot;
}
function completed() {
  var slot=sharedSlot(), results=storage.getItemCopy(slot.cacheKey) || [], t=require('getTimestampMillis')();
  for(var i=0;i<results.length;i++) if(results[i].key===slot.hash && t<results[i].until && results[i].pair) return results[i].pair;
  return undefined;
}
function validPair(pair) {
  if(getType(pair)!=='object' || ['pending','human','agent_verified','crawler_verified','automation_verified','agent_unverified','bot_spoofed','bot_automation','bot_suspicious'].indexOf(pair.vv_type)<0 || getType(pair.vv_detail)!=='string' || pair.vv_detail.length>100) return false;
  var parts=pair.vv_detail.split('|');
  return parts.length===6 && safeOperator(parts[0])===parts[0] &&
    ['-','none','no_signature','ip_match','ip_mismatch','signature_valid','signature_invalid','pair_unavailable','feed_unavailable','service_unavailable','config_suspect','rejected'].indexOf(parts[1])>=0 &&
    ['-','unknown','crawler','user_directed','intermediary'].indexOf(parts[2])>=0 &&
    ['-','none','signature_agent','ua_token','dom_host','dom_marker','poppy_session'].indexOf(parts[3])>=0 &&
    ['-','human','suspicious','automated','declared_agent'].indexOf(parts[4])>=0 && ['-','initial','final','agent'].indexOf(parts[5])>=0;
}
function select(pair) {if(data.outputField==='pair') return pair; if(data.outputField==='vv_detail') return pair.vv_detail; return pair.vv_type;}
// Pin ongoing evaluations independently of completed-result LRU. Leases bound abandoned work.
function reserve() {
  var slot=sharedSlot(), current=storage.getItemCopy(slot.cacheKey) || [], t=require('getTimestampMillis')();
  var entry;
  for(var i=0;i<current.length;i++) if(current[i].key===slot.hash) entry=current[i];
  if(!entry) {entry={key:slot.hash,until:0,active:0};current.push(entry);}
  if(!(entry.lease>t)) {entry.active=0;entry.generation=(entry.generation || 0)+1;}
  else if(!entry.generation) entry.generation=1;
  entry.active=(entry.active || 0)+1;entry.lease=t+10000;
  reservationGeneration=entry.generation;
  reserved=true;storage.setItemCopy(slot.cacheKey,current);
}
function publish(rules,available,verdict,until) {
  var existing=completed(), pair=existing || labels(rules,available,verdict), t=require('getTimestampMillis')();
  var slot=sharedSlot(), current=storage.getItemCopy(slot.cacheKey) || [], keep=[];
  if(until===undefined) until=t+5000;
  if(!available && cached && cached.retryAt>t) until=Math.min(until,cached.retryAt);
  if(mismatchUntil) until=Math.min(until,mismatchUntil);
  var entry;
  for(var i=0;i<current.length;i++) {
    var row=current[i];
    if(row.key===slot.hash) entry=row;
    else if(row.until>t || (row.active>0 && row.lease>t)) keep.push(row);
  }
  if(!entry) entry={key:slot.hash,active:0,until:0};
  if(reserved) {if(entry.generation===reservationGeneration) entry.active=Math.max(0,(entry.active || 0)-1);reserved=false;}
  if(!existing && until>t) {entry.pair=pair;entry.until=until;}
  // Evict only completed entries; a slow peer retains the first pair under pressure.
  var completedCount=0;
  for(var i=0;i<keep.length;i++) if(!(keep[i].active>0 && keep[i].lease>t)) completedCount++;
  for(var i=0;i<keep.length && completedCount>=100;i++) if(!(keep[i].active>0 && keep[i].lease>t)) {keep.splice(i,1);i--;completedCount--;}
  if(entry.until>t || (entry.active>0 && entry.lease>t)) keep.push(entry);
  storage.setItemCopy(slot.cacheKey,keep);
  debug('result_done ms='+(t-now));
  return select(pair);
}
function classify(rules, available, verdict) {return publish(rules,available,verdict);}
function labels(rules, available, verdict) {
  var browser=oneOf(getEventData('traffic_class'),['human','suspicious','automated','declared_agent'],'-');
  var phase=oneOf(getEventData('traffic_phase'),['initial','final','agent'],'-');
  var marker=browser==='declared_agent' ? oneOf(getEventData('traffic_agent'),['openai','anthropic'],'none') : 'none';
  var validInput=validUa() && validSignatureEnvelope();
  var ua=validInput ? (getRequestHeader('user-agent') || '').toLowerCase() : '';
  var agent=validInput ? getRequestHeader('signature-agent').trim() : '';
  if(!validInput) verdict=undefined;
  var signature=!!agent;
  var ignored=nonWbaOnly();
  var signed=(hasHeader('signature') || hasHeader('signature-input')) && !ignored;
  var identity=signature ? trustedAgent(agent,rules) : false;
  var ipAllowed=validInput && !signed && (!signature || !!identity || ignored);
  var matches=[];
  for(var i=0;i<rules.tokens.length;i++) if(uaHas(ua,rules.tokens[i])) matches.push(i);
  var verification= !ipAllowed || !available || eligibleUnavailable(rules,matches) ? 'none' : 'no_signature', purpose='unknown', operator='none';
  var claim=signature ? 'signature_agent' : (matches.length ? 'ua_token' : 'none');
  var source=clientIp();
  var ip=source.ip;
  var n=ipv4(ip), hex=ip.indexOf(':')>=0 ? ipv6(ip) : '';
  // node:net treats IPv4-mapped IPv6 addresses as IPv4 evidence too.
  if(hex && hex.slice(0,24)==='00000000000000000000ffff') {
    n=0; for(var i=24;i<32;i++) n=n*16+'0123456789abcdef'.indexOf(hex.charAt(i));
  }
  if(available && ipAllowed && source.promote) for(var i=0;i<rules.groups.length;i++) {
    var group=rules.groups[i]; var eligible=group.tokens===null;
    if(group.tokens) for(var j=0;j<group.tokens.length;j++) if(matches.indexOf(group.tokens[j])>=0) eligible=true;
    if(!eligible || !((n>=0 && v4Match(n,group.v4)) || v6Match(hex,group.v6))) continue;
    var op=rules.operators[group.operator];
    if(identity && !ignored && op.signatureAgent!==identity) continue;
    operator=safeOperator(op.id); verification='ip_match';
    var policy=op.purposes;
    if(policy.ipLists && policy.ipLists[group.list]) purpose=policy.ipLists[group.list];
    else {
      var roles=[];
      for(var j=0;j<matches.length;j++) if(group.tokens===null || group.tokens.indexOf(matches[j])>=0) {
        var token=rules.tokens[matches[j]], role=policy.uaTokens && policy.uaTokens[token] || 'unknown';
        if(roles.indexOf(role)<0) roles.push(role);
      }
      purpose=roles.length===1 ? roles[0] : 'unknown';
    }
    purpose=oneOf(purpose,['crawler','user_directed','intermediary','unknown'],'unknown'); break;
  }
  if(verdict) { verification=verdict.verification; operator=verdict.operator; purpose=verdict.purpose; if(verdict.verification!=='none') claim=verdict.claim; }
  var mismatchFresh=false;
  if(ipAllowed && data.flagSpoofed && available && matches.length && verification!=='ip_match') {
    // Only explicit token-gated lists prove that this UA has a complete IP list.
    var operators=[];
    for(var i=0;i<rules.groups.length;i++) {
      var g=rules.groups[i];
      if(g.complete===true && g.tokens && (g.v4.length || g.v6.length || (g.shared_v4 && g.shared_v4.length) || (g.shared_v6 && g.shared_v6.length))) for(var j=0;j<g.tokens.length;j++) if(matches.indexOf(g.tokens[j])>=0) {if(operators.indexOf(g.operator)<0) operators.push(g.operator);}
    }
    for(var i=0;i<operators.length;i++) {
      var inOperatorRange=false;
      for(var j=0;j<rules.groups.length;j++) {
        var g=rules.groups[j];
        if(g.operator===operators[i] && ((n>=0 && v4Match(n,g.v4)) || v6Match(hex,g.v6) || (g.shared_v4 && n>=0 && v4Match(n,g.shared_v4)) || (g.shared_v6 && v6Match(hex,g.shared_v6)))) inOperatorRange=true;
      }
      if(!inOperatorRange && (n>=0 || hex) && presentUnion(rules,operators[i]) && (!identity || ignored || rules.operators[operators[i]].signatureAgent===identity)) {
        verification='ip_mismatch';
        var until=negativeWindow(rules,operators[i]);
        if(until) {mismatchFresh=true;mismatchUntil=Math.max(mismatchUntil,until);}
      }
    }
  }
  var verified=verification==='ip_match' || verification==='signature_valid';
  if(!verified && verification!=='signature_invalid' && marker!=='none') {operator=marker; claim=getEventData('traffic_agent_claim')==='dom_host' ? 'dom_host' : 'dom_marker';}
  var type='pending';
  if(verification==='signature_invalid') type='bot_spoofed';
  else if(verification==='ip_mismatch' && source.certain && mismatchFresh) type='bot_spoofed';
  else if(verified) type=purpose==='crawler' ? 'crawler_verified' : (purpose==='intermediary' ? 'automation_verified' : 'agent_verified');
  else if(browser==='automated') type='bot_automation';
  else if(verification==='ip_mismatch' || browser==='declared_agent' || claim==='ua_token' || claim==='signature_agent') type='agent_unverified';
  else if(browser==='suspicious') type='bot_suspicious';
  else if(browser==='human') type='human';
  var diagnostic=verdict && verdict.diagnostic;
  if(!available && !diagnostic) diagnostic='feed_unavailable';
  var suffix=[diagnostic || verification,purpose,claim,browser,phase].join('|');
  if(operator.length+1+suffix.length>100) operator='none';
  return {vv_type:type,vv_detail:operator+'|'+suffix};
}
// Validate the bounded feed before it can enter shared template storage.
function jsonBytes(r) {
  var raw=JSON.stringify(r);var size=1;
  for(var i=0;i<raw.length;i++) {
    var c=raw.charAt(i);
    if(c<='\u007f') size++;
    else if(c<='\u07ff') size+=2;
    else if(c>='\ud800' && c<='\udbff') {size+=4;i++;}
    else size+=3;
  }
  return size;
}
function valid(r) {
  // N-1 defaults are read locally: validation never mutates the wire object.
  if(getType(r)!=='object' || (r.schema!==2 && r.schema!==1) || r.complete!==true || getType(r.missing)!=='array' || r.missing.length!==0 || !contentFresh(r) || getType(r.operators)!=='array' || getType(r.tokens)!=='array' || getType(r.groups)!=='array' || r.operators.length>128 || r.tokens.length>512 || r.groups.length>256 || jsonBytes(r)>200000) return false;
  for(var i=0;i<r.operators.length;i++) {
    if(getType(r.operators[i])!=='object' || safeOperator(r.operators[i].id)==='none' || getType(r.operators[i].purposes)!=='object') return false;
    for(var j=0;j<i;j++) if(r.operators[j].id===r.operators[i].id) return false;
  }
  for(var i=0;i<r.tokens.length;i++) if(getType(r.tokens[i])!=='string' || !r.tokens[i] || r.tokens[i].length>128) return false;
  {
    var sources=r.sources;
    if(r.schema===1 && sources===undefined) sources=[];
    if(getType(sources)!=='array' || sources.length>256) return false;
    for(var i=0;i<sources.length;i++) {
      var source=sources[i];
      if(getType(source)!=='object' || safeOperator(source.operator)==='none' || getType(source.list)!=='string' || !(source.fetched_at_ms===null || (timestamp(source.fetched_at_ms) && source.fetched_at_ms<=now+300000)) || (source.available && source.fetched_at_ms===null) || getType(source.available)!=='boolean' || getType(source.refresh_ok)!=='boolean' || [undefined,null,'fetch','limit','shrink'].indexOf(source.reason)<0) return false;
      if(source.tokens!==undefined && source.tokens!==null) {
        if(getType(source.tokens)!=='array') return false;
        for(var j=0;j<source.tokens.length;j++) if(getType(source.tokens[j])!=='number' || source.tokens[j]%1!==0 || source.tokens[j]<0 || source.tokens[j]>=r.tokens.length) return false;
      }
      var known=false;
      for(var j=0;j<r.operators.length;j++) if(r.operators[j].id===source.operator) known=true;
      if(!known) return false;
      for(var j=0;j<i;j++) if(sources[j].operator===source.operator && sources[j].list===source.list) return false;
    }
  }
  var total=0;
  for(var i=0;i<r.groups.length;i++) {
    var g=r.groups[i];
    if(getType(g)!=='object' || getType(g.operator)!=='number' || g.operator%1!==0 || g.operator<0 || g.operator>=r.operators.length || getType(g.list)!=='string' || getType(g.v4)!=='array' || getType(g.v6)!=='array' || !(g.tokens===null || getType(g.tokens)==='array')) return false;
    if((getType(g.complete)!=='boolean' && !(r.schema===1 && g.complete===undefined)) || (!timestamp(g.fetched_at_ms) && !(r.schema===1 && g.fetched_at_ms===undefined)) || g.fetched_at_ms>now+300000) return false;
    for(var j=0;j<i;j++) if(r.groups[j].operator===g.operator && r.groups[j].list===g.list) return false;
    if(g.tokens) for(var j=0;j<g.tokens.length;j++) if(getType(g.tokens[j])!=='number' || g.tokens[j]%1!==0 || g.tokens[j]<0 || g.tokens[j]>=r.tokens.length) return false;
    var blocks=[g];
    if(g.shared_v4!==undefined || g.shared_v6!==undefined) blocks.push({v4:g.shared_v4,v6:g.shared_v6});
    for(var k=0;k<blocks.length;k++) {
      var block=blocks[k];
      if(getType(block.v4)!=='array' || getType(block.v6)!=='array') return false;
    total+=block.v4.length+block.v6.length; if(total>8192) return false;
    var end=-1;
    for(var j=0;j<block.v4.length;j++) {var row=block.v4[j]; if(getType(row)!=='array' || row.length!==2 || getType(row[0])!=='number' || getType(row[1])!=='number' || row[0]%1!==0 || row[1]%1!==0 || row[0]<=end || row[1]<row[0] || row[1]>4294967295) return false; end=row[1];}
    for(var j=0;j<block.v6.length;j++) {var row=block.v6[j]; if(getType(row)!=='array' || row.length!==2 || getType(row[0])!=='string' || row[0].length!==32 || getType(row[1])!=='number' || row[1]%1!==0 || row[1]<0 || row[1]>128) return false; for(var digit=0;digit<32;digit++) if('0123456789abcdef'.indexOf(row[0].charAt(digit))<0) return false;}
    }
  }
  return true;
}
function usableRules(r) {
  return r && (r.schema===2 || r.schema===1) && r.complete===true && getType(r.missing)==='array' && r.missing.length===0 && contentFresh(r);
}
function allowedUrl(value) {
  var base='https://cdn.jsdelivr.net/gh/Narrativva-Labs/visitor-verdict@';
  var tail='/dist/sgtm-rules.json';
  if(getType(value)!=='string' || value.indexOf(base)!==0 || value.slice(-tail.length)!==tail) return false;
  var tag=value.slice(base.length,-tail.length); if(!tag || tag.length>128) return false;
  for(var i=0;i<tag.length;i++) if('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-'.indexOf(tag.charAt(i))<0) return false;
  return true;
}
// Direct hosting uses the ingress-resolved sGTM address (Cloud Run capture 24 Nov).
// Custom chains require an enforced trusted suffix, including a client at index zero.
function clientIp() {
  var remote=requestIp;
  var raw=getRequestHeader('x-forwarded-for') || '';
  var mode=data.proxyMode || 'none';
  var clean=validIp(remote) ? remote : '';
  if(mode==='custom') {
    var count=makeNumber(data.proxyCount), parts=raw.length<=8192 ? raw.split(',') : [];
    var index=parts.length-count;
    if(count%1!==0 || count<1 || index<0 || index>=parts.length) return {ip:'',certain:false,promote:false};
    var ip=parts[index].trim();
    return {ip:validIp(ip) ? ip : '',certain:validIp(ip),promote:validIp(ip)};
  }
  if(mode==='cloudflare') {
    debug('proxy: cloudflare ranges/peer unavailable; using none with uncertain IP');
    return {ip:clean,certain:false,promote:false};
  }
  return {ip:clean,certain:!!clean,promote:!!clean};
}
function validIp(ip) { return getType(ip)==='string' && ip.length<=64 && (ipv4(ip)>=0 || !!ipv6(ip)); }
function serviceAllowed() {
  if(getType(service)!=='string' || service.indexOf('https://')!==0 || service.length>2048) return false;
  for(var i=8;i<service.length;i++) if('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_:/'.indexOf(service.charAt(i))<0) return false;
  return service.length>8 && service.slice(-1)!=='/';
}
function pathContext() {
  var path=require('getRequestPath')();
  if(getType(path)!=='string') return undefined;
  path=path.split('?')[0];
  var prefix=data.pathMode==='unset' ? '' : (data.pathMode==='root' ? '/' : data.publicPath || '');
  var full=(prefix==='/' ? '' : prefix)+path;
  return validPrefix(prefix) && validPath(path) && validPath(full) ? {path:full,prefix:prefix} : undefined;
}
function prefilter(rules) {
  var context=pathContext();
  var sig=getRequestHeader('signature'), input=getRequestHeader('signature-input'), rawAgent=getRequestHeader('signature-agent');
  if(!sig || !input || !rawAgent) return {reason:'missing_headers'};
  if(sig.length>16384 || input.length>16384 || rawAgent.length>16384 || sig.length+input.length+rawAgent.length>24000) return {reason:'header_limit'};
  var headers=[sig,input,rawAgent];
  for(var i=0;i<headers.length;i++) for(var j=0;j<headers[i].length;j++) if(!printable(headers[i].charAt(j)) && headers[i].charAt(j)!=='\t') return {reason:'header_encoding'};
  var members=signatureInputs(), agent=agents(rawAgent), signatures=sf(sig,false);
  if(!members || !agent || !signatures) return {reason:'parameters'};
  var union=[];
  for(var i=0;i<members.length;i++) if(union.indexOf(members[i].name)<0) union.push(members[i].name);
  for(var i=0;i<signatures.length;i++) if(union.indexOf(signatures[i].name)<0) union.push(signatures[i].name);
  if(union.length>4) return {reason:'signature_count'};
  var wba=false, path=false;
  var supported=[];
  for(var i=0;i<members.length;i++) {
    var member=members[i], tag=parameter(member,'tag');
    if(member.kind!=='list') {supported.push({member:member,safe:false,identity:false,path:false,refs:[]});continue;}
    if(!tag || tag.kind!=='string' || tag.value!=='web-bot-auth') {supported.push({member:member,safe:true,identity:false,path:false,refs:[]});continue;}
    wba=true;
    var seen=[], refs=[], agentKeys=[]; var identity=false, bareAgent=false, safe=true, memberPath=false;
    for(var j=0;j<member.value.length;j++) {
      var component=member.value[j], name=component.value, params=component.params;
      var dictionary=name==='signature-agent' || name==='signature' || name==='signature-input';
      if(component.kind!=='string' || ['@authority','@method','@scheme','@path','signature-agent','signature','signature-input'].indexOf(name)<0) safe=false;
      if(params.length && !(dictionary && params.length===1 && params[0].name==='key' && params[0].kind==='string')) safe=false;
      if((name==='signature' || name==='signature-input') && (!params.length || params[0].value===member.name)) safe=false;
      var id=name+';'+JSON.stringify(params);
      if(seen.indexOf(id)>=0) safe=false;
      seen.push(id);
      if(name==='@path') memberPath=true;
      if(name==='signature-input' && params.length) refs.push(params[0].value);
      if(name==='signature-agent') {
        if(!params.length) bareAgent=true;
        else if(params.length===1 && params[0].name==='key' && params[0].kind==='string' && agentKeys.indexOf(params[0].value)<0) agentKeys.push(params[0].value);
      }
    }
    // Match the verifier's attribution: own dictionary label wins; otherwise
    // exactly one covered key is required. An ambiguous peer cannot demand @path.
    var candidate=undefined;
    if(agent.legacy) {if(bareAgent) candidate=identityAt(agent);}
    else if(agentKeys.indexOf(member.name)>=0) candidate=identityAt(agent,member.name);
    else if(agentKeys.length===1) candidate=identityAt(agent,agentKeys[0]);
    identity=safe && knownIdentity(candidate,rules) && (!memberPath || !!context);
    supported.push({member:member,safe:safe,identity:identity,path:memberPath,refs:refs});
  }
  if(!wba) return {reason:'tag'};
  // A nested signature needs the raw input member it covers. Drop a parent if
  // that dependency cannot be forwarded, rather than fabricate an invalid base.
  for(var pass=0;pass<supported.length;pass++) for(var i=0;i<supported.length;i++) {
    var candidate=supported[i];
    for(var j=0;j<candidate.refs.length;j++) {
      var found=false;
      for(var k=0;k<supported.length;k++) if(supported[k].member.name===candidate.refs[j]) found=true;
      if(!found) {candidate.safe=false;candidate.identity=false;}
    }
  }
  // Independent unknown WBA peers are not verification candidates. Retain one
  // only when its raw input is a dependency of a recognized outer signature.
  for(var i=0;i<supported.length;i++) {
    var tag=parameter(supported[i].member,'tag');
    supported[i].forward=supported[i].safe && (supported[i].identity || !tag || tag.value!=='web-bot-auth');
  }
  for(var pass=0;pass<supported.length;pass++) for(var i=0;i<supported.length;i++) if(supported[i].forward) {
    for(var j=0;j<supported[i].refs.length;j++) for(var k=0;k<supported.length;k++) if(supported[k].member.name===supported[i].refs[j]) supported[k].forward=true;
  }
  var trusted=false; var forwarded=[];
  for(var i=0;i<supported.length;i++) if(supported[i].forward) {
    forwarded.push(supported[i].member.raw);
    if(supported[i].identity) {trusted=true;if(supported[i].path) path=true;}
  }
  if(!trusted) return {reason:'unsupported_candidate'};
  // Keep each member byte-for-byte; only dictionary separators may change.
  return {reason:'',path:path,input:forwarded.length===members.length ? input : forwarded.join(', ')};
}
function agentContains(identity) {
  var agent=agents(getRequestHeader('signature-agent')); if(!agent) return false;
  if(agent.legacy) return identityAt(agent)===identity;
  for(var i=0;i<agent.members.length;i++) if(identityAt(agent,agent.members[i].name)===identity) return true;
  return false;
}
function serviceVerdict(body,rules) {
  if(!body || getType(body)!=='object') return undefined;
  var none={verification:'none',operator:'none',purpose:'unknown',claim:'signature_agent',tolerated:true};
  if((getType(body.v)==='number' && body.v>1) || (getType(body.verification)==='string' && ['signature_valid','signature_invalid','none'].indexOf(body.verification)<0) || (getType(body.claim)==='string' && ['signature_agent','none'].indexOf(body.claim)<0)) return none;
  if(!(body.expires_at===null || (getType(body.expires_at)==='number' && body.expires_at%1===0)) || body.v!==1 || ['signature_valid','signature_invalid','none'].indexOf(body.verification)<0 || getType(body.purpose)!=='string' || ['signature_agent','none'].indexOf(body.claim)<0 || getType(body.operator)!=='string') return undefined;
  var known=false;
  for(var i=0;i<rules.operators.length;i++) if(rules.operators[i].id===body.operator && agentContains(rules.operators[i].signatureAgent)) known=true;
  if(body.verification==='signature_valid' && (!known || safeOperator(body.operator)==='none')) {
    // A newer service registry can lead the local feed. Schedule its renewal;
    // registry skew is not an HTTP/transport failure and must not open the breaker.
    var cached=storage.getItemCopy(rulesKey);
    if(cached && cached.url===url) {
      var t=require('getTimestampMillis')();
      if(cached.unknownAt===undefined || t-cached.unknownAt>=600000) {
        cached.forceRefresh=true;cached.unknownAt=t;storage.setItemCopy(rulesKey,cached);
      }
    }
    return none;
  }
  return {verification:body.verification,operator:body.verification==='signature_valid' ? body.operator : 'none',purpose:body.verification==='signature_valid' ? oneOf(body.purpose,['user_directed','crawler','intermediary','unknown'],'unknown') : 'unknown',claim:body.claim,expires:body.expires_at,reuse:body.reuse_until_ms};
}
function validPath(path) {
  if(getType(path)!=='string' || !path || path.charAt(0)!=='/' || path.length>2048) return false;
  for(var i=0;i<path.length;i++) {
    if(!printable(path.charAt(i)) || ' ?#\\'.indexOf(path.charAt(i))>=0) return false;
    if(path.charAt(i)==='%') {
      if(i+2>=path.length || '0123456789abcdefABCDEF'.indexOf(path.charAt(i+1))<0 || '0123456789abcdefABCDEF'.indexOf(path.charAt(i+2))<0) return false;
      i+=2;
    }
  }
  return true;
}
function validPrefix(prefix) {
  return validPath(prefix) && (prefix==='/' || prefix.slice(-1)!=='/');
}
function validMethod(method) {
  if(getType(method)!=='string' || !method || method.length>32) return false;
  for(var i=0;i<method.length;i++) if('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(method.charAt(i))<0) return false;
  return true;
}
function validAuthority(host) {
  if(getType(host)!=='string' || !host || host.length>253) return false;
  var labels=host.split('.');
  for(var i=0;i<labels.length;i++) {
    var label=labels[i];if(!label || label.length>63 || label.charAt(0)==='-' || label.slice(-1)==='-') return false;
    for(var j=0;j<label.length;j++) if('abcdefghijklmnopqrstuvwxyz0123456789-'.indexOf(label.charAt(j))<0) return false;
  }
  return true;
}
function finish(rules,available) {
  var shared=completed(); if(shared) return publish(rules,available);
  if(!validSignatureEnvelope()) {debug('prefilter: header_limit');return classify(rules,available);}
  if(!apiKey || !validUa()) return classify(rules,available);
  var filter=prefilter(rules);
  if(filter.reason) {debug('prefilter: '+filter.reason); return classify(rules,available);}
  var stateKey='vv_service_'+require('sha256Sync')(service+'\n'+apiKey,{outputEncoding:'hex'});
  var state=storage.getItemCopy(stateKey) || {errors:0,until:0};
  var none={verification:'none',operator:'none',purpose:'unknown',claim:'signature_agent'};
  var method=require('getRequestMethod')();
  var authority=getRequestHeader('host').toLowerCase();
  if(authority.slice(-4)===':443') authority=authority.slice(0,-4);
  if(!validMethod(method) || !validAuthority(authority)) {debug('prefilter: request_context'); return classify(rules,available,none);}
  var body={method:method,authority:authority,signature:getRequestHeader('signature'),signature_input:filter.input,signature_agent:getRequestHeader('signature-agent')};
  if(filter.path) {
    var context=pathContext();
    body.path=context.path;
    body.public_path_hash=require('sha256Sync')(context.prefix,{outputEncoding:'hex'});
  }
  var json=JSON.stringify(body);
  // Headers are checked printable ASCII above; host and path must be too, so bytes = characters.
  for(var i=0;i<json.length;i++) if(!printable(json.charAt(i))) {debug('prefilter: body_encoding'); return classify(rules,available,none);}
  var bytes=json.length;
  if(bytes>32768) {debug('prefilter: body_limit'); return classify(rules,available,none);}
  // First completed pair wins, including cold-feed and transport fallbacks.
  function result(verdict,until) {return publish(rules,available,verdict,until);}
  if(require('getTimestampMillis')()<state.until) {debug('breaker_open');none.diagnostic=oneOf(state.reason,['service_unavailable','rejected'],'service_unavailable');return result(none,require('getTimestampMillis')()+5000);}
  function failed(status,retry) {
    var t=require('getTimestampMillis')();
    var latest=storage.getItemCopy(stateKey) || {errors:0,until:0};
    var configError=status>=400 && status<500 && status!==429;
    if(configError) latest.errors=0;
    else latest.errors++;
    var end=0;
    if(status===429) end=t+(retry>0 && retry%1===0 ? retry*1000 : 30000);
    else if(!configError && latest.errors>=3) end=t+60000;
    if(end>=latest.until && end>t) {latest.until=end;latest.reason=status===429 ? 'rejected' : 'service_unavailable';}
    storage.setItemCopy(stateKey,latest);
    debug(status===400 ? '400 bad_request' : (status===401 ? 'rejected 401 invalid_key' : (status===403 ? 'rejected 403 host_not_allowed' : (status===429 ? 'rejected 429 rate_limited' : status))));
    // Check a completed result even on failure; never split type/detail on timeout.
    return result({verification:'none',operator:'none',purpose:'unknown',claim:'signature_agent',diagnostic:configError || status===429 ? 'rejected' : 'service_unavailable'},t+5000);
  }
  return require('sendHttpRequest')(service+'/verify',{method:'POST',timeout:500,headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','X-VV-Template':TEMPLATE_VERSION}},json).then(function(response) {
    if(response.statusCode!==200) return failed(response.statusCode,retrySeconds(((response.headers || {})['retry-after'] || (response.headers || {})['Retry-After'])));
    var parsed=getType(response.body)==='string' && response.body.length<=4096 ? JSON.parse(response.body) : undefined;
    var verdict=serviceVerdict(parsed,rules);
    if(!verdict) return failed('invalid_response',0);
    var t=require('getTimestampMillis')();
    var latest=storage.getItemCopy(stateKey) || {errors:0,until:0};
    storage.setItemCopy(stateKey,{errors:0,until:latest.until>t ? latest.until : 0,reason:latest.reason});
    if(verdict.tolerated) {debug('200 unsupported_contract'); return result(none,t+5000);}
    if(parsed.diagnostic==='config_suspect') {debug('config_suspect');verdict.diagnostic='config_suspect';}
    if(['directory_unavailable','capacity','evidence_unavailable'].indexOf(parsed.diagnostic)>=0) {debug(parsed.diagnostic);verdict.diagnostic='service_unavailable';}
    var until=t+5000;
    // An older service without the absolute deadline can answer this evaluation,
    // but its evidence must never start another local replay window.
    var reusable=getType(verdict.reuse)==='number' && verdict.reuse%1===0;
    if(reusable) until=Math.min(until,verdict.reuse);
    if(getType(verdict.expires)==='number') until=Math.min(until,verdict.expires*1000);
    debug('200 '+verdict.verification);
    if(until<=t) return result(verdict,t);
    return result(verdict,reusable ? until : t);
  }).then(undefined,function() {return failed('timeout',0);});
}
// One feed copy per evaluation. Result cache lookup does not copy or hash the feed.
var cached;
var prior=completed();
if(prior) return select(prior);
cached=storage.getItemCopy(rulesKey);
// Upgrade the former single custom-URL slot without losing its LKG or cooldown.
if(!cached && rulesKey!=='vv_rules_v1') {
  var legacyRules=storage.getItemCopy('vv_rules_v1');
  if(legacyRules && legacyRules.url===url) {cached=legacyRules;storage.setItemCopy(rulesKey,cached);}
}
if(cached && cached.url!==url) cached=undefined;
reserve();
if(url!==service+'/rules.json' && !allowedUrl(url)) return finish(empty,false);
if(!serviceAllowed()) return finish(empty,false);
var usable=cached && cached.rules && now-cached.at<86400000 && usableRules(cached.rules);
function settleFlight() {
  var flight=storage.getItemCopy(flightKey);
  if(flight && flight.url===url && flight.attempt===attempt) storage.setItemCopy(flightKey,null);
}
function retiredFlight(background,latest) {
  if(background) return undefined;
  var t=require('getTimestampMillis')();
  var ready=latest && latest.url===url && latest.rules && t-latest.at<86400000 && usableRules(latest.rules);
  cached=latest;
  // Release only this evaluation; never pin a fallback over an active successor.
  return publish(ready ? latest.rules : empty,!!ready,undefined,t);
}
function fallback(background,unsupported,retry) {
  settleFlight();
  var latest=storage.getItemCopy(rulesKey);
  if(latest && latest.attempt!==attempt) return retiredFlight(background,latest);
  if(latest && latest.url!==url) return background ? undefined : finish(usable ? cached.rules : empty,!!usable);
  var current=latest && latest.url===url && latest.rules && now-latest.at<86400000 && usableRules(latest.rules);
  var keep=current ? latest : (usable ? cached : {url:url,at:0,errors:latest && latest.errors || cached && cached.errors || 0});
  if(unsupported) keep.unsupported=true;
  keep.refreshFailed=true;
  keep.errors=(keep.errors || 0)+1;
  var delay=keep.rules ? (data.flagSpoofed || keep.forceRefresh || keep.unsupported ? 600000 : 300000) : Math.min(300000,15000*Math.pow(2,Math.min(keep.errors-1,5)));
  if(retry>0 && retry%1===0) delay=Math.max(delay,retry*1000);
  keep.retryAt=require('getTimestampMillis')()+delay;
  storage.setItemCopy(rulesKey,keep);cached=keep;
  return background ? undefined : finish(keep.rules || empty,!!keep.rules);
}
var attempt;
function refresh(background) {
  var headers={'X-VV-Template':TEMPLATE_VERSION};if(cached && cached.etag) headers['If-None-Match']=cached.etag;
  return sendHttpGet(url,{timeout:800,headers:headers}).then(function(response) {
    var latest=storage.getItemCopy(rulesKey);
    // Both success and failure must own the reservation. Late old URLs cannot evict a newer slot.
    var owned=latest && latest.url===url && latest.attempt===attempt;
    var t=require('getTimestampMillis')();
    debug('get_done status='+response.statusCode+' ms='+(t-now));
    if(!owned) return retiredFlight(background,latest);
    var rules;
    if(response.statusCode===304 && cached && cached.rules) rules=cached.rules;
    else {
      if(response.statusCode!==200 || getType(response.body)!=='string' || response.body.length>200000) return fallback(background,false,retrySeconds(((response.headers || {})['retry-after'] || (response.headers || {})['Retry-After'])));
      rules=JSON.parse(response.body);
      if(rules && getType(rules.schema)==='number' && rules.schema!==2 && rules.schema!==1) {
        if(owned) {latest.unsupported=true;latest.retryAt=t+600000;storage.setItemCopy(rulesKey,latest);}
        debug('200 unsupported_rules_schema');
        return fallback(background,true);
      }
    }
    if(!valid(rules)) return fallback(background);
    var etag=(response.headers || {}).etag || (response.headers || {}).ETag || (cached && cached.etag);
    var next={url:url,rules:rules,at:t,retryAt:0,refreshFailed:false,etag:etag,version:etag || rules.generated_at_ms,
      nextFetchAt:t+(data.flagSpoofed ? 600000 : 60000),unknownAt:latest && latest.url===url ? latest.unknownAt : cached && cached.unknownAt};
    if(owned) storage.setItemCopy(rulesKey,next);
    settleFlight();
    cached=next;
    return background ? undefined : finish(rules,true);
  }).then(undefined,function() {return fallback(background);});
}
function unavailableSources(r) {
  if(getType(r.sources)!=='array') return false;
  for(var i=0;i<r.sources.length;i++) if(!r.sources[i].available) return true;
  return false;
}
function needsNegativeRefresh(r) {
  for(var i=0;i<r.groups.length;i++) if(r.groups[i].complete===true && r.groups[i].source_key!=='static' && !negativeWindow(r,r.groups[i].operator)) return true;
  return false;
}
function begin(background) {
  attempt=(storage.getItemCopy('vv_rules_revision') || 0)+1;
  storage.setItemCopy('vv_rules_revision',attempt);
  var next=cached || {url:url,at:0};
  next.attempt=attempt;
  if(next.forceRefresh) next.forcedAt=now;
  next.retryAt=now+2000;
  storage.setItemCopy(rulesKey,next);
  storage.setItemCopy(flightKey,{url:url,attempt:attempt,until:now+2000});
  return refresh(background);
}
// Every successful GET, even an unchanged/still-incomplete feed, has a minimum interval.
if(usable) {
  var due=cached.forceRefresh || cached.unsupported || now-cached.at>=21600000 ||
    (data.flagSpoofed && (now-cached.at>=600000 || needsNegativeRefresh(cached.rules))) ||
    (now-cached.at>=600000 && unavailableSources(cached.rules));
  if(due && (!cached.forceRefresh || cached.forcedAt===undefined || now-cached.forcedAt>=600000) && now>=(cached.retryAt || 0) && now>=(cached.nextFetchAt || 0)) begin(true);
  return finish(cached.rules,true);
}
// callLater has no delay argument. The 2 s wall-clock deadline governs; the
// callback cap only guards a frozen clock (live sGTM 25. 11.: ~37 us per
// callback, so a 2048 cap expired after ~76 ms, before a 123 ms GET).
// Storage reads stay exponentially spaced (4..32 ms); every 512th callback
// reads anyway so a frozen clock still observes completion (live pace: ~19 ms).
var flight=storage.getItemCopy(flightKey);
if(flight && flight.url===url) {
  var callLater=require('callLater'), timestamp=require('getTimestampMillis');
  var polls=0, checkAt=0, step=4, MAX_CALLBACKS=262144;
  return require('Promise').create(function(resolve) {
    function settled() {
      var t=timestamp();polls++;
      if(t<flight.until && polls<MAX_CALLBACKS && t<checkAt && polls%512!==0) {callLater(settled);return;}
      var current=storage.getItemCopy(flightKey);
      if(current && current.attempt===flight.attempt && t<flight.until && polls<MAX_CALLBACKS) {
        checkAt=t+step;step=Math.min(32,step*2);callLater(settled);return;
      }
      if(current && current.attempt===flight.attempt) {resolve('deadline');return;}
      resolve('settled');
    }
    callLater(settled);
  }).then(function(state) {
    if(state==='deadline') {
      debug('cold_join_deadline');
      var current=storage.getItemCopy(flightKey);
      if(current && current.attempt===flight.attempt) {
        // Settle the abandoned generation for every active reader, including a
        // late owner. Its callback cannot publish stronger evidence to one side.
        storage.setItemCopy(flightKey,null);
        cached=storage.getItemCopy(rulesKey);
        if(cached && cached.attempt===flight.attempt) {
          cached.attempt=0;cached.refreshFailed=true;cached.errors=(cached.errors || 0)+1;
          cached.retryAt=timestamp()+Math.min(300000,15000*Math.pow(2,Math.min(cached.errors-1,5)));
          storage.setItemCopy(rulesKey,cached);
        }
      }
      return publish(empty,false);
    }
    cached=storage.getItemCopy(rulesKey);
    var ready=cached && cached.url===url && cached.rules && timestamp()-cached.at<86400000 && usableRules(cached.rules);
    debug(ready ? 'cold_join_ready' : 'cold_join_unavailable');
    return finish(ready ? cached.rules : empty,!!ready);
  });
}
if(cached && now<cached.retryAt) return finish(empty,false);
return begin(false);
