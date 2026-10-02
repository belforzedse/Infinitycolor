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
var eventProto=window.EventTarget&&window.EventTarget.prototype;
var nativeAdd=eventProto&&eventProto.addEventListener,nativeRemove=eventProto&&eventProto.removeEventListener;
var originalAdd=window.addEventListener,originalRemove=window.removeEventListener;
if(typeof nativeAdd==="function"&&typeof nativeRemove==="function"&&originalAdd!==nativeAdd){
var recovered=[];
var diagnostics=window.__infinityListenerRecovery={popstate:false,pageshow:false};
function signature(e){return e&&e.name==="TypeError"&&e.message==="Cannot read properties of null (reading 'tagName')"&&typeof e.stack==="string"&&e.stack.indexOf("addEL_hook")>=0&&e.stack.indexOf("top.addEventListener")>=0&&e.stack.indexOf("<anonymous>")>=0;}
window.addEventListener=function(type,listener,options){
try{return originalAdd.call(this,type,listener,options);}catch(e){
if(this!==window||(type!=="popstate"&&type!=="pageshow")||!signature(e))throw e;
try{nativeAdd.call(window,type,listener,options);}catch(fallbackError){throw e;}
recovered.push([type,listener,typeof options==="boolean"?options:!!(options&&options.capture)]);
diagnostics[type]=true;try{if(typeof diagnostics.flush==="function")diagnostics.flush();}catch(loggingError){}
}};
window.removeEventListener=function(type,listener,options){
var capture=typeof options==="boolean"?options:!!(options&&options.capture);
for(var j=recovered.length-1;j>=0;j--){if(recovered[j][0]===type&&recovered[j][1]===listener&&recovered[j][2]===capture){recovered.splice(j,1);return nativeRemove.call(window,type,listener,options);}}
return originalRemove.call(this,type,listener,options);
};}
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
