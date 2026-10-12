import { parse, serialize } from 'parse5';
const tags=new Set('html head title body main section article header footer div span p h1 h2 h3 h4 ul ol li strong b em i br hr table thead tbody tfoot tr th td caption colgroup col figure figcaption code pre svg rect circle line polyline polygon text'.split(' '));
const classes=new Set('eyebrow metadata provenance muted grid grid-three card kpi kpi-value kpi-label positive warning negative unknown notice number label page-break keep legend'.split(' '));
const colors=new Set('#111113 #52525b #1d4ed8 #166534 #854d0e #991b1b'.split(' '));
const backgrounds=new Set('#ffffff #fff #f4f4f5 #fef9c3 #fee2e2'.split(' '));
const styles={
 'font-size':v=>/^\d+(\.\d+)?pt$/.test(v)&&parseFloat(v)>=8&&parseFloat(v)<=48,
 'font-weight':v=>['400','700'].includes(v),'font-style':v=>['normal','italic'].includes(v),
 'text-align':v=>['left','right','center'].includes(v),'font-variant-numeric':v=>v==='tabular-nums',
 'line-height':v=>/^\d+(\.\d+)?$/.test(v)&&+v>=1.2&&+v<=2,
 color:v=>colors.has(v),'background-color':v=>backgrounds.has(v),
 'break-before':v=>['auto','page'].includes(v),'break-after':v=>['auto','page','avoid'].includes(v),'break-inside':v=>['auto','avoid'].includes(v),
};
export function validateStyle(value){
 if(value.length>1024)throw Error('style');
 const seen=new Set();for(const part of value.split(';').filter(x=>x.trim())){
  const match=/^\s*([a-z-]+)\s*:\s*([^:;]+?)\s*$/.exec(part);if(!match||seen.has(match[1])||!styles[match[1]]?.(match[2]))throw Error('style');seen.add(match[1]);
 }
}
const scalar=v=>/^\d+(\.\d+)?$/.test(v)&&Number.isFinite(+v)&&+v<=2000;
export function inertDocument(html,provenance){
 if(typeof html!=='string'||Buffer.byteLength(html)>524288||/\u0000/.test(html))throw Error('html');
 const errors=[];const doc=parse(html,{onParseError:e=>{if(!['missing-doctype'].includes(e.code))errors.push(e.code);}});
 if(errors.length)throw Error('markup');let nodes=0,svgCount=0,text='',allText='';
 function visit(node,insideSvg=false,insideBody=false){
  if(++nodes>20000)throw Error('nodes');
  if(node.nodeName==='#text'){allText+=' '+node.value;if(insideBody)text+=node.value;return;}
  if(node.nodeName==='#comment')throw Error('comment');
  if(node.tagName){
   const tag=node.tagName;if(!tags.has(tag)||node.namespaceURI!=='http://www.w3.org/1999/xhtml'&&!insideSvg&&tag!=='svg'||tag==='svg'&&insideSvg)throw Error('tag');
   const attrs=Object.fromEntries(node.attrs.map(a=>[a.name,a.value]));
   for(const a of node.attrs){
    const {name,value,namespace}=a;allText+=' '+value;if(namespace)throw Error('namespace');
    if(name==='class'){if(value.split(/\s+/).some(c=>!classes.has(c)))throw Error('class');}
    else if(name==='style'){if(insideSvg||tag==='svg')throw Error('svg style');validateStyle(value);}
    else if(name==='lang'){if(tag!=='html'||value!=='it')throw Error('lang');}
    else if(name==='scope'){if(tag!=='th'||!['row','col'].includes(value))throw Error('scope');}
    else if(['colspan','rowspan','span'].includes(name)){if(!['td','th','col','colgroup'].includes(tag)||!/^([1-9]|1[0-2])$/.test(value))throw Error('span');}
    else if(name==='role'||name==='aria-label'){if(tag!=='svg'||name==='role'&&value!=='img'||name==='aria-label'&&(value.length<1||value.length>512))throw Error('aria');}
    else if(tag==='svg'&&['width','height','viewBox'].includes(name)){if(name!=='viewBox'&&!scalar(value))throw Error('svg viewport');}
    else if(insideSvg&&['x','y','x1','y1','x2','y2','cx','cy','r','width','height','stroke-width','font-size'].includes(name)){if(!scalar(value))throw Error('svg coordinate');if(name==='font-size'&&(+value<10.666||+value>64))throw Error('svg font');if(name==='stroke-width'&&(+value<1||+value>6))throw Error('svg stroke');}
    else if(insideSvg&&['fill','stroke'].includes(name)){if(!colors.has(value)&&!(value==='none'&&tag!=='text'))throw Error('svg paint');}
    else if(insideSvg&&name==='points'&&['polyline','polygon'].includes(tag)){if(value.length>8192||!/^\d+(?:\.\d+)?(?:[, ]+\d+(?:\.\d+)?)+$/.test(value)||value.split(/[, ]+/).some(v=>!scalar(v))||value.split(/[, ]+/).length%2)throw Error('svg points');}
    else throw Error('attribute');
   }
   if(tag==='svg'){
    if(++svgCount>128||+attrs.width<80||+attrs.width>660||+attrs.height<40||+attrs.height>800||attrs.viewBox!==`0 0 ${attrs.width} ${attrs.height}`)throw Error('svg viewport');
   }
   if(insideSvg&&!['rect','circle','line','polyline','polygon','text'].includes(tag))throw Error('svg tag');
   if(insideSvg&&tag==='text'&&(attrs.x===undefined||attrs.y===undefined||attrs['font-size']===undefined))throw Error('svg text');
  }
  for(const child of node.childNodes??[])visit(child,insideSvg||node.tagName==='svg',insideBody||node.tagName==='body');
 }
 visit(doc);
 // Preserve decoded adjacent body nodes: inline markup must not split a recognized sensitive value.
 if(!text.trim()||/\b(?:\d{6,12}:[A-Za-z0-9_-]{20,}|lnbc[a-z0-9]+|nsec1[a-z0-9]+|sk-[A-Za-z0-9_-]{12,}|gh[op]_[A-Za-z0-9_-]+)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(allText+' '+text))throw Error('sensitive content');
 if(provenance&&[provenance.observedAt,provenance.coverage,...provenance.evidenceRefs].some(value=>!text.includes(value)))throw Error('missing visible provenance');
 return serialize(doc);
}
/** Executed by trusted Puppeteer in its isolated document; no agent script is enabled. */
export function visibleLayout(){
 const fail=()=>{throw Error('Visible DLS layout rejected');};
 const width=document.documentElement.clientWidth;let textBoxes=0,svgBoxes=0,minFontPt=48;
 const lum=c=>{const v=c.match(/[\d.]+/g)?.slice(0,3).map(Number);if(!v||v.length!==3)fail();return v.map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0);};
 const textWalker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 while(textWalker.nextNode()){
  const node=textWalker.currentNode;if(!node.textContent.trim())continue;const el=node.parentElement,style=getComputedStyle(el);
  if(style.visibility!=='visible'||style.display==='none'||+style.opacity!==1)fail();
  const size=parseFloat(style.fontSize)*.75;if(size<7.99||size>48.01)fail();minFontPt=Math.min(minFontPt,size);
  let ancestor=el;let bg='rgb(255, 255, 255)';
  while(ancestor){const css=getComputedStyle(ancestor);if(+css.opacity!==1||css.transform!=='none'||css.clipPath!=='none'||css.filter!=='none')fail();if(css.backgroundColor!=='rgba(0, 0, 0, 0)'&&css.backgroundColor!=='transparent'){bg=css.backgroundColor;break;}ancestor=ancestor.parentElement;}
  const l1=lum(style.color),l2=lum(bg);if((Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05)<4.5)fail();
  const range=document.createRange();range.selectNodeContents(node);const rects=[...range.getClientRects()];if(!rects.length)fail();
  for(const r of rects){if(r.width<=0||r.height<=0||r.left<-.5||r.right>width+.5||r.top<-.5)fail();textBoxes++;if(textBoxes>100000)fail();}
 }
 for(const el of document.querySelectorAll('tr,.keep,.card,.kpi,figure'))if(el.getBoundingClientRect().height>975)fail();
 for(const svg of document.querySelectorAll('svg')){
  const view=svg.viewBox.baseVal,rect=svg.getBoundingClientRect();if(Math.abs(rect.width-view.width)>1||Math.abs(rect.height-view.height)>1)fail();
  const boxes=[];
  for(const el of svg.children){const b=el.getBBox();if(b.x<0||b.y<0||b.x+b.width>view.width+.1||b.y+b.height>view.height+.1)fail();boxes.push({tag:el.tagName,b});svgBoxes++;}
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],c=boxes[j];if(a.tag!=='text'&&c.tag!=='text')continue;if(a.b.x<c.b.x+c.b.width&&c.b.x<a.b.x+a.b.width&&a.b.y<c.b.y+c.b.height&&c.b.y<a.b.y+a.b.height)fail();}
 }
 if(!textBoxes||document.body.scrollWidth>width+1)fail();return {version:'puppeteer-visible-v1',textBoxes,svgBoxes,minFontPt};
}
