/* Independently included horn samples, GPL-2.0, with separate licence notice.
   Notes are played only from MusicXML, never from guessed image positions. */
export class HornSound {
  constructor() { this.ctx=null;this.master=null;this.buffers=new Map();this.loading=null;this.scheduled=[];this.timer=null;this.ticket=0;this.started=0;this.duration=0;this.onTick=null;this.onEnd=null;this.current=[];}
  get playing(){return !!this.timer;}
  async init(){if(!this.ctx){this.ctx=new (window.AudioContext||window.webkitAudioContext)();this.master=this.ctx.createGain();this.master.gain.value=0.74;const comp=this.ctx.createDynamicsCompressor();this.master.connect(comp).connect(this.ctx.destination);}await this.ctx.resume();}
  async preload(){await this.init();if(this.buffers.size===16)return;
    if(!this.loading) this.loading=Promise.all([43,46,49,52,55,58,61,64,67,70,73,76,79,82,85,88].map(async midi=>{
      const res=await fetch(new URL(`./horn/${midi}.mp3`,import.meta.url));if(!res.ok)throw Error(`ホルン音源が見つかりません（${midi}）`);
      this.buffers.set(midi,await this.ctx.decodeAudioData(await res.arrayBuffer()));
    })).catch(e=>{this.loading=null;throw e});
    return this.loading;
  }
  sound(pitch,at,sec){const keys=[...this.buffers.keys()];let nearest=keys[0];for(const n of keys)if(Math.abs(n-pitch)<Math.abs(nearest-pitch))nearest=n;
    const src=this.ctx.createBufferSource();src.buffer=this.buffers.get(nearest);src.playbackRate.value=2**((pitch-nearest)/12);src.loop=true;src.loopStart=.68;src.loopEnd=2.4;
    const env=this.ctx.createGain(),end=at+Math.max(.07,sec*.94),attack=Math.min(.072,sec*.30);
    env.gain.setValueAtTime(.0001,at);env.gain.linearRampToValueAtTime(.33,at+Math.max(.018,attack));
    env.gain.setTargetAtTime(.27,at+Math.max(.03,attack),.16);
    env.gain.setValueAtTime(.27,end);env.gain.exponentialRampToValueAtTime(.0001,end+.11);
    src.connect(env).connect(this.master);src.start(at);src.stop(end+.14);
    this.scheduled.push(src);src.onended=()=>{const ix=this.scheduled.indexOf(src);if(ix>=0)this.scheduled.splice(ix,1)};
  }
  async play(events,{shift=-7,from=0,speed=100,tempoEvents=[{beat:0,bpm:120}],onTick,onEnd,loop=false}={}){
    this.stop();const ticket=++this.ticket;this.onEnd=onEnd;
    await this.preload();if(ticket!==this.ticket)return;
    const filtered=events.filter(n=>n.beat + n.dur>from && Number.isFinite(n.pitch));if(!filtered.length){this.stop();throw Error('演奏する音符がありません');}
    const mapper=new TempoMap(tempoEvents,speed);
    const fromSec=mapper.at(from);const songEnd=Math.max(...events.map(n=>n.beat+n.dur));const endAt=mapper.at(songEnd)-fromSec;
    this.duration=endAt;this.started=this.ctx.currentTime+.15;
    // A held/tied note may cross the selected start bar. Start it from
    // the requested beat instead of trying to schedule it in the past.
    const arr=filtered.map(n=>{const startBeat=Math.max(n.beat,from);
      return {...n,st:mapper.at(startBeat)-fromSec,sec:Math.max(.07,mapper.at(n.beat+n.dur)-mapper.at(startBeat))};});
    // If a selected measure begins with a rest, don't discard it: the rest is silence.
    let next=0;
    this.timer=setInterval(()=>{
      if(ticket!==this.ticket)return;
      const elapsed=this.ctx.currentTime-this.started;
      for(;next<arr.length && arr[next].st<=elapsed+.30;next++){
        const n=arr[next];const when=this.started+n.st;
        if(when>=this.ctx.currentTime-.03) this.sound(n.pitch+shift,when,n.sec);
      }
      const active=arr.find(n=>n.st<=elapsed && elapsed<n.st+n.sec);
      if(typeof onTick==='function')onTick(active?.bar ?? null,elapsed,endAt);
      if(elapsed>=endAt+.2){this.stop();if(loop){this.play(events,{shift,from,speed,tempoEvents,onTick,onEnd,loop}).catch(onEnd);}else onEnd?.();}
    },35);
  }
  stop(){this.ticket++;if(this.timer){clearInterval(this.timer);this.timer=null;}for(const n of this.scheduled){try{n.stop()}catch{}}this.scheduled=[];if(this.master){try{this.master.gain.cancelScheduledValues(this.ctx.currentTime)}catch{}}}
}
class TempoMap {
  constructor(list,speed){const es=[...list].filter(x=>Number.isFinite(x.beat)&&Number.isFinite(x.bpm)&&x.bpm>0).sort((a,b)=>a.beat-b.beat);let unique=[];for(const e of es){if(unique.length&&unique.at(-1).beat===e.beat)unique[unique.length-1]=e;else unique.push({...e});}if(!unique.length||unique[0].beat>0)unique.unshift({beat:0,bpm:120});this.es=unique;this.factor=speed/100;}
  at(beat){let t=0;const es=this.es;for(let i=0;i<es.length;i++){const first=es[i].beat;const end=(i+1<es.length?Math.min(beat,es[i+1].beat):beat);if(end>first)t+=(end-first)*60/(es[i].bpm*this.factor);if(i+1<es.length && beat<=es[i+1].beat)break;}return t;}
}
