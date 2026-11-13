// Uses only the isolated localhost defects fixture. Never point this at production.
const { request } = require('@playwright/test');
const assert = require('node:assert/strict');
(async () => {
 const client = await request.newContext({ baseURL: 'http://localhost:2889', extraHTTPHeaders: { Origin: 'http://localhost:2888' } });
 async function login(phone,password) {
  await client.post('/api/auth/infinity/phone-status',{data:{phone}});
  const response = await client.post('/api/auth/infinity/password/sign-in',{data:{phone,password}});
  assert.equal(response.status(),200);
  const result = await response.json();
  if(result.redirectTo === '/auth/register/info') {
   const completed = await client.post('/api/auth/infinity/register-info',{data:{firstName:'آزمایش',lastName:'فروشگاه'}});
   assert.equal(completed.status(),200,await completed.text());
  }
  const token = await client.get('/api/auth/token'); assert.equal(token.status(),200);
  return (await token.json()).token;
 }
 const customerToken = await login('+989000000101','E2eCustomer!123');
 const api = await request.newContext({ baseURL:'http://127.0.0.1:1337/api',extraHTTPHeaders:{Authorization:`Bearer ${customerToken}`} });
 const pub = await request.newContext({baseURL:'http://127.0.0.1:1337/api'});
 const products = await (await pub.get('/api/products?filters[Slug][$eq]=e2e-storefront-smoke-product')).json();
 const productId = products.data[0].id;
 const toggles = await Promise.all(Array.from({length:8},()=>api.post('/api/product-likes/toggle',{data:{productId,isFavorite:true}})));
 for(const r of toggles) assert.equal(r.status(),200, await r.text());
 const saved = await Promise.all(toggles.map(r=>r.json())); assert(saved.every(r=>r.isFavorite));
 const reviewResults = await Promise.all(Array.from({length:6},()=>api.post('/api/product-reviews/submit',{data:{productId,rate:4,content:'Parallel isolated review verification'}})));
 const reviews=[]; for(const r of reviewResults) {assert.equal(r.status(),200,await r.text()); reviews.push(await r.json());}
 assert.equal(new Set(reviews.map(r=>r.id)).size,1); const id=reviews[0].id;
 const mine=await (await api.get('/api/product-reviews/user/me')).json();
 assert.equal(mine.data.filter(r=>r.product?.id===productId).length,1);
 const hidden=await pub.get(`/api/product-reviews/${id}`); assert.equal(hidden.status(),404);
 const invalid=await api.post('/api/product-reviews/submit',{data:{productId,rate:6,content:'invalid review rating'}}); assert.equal(invalid.status(),400);
 console.log('PASS: 8 concurrent explicit favorites; 6 concurrent reviews yield one identity; pending hidden; invalid rating rejected.');
 const adminToken=await login('+989000000201','E2eAdmin!123');
 const admin=await request.newContext({baseURL:'http://127.0.0.1:1337/api',extraHTTPHeaders:{Authorization:`Bearer ${adminToken}`}});
 const baseline=(await (await pub.get(`/api/products/${productId}`)).json()).data.attributes;
 const accepted=await admin.put(`/api/product-reviews/${id}`,{data:{data:{Status:'Accepted'}}}); assert.equal(accepted.status(),200,await accepted.text());
 const published=await pub.get(`/api/product-reviews/${id}`); assert.equal(published.status(),200,await published.text());
 const rated=(await (await pub.get(`/api/products/${productId}`)).json()).data.attributes;
 assert.equal(rated.RatingCount,(baseline.RatingCount||0)+1);
 const repeat=await api.post('/api/product-reviews/submit',{data:{productId,rate:4,content:'Parallel isolated review verification'}});assert.equal((await repeat.json()).Status,'Accepted');
 const edited=await api.post('/api/product-reviews/submit',{data:{productId,rate:5,content:'Edited isolated review verification'}}); assert.equal((await edited.json()).Status,'Need for Review');
 assert.equal((await pub.get(`/api/product-reviews/${id}`)).status(),404);
 const restored=(await (await pub.get(`/api/products/${productId}`)).json()).data.attributes;
 assert.equal(restored.RatingCount,baseline.RatingCount);
 assert(Math.abs((restored.AverageRating||0)-(baseline.AverageRating||0))<0.001);
 console.log('PASS: moderation publication; rating count increments once; unchanged replay remains accepted; edit becomes pending and restores rating baseline.');
 for(const c of [client,api,pub,admin])await c.dispose();
})().catch(e=>{console.error(e);process.exit(1)});
