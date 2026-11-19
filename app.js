import {readMusicXML} from './musicxml.js?v=0.6.0';
import {HornSound} from './horn-sound.js?v=0.6.0';

const $=id=>document.getElementById(id);
const sound=new HornSound();
const projectBase=new URL('./',location.href);

let state={
  ready:false,engineLoaded:false,pages:[],score:null,scanRunning:false,batchRunning:false,
  engineError:null,enginePageId:null,currentScanIndex:-1,currentReviewIndex:-1,
  reviewConfirmed:false,watcher:null
};
let reviewShown=false;

function status(title,desc,kind='wait',progress=0){
  $('statusTitle').textContent=title;
  $('statusText').textContent=desc;
  $('statusDot').className='status-dot'+(kind==='ok'?' ok':kind==='error'?' error':'');
  $('progress').hidden=!(progress>0&&progress<100);
  $('progressFill').style.width=Math.max(4,Math.min(100,progress))+'%';
}
function fail(title,msg){
  state.scanRunning=false;state.batchRunning=false;
  status(title,msg,'error');
  $('retryBtn').hidden=!state.pages.some(p=>p.status==='error'||p.status==='pending');
  setBatchControls(false);renderPageList();
}
function makeId(){return globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(16).slice(2)}`;}
function isSupportedFile(file){return /\.(?:jpe?g|png|webp|pdf)$/i.test(file.name)||/^image\//.test(file.type)||file.type==='application/pdf';}
function isImageFile(file){return /^image\//.test(file.type)||/\.(?:jpe?g|png|webp)$/i.test(file.name);}
function cleanPageUrl(page){if(page?.previewUrl){URL.revokeObjectURL(page.previewUrl);page.previewUrl=null;}}
function setBatchControls(disabled){
  const allDone=state.pages.length>0&&state.pages.every(p=>p.status==='done'&&p.score);
  $('photo').disabled=disabled;
  $('scanAllBtn').disabled=disabled||!state.pages.length||allDone;
  $('clearPagesBtn').disabled=disabled||!state.pages.length;
}
function invalidateCombined(){
  sound.stop();state.score=null;state.reviewConfirmed=false;
  $('resultPanel').hidden=true;$('reviewPanel').hidden=true;reviewShown=false;
  $('playBtn').disabled=true;$('stopBtn').disabled=true;
}

async function init(){
  try{
    if(location.protocol==='file:')throw Error('ファイルを直接開く方法では読譜エンジンが動きません。GitHub Pagesへ公開してください。');
    if(!('serviceWorker' in navigator))throw Error('このブラウザは読譜エンジンに対応していません。Chrome または Edge をお試しください。');
    await navigator.serviceWorker.register(new URL('./sw.js',projectBase),{scope:projectBase.pathname});
    await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller){
      await new Promise(resolve=>{navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true});setTimeout(resolve,4000)});
    }
    if(!crossOriginIsolated&&!sessionStorage.getItem('horn-isolation-reload')){
      sessionStorage.setItem('horn-isolation-reload','1');location.reload();return;
    }
    state.ready=true;
    status('じゅんび OK！','楽譜を1枚でも、何枚でも選べます。','ok');
  }catch(e){fail('じゅんびに しっぱいしました',String(e?.message||e));}
}

function engineWindow(){return $('engineFrame').contentWindow;}
function attachEngineDiagnostics(){
  try{
    const win=engineWindow();
    if(!win||win.__hornDiagAttached)return;
    win.__hornDiagAttached=true;
    win.addEventListener('error',e=>{state.engineError=String(e?.message||e?.error?.message||'不明なエラー');});
    win.addEventListener('unhandledrejection',e=>{const r=e?.reason;state.engineError=String(r?.message||r||'不明なエラー');});
  }catch{}
}
function engineVisibleError(doc){
  try{
    for(const sel of ['#error','.error','[role="alert"]','[data-error]']){
      for(const el of doc.querySelectorAll(sel)){
        if(el.hidden)continue;
        const t=(el.textContent||'').trim();
        if(t&&/(error|failed|failure|exception|memory|abort|エラー|失敗)/i.test(t))return t.slice(0,240);
      }
    }
  }catch{}
  return '';
}
async function loadEngine(){
  if(state.engineLoaded){try{if(engineWindow()?.document?.getElementById('files'))return;}catch{}}
  status('がくふを よむ じゅんび','読譜エンジンを読み込んでいます。初回は通信が必要です。','wait',8);
  const frame=$('engineFrame');frame.src=new URL('./_omr/index.html',projectBase).href;
  const start=performance.now();
  while(performance.now()-start<45000){
    await new Promise(r=>setTimeout(r,300));
    try{
      const doc=frame.contentDocument;if(!doc)continue;
      if(doc.getElementById('files')&&engineWindow()?.sheetscan){state.engineLoaded=true;attachEngineDiagnostics();return;}
      if(doc.body?.innerText?.includes('読譜エンジンが取得できません'))throw Error(doc.body.innerText.slice(0,140));
    }catch(e){if(String(e).includes('cross-origin'))throw Error('読譜エンジンの読み込みがブロックされました。');else throw e;}
  }
  throw Error('読譜エンジンが起動しません。通信状態とブラウザを確認してください。');
}

function humanStatus(step,detail){
  const s=step+' '+detail;
  if(/Downloading recognition models/i.test(s))return 'はじめての準備：読譜データをダウンロードしています（約150MB）';
  if(/Reading staff/i.test(s))return '五線の音符を ひとつずつ読んでいます…';
  if(/Reading page/i.test(s))return '楽譜のページを読んでいます…';
  if(/Finding staves/i.test(s))return '五線と音符を探しています…';
  if(/Python runtime|recognition engine|image libraries/i.test(s))return '音符を読む道具を準備しています…';
  return '楽譜を解析しています。しばらくこの画面のままにしてください。';
}

async function imageLowResolution(page){
  if(!isImageFile(page.file)||!page.previewUrl)return false;
  try{
    const img=new Image();img.src=page.previewUrl;await img.decode();
    return Math.min(img.naturalWidth,img.naturalHeight)<1000||Math.max(img.naturalWidth,img.naturalHeight)<1600;
  }catch{return false;}
}

async function scanPage(page,index,total,{review=false}={}){
  if(!state.ready)throw Error('アプリの準備が終わっていません。');
  const file=page?.file;if(!file)throw Error('写真を選んでください。');
  if(file.size>30*1024*1024)throw Error(`${index+1}ページ目が大きすぎます。30MB以下にしてください。`);
  if(!isSupportedFile(file))throw Error(`${index+1}ページ目はJPG・PNG・WEBP・PDFを選んでください。`);

  const oldStatus=page.status,oldError=page.error;
  sound.stop();state.scanRunning=true;state.engineError=null;state.currentScanIndex=index;
  page.status='reading';page.error=null;renderPageList();
  $('retryBtn').hidden=true;

  try{
    const lowRes=await imageLowResolution(page);
    await loadEngine();attachEngineDiagnostics();
    const win=engineWindow();const doc=win?.document;
    if(!doc)throw Error('読譜エンジンの画面を開けませんでした。');
    const input=doc.getElementById('files');if(!input)throw Error('読譜エンジンの入力欄が見つかりません。');

    const oldXml=typeof win?.sheetscan?.xml==='string'?win.sheetscan.xml:'';
    let resetWorked=false;
    try{win.sheetscan.xml='';resetWorked=!(typeof win.sheetscan.xml==='string'&&win.sheetscan.xml.length>50);}catch{}

    const beforeView=doc.body?.dataset.view||'';
    const beforeStep=doc.getElementById('status')?.textContent||'';
    const beforeDetail=doc.getElementById('detail')?.textContent||'';
    const beforeSignature=[beforeView,beforeStep,beforeDetail].join('|');

    const dt=new DataTransfer();dt.items.add(file);
    try{input.files=dt.files;}catch{throw Error('このブラウザでは写真を読み取りエンジンに渡せませんでした。');}
    if(!input.files||input.files.length!==1)throw Error('写真を読み取りエンジンに渡せませんでした。ブラウザを更新してもう一度お試しください。');
    input.dispatchEvent(new Event('change',{bubbles:true}));

    const t0=performance.now();let lastSignal=t0,lastSignature=beforeSignature,sawBusy=false,busyEndedAt=0;
    while(performance.now()-t0<8*60*1000){
      await new Promise(r=>setTimeout(r,450));if(!state.scanRunning)throw Error('読譜を中断しました。');
      const liveWin=engineWindow();const liveDoc=liveWin?.document;if(!liveDoc)continue;
      const view=liveDoc.body?.dataset.view||'';
      const step=liveDoc.getElementById('status')?.textContent||'';
      const detail=liveDoc.getElementById('detail')?.textContent||'';
      const p=parseFloat(liveDoc.getElementById('bar')?.style.width||'0');
      const localProgress=Number.isFinite(p)&&p>0?Math.min(92,p):35;
      const overall=((index+Math.max(.08,localProgress/100))/Math.max(1,total))*100;
      const busy=/(Downloading|Reading|Finding|Python runtime|recognition engine|image libraries|processing|analy)/i.test(step+' '+detail);
      if(busy){sawBusy=true;busyEndedAt=0;}
      else if(sawBusy&&!busyEndedAt)busyEndedAt=performance.now();

      const xml=liveWin?.sheetscan?.xml;
      const xmlReady=typeof xml==='string'&&xml.length>50;
      const completionFallback=sawBusy&&!busy&&busyEndedAt>0&&(performance.now()-busyEndedAt>1200); 
      if(xmlReady&&(resetWorked||xml!==oldXml||completionFallback)){
        const score=readMusicXML(xml);
        page.xml=xml;page.score=score;page.lowRes=lowRes;page.status='done';page.error=null;
        state.enginePageId=page.id;state.scanRunning=false;renderPageList();
        return {xml,score,lowRes};
      }

      if(state.engineError)throw Error('読譜エンジンでエラーが発生しました：'+state.engineError.slice(0,220));
      const visibleError=engineVisibleError(liveDoc);
      if(visibleError)throw Error('読譜エンジンでエラーが発生しました：'+visibleError);
      const unsupported=liveDoc.getElementById('unsupported');
      if(view==='start'&&unsupported&&!unsupported.hidden&&unsupported.textContent)throw Error('楽譜を読めませんでした。'+unsupported.textContent.slice(0,160));

      const signature=[view,step,detail,Number.isFinite(p)?Math.round(p):''].join('|');
      if(signature!==lastSignature){lastSignature=signature;lastSignal=performance.now();}
      const prefix=total>1?`${index+1} / ${total} ページ　`:'';
      if(step){status(prefix+'がくふを よんでいます…',humanStatus(step,detail),'wait',overall);}
      else{
        const elapsed=performance.now()-t0,quiet=performance.now()-lastSignal;
        if(elapsed<30000)status(prefix+'がくふを よんでいます…','読譜エンジンを起動しています。初回は約150MBの取得があります。','wait',overall);
        else if(quiet>45000)status(prefix+'がくふを よんでいます…','初回データの取得または音符解析を続けています。通信が切れると失敗表示に変わります。','wait',overall);
      }
    }
    throw Error('8分以内に読譜が完了しませんでした。通信状態・端末の空きメモリを確認し、ページを更新してもう一度お試しください。');
  }catch(e){
    state.scanRunning=false;
    if(review&&page.score){page.status=oldStatus==='done'?'done':oldStatus;page.error=oldError;}
    else{page.status='error';page.error=String(e?.message||e);}
    renderPageList();throw e;
  }
}

function mergeScores(pages){
  if(!pages.length||pages.some(p=>!p.score))throw Error('まだ読み終わっていないページがあります。');
  const events=[],tempoEvents=[],barStarts={},warnings=[];
  let beatOffset=0,barOffset=0,totalNotes=0,totalUnusual=0,totalInvalid=0,totalPitchFlags=0,maxParts=1;

  pages.forEach((page,pageIndex)=>{
    const s=page.score;
    const sourceBars=Object.entries(s.barStarts||{}).map(([bar,beat])=>({bar:Number(bar),beat:Number(beat)})).sort((a,b)=>a.beat-b.beat||a.bar-b.bar);
    const barMap=new Map();
    sourceBars.forEach((b,j)=>{const newBar=barOffset+j+1;barMap.set(b.bar,newBar);barStarts[newBar]=beatOffset+b.beat;});
    const fallbackMap=oldBar=>barMap.get(Number(oldBar))??(barOffset+Math.max(1,Number(oldBar)||1));

    for(const e of s.events||[])events.push({...e,beat:e.beat+beatOffset,bar:fallbackMap(e.bar),endBar:fallbackMap(e.endBar)});

    let tempos=(s.tempoEvents||[]).map(t=>({...t}));
    const hadSyntheticStart=(s.warnings||[]).some(w=>w.includes('曲の冒頭のテンポが読み取れない'));
    if(pageIndex>0&&hadSyntheticStart&&tempos.length&&Math.abs(tempos[0].beat)<1e-8&&Math.abs(tempos[0].bpm-120)<1e-8)tempos=tempos.slice(1);
    for(const t of tempos)tempoEvents.push({beat:t.beat+beatOffset,bpm:t.bpm});

    for(const w of s.warnings||[])warnings.push(pages.length>1?`${pageIndex+1}ページ目：${w}`:w);
    totalNotes+=s.notes||0;totalUnusual+=s.unusual||0;totalInvalid+=s.invalidDurations||0;totalPitchFlags+=s.pitchFlags||0;maxParts=Math.max(maxParts,s.parts||1);
    beatOffset+=s.totalBeats||0;barOffset+=s.bars||sourceBars.length;
  });

  events.sort((a,b)=>a.beat-b.beat||a.pitch-b.pitch);
  tempoEvents.sort((a,b)=>a.beat-b.beat);
  const normalized=[];
  for(const t of tempoEvents){
    if(normalized.length&&Math.abs(normalized.at(-1).beat-t.beat)<1e-8)normalized[normalized.length-1]={...t};
    else normalized.push({...t});
  }
  if(!normalized.length)normalized.push({beat:0,bpm:120});
  const validBars=[...new Set(events.map(e=>e.bar))].sort((a,b)=>a-b);
  return {events,bars:barOffset,measures:barOffset,validBars,firstTempo:normalized[0].bpm,tempoEvents:normalized,barStarts,notes:totalNotes,warnings,unusual:totalUnusual,invalidDurations:totalInvalid,parts:maxParts,totalBeats:beatOffset,pitchFlags:totalPitchFlags};
}

function showResult(score,{scroll=true}={}){
  state.score=score;state.reviewConfirmed=false;
  $('resultPanel').hidden=false;
  $('resultTitle').textContent=state.pages.length>1?`全${state.pages.length}ページを よみとりました`:'がくふを よみとりました';
  $('resultMeta').textContent=`${state.pages.length}ページ・${score.bars}小節・${score.notes}音の候補（正確さは要確認）`;
  $('baseBpm').value=score.firstTempo;
  $('fromBar').replaceChildren(new Option('はじめから','0'),...score.validBars.map(n=>new Option(`${n} 小節から`,String(n))));

  const warnings=[...score.warnings];
  state.pages.forEach((p,i)=>{if(p.lowRes)warnings.unshift(`${state.pages.length>1?`${i+1}ページ目：`:''}写真の解像度が低いため、読み間違いの可能性が高いです。近くから撮り直すことをおすすめします。`);});
  if(warnings.length){$('caution').hidden=false;$('caution').textContent='⚠️ おとなの人と確認してね：'+warnings.join('／');}
  else $('caution').hidden=true;

  $('reviewCheck').checked=false;$('allowPlay').disabled=true;$('verifyBox').hidden=false;$('playBtn').disabled=true;
  $('reviewCheckText').textContent=state.pages.length>1?'すべてのページを、もとの楽譜と見比べました':'もとの楽譜と、音符・休符・長さを見比べました';
  $('nowPlaying').textContent='おとなの人が音符を見比べるまで演奏できません';

  $('reviewPageTools').hidden=state.pages.length<2;
  $('reviewPage').replaceChildren(...state.pages.map((p,i)=>new Option(`${i+1}ページ目：${p.file.name}`,String(i))));
  if(state.currentReviewIndex<0||state.currentReviewIndex>=state.pages.length)state.currentReviewIndex=Math.max(0,state.currentScanIndex);
  $('reviewPage').value=String(state.currentReviewIndex);

  status('がくふを よみとりました',state.pages.length>1?'全部のページを1曲につなぎました。原譜と見比べてください。':'その音を正しいお手本にする前に、原譜と見比べてください。','ok');
  if(scroll)$('resultPanel').scrollIntoView({block:'start',behavior:'smooth'});
}

function finalizeResults({scroll=true}={}){
  if(!state.pages.length||state.pages.some(p=>p.status!=='done'||!p.score))return false;
  const score=mergeScores(state.pages);showResult(score,{scroll});return true;
}

async function startBatch(){
  if(state.batchRunning||!state.pages.length)return;
  if(!state.ready){fail('まだ準備中です','アプリの準備が終わってから、もう一度押してください。');return;}
  state.batchRunning=true;state.scanRunning=false;setBatchControls(true);invalidateCombined();
  state.pages.forEach(p=>{if(p.status==='error')p.status='pending';p.error=null;});renderPageList();
  let lastError='';
  try{
    for(let i=0;i<state.pages.length;i++){
      const page=state.pages[i];if(page.status==='done'&&page.score)continue;
      try{await scanPage(page,i,state.pages.length);}catch(e){lastError=String(e?.message||e);}
    }
  }finally{
    state.batchRunning=false;state.scanRunning=false;setBatchControls(false);renderPageList();
  }
  const failed=state.pages.filter(p=>p.status==='error');
  if(failed.length){
    status(`${failed.length}ページ よめませんでした`,failed.length===1?(failed[0].error||lastError):'赤いページだけ「もういちど」で読み直せます。','error');
    $('retryBtn').hidden=false;return;
  }
  state.currentReviewIndex=Math.max(0,state.pages.findLastIndex?state.pages.findLastIndex(p=>p.status==='done'):state.pages.length-1);
  $('retryBtn').hidden=true;finalizeResults();
}

function pageStatusText(page){
  if(page.status==='reading')return '読み取り中…';
  if(page.status==='done')return '読み取り済み';
  if(page.status==='error')return 'エラー';
  return 'まだ読んでいません';
}
function renderPageList(){
  const box=$('selectedPages'),list=$('pageList');
  box.hidden=!state.pages.length;list.replaceChildren();
  $('pageCount').textContent=state.pages.length?`（${state.pages.length}ページ）`:'';
  $('filename').textContent=state.pages.length===1?state.pages[0].file.name:state.pages.length?`${state.pages.length}ページ 選択中`:'';
  $('scanAllBtn').textContent=state.pages.length&&state.pages.every(p=>p.status==='done'&&p.score)?'全部 読み取り済み':'この順で 全部よむ';

  state.pages.forEach((page,i)=>{
    const card=document.createElement('div');card.className='page-card '+page.status;card.dataset.id=page.id;
    const thumb=document.createElement('div');thumb.className='page-thumb';
    if(page.previewUrl){const img=document.createElement('img');img.src=page.previewUrl;img.alt=`${i+1}ページ目の写真`;thumb.append(img);}
    else{const pdf=document.createElement('span');pdf.className='pdf-thumb';pdf.textContent='PDF';thumb.append(pdf);}
    const info=document.createElement('div');info.className='page-info';
    const title=document.createElement('strong');title.textContent=`${i+1}ページ目`;
    const name=document.createElement('span');name.textContent=page.file.name;
    const st=document.createElement('span');st.className='page-state';st.textContent=pageStatusText(page);
    if(page.error)st.title=page.error;
    info.append(title,name,st);
    const actions=document.createElement('div');actions.className='page-actions';
    for(const [action,label,titleText] of [['up','↑','上へ'],['down','↓','下へ'],['remove','×','削除']]){
      const b=document.createElement('button');b.type='button';b.dataset.action=action;b.dataset.id=page.id;b.textContent=label;b.title=titleText;
      b.disabled=state.batchRunning||(action==='up'&&i===0)||(action==='down'&&i===state.pages.length-1);actions.append(b);
    }
    card.append(thumb,info,actions);list.append(card);
  });
  setBatchControls(state.batchRunning);
}

function addFiles(files){
  const arr=[...files];if(!arr.length)return 0;
  const errors=[];let added=0;
  for(const file of arr){
    if(!isSupportedFile(file)){errors.push(`${file.name}：対応していない形式`);continue;}
    if(file.size>30*1024*1024){errors.push(`${file.name}：30MBを超えています`);continue;}
    const page={id:makeId(),file,previewUrl:null,status:'pending',xml:null,score:null,lowRes:false,error:null};
    if(isImageFile(file))page.previewUrl=URL.createObjectURL(file);
    state.pages.push(page);added++;
  }
  if(added)invalidateCombined();renderPageList();
  if(errors.length)status('一部のファイルを追加できませんでした',errors.join('／'),'error');
  else if(state.pages.length>1)status(`${state.pages.length}ページ えらびました`,'↑↓で順番を確認して「この順で 全部よむ」を押してください。','ok');
  return added;
}
function clearPages(){
  if(state.batchRunning)return;sound.stop();state.pages.forEach(cleanPageUrl);state.pages=[];state.score=null;state.enginePageId=null;state.currentReviewIndex=-1;
  $('resultPanel').hidden=true;$('reviewPanel').hidden=true;$('retryBtn').hidden=true;reviewShown=false;renderPageList();
  status('じゅんび OK！','楽譜を1枚でも、何枚でも選べます。','ok');
}
function removePage(id){
  if(state.batchRunning)return;const i=state.pages.findIndex(p=>p.id===id);if(i<0)return;cleanPageUrl(state.pages[i]);state.pages.splice(i,1);invalidateCombined();
  if(state.pages.length&&state.pages.every(p=>p.status==='done'&&p.score))finalizeResults({scroll:false});
  else status(state.pages.length?`${state.pages.length}ページ 選択中`:'じゅんび OK！',state.pages.length?'順番を確認して読み取ってください。':'楽譜を選んでください。','ok');
  renderPageList();
}
function movePage(id,delta){
  if(state.batchRunning)return;const i=state.pages.findIndex(p=>p.id===id),j=i+delta;if(i<0||j<0||j>=state.pages.length)return;
  [state.pages[i],state.pages[j]]=[state.pages[j],state.pages[i]];invalidateCombined();renderPageList();
  if(state.pages.every(p=>p.status==='done'&&p.score))finalizeResults({scroll:false});
  else status('ページの順番を変えました','この順番で読み取ります。','ok');
}

function markPlaying(playing){
  $('playBtn').disabled=playing;$('stopBtn').disabled=!playing;
  $('playText').textContent=playing?'えんそう中…':'ホルンで きく';$('playGlyph').textContent=playing?'♫':'▶';
}
async function startPlayback(){
  try{
    const s=state.score;if(!s)throw Error('先に楽譜を読み取ってください。');
    if(!state.reviewConfirmed)throw Error('読み取った楽譜を大人の人と確認してください。');
    markPlaying(true);$('nowPlaying').textContent='ホルンの音色を準備しています…';
    const pick=Number($('fromBar').value||0);const first=pick?s.events.find(e=>e.bar>=pick):s.events[0];
    if(!first)throw Error('指定した小節に演奏する音符がありません。');
    const bpm=Number($('baseBpm').value)||s.firstTempo;
    const tempos=(s.tempoEvents||[]).map(t=>({...t}));
    if(tempos.length){const ratio=bpm/s.firstTempo;for(const t of tempos)t.bpm*=ratio;}
    const onEnd=()=>{markPlaying(false);$('nowPlaying').textContent='おわりました！';};
    await sound.play(s.events,{from:pick?(s.barStarts[pick]??first.beat):0,shift:Number($('transpose').value),speed:Number($('speed').value),tempoEvents:tempos,loop:$('repeat').value==='1',onEnd,onTick:(bar,elapsed,total)=>{
      $('nowPlaying').textContent=bar?`${bar} 小節を えんそう中　${Math.round(elapsed)}秒 / ${Math.round(total)}秒`:'♪ えんそう中…';
    }});
  }catch(e){sound.stop();markPlaying(false);$('nowPlaying').textContent='再生できません：'+String(e?.message||e);}
}
function stopPlayback(){sound.stop();markPlaying(false);$('nowPlaying').textContent='とまりました';}

function showReviewPanel(){
  reviewShown=true;$('reviewPanel').hidden=false;$('reviewToggle').setAttribute('aria-expanded','true');$('reviewToggle').textContent='とじる ▲';
  setTimeout(()=>engineWindow()?.dispatchEvent(new Event('resize')),100);$('reviewPanel').scrollIntoView({behavior:'smooth'});
}
function openReview(){
  if(!state.pages.length)return;
  if(state.currentReviewIndex<0)state.currentReviewIndex=Math.max(0,state.pages.length-1);
  $('reviewPage').value=String(state.currentReviewIndex);showReviewPanel();
  if(state.pages.length>1&&state.enginePageId!==state.pages[state.currentReviewIndex]?.id){
    status('確認するページを選べます','上の「確認するページ」から選び、「このページを表示」を押してください。','ok');
  }
}
async function loadReviewPage(){
  const index=Number($('reviewPage').value);if(!Number.isInteger(index)||!state.pages[index])return;
  const page=state.pages[index];state.currentReviewIndex=index;
  if(state.enginePageId===page.id){showReviewPanel();return;}
  if(state.batchRunning)return;
  state.batchRunning=true;setBatchControls(true);
  try{
    await scanPage(page,index,state.pages.length,{review:true});
    finalizeResults({scroll:false});$('reviewPage').value=String(index);showReviewPanel();
    status(`${index+1}ページ目を表示しています`,'原譜と読み取った音符を見比べてください。','ok');
  }catch(e){fail('確認するページを開けませんでした',String(e?.message||e));}
  finally{state.batchRunning=false;setBatchControls(false);renderPageList();}
}
function updateXML(){
  const index=state.currentReviewIndex,page=state.pages[index];if(!page)throw Error('確認中のページが見つかりません。');
  if(state.enginePageId!==page.id)throw Error('先に「このページを表示」で確認するページを開いてください。');
  const xml=engineWindow()?.sheetscan?.xml;if(!xml)throw Error('修正後の楽譜が見つかりません。');
  page.xml=xml;page.score=readMusicXML(xml);page.status='done';page.error=null;finalizeResults({scroll:false});showReviewPanel();
}

$('photo').addEventListener('change',async e=>{
  const files=[...e.target.files];e.target.value='';const before=state.pages.length;const added=addFiles(files);if(!added)return;
  if(before===0&&state.pages.length===1){try{await startBatch();}catch(e){fail('がくふを よめませんでした',String(e?.message||e));}}
});
$('scanAllBtn').onclick=()=>startBatch().catch(e=>fail('がくふを よめませんでした',String(e?.message||e)));
$('retryBtn').onclick=()=>startBatch().catch(e=>fail('がくふを よめませんでした',String(e?.message||e)));
$('clearPagesBtn').onclick=clearPages;
$('pageList').onclick=e=>{
  const btn=e.target.closest('button[data-action]');if(!btn)return;const id=btn.dataset.id;
  if(btn.dataset.action==='up')movePage(id,-1);else if(btn.dataset.action==='down')movePage(id,1);else if(btn.dataset.action==='remove')removePage(id);
};
$('playBtn').onclick=startPlayback;
$('stopBtn').onclick=stopPlayback;
$('speed').oninput=()=>{$('speedLabel').textContent=+$('speed').value===100?'ふつう（100%）':`${$('speed').value}%`;};
$('speed').onchange=()=>{if(sound.playing)stopPlayback();};
$('openReview').onclick=openReview;
$('loadReviewPage').onclick=()=>loadReviewPage().catch(e=>fail('確認するページを開けませんでした',String(e?.message||e)));
$('reviewCheck').onchange=()=>{$('allowPlay').disabled=!$('reviewCheck').checked;};
$('allowPlay').onclick=()=>{
  if(!$('reviewCheck').checked||!state.score)return;
  state.reviewConfirmed=true;$('verifyBox').hidden=true;$('playBtn').disabled=false;$('nowPlaying').textContent='じゅんびOK！ 「ホルンで きく」を押してね';
};
$('reviewToggle').onclick=()=>{
  reviewShown=!reviewShown;$('reviewPanel').hidden=!reviewShown;$('reviewToggle').setAttribute('aria-expanded',String(reviewShown));$('reviewToggle').textContent=reviewShown?'とじる ▲':'がくふが あっているか たしかめる ▼';
  if(reviewShown){setTimeout(()=>engineWindow()?.dispatchEvent(new Event('resize')),100);$('reviewPanel').scrollIntoView({behavior:'smooth'});}
};
$('refreshResult').onclick=()=>{try{stopPlayback();updateXML();}catch(e){fail('修正の反映に失敗',String(e?.message||e));}};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&sound.playing)stopPlayback();});
window.addEventListener('beforeunload',()=>state.pages.forEach(cleanPageUrl));

renderPageList();init();
