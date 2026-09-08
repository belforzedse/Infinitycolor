// Isolated local database only. Seed three promotions, exercise real SQL, then restore.
const assert = require('node:assert/strict');
const path = require('node:path');
if(process.env.DATABASE_NAME !== 'infinity_defects_e2e' || process.env.DATABASE_PORT !== '29454') throw new Error('Requires isolated defects fixture');
const appDir=path.resolve(__dirname,'../../backend');
const create=require(path.join(appDir,'node_modules/@strapi/strapi'));
(async()=>{
 const app=create({appDir,distDir:path.join(appDir,'dist'),autoReload:false,serveAdminPanel:false});await app.load();
 const uid=n=>`api::${n}.${n}`, query=n=>app.db.query(uid(n));
 const made=[];let settings;
 try {
  settings=await query('settings').findOne();
  for(const [name,stocks] of [['available',[4]],['soldout',[0]],['mixed',[0,3]]]) {
   const p=await query('product').create({data:{Title:`defects promo ${name}`,Slug:`defects-promo-${name}`,Status:'Active',CoverImage:1}});made.push(['product',p.id]);
   for(let i=0;i<stocks.length;i++) {
    const st=await query('product-stock').create({data:{Count:stocks[i]}});made.push(['product-stock',st.id]);
    const v=await query('product-variation').create({data:{SKU:`defects-promo-${name}-${i}`,Price:100000,DiscountPrice:80000,IsPublished:true,product:p.id,product_stock:st.id}});made.push(['product-variation',v.id]);
   }
  }
  const ids=made.filter(x=>x[0]==='product').map(x=>x[1]);const svc=app.service(uid('product'));
  const all=await svc.findProductCards({hasDiscount:true,filters:{id:{$in:ids}},pagination:{page:1,pageSize:2}});
  assert.equal(all.meta.pagination.total,3);assert.equal(all.meta.pagination.pageCount,2);
  const last=await svc.findProductCards({hasDiscount:true,filters:{id:{$in:ids}},pagination:{page:2,pageSize:2}});
  assert.equal(last.data[0].id,ids[1]);assert.equal(last.data[0].attributes.IsAvailable,false);
  const available=await svc.findProductCards({hasDiscount:true,availability:'available',filters:{id:{$in:ids}}});
  assert.equal(available.data.length,2);assert(!available.data.some(x=>x.id===ids[1]));
  const check=async(manual)=>{
   await query('settings').update({where:{id:settings.id},data:{homeDiscountedProductIds:manual?ids:[]}});
   const home=await svc.findHomepageSections();
   const section=home.data.sections.find(x=>x.id==='discounted');
   assert(section,JSON.stringify(Object.keys(home.data)));
   assert(ids.every(id=>section.products.some(p=>p.id===id)));
  };
  await check(false);await check(true);
  console.log('PASS: sold-out and mixed-stock promotions; SQL pagination; explicit availability filter; automatic and manual homepage membership.');
 } finally {
  if(settings) await query('settings').update({where:{id:settings.id},data:{homeDiscountedProductIds:settings.homeDiscountedProductIds}});
  for(const [name,id] of made.reverse()) await query(name).delete({where:{id}});
  await app.destroy();
 }
})().catch(e=>{console.error(e);process.exitCode=1});
