/**
 * Runtime polyfills for browsers older than the build's transpile floor.
 *
 * The storefront is server-rendered, so on an older Android browser the page
 * paints and links work while hydration throws — which reads to a customer as
 * "the page is fine but the menu won't open". Syntax is handled by lowering the
 * `browserslist` floor in package.json; these are the *runtime* APIs that
 * dependencies call and that Next's own polyfill bundle does not cover
 * (it ships `Object.hasOwn` and `Array.prototype.at`, but not these).
 *
 * Emitted as a blocking inline script in <head> so it runs before the framework
 * bundle. Keep it ES5, small, and feature-detected — it is parsed on every page
 * load by every browser, including current ones.
 */
export function getLegacyRuntimePolyfillScript(): string {
  return `(function(){
try{
if(typeof window.queueMicrotask!=="function"&&typeof Promise==="function"){
window.queueMicrotask=function(callback){
if(typeof callback!=="function")throw new TypeError("Microtask callback must be a function");
Promise.resolve().then(function(){try{callback();}catch(error){setTimeout(function(){throw error;},0);}});
};}
if(typeof Promise==="function"&&typeof Promise.allSettled!=="function"){
Object.defineProperty(Promise,"allSettled",{configurable:true,writable:true,value:function(iterable){
var C=this;
return new C(function(resolve,reject){try{
if(iterable==null||typeof Symbol==="undefined"||typeof iterable[Symbol.iterator]!=="function")throw new TypeError("Expected an iterable");
var values=Array.from(iterable),results=new Array(values.length),remaining=values.length;
if(!remaining){resolve(results);return;}
values.forEach(function(value,index){C.resolve(value).then(function(result){results[index]={status:"fulfilled",value:result};if(!--remaining)resolve(results);},function(reason){results[index]={status:"rejected",reason:reason};if(!--remaining)resolve(results);});});
}catch(error){reject(error);}});
}});}
}catch(runtimeError){}
try{
var eventProto=window.EventTarget&&window.EventTarget.prototype;
var nativeAdd=eventProto&&eventProto.addEventListener,nativeRemove=eventProto&&eventProto.removeEventListener;
var stringify=Function.prototype.toString;
if(typeof nativeAdd==="function"&&typeof nativeRemove==="function"&&/\\[native code\\]/.test(stringify.call(nativeAdd))&&/\\[native code\\]/.test(stringify.call(nativeRemove))&&typeof WeakMap==="function"&&!window.__infinityListenerGuard){
var recovered=new WeakMap();
var diagnostics=window.__infinityListenerRecovery={popstate:false,pageshow:false,resize:false,focus:false};
function signature(e){
if(!e||e.name!=="TypeError"||e.message!=="Cannot read properties of null (reading 'tagName')"||typeof e.stack!=="string")return false;
var frames=e.stack.split("\\n").filter(function(line){return /\\bat\\s|@/.test(line);});
return frames.length>0&&/addEL_hook/.test(frames[0])&&/<anonymous>/.test(frames[0])&&/top\\.addEventListener/.test(e.stack);
}
function key(type,options){return type+":"+(typeof options==="boolean"?options:!!(options&&options.capture));}
function wrapAdd(delegate){return function(type,listener,options){
try{return delegate.call(this,type,listener,options);}catch(error){
if(this!==window||(type!=="popstate"&&type!=="pageshow"&&type!=="resize"&&type!=="focus")||!signature(error))throw error;
try{nativeAdd.call(this,type,listener,options);}catch(nativeError){throw error;}
if(listener&&(typeof listener==="function"||typeof listener==="object")){var entries=recovered.get(listener)||{};entries[key(type,options)]=true;recovered.set(listener,entries);}
diagnostics[type]=true;try{if(typeof diagnostics.flush==="function")diagnostics.flush();}catch(loggingError){}
}};}
function wrapRemove(delegate){return function(type,listener,options){
var entries=listener&&(typeof listener==="function"||typeof listener==="object")&&recovered.get(listener);
if(this===window&&entries&&entries[key(type,options)]){delete entries[key(type,options)];return nativeRemove.call(this,type,listener,options);}
return delegate.call(this,type,listener,options);
};}
// Each assigned wrapper closes over its own delegate: SDK wrappers cannot recurse through a mutable facade.
var guardedAdd=wrapAdd(window.addEventListener),guardedRemove=wrapRemove(window.removeEventListener);
Object.defineProperty(window,"addEventListener",{configurable:true,get:function(){return guardedAdd;},set:function(value){if(typeof value==="function"&&value!==guardedAdd)guardedAdd=wrapAdd(value);}});
Object.defineProperty(window,"removeEventListener",{configurable:true,get:function(){return guardedRemove;},set:function(value){if(typeof value==="function"&&value!==guardedRemove)guardedRemove=wrapRemove(value);}});
window.__infinityListenerGuard=true;
}
}catch(compatibilityError){}

try{
var mql=window.matchMedia&&window.matchMedia("all");
var mqProto=mql&&Object.getPrototypeOf(mql);
if(mqProto&&mqProto!==Object.prototype&&typeof mql.addEventListener!=="function"&&typeof mql.addListener==="function"&&typeof mql.removeListener==="function"){
Object.defineProperty(mqProto,"addEventListener",{configurable:true,writable:true,value:function(type,listener){if(type==="change")this.addListener(listener);}});
Object.defineProperty(mqProto,"removeEventListener",{configurable:true,writable:true,value:function(type,listener){if(type==="change")this.removeListener(listener);}});}
}catch(e){}
try{
if(typeof Array.prototype.findLast!=="function"){
Object.defineProperty(Array.prototype,"findLast",{configurable:true,writable:true,value:function(fn,thisArg){
for(var i=this.length-1;i>=0;i--){if(fn.call(thisArg,this[i],i,this))return this[i];}
return undefined;}});}
if(typeof Array.prototype.findLastIndex!=="function"){
Object.defineProperty(Array.prototype,"findLastIndex",{configurable:true,writable:true,value:function(fn,thisArg){
for(var i=this.length-1;i>=0;i--){if(fn.call(thisArg,this[i],i,this))return i;}
return -1;}});}
if(typeof window.structuredClone!=="function"){
window.structuredClone=function(value){
if(value===undefined)return undefined;
// Not a faithful structured clone (no cycles, Map/Set, Blob or transfer), but
// dependencies use it for plain serialisable state, and a working approximation
// beats a ReferenceError that kills hydration for the whole page.
return JSON.parse(JSON.stringify(value));};}
}catch(e){}
})();`;
}
