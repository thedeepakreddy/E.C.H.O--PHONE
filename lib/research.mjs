import {XMLParser} from 'fast-xml-parser';
const clip=(value,n=600)=>String(value??'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,n);
const url=value=>{try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return null;u.protocol='https:';return u.href;}catch{return null;}};
const list=value=>Array.isArray(value)?value:value?[value]:[];
const date=value=>{const parts=value?.['date-parts']?.[0];return Array.isArray(parts)&&Number.isInteger(parts[0])?parts.map((n,i)=>i===0?String(n):String(n).padStart(2,'0')).join('-'):null;};
export function crossrefPapers(data) {
 return list(data?.message?.items).slice(0,40).map(p=>({title:clip(list(p.title)[0],300),authors:list(p.author).slice(0,8).map(a=>clip([a.given,a.family].filter(Boolean).join(' '),100)),published:date(p.published??p.issued),updated:p.indexed?.['date-time']??null,abstract:clip(p.abstract,2400),url:url(p.DOI?`https://doi.org/${p.DOI}`:p.URL),doi:clip(p.DOI,180),venue:clip(list(p['container-title'])[0],200),kind:p.type==='posted-content'?'preprint or posted content':clip(p.type,60),source:'Crossref',note:'Publisher-deposited metadata/abstract, not a full-text read. Publication type does not by itself verify peer review.'})).filter(p=>p.title&&p.url);
}
export function arxivPapers(xml) {
 if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('Unsupported XML declarations');
 const feed=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,processEntities:false,parseTagValue:false}).parse(xml)?.feed;
 return list(feed?.entry).slice(0,10).map(p=>({title:clip(p.title,300),authors:list(p.author).slice(0,8).map(a=>clip(a.name,100)),published:clip(p.published,30),updated:clip(p.updated,30),abstract:clip(p.summary,2400),url:url(p.id),doi:clip(p.doi,180),venue:clip(p.journal_ref,200),kind:'preprint',source:'arXiv',note:'Live preprint abstract/metadata. This does not verify peer review or mean the full paper was read.'})).filter(p=>p.title&&p.url&&new URL(p.url).hostname==='arxiv.org'&&new URL(p.url).pathname.startsWith('/abs/'));
}
let nextArxiv=0;
async function arxivSlot(signal) {
 const wait=Math.max(0,nextArxiv-Date.now());nextArxiv=Math.max(nextArxiv,Date.now())+3000;
 if(!wait)return;await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason??Error('Cancelled'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},wait);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
}
async function bodyText(response) {
 if(!response.ok)throw Error(`HTTP ${response.status}`);let length=0;const chunks=[];
 for await(const chunk of response.body){length+=chunk.length;if(length>1500000)throw Error('Response size limit');chunks.push(chunk);}
 return Buffer.concat(chunks).toString('utf8');
}
export async function searchResearch({query,since,sort='relevance',source='all',limit=6}={}, {fetchImpl=fetch,signal,now=Date.now,spaceRequests=true}={}) {
 const q=clip(query,300),at=now(),today=new Date(at).toISOString().slice(0,10),from=since||new Date(at-365*86400000).toISOString().slice(0,10);
 if(!q||!/^\d{4}-\d{2}-\d{2}$/.test(from)||!Number.isFinite(Date.parse(from))||new Date(from).toISOString().slice(0,10)!==from||from>today||!['all','arxiv','crossref'].includes(source)||!['relevance','newest'].includes(sort))return {status:'input',papers:[],error:'Use a topic, valid past YYYY-MM-DD date, source all/arxiv/crossref and sort relevance/newest.'};
 const count=Math.min(10,Math.max(1,Number.isInteger(limit)?limit:6)),retrievedAt=new Date(at).toISOString();
 const crossref=new URL('https://api.crossref.org/works');crossref.search=new URLSearchParams({query:q,rows:String(sort==='newest'?Math.min(40,count*4):count),filter:`from-pub-date:${from},until-pub-date:${today}`,sort:'relevance',order:'desc'});
 const arxiv=new URL('https://export.arxiv.org/api/query');
 // Treat the user's topic as terms, never arbitrary API search syntax.
 const terms=q.replace(/["():\[\]]/g,' ').trim().split(/\s+/).slice(0,20).map(t=>`all:"${t}"`).join(' AND ');
 arxiv.search=new URLSearchParams({search_query:`(${terms}) AND submittedDate:[${from.replaceAll('-','')}0000 TO ${today.replaceAll('-','')}2359]`,max_results:String(count),sortBy:sort==='newest'?'submittedDate':'relevance',sortOrder:'descending'});
 const selected=source==='all'?['arxiv','crossref']:[source];
 const results=await Promise.all(selected.map(async name=>{
  const timed=AbortSignal.timeout(15000),combined=signal?AbortSignal.any([signal,timed]):timed;
  try {if(name==='arxiv'&&spaceRequests)await arxivSlot(combined);combined.throwIfAborted();const body=await bodyText(await fetchImpl(name==='arxiv'?arxiv:crossref,{headers:{'User-Agent':'EchoResearch/1.0 (https://github.com/thedeepakreddy/E.C.H.O--PHONE)'},redirect:'error',signal:combined}));
   let papers=name==='arxiv'?arxivPapers(body):crossrefPapers(JSON.parse(body));if(name==='crossref'&&sort==='newest')papers.sort((a,b)=>String(b.published||'').localeCompare(String(a.published||'')));papers=papers.slice(0,count);return {source:name,status:'ok',papers};
  }catch(error){if(signal?.aborted)throw error;return {source:name,status:'unavailable',papers:[],error:'The index could not be reached or returned an invalid/oversized response.'};}
 }));
 const papers=[...new Map(results.flatMap(r=>r.papers).map(p=>[p.doi||p.url,p])).values()].slice(0,20),available=results.filter(r=>r.status==='ok').length;
 return {status:available===results.length?'ok':available?'partial':'unavailable',query:q,since:from,retrievedAt,papers,sources:results.map(({papers,...s})=>s),note:'These are a bounded sample, not exhaustive coverage. Crossref newest sorts the strongest relevance-ranked matches by date, so unrelated fresh records do not dominate. Check topic relevance and use focused queries for broad trends. Use these live records and read relevant source pages for specific claims. Cite actual titles, dates and URLs. An empty result is not evidence that research does not exist. Metadata/abstract access is not a full-paper read. If an index fails, use the other index or public page/browser tools and state the specific gap.'};
}
