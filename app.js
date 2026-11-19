import {readMusicXML} from './musicxml.js?v=0.5.1';
import {HornSound} from './horn-sound.js?v=0.5.1';
const $=id=>document.getElementById(id);
const sound=new HornSound();
let state={ready:false,engineLoaded:false,currentFile:null,xml:null,score:null,lowRes:false,previewUrl:null,scanRunning:false,watcher:null,reviewConfirmed:false};
let reviewShown=false;
const projectBase=new URL('./',location.href);
function status(title,desc,kind='wait',progress=0){$('statusTitle').textContent=title;$('statusText').textContent=desc;
  $('statusDot').className='status-dot'+(kind==='ok'?' ok':kind==='error'?' error':'');
  $('progress').hidden=!(progress>0&&progress<100);$('progressFill').style.width=Math.max(4,Math.min(100,progress))+'%';
}
function fail(title,msg){state.scanRunning=false;status(title,msg,'error');$('retryBtn').hidden=!state.currentFile;}
function cleanPreview(){if(state.previewUrl){URL.revokeObjectURL(state.previewUrl);state.previewUrl=null;}}
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
async function loadEngine(){
  if(state.engineLoaded){try{if(engineWindow()?.document?.getElementById('files'))return;}catch{}}
  status('がくふを よむ じゅんび','読譜エンジンを読み込んでいます。初回は通信が必要です。','wait',8);
  const frame=$('engineFrame');frame.src=new URL('./_omr/index.html',projectBase).href;
  let start=performance.now();
  while(performance.now()-start<45000){
    await new Promise(r=>setTimeout(r,300));
    try{
      const doc=frame.contentDocument;if(!doc)continue;
      if(doc.getElementById('files')&&engineWindow()?.sheetscan){state.engineLoaded=true;return;}
      if(doc.body?.innerText?.includes('読譜エンジンが取得できません'))throw Error(doc.body.innerText.slice(0,140));
    }catch(e){if(String(e).includes('cross-origin'))throw Error('読譜エンジンの読み込みがブロックされました。');else throw e;}
  }
  throw Error('読譜エンジンが起動しません。通信状態とブラウザを確認してください。');
}
async function scan(file){
  if(!state.ready)throw Error('アプリの準備が終わっていません。');
  if(!file)throw Error('写真を選んでください。');
  if(file.size>30*1024*1024)throw Error('写真が大きすぎます。30MB以下にしてください。');
  if(!(/\.(?:jpe?g|png|webp|pdf)$/i.test(file.name)||/^image\//.test(file.type)||file.type==='application/pdf'))throw Error('JPG・PNG・WEBP・PDFを選んでください。');
  sound.stop();state.score=null;state.xml=null;state.scanRunning=true;state.lowRes=false;
  $('resultPanel').hidden=true;$('reviewPanel').hidden=true;reviewShown=false;
  $('retryBtn').hidden=true;$('filename').textContent=file.name;
  cleanPreview();$('photoPreview').hidden=true;
  if(file.type.startsWith('image/')){
    state.previewUrl=URL.createObjectURL(file);$('photoPreview').src=state.previewUrl;$('photoPreview').hidden=false;
    const img=new Image();img.src=state.previewUrl;await img.decode();
    if(Math.min(img.naturalWidth,img.naturalHeight)<1000||Math.max(img.naturalWidth,img.naturalHeight)<1600){state.lowRes=true;}
  }
  await loadEngine();
  const input=engineWindow().document.getElementById('files');
  const dt=new DataTransfer();dt.items.add(file);
  try{input.files=dt.files;}catch{throw Error('このブラウザでは写真を読み取りエンジンに渡せませんでした。');}
  input.dispatchEvent(new Event('change',{bubbles:true}));
  status('がくふを よんでいます…','音符・休符・音の長さを調べています。','wait',13);
  const t0=performance.now();
  while(performance.now()-t0<6*60*1000){
    await new Promise(r=>setTimeout(r,450));if(!state.scanRunning)return;
    const doc=engineWindow().document;
    const view=doc.body?.dataset.view;
    const step=doc.getElementById('status')?.textContent||'';
    const detail=doc.getElementById('detail')?.textContent||'';
    const p=parseFloat(doc.getElementById('bar')?.style.width||'0');
    const progress=Number.isFinite(p)&&p>0?Math.min(90,p):35;
    if(step)status('がくふを よんでいます…',humanStatus(step,detail),'wait',progress);
    const unsupported=doc.getElementById('unsupported');
    if(view==='start'&&unsupported&&!unsupported.hidden&&unsupported.textContent){throw Error('楽譜を読めませんでした。'+unsupported.textContent.slice(0,160));}
    if(view==='work'){
      const xml=engineWindow().sheetscan?.xml;
      if(xml&&xml.length>50){state.scanRunning=false;showResult(xml);return;}
    }
  }
  throw Error('読譜に時間がかかりすぎています。ページを更新して、明るい写真で試してください。');
}
function humanStatus(step,detail){const s=step+' '+detail;if(/Downloading recognition models/i.test(s))return 'はじめての準備：読譜データをダウンロードしています（約150MB）';
  if(/Reading staff/i.test(s))return '五線の音符を ひとつずつ読んでいます…';
  if(/Reading page/i.test(s))return '楽譜のページを読んでいます…';
  if(/Finding staves/i.test(s))return '五線と音符を探しています…';
  if(/Python runtime|recognition engine|image libraries/i.test(s))return '音符を読む道具を準備しています…';
  return '楽譜を解析しています。しばらくこの画面のままにしてください。';
}
function showResult(xml){
  const score=readMusicXML(xml);state.score=score;state.xml=xml;
  $('resultPanel').hidden=false;$('resultTitle').textContent='がくふを よみとりました';
  $('resultMeta').textContent=`${score.bars}小節・${score.notes}音の候補（正確さは要確認）`;
  $('baseBpm').value=score.firstTempo;
  $('fromBar').replaceChildren(new Option('はじめから','0'),...score.validBars.map(n=>new Option(`${n} 小節から`,String(n))));
  let warnings=[...score.warnings];if(state.lowRes)warnings.unshift('写真の解像度が低いため、読み間違いの可能性が高いです。紙の楽譜を近くから撮り直すことをおすすめします。');
  if(warnings.length){$('caution').hidden=false;$('caution').textContent='⚠️ おとなの人と確認してね：'+warnings.join('／');}
  else $('caution').hidden=true;
  // Every OMR score needs visual comparison. Meter checks cannot detect
  // a correctly-timed but wrongly recognized pitch.
  state.reviewConfirmed=false;
  $('reviewCheck').checked=false;
  $('allowPlay').disabled=true;
  $('verifyBox').hidden=false;
  $('playBtn').disabled=true;
  $('nowPlaying').textContent='おとなの人が音符を見比べるまで演奏できません';
  status('がくふを よみとりました','その音を正しいお手本にする前に、原譜と見比べてください。','ok');
  $('resultPanel').scrollIntoView({block:'start',behavior:'smooth'});
}
function updateXML(){const xml=engineWindow()?.sheetscan?.xml;if(!xml)throw Error('修正後の楽譜が見つかりません。');showResult(xml);}
function markPlaying(playing){$('playBtn').disabled=playing;$('stopBtn').disabled=!playing;$('playText').textContent=playing?'えんそう中…':'ホルンで きく';$('playGlyph').textContent=playing?'♫':'▶';}
async function startPlayback(){
  try{
    const s=state.score;if(!s)throw Error('先に楽譜を読み取ってください。');
    if(!state.reviewConfirmed)throw Error('読み取った楽譜を大人の人と確認してください。');
    markPlaying(true);$('nowPlaying').textContent='ホルンの音色を準備しています…';
    const pick=Number($('fromBar').value||0);const first=pick?s.events.find(e=>e.bar>=pick):s.events[0];
    if(!first)throw Error('指定した小節に演奏する音符がありません。');
    const bpm=Number($('baseBpm').value)||s.firstTempo;
    const tempos=[...s.tempoEvents];if(tempos.length){const ratio=bpm/s.firstTempo;for(const t of tempos)t.bpm*=ratio;}
    const onEnd=()=>{markPlaying(false);$('nowPlaying').textContent='おわりました！';};
    await sound.play(s.events,{from:pick?(s.barStarts[pick] ?? first.beat):0,shift:Number($('transpose').value),speed:Number($('speed').value),tempoEvents:tempos,loop:$('repeat').value==='1',onEnd,onTick:(bar,elapsed,total)=>{
      $('nowPlaying').textContent=bar?`${bar} 小節を えんそう中　${Math.round(elapsed)}秒 / ${Math.round(total)}秒`:'♪ えんそう中…';
    }});
  }catch(e){sound.stop();markPlaying(false);$('nowPlaying').textContent='再生できません：'+String(e?.message||e);}
}
function stopPlayback(){sound.stop();markPlaying(false);$('nowPlaying').textContent='とまりました';}
$('photo').addEventListener('change',async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;state.currentFile=file;try{await scan(file);}catch(err){fail('がくふを よめませんでした',err.message||String(err));}});
$('retryBtn').onclick=async()=>{try{await scan(state.currentFile)}catch(e){fail('がくふを よめませんでした',e.message||String(e));}};
$('playBtn').onclick=startPlayback;
function openReview(){
  reviewShown=true;$('reviewPanel').hidden=false;
  $('reviewToggle').setAttribute('aria-expanded','true');
  $('reviewToggle').textContent='とじる ▲';
  setTimeout(()=>engineWindow()?.dispatchEvent(new Event('resize')),100);
  $('reviewPanel').scrollIntoView({behavior:'smooth'});
}
$('openReview').onclick=openReview;
$('reviewCheck').onchange=()=>{$('allowPlay').disabled=!$('reviewCheck').checked;};
$('allowPlay').onclick=()=>{
  if(!$('reviewCheck').checked||!state.score)return;
  state.reviewConfirmed=true;
  $('verifyBox').hidden=true;
  $('playBtn').disabled=false;
  $('nowPlaying').textContent='じゅんびOK！ 「ホルンで きく」を押してね';
};
$('stopBtn').onclick=stopPlayback;
$('speed').oninput=()=>{$('speedLabel').textContent=+$('speed').value===100?'ふつう（100%）':`${$('speed').value}%`;};
$('speed').onchange=()=>{if(sound.playing)stopPlayback()};
$('reviewToggle').onclick=()=>{reviewShown=!reviewShown;$('reviewPanel').hidden=!reviewShown;$('reviewToggle').setAttribute('aria-expanded',String(reviewShown));$('reviewToggle').textContent=reviewShown?'とじる ▲':'がくふが あっているか たしかめる ▼';if(reviewShown){setTimeout(()=>engineWindow()?.dispatchEvent(new Event('resize')),100);$('reviewPanel').scrollIntoView({behavior:'smooth'});}};
$('refreshResult').onclick=()=>{try{stopPlayback();updateXML();$('reviewPanel').hidden=false;reviewShown=true;}catch(e){fail('修正の反映に失敗',String(e.message||e));}};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&sound.playing)stopPlayback()});
init();
