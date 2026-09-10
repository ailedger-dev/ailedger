import {mountCollective} from './scene.js';
const canvas=document.querySelector('#collective'),world=document.querySelector('.world');
let scene;try{scene=mountCollective(canvas);if(canvas.dataset.renderState==='ready')world.classList.add('ready');}catch{canvas.dataset.renderState='unavailable';}
canvas.addEventListener('webglcontextlost',()=>world.classList.remove('ready'));
const reduced=matchMedia('(prefers-reduced-motion: reduce)'),motion=document.querySelector('#motion');
let paused=reduced.matches,scheduled=false,centers=[],current=0;
const sections=[...document.querySelectorAll('.chapter')],links=[...document.querySelectorAll('.chapter-nav a')],names=['Collective intelligence','Connecting context','A verifiable record','Scientific possibility','More capable, together','An expanding frontier'];
const nextChapter=document.querySelector('#next-chapter');
nextChapter.addEventListener('click',()=>links[current+1]?.click());
function pause(){scene?.setPaused(paused);document.body.classList.toggle('motion-paused',paused);motion.innerHTML=paused?'Play motion <span aria-hidden="true">▷</span>':'Pause motion <span aria-hidden="true">Ⅱ</span>';}
motion.addEventListener('click',()=>{paused=!paused;pause();});reduced.addEventListener('change',e=>{paused=e.matches;pause();update();});pause();
// Match chapter navigation to the visible copy, not the oversized scroll section.
function chapterTop(section){
 const copy=section.querySelector('.chapter-copy');
 const top=scrollY+copy.getBoundingClientRect().top;
 const safeTop=document.querySelector('.header').offsetHeight+24;
 const safeBottom=74;
 const inset=Math.max(safeTop,(innerHeight-copy.offsetHeight+safeTop-safeBottom)/2);
 return Math.max(0,Math.min(document.documentElement.scrollHeight-innerHeight,top-inset));
}
function measure(){centers=sections.map(s=>chapterTop(s)+innerHeight*.5);update();}
function jump(section,behavior=reduced.matches?'instant':'smooth'){
 scrollTo({top:chapterTop(section),behavior});
}
document.addEventListener('click',event=>{
 const link=event.target.closest('a[href^="#"]');
 if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
 const section=sections.find(s=>'#'+s.id===link.getAttribute('href'));
 if(!section)return;
 event.preventDefault();
 if(location.hash!=='#'+section.id)history.pushState(null,'','#'+section.id);
 jump(section);
 section.tabIndex=-1;section.focus({preventScroll:true});
});
function jumpToHash(){const section=sections.find(s=>'#'+s.id===location.hash);if(section)jump(section,'instant');}
addEventListener('hashchange',jumpToHash);
document.fonts.ready.then(()=>{measure();jumpToHash();});
function update(){scheduled=false;const point=scrollY+innerHeight*.5;let low=0;while(low<centers.length-2&&point>centers[low+1])low++;const fraction=Math.max(0,Math.min(1,(point-centers[low])/(centers[low+1]-centers[low])));const progress=Math.max(0,Math.min(5,low+fraction));const indicatorProgress=reduced.matches?Math.round(progress):progress;const indicatorLow=Math.min(links.length-2,Math.floor(indicatorProgress));const indicatorFraction=indicatorProgress-indicatorLow;const dotY=i=>links[i].offsetTop+links[i].offsetHeight/2;document.querySelector('.chapter-nav').style.setProperty('--indicator-y',`${dotY(indicatorLow)+(dotY(indicatorLow+1)-dotY(indicatorLow))*indicatorFraction}px`);current=Math.round(progress);nextChapter.hidden=current===sections.length-1;if(!nextChapter.hidden)nextChapter.setAttribute('aria-label','Next section: '+links[current+1].getAttribute('aria-label'));scene?.setScroll(reduced.matches?current:progress);document.body.dataset.chapter=String(current);document.querySelector('#scene-name').textContent=names[current];document.querySelector('#chapter-count').textContent=String(current+1).padStart(2,'0');links.forEach((a,i)=>i===current?a.setAttribute('aria-current','location'):a.removeAttribute('aria-current'));const full=document.documentElement.scrollHeight-innerHeight;document.querySelector('#reading-progress').style.transform=`scaleX(${full>0?scrollY/full:0})`;sections.forEach((s,i)=>{const offset=(centers[i]-point)/innerHeight,copy=s.querySelector('.chapter-copy');copy.style.setProperty('--visibility',String(Math.max(.15,Math.min(1,1-(Math.abs(offset)-.3)*.75))));});}
addEventListener('scroll',()=>{if(!scheduled){scheduled=true;requestAnimationFrame(update);}},{passive:true});addEventListener('resize',measure);document.fonts.ready.then(measure);measure();
const products={record:{kind:'Open-source record infrastructure',title:'A record that stands up.',description:'Capturing AI decision events with input hashes, model provenance, and an append-only chain that can be verified.',nodes:['Input hash','Decision','Record'],href:'https://github.com/ailedger-dev/ailedger'},context:{kind:'Open context standard · aiDNA network',title:'Context that carries forward.',description:'Structuring knowledge so people and agents can carry understanding between efforts. An open standard alongside the aiLedger record.',nodes:['Knowledge','Context','Next effort'],href:'https://github.com/adna-network/aDNA'},detection:{kind:'Open-source detection library',title:'Following the patterns.',description:'Examining recorded decisions for disparate outcomes and model drift. Making evidence available for closer investigation.',nodes:['Decisions','Patterns','Investigation'],href:'https://github.com/ailedger-dev/ailedger-detection'}};
const tabs=[...document.querySelectorAll('[role=tab]')];
function select(tab){const p=products[tab.dataset.product];tabs.forEach(t=>{const yes=t===tab;t.setAttribute('aria-selected',String(yes));t.tabIndex=yes?0:-1;});document.querySelector('#software-panel').setAttribute('aria-labelledby',tab.id);for(const [id,key]of [['product-kind','kind'],['product-title','title'],['product-description','description']])document.getElementById(id).textContent=p[key];['node-one','node-two','node-three'].forEach((id,i)=>document.getElementById(id).textContent=p.nodes[i]);document.querySelector('#product-source').href=p.href;}
tabs.forEach((tab,i)=>{tab.addEventListener('click',()=>select(tab));tab.addEventListener('keydown',e=>{let next;if(e.key==='ArrowRight')next=(i+1)%tabs.length;if(e.key==='ArrowLeft')next=(i+tabs.length-1)%tabs.length;if(e.key==='Home')next=0;if(e.key==='End')next=tabs.length-1;if(next!==undefined){e.preventDefault();select(tabs[next]);tabs[next].focus();}});});
