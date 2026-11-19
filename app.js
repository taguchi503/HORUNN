import {readMusicXML} from './musicxml.js?v=0.6.3';
import {HornSound} from './horn-sound.js?v=0.6.3';

const $=id=>document.getElementById(id);
const sound=new HornSound();
const projectBase=new URL('./',location.href);
let reviewShown=false;
let state={
  ready:false,engineLoaded:false,pages:[],currentFile:null,xml:null,score:null,
  lowRes:false,previewUrl:null,scanRunning:false,reviewConfirmed:false,engineError:null,watcher:null
};

function status(title,desc,kind='wait',progress=0){
  $('statusTitle').textContent=title;$('statusText').textContent=desc;
  $('statusDot').className='status-dot'+(kind==='ok'?' ok':kind==='error'?' error':'');
  $('progress').hidden=!(progress>0&&progress<100);
  $('progressFill').style.width=Math.max(4,Math.min(100,progress))+'%';
}
function fail(title,msg){
  state.scanRunning=false;
  status(title,msg,'error');
  $('retryBtn').hidden=!state.pages.length;
  state.pages.forEach(p=>{if(p.status==='reading')p.status='error';});
  renderPageList();setControls(false);
}
function makeId(){return globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(16).slice(2)}`;}
function isImageFile(file){return /^image\//.test(file.type)||/\.(?:jpe?g|png|webp)$/i.test(file.name);}
function isPdfFile(file){return file.type==='application/pdf'||/\.pdf$/i.test(file.name);}
function isSupportedFile(file){return isImageFile(file)||isPdfFile(file);}
function cleanPageUrl(page){if(page?.previewUrl){URL.revokeObjectURL(page.previewUrl);page.previewUrl=null;}}
function cleanPreview(){if(state.previewUrl){URL.revokeObjectURL(state.previewUrl);state.previewUrl=null;}}
function setControls(disabled){
  $('photo').disabled=disabled;
  $('scanAllBtn').disabled=disabled||!state.pages.length;
  $('clearPagesBtn').disabled=disabled||!state.pages.length;
  for(const b of $('pageList').querySelectorAll('button'))b.disabled=disabled||b.disabled;
}
function invalidateResult(){
  sound.stop();state.score=null;state.xml=null;state.currentFile=null;state.reviewConfirmed=false;
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
    // Cross-origin isolation is necessary on Safari without JSPI. A reload
    // lets our service worker add COOP/COEP to the top-level navigation.
    if(!crossOriginIsolated && !sessionStorage.getItem('horn-isolation-reload')){
      sessionStorage.setItem('horn-isolation-reload','1');location.reload();return;
    }
    state.ready=true;
    status('じゅんび OK！','しゃしんを えらんでね。','ok');
  }catch(e){fail('じゅんびに しっぱいしました',String(e?.message||e));}
}
function engineWindow(){return $('engineFrame').contentWindow;}
function attachEngineDiagnostics(){
  try{
    const win=engineWindow();if(!win||win.__hornDiagAttached)return;
    win.__hornDiagAttached=true;
    win.addEventListener('error',e=>{state.engineError=String(e?.message||e?.error?.message||'不明なエラー');});
    win.addEventListener('unhandledrejection',e=>{const r=e?.reason;state.engineError=String(r?.message||r||'不明なエラー');});
  }catch{}
}
function engineVisibleError(doc){
  try{
    for(const sel of ['#error','.error','[role="alert"]','[data-error]']){
      for(const el of doc.querySelectorAll(sel)){
        if(el.hidden)continue;const t=(el.textContent||'').trim();
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
  let start=performance.now();
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

function ascii(s){return new TextEncoder().encode(s);}
function joinBytes(parts){
  const total=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(total);let off=0;
  for(const p of parts){out.set(p,off);off+=p.length;}return out;
}
function canvasToJpeg(canvas,quality=.93){
  return new Promise((resolve,reject)=>canvas.toBlob(async blob=>{
    if(!blob)return reject(Error('写真をPDF用画像へ変換できませんでした。'));
    resolve(new Uint8Array(await blob.arrayBuffer()));
  },'image/jpeg',quality));
}
async function loadImageForPdf(file){
  const url=URL.createObjectURL(file);
  try{
    const img=new Image();img.decoding='async';img.src=url;await img.decode();
    const ow=img.naturalWidth,oh=img.naturalHeight;
    if(!ow||!oh)throw Error(`${file.name} の画像サイズを取得できませんでした。`);
    const maxSide=2400,scale=Math.min(1,maxSide/Math.max(ow,oh));
    const w=Math.max(1,Math.round(ow*scale)),h=Math.max(1,Math.round(oh*scale));
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw Error('画像変換用キャンバスを作成できませんでした。');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(img,0,0,w,h);
    const jpeg=await canvasToJpeg(canvas);
    return {jpeg,width:w,height:h,lowRes:Math.min(ow,oh)<1000||Math.max(ow,oh)<1600};
  }finally{URL.revokeObjectURL(url);}
}
function buildPdfFromJpegs(images){
  const n=images.length;if(!n)throw Error('PDFにする写真がありません。');
  const objects=new Map();
  objects.set(1,[ascii('<< /Type /Catalog /Pages 2 0 R >>')]);
  const kids=[];
  for(let i=0;i<n;i++)kids.push(`${3+i*3} 0 R`);
  objects.set(2,[ascii(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`)]);
  for(let i=0;i<n;i++){
    const {jpeg,width,height}=images[i];
    const pageObj=3+i*3,imgObj=4+i*3,contentObj=5+i*3;
    const portrait=height>=width,pageW=portrait?595:842,pageH=portrait?842:595;
    const scale=Math.min(pageW/width,pageH/height),drawW=width*scale,drawH=height*scale;
    const x=(pageW-drawW)/2,y=(pageH-drawH)/2;
    const content=`q\n${drawW.toFixed(3)} 0 0 ${drawH.toFixed(3)} ${x.toFixed(3)} ${y.toFixed(3)} cm\n/Im0 Do\nQ\n`;
    objects.set(pageObj,[ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 ${imgObj} 0 R >> >> /Contents ${contentObj} 0 R >>`)]);
    objects.set(imgObj,[ascii(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,ascii('\nendstream')]);
    const c=ascii(content);
    objects.set(contentObj,[ascii(`<< /Length ${c.length} >>\nstream\n`),c,ascii('endstream')]);
  }
  const chunks=[ascii('%PDF-1.4\n%HORUNN\n')],offsets=[0];let pos=chunks[0].length;
  const maxObj=2+n*3;
  for(let id=1;id<=maxObj;id++){
    offsets[id]=pos;const head=ascii(`${id} 0 obj\n`),tail=ascii('\nendobj\n');
    chunks.push(head);pos+=head.length;
    for(const p of objects.get(id)){chunks.push(p);pos+=p.length;}
    chunks.push(tail);pos+=tail.length;
  }
  const xref=pos;let table=`xref\n0 ${maxObj+1}\n0000000000 65535 f \n`;
  for(let id=1;id<=maxObj;id++)table+=`${String(offsets[id]).padStart(10,'0')} 00000 n \n`;
  table+=`trailer\n<< /Size ${maxObj+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  chunks.push(ascii(table));return new Blob(chunks,{type:'application/pdf'});
}
async function prepareScanFile(){
  if(!state.pages.length)throw Error('楽譜を選んでください。');
  if(state.pages.length===1)return {file:state.pages[0].file,lowRes:false};
  if(state.pages.some(p=>!isImageFile(p.file)))throw Error('複数ページでまとめる場合は写真（JPG・PNG・WEBP）を選んでください。PDFは1ファイルで選んでください。');
  if(state.pages.length>12)throw Error('一度にまとめられる写真は12ページまでです。');
  const images=[];let lowRes=false;
  for(let i=0;i<state.pages.length;i++){
    status('楽譜を まとめています…',`${i+1} / ${state.pages.length} ページをPDFにしています。`,'wait',5+20*(i/state.pages.length));
    const image=await loadImageForPdf(state.pages[i].file);images.push(image);lowRes ||= image.lowRes;
    await new Promise(r=>setTimeout(r,0));
  }
  const blob=buildPdfFromJpegs(images);
  return {file:new File([blob],`HORUNN_${state.pages.length}pages.pdf`,{type:'application/pdf',lastModified:Date.now()}),lowRes};
}
async function pageLowRes(page){
  if(!isImageFile(page.file))return false;
  const url=URL.createObjectURL(page.file);
  try{const img=new Image();img.src=url;await img.decode();return Math.min(img.naturalWidth,img.naturalHeight)<1000||Math.max(img.naturalWidth,img.naturalHeight)<1600;}
  catch{return false;}finally{URL.revokeObjectURL(url);}
}

async function scan(file){
  if(!state.ready)throw Error('アプリの準備が終わっていません。');
  if(!file)throw Error('写真を選んでください。');
  if(file.size>30*1024*1024)throw Error('写真が大きすぎます。30MB以下にしてください。');
  if(!(/\.(?:jpe?g|png|webp|pdf)$/i.test(file.name)||/^image\//.test(file.type)||file.type==='application/pdf'))throw Error('JPG・PNG・WEBP・PDFを選んでください。');
  sound.stop();state.score=null;state.xml=null;state.scanRunning=true;state.lowRes=false;state.engineError=null;
  $('resultPanel').hidden=true;$('reviewPanel').hidden=true;reviewShown=false;
  $('retryBtn').hidden=true;$('filename').textContent=file.name;
  cleanPreview();$('photoPreview').hidden=true;
  if(file.type.startsWith('image/')){
    state.previewUrl=URL.createObjectURL(file);$('photoPreview').src=state.previewUrl;$('photoPreview').hidden=false;
    const img=new Image();img.src=state.previewUrl;await img.decode();
    if(Math.min(img.naturalWidth,img.naturalHeight)<1000||Math.max(img.naturalWidth,img.naturalHeight)<1600){state.lowRes=true;}
  }
  await loadEngine();
  attachEngineDiagnostics();
  const input=engineWindow().document.getElementById('files');
  const dt=new DataTransfer();dt.items.add(file);
  try{input.files=dt.files;}catch{throw Error('このブラウザでは写真を読み取りエンジンに渡せませんでした。');}
  if(!input.files||input.files.length!==1)throw Error('写真を読み取りエンジンに渡せませんでした。ブラウザを更新してもう一度お試しください。');
  input.dispatchEvent(new Event('change',{bubbles:true}));
  status('がくふを よんでいます…','初回は読譜データ（約150MB）を取得するため時間がかかります。','wait',13);
  const t0=performance.now();
  let lastSignal=t0,lastSignature='';
  while(performance.now()-t0<8*60*1000){
    await new Promise(r=>setTimeout(r,450));if(!state.scanRunning)return;
    const win=engineWindow();const doc=win?.document;if(!doc)continue;
    const view=doc.body?.dataset.view||'';
    const step=doc.getElementById('status')?.textContent||'';
    const detail=doc.getElementById('detail')?.textContent||'';
    const p=parseFloat(doc.getElementById('bar')?.style.width||'0');
    const progress=Number.isFinite(p)&&p>0?Math.min(92,p):35;

    // v0.5.2: result detection must not depend on the upstream screen name.
    // Sheetscan may change its body[data-view] while keeping the MusicXML ready.
    const xml=win?.sheetscan?.xml;
    if(typeof xml==='string'&&xml.length>50){state.scanRunning=false;showResult(xml);return;}

    if(state.engineError)throw Error('読譜エンジンでエラーが発生しました：'+state.engineError.slice(0,220));
    const visibleError=engineVisibleError(doc);
    if(visibleError)throw Error('読譜エンジンでエラーが発生しました：'+visibleError);

    const unsupported=doc.getElementById('unsupported');
    if(view==='start'&&unsupported&&!unsupported.hidden&&unsupported.textContent){throw Error('楽譜を読めませんでした。'+unsupported.textContent.slice(0,160));}

    const signature=[view,step,detail,Number.isFinite(p)?Math.round(p):''].join('|');
    if(signature!==lastSignature){lastSignature=signature;lastSignal=performance.now();}
    if(step){
      status('がくふを よんでいます…',humanStatus(step,detail),'wait',progress);
    }else{
      const elapsed=performance.now()-t0;
      const quiet=performance.now()-lastSignal;
      if(elapsed<30000){
        status('がくふを よんでいます…','読譜エンジンを起動しています。初回は約150MBの取得があります。','wait',20);
      }else if(quiet>45000){
        status('がくふを よんでいます…','初回データの取得または音符解析を続けています。通信が切れると失敗表示に変わります。','wait',35);
      }
    }
  }
  throw Error('8分以内に読譜が完了しませんでした。通信状態・端末の空きメモリを確認し、ページを更新してもう一度お試しください。');
}
function humanStatus(step,detail){
  const s=step+' '+detail;
  if(/Downloading recognition models/i.test(s))return 'はじめての準備：読譜データをダウンロードしています（約150MB）';
  if(/Reading staff/i.test(s))return '五線の音符を ひとつずつ読んでいます…';
  if(/Reading page/i.test(s))return state.pages.length>1?`${state.pages.length}ページの楽譜を順番に読んでいます…`:'楽譜のページを読んでいます…';
  if(/Finding staves/i.test(s))return '五線と音符を探しています…';
  if(/Python runtime|recognition engine|image libraries/i.test(s))return '音符を読む道具を準備しています…';
  return '楽譜を解析しています。しばらくこの画面のままにしてください。';
}
function showResult(xml){
  const score=readMusicXML(xml);state.score=score;state.xml=xml;
  $('resultPanel').hidden=false;
  $('resultTitle').textContent=state.pages.length>1?`全${state.pages.length}ページを よみとりました`:'がくふを よみとりました';
  $('resultMeta').textContent=`${score.bars}小節・${score.notes}音の候補（正確さは要確認）`;
  $('baseBpm').value=score.firstTempo;
  $('fromBar').replaceChildren(new Option('はじめから','0'),...score.validBars.map(n=>new Option(`${n} 小節から`,String(n))));
  const warnings=[...score.warnings];if(state.lowRes)warnings.unshift('解像度が低い写真があります。読み間違いの可能性が高いため、原譜とよく見比べてください。');
  if(warnings.length){$('caution').hidden=false;$('caution').textContent='⚠️ おとなの人と確認してね：'+warnings.join('／');}else $('caution').hidden=true;
  state.reviewConfirmed=false;$('reviewCheck').checked=false;$('allowPlay').disabled=true;$('verifyBox').hidden=false;$('playBtn').disabled=true;
  $('reviewCheckText').textContent=state.pages.length>1?'すべてのページを、もとの楽譜と見比べました':'もとの楽譜と、音符・休符・長さを見比べました';
  $('reviewPageTools').hidden=true;
  $('nowPlaying').textContent='おとなの人が音符を見比べるまで演奏できません';
  status('がくふを よみとりました',state.pages.length>1?'複数ページを1つの楽譜として読み取りました。原譜と見比べてください。':'その音を正しいお手本にする前に、原譜と見比べてください。','ok');
  $('retryBtn').hidden=true;$('resultPanel').scrollIntoView({block:'start',behavior:'smooth'});
}
async function startBatch(){
  if(state.scanRunning||!state.pages.length)return;
  try{
    invalidateResult();state.pages.forEach(p=>p.status='reading');renderPageList();setControls(true);
    const prepared=await prepareScanFile();
    if(prepared.file.size>30*1024*1024)throw Error('まとめた楽譜が30MBを超えました。写真の枚数を減らしてください。');
    await scan(prepared.file);
    if(prepared.lowRes)state.lowRes=true;
    state.pages.forEach(p=>p.status='done');renderPageList();setControls(false);
  }catch(e){fail('がくふを よめませんでした',String(e?.message||e));}
}

function pageStatusText(page){if(page.status==='reading')return '読み取り中…';if(page.status==='done')return '読み取り済み';if(page.status==='error')return 'エラー';return 'まだ読んでいません';}
function renderPageList(){
  const box=$('selectedPages'),list=$('pageList');list.replaceChildren();
  $('pageCount').textContent=state.pages.length?`（${state.pages.length}ページ）`:'';
  $('filename').textContent=state.pages.length===1?state.pages[0].file.name:state.pages.length?`${state.pages.length}ページ 選択中`:'';
  $('scanAllBtn').textContent=state.pages.length>1?'この順で 全部よむ':'この楽譜を よむ';
  // A single photo follows the v0.5.2 path directly. Do not render another
  // full-resolution thumbnail; scan() already shows the one preview needed.
  box.hidden=state.pages.length<=1;
  if(state.pages.length<=1){setControls(state.scanRunning);return;}
  state.pages.forEach((page,i)=>{
    const card=document.createElement('div');card.className='page-card '+page.status;
    const thumb=document.createElement('div');thumb.className='page-thumb';
    const mark=document.createElement('span');mark.className='pdf-thumb';mark.textContent=isPdfFile(page.file)?'PDF':'写真';thumb.append(mark);
    const info=document.createElement('div');info.className='page-info';
    const title=document.createElement('strong');title.textContent=`${i+1}ページ目`;
    const name=document.createElement('span');name.textContent=page.file.name;
    const st=document.createElement('span');st.className='page-state';st.textContent=pageStatusText(page);info.append(title,name,st);
    const actions=document.createElement('div');actions.className='page-actions';
    for(const [action,label,titleText] of [['up','↑','上へ'],['down','↓','下へ'],['remove','×','削除']]){
      const b=document.createElement('button');b.type='button';b.dataset.action=action;b.dataset.id=page.id;b.textContent=label;b.title=titleText;
      b.disabled=state.scanRunning||(action==='up'&&i===0)||(action==='down'&&i===state.pages.length-1);actions.append(b);
    }
    card.append(thumb,info,actions);list.append(card);
  });
  setControls(state.scanRunning);
}
function addFiles(files){
  const arr=[...files];if(!arr.length)return 0;let added=0;const errors=[];
  for(const file of arr){
    if(!isSupportedFile(file)){errors.push(`${file.name}：JPG・PNG・WEBP・PDFのみ対応`);continue;}
    if(file.size>30*1024*1024){errors.push(`${file.name}：30MBを超えています`);continue;}
    if(state.pages.length&&isPdfFile(file)){errors.push(`${file.name}：PDFは単独で選んでください`);continue;}
    if(state.pages.some(p=>isPdfFile(p.file))){errors.push(`${file.name}：PDFと写真は同時にまとめられません`);continue;}
    const page={id:makeId(),file,previewUrl:null,status:'pending'};
    state.pages.push(page);added++;
  }
  if(added){invalidateResult();renderPageList();}
  if(errors.length)status('一部のファイルを追加できませんでした',errors.join('／'),'error');
  else if(state.pages.length>1)status(`${state.pages.length}ページ えらびました`,'↑↓で順番を確認して「この順で 全部よむ」を押してください。','ok');
  return added;
}
function clearPages(){
  if(state.scanRunning)return;state.pages.forEach(cleanPageUrl);state.pages=[];invalidateResult();$('retryBtn').hidden=true;renderPageList();status('じゅんび OK！','楽譜を選んでください。','ok');
}
function removePage(id){
  if(state.scanRunning)return;const i=state.pages.findIndex(p=>p.id===id);if(i<0)return;cleanPageUrl(state.pages[i]);state.pages.splice(i,1);invalidateResult();renderPageList();
  status(state.pages.length?`${state.pages.length}ページ 選択中`:'じゅんび OK！',state.pages.length?'順番を確認して読み取ってください。':'楽譜を選んでください。','ok');
}
function movePage(id,delta){
  if(state.scanRunning)return;const i=state.pages.findIndex(p=>p.id===id),j=i+delta;if(i<0||j<0||j>=state.pages.length)return;
  [state.pages[i],state.pages[j]]=[state.pages[j],state.pages[i]];invalidateResult();renderPageList();status('ページの順番を変えました','この順番で読み取ります。','ok');
}

function updateXML(){const xml=engineWindow()?.sheetscan?.xml;if(!xml)throw Error('修正後の楽譜が見つかりません。');showResult(xml);}
function markPlaying(playing){$('playBtn').disabled=playing;$('stopBtn').disabled=!playing;$('playText').textContent=playing?'えんそう中…':'ホルンで きく';$('playGlyph').textContent=playing?'♫':'▶';}
async function startPlayback(){
  try{
    const s=state.score;if(!s)throw Error('先に楽譜を読み取ってください。');if(!state.reviewConfirmed)throw Error('読み取った楽譜を大人の人と確認してください。');
    markPlaying(true);$('nowPlaying').textContent='ホルンの音色を準備しています…';
    const pick=Number($('fromBar').value||0),first=pick?s.events.find(e=>e.bar>=pick):s.events[0];if(!first)throw Error('指定した小節に演奏する音符がありません。');
    const bpm=Number($('baseBpm').value)||s.firstTempo,tempos=(s.tempoEvents||[]).map(t=>({...t}));if(tempos.length){const ratio=bpm/s.firstTempo;for(const t of tempos)t.bpm*=ratio;}
    const onEnd=()=>{markPlaying(false);$('nowPlaying').textContent='おわりました！';};
    await sound.play(s.events,{from:pick?(s.barStarts[pick]??first.beat):0,shift:Number($('transpose').value),speed:Number($('speed').value),tempoEvents:tempos,loop:$('repeat').value==='1',onEnd,onTick:(bar,elapsed,total)=>{$('nowPlaying').textContent=bar?`${bar} 小節を えんそう中　${Math.round(elapsed)}秒 / ${Math.round(total)}秒`:'♪ えんそう中…';}});
  }catch(e){sound.stop();markPlaying(false);$('nowPlaying').textContent='再生できません：'+String(e?.message||e);}
}
function stopPlayback(){sound.stop();markPlaying(false);$('nowPlaying').textContent='とまりました';}
function openReview(){reviewShown=true;$('reviewPanel').hidden=false;$('reviewToggle').setAttribute('aria-expanded','true');$('reviewToggle').textContent='とじる ▲';setTimeout(()=>engineWindow()?.dispatchEvent(new Event('resize')),100);$('reviewPanel').scrollIntoView({behavior:'smooth'});}

$('photo').addEventListener('change',async e=>{
  const files=[...e.target.files];e.target.value='';const before=state.pages.length,added=addFiles(files);if(!added)return;
  if(before===0&&state.pages.length===1){
    const page=state.pages[0];state.currentFile=page.file;page.status='reading';renderPageList();
    try{await scan(page.file);page.status='done';renderPageList();}
    catch(err){page.status='error';fail('がくふを よめませんでした',err?.message||String(err));}
  }
});
$('scanAllBtn').onclick=startBatch;
$('retryBtn').onclick=async()=>{
  if(state.pages.length===1){const page=state.pages[0];state.currentFile=page.file;page.status='reading';renderPageList();try{await scan(page.file);page.status='done';renderPageList();}catch(e){page.status='error';fail('がくふを よめませんでした',e?.message||String(e));}}
  else await startBatch();
};
$('clearPagesBtn').onclick=clearPages;
$('pageList').onclick=e=>{const b=e.target.closest('button[data-action]');if(!b)return;if(b.dataset.action==='up')movePage(b.dataset.id,-1);else if(b.dataset.action==='down')movePage(b.dataset.id,1);else if(b.dataset.action==='remove')removePage(b.dataset.id);};
$('playBtn').onclick=startPlayback;$('stopBtn').onclick=stopPlayback;
$('speed').oninput=()=>{$('speedLabel').textContent=+$('speed').value===100?'ふつう（100%）':`${$('speed').value}%`;};
$('speed').onchange=()=>{if(sound.playing)stopPlayback();};
$('openReview').onclick=openReview;
$('reviewCheck').onchange=()=>{$('allowPlay').disabled=!$('reviewCheck').checked;};
$('allowPlay').onclick=()=>{if(!$('reviewCheck').checked||!state.score)return;state.reviewConfirmed=true;$('verifyBox').hidden=true;$('playBtn').disabled=false;$('nowPlaying').textContent='じゅんびOK！ 「ホルンで きく」を押してね';};
$('reviewToggle').onclick=()=>{reviewShown=!reviewShown;$('reviewPanel').hidden=!reviewShown;$('reviewToggle').setAttribute('aria-expanded',String(reviewShown));$('reviewToggle').textContent=reviewShown?'とじる ▲':'がくふが あっているか たしかめる ▼';if(reviewShown){setTimeout(()=>engineWindow()?.dispatchEvent(new Event('resize')),100);$('reviewPanel').scrollIntoView({behavior:'smooth'});}};
$('refreshResult').onclick=()=>{try{stopPlayback();updateXML();$('reviewPanel').hidden=false;reviewShown=true;}catch(e){fail('修正の反映に失敗',String(e?.message||e));}};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&sound.playing)stopPlayback();});
window.addEventListener('beforeunload',()=>{state.pages.forEach(cleanPageUrl);cleanPreview();});

renderPageList();init();
