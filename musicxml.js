/* A conservative MusicXML reader for solo horn. All rhythms are read from
   MusicXML <duration> and <divisions>; no guessing from image coordinates. */
const children=(node,name)=>[...node.children].filter(x=>x.localName===name);
const first=(node,name)=>children(node,name)[0]||null;
const text=(node,name)=>first(node,name)?.textContent?.trim()||'';
const number=(node,name)=>Number(text(node,name));
const STEP={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
function pitch(note){const p=first(note,'pitch');if(!p)return null;const step=text(p,'step'),oct=number(p,'octave'),alter=number(p,'alter')||0;
  if(!(step in STEP)||!Number.isInteger(oct))return null;
  return (oct+1)*12+STEP[step]+alter;
}
function tempo(node){const sound=first(node,'sound');if(sound?.hasAttribute('tempo')){
  const b=Number(sound.getAttribute('tempo'));if(b>15&&b<500)return b;
  }
  const metro=first(first(node,'direction-type')||node,'metronome');if(metro){const n=number(metro,'per-minute');const unit=text(metro,'beat-unit');const factors={quarter:1,half:2,eighth:.5,'16th':.25,'whole':4};
    const dots=children(metro,'beat-unit-dot').length;const dotFactor=dots?1.5:1;
    if(n>15&&n<500&&factors[unit])return n*factors[unit]*dotFactor;
  }
  return null;
}
function ties(note){const arr=[...children(note,'tie')];const notation=first(note,'notations');if(notation)arr.push(...children(notation,'tied'));
  return {start:arr.some(n=>n.getAttribute('type')==='start'),stop:arr.some(n=>n.getAttribute('type')==='stop')};
}
export function readMusicXML(xml){
  if(typeof xml!=='string'||xml.length<30)throw Error('読み取った楽譜データが空です。');
  const doc=new DOMParser().parseFromString(xml,'application/xml');
  if(doc.querySelector('parsererror'))throw Error('読み取った楽譜データが壊れています。');
  const root=doc.documentElement;if(root.localName!=='score-partwise')throw Error('この形式の楽譜にはまだ対応していません。');
  const parts=children(root,'part');if(!parts.length)throw Error('音符のパートが見つかりません。');
  const part=parts[0],bars=children(part,'measure'),warnings=[];
  if(parts.length>1)warnings.push('複数の楽器が読み取られています。いちばん上のパートだけを演奏します。');
  const events=[],tempoEvents=[],barStarts={};const tied=new Map();let beat=0,divisions=1,meter=4,meterSeen=false;
  let unusual=0,empty=0,invalidDurations=0,polyphonic=false,repeat=false;
  
  for(let mi=0;mi<bars.length;mi++){
    const bar=bars[mi],localBar=mi+1;let cursor=0,max=0,lastNoteStart=0,hasNote=false,hasRest=false;
    let barExpected=meter,barNumber=Number(bar.getAttribute('number'))||localBar;barStarts[barNumber]=beat;
    const measureVoice=new Set();
    for(const el of bar.children){
      switch(el.localName){
        case 'attributes':{
          const d=number(el,'divisions');if(Number.isFinite(d)&&d>0)divisions=d;
          const time=first(el,'time');if(time){const b=number(time,'beats'),bt=number(time,'beat-type');if(b>0&&bt>0){meter=b*4/bt;meterSeen=true;barExpected=meter;}}
          break;
        }
        case 'direction':{
          const bpm=tempo(el);if(bpm){
            const offset=number(el,'offset');const at=beat+cursor+(Number.isFinite(offset)?offset/divisions:0);
            tempoEvents.push({beat:Math.max(0,at),bpm});}
          break;
        }
        case 'barline':{
          if(first(el,'repeat'))repeat=true;break;
        }
        case 'backup':{
          const n=number(el,'duration');if(Number.isFinite(n))cursor=Math.max(0,cursor-n/divisions);else invalidDurations++;
          break;
        }
        case 'forward':{
          const n=number(el,'duration');if(Number.isFinite(n))cursor+=Math.max(0,n/divisions);else invalidDurations++;max=Math.max(max,cursor);
          break;
        }
        case 'note':{
          if(first(el,'grace'))break;
          const isChord=!!first(el,'chord'),isRest=!!first(el,'rest');
          const voice=text(el,'voice')||'1';measureVoice.add(voice);
          const n=number(el,'duration');
          if(!Number.isFinite(n)||n<=0){invalidDurations++;break;}
          const dur=n/divisions;if(!Number.isFinite(dur)||dur<=0||dur>32){invalidDurations++;break;}
          const position=isChord?lastNoteStart:cursor;
          if(!isChord){lastNoteStart=cursor;cursor+=dur;max=Math.max(max,cursor);}
          if(isRest){hasRest=true;break;}
          const notePitch=pitch(el);if(notePitch===null){invalidDurations++;break;}
          hasNote=true;
          const state=ties(el),key=`${voice}/${notePitch}`;
          if(state.stop&&tied.has(key)){
            const prev=tied.get(key);if(Math.abs(prev.beat+prev.dur-(beat+position))<.02){prev.dur+=dur;prev.endBar=barNumber;if(!state.start)tied.delete(key);continue;}
          }
          const event={beat:beat+position,dur,pitch:notePitch,bar:barNumber,endBar:barNumber,voice};events.push(event);
          if(state.start)tied.set(key,event);else tied.delete(key);
          break;
        }
      }
    }
    if(measureVoice.size>1)polyphonic=true;
    const length=Math.max(max,0);
    if(mi>0&&mi<bars.length-1&&bar.getAttribute('implicit')!=='yes'&&length>0&&Math.abs(length-barExpected)>.10){unusual++;}
    if(!hasNote){empty++;}
    // A full-measure rest is included as a <note><rest/><duration>... .
    beat+=length||meter;
  }
  if(!meterSeen)warnings.push('拍子記号を確認できませんでした。');
  if(unusual)warnings.push(`拍数が合わない小節が ${unusual} 個あります。原譜と見比べてください。`);
  if(invalidDurations)warnings.push(`読み取れない長さ・音符が ${invalidDurations} 個あります。`);
  if(polyphonic)warnings.push('複数の声部が含まれています。ホルンソロ以外の音が混じる可能性があります。');
  if(repeat)warnings.push('反復記号が見つかりました。記号どおりの繰り返しはまだ自動再生できません。');
  if(empty>bars.length*.25)warnings.push('音符のない小節が多くあります。読み取り結果を確認してください。');
  if(!events.length)throw Error('音符を読み取れませんでした。写真を撮り直してください。');
  events.sort((a,b)=>a.beat-b.beat||a.pitch-b.pitch);
  const validBars=[...new Set(events.map(e=>e.bar))].sort((a,b)=>a-b);
  // Crucial: a tempo mark appearing only in bar 2 (or later) must NOT
  // retroactively change the tempo of bars before it. Until the first mark,
  // use a clearly labelled provisional 120 quarter-notes per minute.
  tempoEvents.sort((a,b)=>a.beat-b.beat);
  const normalized=[];
  for(const e of tempoEvents){
    if(normalized.length && Math.abs(normalized.at(-1).beat-e.beat)<1e-8)normalized[normalized.length-1]={...e};
    else normalized.push({...e});
  }
  if(!normalized.length || normalized[0].beat>1e-8){
    normalized.unshift({beat:0,bpm:120});
    warnings.push('曲の冒頭のテンポが読み取れないため、最初の部分は仮に♩=120で演奏します。');
  }
  // This is only a *sanity flag*, not a claim that the notes are correct.
  // A different pitch can have perfectly valid rhythm and evade every test.
  const unusualPitches=[];
  for(let i=0;i<events.length;i++){
    const e=events[i],previous=events[i-1];
    if(e.pitch<42||e.pitch>94)unusualPitches.push(`${e.bar}小節（音域）`);
    if(previous && e.voice===previous.voice && e.beat>previous.beat &&
      e.beat-previous.beat<4 && Math.abs(e.pitch-previous.pitch)>=22){
      unusualPitches.push(`${e.bar}小節（大きな音程の移動）`);
    }
  }
  if(unusualPitches.length)warnings.push(`音程を原譜と確認してください：${[...new Set(unusualPitches)].slice(0,6).join('、')}${unusualPitches.length>6?' ほか':''}。意図的な音符も含まれます。`);
  return {events,bars:bars.length,measures:bars.length,validBars,firstTempo:normalized[0].bpm,tempoEvents:normalized,barStarts,notes:events.length,warnings,unusual,invalidDurations,parts:parts.length,totalBeats:beat,pitchFlags:unusualPitches.length};
}
