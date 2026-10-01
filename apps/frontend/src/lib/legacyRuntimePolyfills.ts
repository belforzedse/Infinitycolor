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
