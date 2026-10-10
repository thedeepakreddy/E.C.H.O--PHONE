/** Public illustration search, shared by Phone and Mac. No arbitrary upstream URL is accepted. */
const text = (raw,limit=220) => String(raw ?? '').replace(/<[^>]*>/g,' ').replace(/&(?:amp|quot|lt|gt|#39);/g,e=>({'&amp;':'&','&quot;':'"','&lt;':'<','&gt;':'>','&#39;':"'"}[e])).replace(/\s+/g,' ').trim().slice(0,limit);
const mdText = raw => text(raw).replace(/[\\`*_{}\[\]()<>!#|]/g,'\\$&');
function httpsUrl(raw,hosts,path) {
 try {const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port||!hosts.includes(u.hostname)||!u.pathname.startsWith(path))return null;u.search='';u.hash='';return u.href;}catch{return null;}
}
export function cleanImage(page) {
 const info=page?.imageinfo?.[0],meta=info?.extmetadata;if(!info||!meta)return null;
 const url=httpsUrl(info.thumburl,['upload.wikimedia.org','thumb.wikimedia.org'],'/wikipedia/commons/');
 const source=httpsUrl(info.descriptionurl,['commons.wikimedia.org'],'/wiki/File:');
 const license=text(meta.LicenseShortName?.value,60),author=text(meta.Artist?.value||info.user,400);
 if(!url||!source||!author||!/\.(?:jpe?g|png|webp|gif)$/i.test(new URL(url).pathname)||!/^image\/(?:jpeg|png|webp|gif)$/.test(info.thumbmime||info.mime)||! /^(?:CC0(?: 1\.0)?|CC BY(?:-SA)?(?: [1-4]\.0)?|Public domain)$/i.test(license))return null;
 const title=text(String(page.title??'').replace(/^File:/,''),180),description=text(meta.ImageDescription?.value,320);
 const licenseUrl=httpsUrl(meta.LicenseUrl?.value,['creativecommons.org'],'/');
 const credit=`[${mdText(title)}](${source}) · ${mdText(author)} · ${licenseUrl?`[${mdText(license)}](${licenseUrl})`:mdText(license)}`;
 return {title,description,url,source,author,license,licenseUrl,markdown:`![${mdText(title)}](${url})\n\n${credit}`};
}
export async function searchImages(query,{fetchImpl=fetch,signal}={}) {
 const subject=text(query,160);if(!subject)return {images:[],note:'Choose a public subject for image search.'};
 const url=new URL('https://commons.wikimedia.org/w/api.php');
 url.search=new URLSearchParams({action:'query',format:'json',formatversion:'2',generator:'search',gsrsearch:`${subject} filetype:bitmap`,gsrnamespace:'6',gsrlimit:'6',gsrsort:'relevance',prop:'imageinfo',iiprop:'url|mime|thumbmime|extmetadata|user',iiurlwidth:'640',iiextmetadatafilter:'Artist|LicenseShortName|LicenseUrl|ImageDescription'});
 try {
  const timeout=AbortSignal.timeout(10000),r=await fetchImpl(url,{headers:{'User-Agent':'EchoResearch/1.0 (https://github.com/thedeepakreddy/E.C.H.O--PHONE)'},redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});
  if(!r.ok)throw Error('Image source unavailable');
  // Fixed upstream and bounded response; never fetch model-selected private hosts.
  let size=0;const chunks=[];for await(const chunk of r.body){size+=chunk.length;if(size>1000000)throw Error('Image response too large');chunks.push(chunk);}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const images=(data.query?.pages||[]).sort((a,b)=>(a.index??0)-(b.index??0)).map(cleanImage).filter(Boolean).slice(0,4);
  return {images,note:images.length?'Select up to two genuinely relevant illustrations. Copy their exact Markdown AND full credit into the answer. Images are illustrations, not evidence of current facts. Never invent image URLs.':'No suitable credited pictures found. Answer without images; do not substitute an unrelated picture.'};
 }catch(error){if(signal?.aborted)throw error;return {images:[],note:'Image search unavailable. Continue with the answer without invented or unrelated pictures.'};}
}
