// HTML 앱 안에 넣는 연결 스크립트.
//  - <input type="file">(직접 클릭, label 클릭, .click(), showPicker)을 가로채 Inkpad가 파일을 골라 넣어 준다
//  - sandbox(불투명 origin)라 localStorage가 막혀 있으므로 Inkpad 쪽 저장소로 대신한다
//  - 내보내기(<a download>의 blob:/data: 링크, showSaveFilePicker)를 가로채 Inkpad가 기기 또는 Inkpad(기타 파일)에 저장한다
//  - window.inkpad.pickFiles(accept, multiple) · window.inkpad.saveFile(data, name, type) 도 직접 쓸 수 있다
function bridgeScript(store: Record<string, string>) {
  const init = JSON.stringify(store).replace(/</g, '\\u003c')
  return `<script>(function(){
var P=window.parent,seq=0,waits={};
function send(m){m.__inkpad=1;P.postMessage(m,'*')}
addEventListener('message',function(e){if(e.source!==P)return;var m=e.data;if(!m||m.__inkpad!==1)return;var w=waits[m.id];if(w){delete waits[m.id];w(m)}});
function pickFiles(accept,multiple){return new Promise(function(res){var id=++seq;waits[id]=function(m){res(m.files||[])};send({type:'pick',id:id,accept:accept||'',multiple:!!multiple})})}
function isFile(el){return el instanceof HTMLInputElement&&el.type==='file'&&!el.disabled}
function fill(input){pickFiles(input.accept,input.multiple).then(function(files){
 if(!files.length){input.dispatchEvent(new Event('cancel'));return}
 var dt=new DataTransfer();for(var i=0;i<files.length;i++)dt.items.add(files[i]);
 input.files=dt.files;
 input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})}
var IP=HTMLInputElement.prototype,oc=IP.click;
IP.click=function(){if(isFile(this))return fill(this);return oc.call(this)};
if(IP.showPicker){var os=IP.showPicker;IP.showPicker=function(){if(isFile(this))return fill(this);return os.call(this)}}
document.addEventListener('click',function(e){if(isFile(e.target)){e.preventDefault();fill(e.target)}},true);
function saveFile(d,name,type){return Promise.resolve(d).then(function(d){
 var b=d instanceof Blob?d:new Blob([d],{type:type||''});
 return new Promise(function(res){var id=++seq;waits[id]=function(m){res(!!m.ok)};send({type:'save',id:id,name:String(name||''),file:b})})})}
var blobs=new Map(),U=URL,ou=U.createObjectURL,orv=U.revokeObjectURL;
U.createObjectURL=function(o){var u=ou.call(U,o);if(o instanceof Blob)blobs.set(u,o);return u};
U.revokeObjectURL=function(u){blobs.delete(u);return orv.call(U,u)};
function isDl(a){return a instanceof HTMLAnchorElement&&a.hasAttribute('download')&&/^(blob|data):/i.test(a.href)}
function grab(a){var b=blobs.get(a.href),name=a.getAttribute('download')||'';
 saveFile(b||fetch(a.href).then(function(r){return r.blob()}),name)}
addEventListener('click',function(e){var a=e.target instanceof Element&&e.target.closest('a');if(!e.defaultPrevented&&isDl(a)){e.preventDefault();grab(a)}});
var AP=HTMLAnchorElement.prototype,ac=AP.click,ad=EventTarget.prototype.dispatchEvent;
AP.click=function(){if(!this.isConnected&&isDl(this))return grab(this);return ac.call(this)};
AP.dispatchEvent=function(ev){if(ev&&ev.type==='click'&&!this.isConnected&&isDl(this)){grab(this);return false}return ad.call(this,ev)};
function abort(){return new DOMException('저장을 취소했습니다.','AbortError')}
window.showSaveFilePicker=function(o){o=o||{};var name=o.suggestedName||'',t=o.types&&o.types[0]&&Object.keys(o.types[0].accept||{})[0]||'',parts=[];
 return Promise.resolve({kind:'file',name:name,
  getFile:function(){return Promise.resolve(new File(parts,name,{type:t}))},
  createWritable:function(){parts=[];return Promise.resolve({
   write:function(c){if(c&&typeof c==='object'&&'type'in c&&!(c instanceof Blob)){if(c.type!=='write'||c.position!=null)return Promise.reject(new DOMException('지원하지 않는 쓰기입니다.','NotSupportedError'));c=c.data}parts.push(c);return Promise.resolve()},
   close:function(){return saveFile(new Blob(parts,{type:t}),name).then(function(ok){if(!ok)throw abort()})},
   abort:function(){parts=[];return Promise.resolve()}})}})};
var data=${init};
function save(){send({type:'storage',data:data})}
var shim={getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(data,k)?data[k]:null},
setItem:function(k,v){data[String(k)]=String(v);save()},
removeItem:function(k){delete data[String(k)];save()},
clear:function(){data={};save()},
key:function(i){var ks=Object.keys(data);return i<ks.length?ks[i]:null},
get length(){return Object.keys(data).length}};
var ok=true;try{ok=!!window.localStorage}catch(e){ok=false}
if(!ok){try{Object.defineProperty(window,'localStorage',{value:shim,configurable:true})}catch(e){}}
window.inkpad={pickFiles:pickFiles,saveFile:saveFile};
})()</script>`
}

/** 앱의 다른 스크립트보다 먼저 실행되도록 <head> 바로 뒤에 넣는다 (doctype 앞에 넣으면 quirks 모드가 된다) */
export function buildSrcDoc(html: string, store: Record<string, string>) {
  const tag = bridgeScript(store)
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html)
    if (m) {
      const at = m.index + m[0].length
      return html.slice(0, at) + tag + html.slice(at)
    }
  }
  return tag + html
}
