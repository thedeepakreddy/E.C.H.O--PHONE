/* Shared readable answer renderer. Raw HTML stays literal; only public Commons pictures load. */
(() => {
  const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function linkUrl(raw) {
    try { const url = new URL(raw); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
  }
  function imageUrl(raw) {
    const safe = linkUrl(raw); if (!safe) return null;
    const u = new URL(safe);
    if (!['upload.wikimedia.org','thumb.wikimedia.org'].includes(u.hostname) || u.port || !u.pathname.startsWith('/wikipedia/commons/') || !/\.(?:jpe?g|png|webp|gif)$/i.test(u.pathname)) return null;
    u.search = ''; u.hash = ''; return u.href;
  }
  const md = window.markdownit({html:false,linkify:false,breaks:true,typographer:false,maxNesting:20});
  md.renderer.rules.link_open = (tokens,idx) => {
    const url = linkUrl(tokens[idx].attrGet('href'));
    return url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">` : '<span>';
  };
  md.renderer.rules.link_close = (tokens,idx) => {
    // Opening and closing tokens are paired, including nested inline emphasis.
    for(let i=idx-1,depth=0;i>=0;i--){if(tokens[i].type==='link_close')depth++;if(tokens[i].type==='link_open'){if(depth===0)return linkUrl(tokens[i].attrGet('href'))?'</a>':'</span>';depth--;}}
    return '</span>';
  };
  md.renderer.rules.image = (tokens,idx,options,env,self) => {
    const token=tokens[idx],alt=self.renderInlineAsText(token.children,options,env),url=imageUrl(token.attrGet('src'));
    if(!url || env.images>=3) return `<span>${escape(alt || 'Picture')}</span>`;
    env.images++;return `<img src="${escape(url)}" alt="${escape(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
  };
  function html(text) {
    return window.DOMPurify.sanitize(md.render(String(text ?? '').slice(0,100000),{images:0}),{
      ALLOWED_TAGS:['p','br','h1','h2','h3','h4','h5','h6','strong','em','s','ul','ol','li','blockquote','pre','code','hr','table','thead','tbody','tr','th','td','a','span','img'],
      ALLOWED_ATTR:['href','src','alt','title','class','start','target','rel','referrerpolicy','loading','decoding'],
      ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false
    });
  }
  function render(text) { const box=document.createElement('div');box.className='echo-markdown';box.innerHTML=html(text);return box; }
  // DOMPurify strips events. Attach failure behavior ourselves, including bodies
  // inserted via template strings on the Agents page. A failed image keeps its alt text.
  document.addEventListener('error',event=>{
    const img=event.target;if(img?.tagName!=='IMG'||!img.closest('.echo-markdown'))return;
    const fallback=document.createElement('span');fallback.className='echo-image-unavailable';fallback.textContent=`${img.alt||'Picture'} · image unavailable`;img.replaceWith(fallback);
  },true);
  function speechText(text) {
    const box=render(text);box.querySelectorAll('img').forEach(n=>n.remove());box.querySelectorAll('pre').forEach(n=>{n.textContent=' Code block. ';});
    for(const n of box.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,tr,blockquote'))n.append(document.createTextNode(' '));
    return box.textContent.replace(/\s+/g,' ').trim();
  }
  window.EchoMarkdown=Object.freeze({html,render,speechText,imageUrl});
})();
