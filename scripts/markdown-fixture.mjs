export const picture='https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Neural_network.png/640px-Neural_network.png';
export const report=`# AI research

## What matters

**Useful insight** and *careful reasoning*.

- First finding
- Second finding

1. Read the evidence
2. Make a decision

> Check claims against their sources.

| Topic | Detail |
| --- | --- |
| AI | Evidence |

\`\`\`js
const answer = "<script>alert('unsafe')</script>";
\`\`\`

[Research source](https://example.org/research)

![Neural network diagram](${picture})

[Neural network](https://commons.wikimedia.org/wiki/File:Neural_network.png) · A Scientist · [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

<img src=x onerror=window.injected=true><script>window.injected=true</script>

![Private tracking image](https://evil.example/tracker.png)

[Unsafe](javascript:alert(1)) [File](file:///etc/passwd)
`;
export async function assertions(page,selector){
 const facts=await page.evaluate(selector=>{const b=document.querySelector(selector);return {h1:b.querySelector('h1')?.textContent,h2:b.querySelector('h2')?.textContent,strong:b.querySelector('strong')?.textContent,em:b.querySelector('em')?.textContent,ul:b.querySelectorAll('ul li').length,ol:b.querySelectorAll('ol li').length,table:b.querySelectorAll('table th').length,code:b.querySelector('pre code')?.textContent,images:[...b.querySelectorAll('img')].map(i=>i.src),bad:b.querySelectorAll('script,iframe,object,[onerror],[style],[id]').length,links:[...b.querySelectorAll('a')].map(a=>({url:a.href,rel:a.rel,target:a.target})),injected:!!window.injected,headingSize:parseFloat(getComputedStyle(b.querySelector('h1')).fontSize),copySize:parseFloat(getComputedStyle(b.querySelector('p')).fontSize)};},selector);
 if(facts.h1!=='AI research'||facts.h2!=='What matters'||facts.strong!=='Useful insight'||facts.em!=='careful reasoning'||facts.ul!==2||facts.ol!==2||facts.table!==2||!facts.code.includes('<script>')||facts.images.length!==1||facts.images[0]!==picture||facts.bad||facts.injected||facts.links.some(a=>!a.url.startsWith('https:')||!a.rel.includes('noopener')||a.target!=='_blank')||facts.headingSize<=facts.copySize)throw Error('Markdown structure/safety regression: '+JSON.stringify(facts));
 const speech=await page.evaluate(()=>window.EchoMarkdown.speechText('# Hello **world**.\n\n![Diagram](https://upload.wikimedia.org/wikipedia/commons/a/ab/test.png)\n\n[Learn](https://example.org)'));
 if(speech!=='Hello world. Learn')throw Error('Speakable answer regression: '+speech);
 const badImages=await page.evaluate(()=>['javascript:alert(1)','data:image/svg+xml,x','file:///test.png','https://127.0.0.1/test.png','https://upload.wikimedia.org.evil.test/wikipedia/commons/a.png','https://user@upload.wikimedia.org/wikipedia/commons/a.png','https://upload.wikimedia.org/wikipedia/commons/a.svg'].map(u=>window.EchoMarkdown.imageUrl(u)));
 if(badImages.some(Boolean))throw Error('Unsafe image URL accepted');
}
