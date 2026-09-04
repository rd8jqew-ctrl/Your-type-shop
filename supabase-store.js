const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'your-type-media';
const enabled = Boolean(SUPABASE_URL && SUPABASE_KEY);

let writeQueue = Promise.resolve();
let lastSync = null;
let lastError = null;
const disabledTables = new Set();
let storageReady = false;

function cleanError(e){ return e?.message || String(e || 'Unknown Supabase error'); }
function deep(v){ return JSON.parse(JSON.stringify(v)); }
function baseUrl(){ return SUPABASE_URL.replace(/\/$/,''); }
function headers(prefer){ const h={apikey:SUPABASE_KEY,Authorization:'Bearer '+SUPABASE_KEY,Accept:'application/json','Content-Type':'application/json'}; if(prefer)h.Prefer=prefer; return h; }

async function request(table, method='GET', body=null, query=''){
  const url=baseUrl()+'/rest/v1/'+table+(query?'?'+query:'');
  const r=await fetch(url,{method,headers:headers((method==='POST'||method==='PATCH'||method==='DELETE')?'resolution=merge-duplicates,return=representation':undefined),body:body==null?undefined:JSON.stringify(body)});
  const text=await r.text(); let data=[]; try{data=text?JSON.parse(text):[]}catch{data=[]}
  if(!r.ok) throw new Error(`${table} ${method} failed (${r.status}): ${data?.message||data?.error||text||'Unknown error'}`);
  return data;
}
async function getAll(table, order='created_at'){
  return request(table,'GET',null,'select=*'+(order?'&order='+encodeURIComponent(order)+'.desc':''));
}
async function getAllOptional(table, order='created_at'){
  if(disabledTables.has(table)) return [];
  try{return await getAll(table,order)}catch(e){if(/\b404\b/.test(cleanError(e))){disabledTables.add(table);console.warn(`[Supabase] Optional table "${table}" is not available through PostgREST; continuing without it.`);return []}throw e;}
}

async function ensureStorageBucket(){
  if(!enabled || storageReady)return;
  const bucketUrl=baseUrl()+'/storage/v1/bucket/'+encodeURIComponent(STORAGE_BUCKET);
  const get=await fetch(bucketUrl,{headers:headers()});
  if(get.ok){storageReady=true;return;}

  // Some Supabase Storage versions/proxies return 400 for the bucket GET even
  // when the bucket is usable. Do not stop an upload on that check. Try the
  // idempotent create call; 409 means the bucket already exists.
  const create=await fetch(baseUrl()+'/storage/v1/bucket',{method:'POST',headers:headers(),body:JSON.stringify({id:STORAGE_BUCKET,name:STORAGE_BUCKET,public:true,file_size_limit:52428800})});
  const createText=await create.text();
  if(create.ok || create.status===409){storageReady=true;return;}

  let detail=createText;
  try{const j=createText?JSON.parse(createText):null;detail=j?.message||j?.error||j?.statusCode||createText}catch{}
  throw new Error(`Storage bucket setup failed (check ${get.status}, create ${create.status}): ${detail||'Unknown Storage error'}`);
}
async function uploadMedia(filename,buffer,contentType){
  if(!enabled)return '';
  await ensureStorageBucket();
  const path='products/'+filename;
  const r=await fetch(baseUrl()+'/storage/v1/object/'+encodeURIComponent(STORAGE_BUCKET)+'/'+path,{method:'POST',headers:{apikey:SUPABASE_KEY,Authorization:'Bearer '+SUPABASE_KEY,'Content-Type':contentType,'x-upsert':'true'},body:buffer});
  if(!r.ok){const t=await r.text();throw new Error(`Storage upload failed (${r.status}): ${t}`)}
  return baseUrl()+'/storage/v1/object/public/'+encodeURIComponent(STORAGE_BUCKET)+'/'+path;
}
async function listMedia(){
  await ensureStorageBucket();
  const r=await fetch(baseUrl()+'/storage/v1/object/list/'+encodeURIComponent(STORAGE_BUCKET),{method:'POST',headers:headers(),body:JSON.stringify({prefix:'products',limit:1000,offset:0,sortBy:{column:'updated_at',order:'desc'}})});
  const t=await r.text(); let data=[]; try{data=t?JSON.parse(t):[]}catch{data=[]}
  if(!r.ok)throw new Error(`Storage list failed (${r.status}): ${data?.message||t}`);
  return (Array.isArray(data)?data:[]).filter(x=>x.name).map(x=>({name:x.name,size:Number(x.metadata?.size||x.size||0),type:x.metadata?.mimetype||'application/octet-stream',updatedAt:x.updated_at||x.created_at||'',url:baseUrl()+'/storage/v1/object/public/'+encodeURIComponent(STORAGE_BUCKET)+'/products/'+encodeURIComponent(x.name)}));
}
async function deleteMedia(filename){
  await ensureStorageBucket();
  const path='products/'+filename;
  const r=await fetch(baseUrl()+'/storage/v1/object/'+encodeURIComponent(STORAGE_BUCKET),{method:'DELETE',headers:headers(),body:JSON.stringify({prefixes:[path]})});
  if(r.status===404)return false;
  if(!r.ok){const t=await r.text();throw new Error(`Storage delete failed (${r.status}): ${t}`)}
  return true;
}

async function hydrateDb(db, options={}){
  if(!enabled)return {enabled:false,source:'data.json'};
  try{
    const [products,customers,orders,items,reviews,coupons,returns,newsletter,notifications,audit,siteRows,settingsRows,deleted]=await Promise.all([
      getAll('products','created_at'),getAll('customers','created_at'),getAll('orders','order_date'),getAll('order_items','created_at'),getAll('reviews','created_at'),getAll('coupons','created_at'),getAll('returns','created_at'),getAll('newsletter','created_at'),getAllOptional('notifications','created_at'),getAllOptional('audit','created_at'),getAllOptional('site_config','updated_at'),getAllOptional('store_settings','updated_at'),getAllOptional('deleted_product_ids','deleted_at')
    ]);
    const hasBusinessData=products.length||customers.length||orders.length||items.length||reviews.length||coupons.length||returns.length||newsletter.length||notifications.length;
    if(!hasBusinessData){db.deletedProductIds=[...new Set([...(db.deletedProductIds||[]).map(String),...(options.preserveDeletedIds||[]).map(String)])];db.products=(db.products||[]).filter(p=>!new Set(db.deletedProductIds).has(String(p.id)));await persistDb(db,true);return {enabled:true,source:'data.json->supabase',migrated:true};}
    const preservedDeleted=new Set((options.preserveDeletedIds||[]).map(String)),remoteDeleted=new Set(deleted.map(x=>String(x.product_id))),allDeleted=new Set([...preservedDeleted,...remoteDeleted]);
    db.products=products.filter(p=>!allDeleted.has(String(p.id))).map(p=>({id:p.id,name:p.name,category:p.category,price:String(p.price??''),cost:Number(p.cost||0),sku:p.sku||'',description:p.description||'',image:p.image||'',images:Array.isArray(p.images)?p.images:[],sizes:p.sizes||{},colors:Array.isArray(p.colors)?p.colors:[],active:p.active!==false,featured:Boolean(p.featured),createdAt:p.created_at,updatedAt:p.updated_at}));
    db.users=customers.map(c=>({id:c.id,name:c.name,email:c.email,phone:c.phone||'',password:c.password_hash||'',createdAt:c.created_at}));
    const itemMap=new Map(); for(const it of items){const a=itemMap.get(it.order_id)||[];a.push({productId:it.product_id,name:it.name,image:it.image||'',sku:it.sku||'',price:String(it.price??''),size:it.size||'M',color:it.color||'Black',qty:Number(it.qty||1)});itemMap.set(it.order_id,a)}
    db.orders=orders.map(o=>({orderId:o.order_id,userId:o.user_id||null,name:o.name,email:o.email,phone:o.phone,address:o.address,city:o.city||'',pin:o.pin,items:itemMap.get(o.order_id)||[],subtotal:Number(o.subtotal||0),discount:Number(o.discount||0),couponCode:o.coupon_code||'',taxableSubtotal:Number(o.taxable_subtotal||0),gstRate:Number(o.gst_rate||0),gst:Number(o.gst||0),shipping:Number(o.shipping||0),total:Number(o.total||0),payment:o.payment||'cod',status:o.status||'New',verified:Boolean(o.verified),awb:o.awb||'',courier:o.courier||'',tracking_url:o.tracking_url||'',date:o.order_date}));
    db.reviews=reviews.map(r=>({id:r.id,product:r.product,rating:Number(r.rating||5),title:r.title||'',text:r.review_text||'',name:r.customer_name||'Customer',verified:Boolean(r.verified),status:r.status||'pending',reply:r.reply||'',createdAt:r.created_at}));
    db.coupons=coupons.map(c=>({id:c.id,code:c.code,type:c.type||'percent',value:Number(c.value||0),minOrder:Number(c.min_order||0),expiresAt:c.expires_at||null,active:c.active!==false,createdAt:c.created_at}));
    db.returns=returns.map(r=>({id:r.id,orderId:r.order_id,userId:r.user_id,status:r.status||'pending',refundAmount:Number(r.refund_amount||0),data:r.data||{},createdAt:r.created_at}));
    db.newsletter=newsletter.map(n=>({email:n.email,createdAt:n.created_at})); db.notifications=notifications.map(n=>({id:n.id,type:n.type||'',title:n.title||'',message:n.message||'',read:Boolean(n.read),data:n.data||{},createdAt:n.created_at})); db.audit=audit.map(a=>({id:a.id,action:a.action,meta:a.meta||{},time:a.created_at}));
    if(siteRows[0]){const s=siteRows[0];db.site={hero:s.hero,announcement:s.announcement,sections:s.sections||{},sectionProducts:s.section_products||{},colorPalette:s.color_palette||[],store:s.store||{},content:s.content||{},categories:s.categories||[]}}
    if(settingsRows[0]){const s=settingsRows[0];db.settings={gst:Number(s.gst||0),shipping:Number(s.shipping||0),freeShipping:Number(s.free_shipping||0),gateway:s.gateway||{},courier:s.courier||{},notifications:s.notifications||{},role:s.role||'Super Admin'}}
    db.deletedProductIds=[...new Set([...(options.preserveDeletedIds||[]).map(String),...deleted.map(x=>String(x.product_id))])];db.sessions={};lastSync=new Date().toISOString();lastError=null;return {enabled:true,source:'supabase',migrated:false};
  }catch(e){lastError=cleanError(e);throw new Error('Supabase connection failed: '+lastError)}
}

async function persistDb(db,initial=false){
  if(!enabled)return {enabled:false};
  const d=deep(db);
  const productRows=(d.products||[]).filter(p=>!d.deletedProductIds?.includes(String(p.id))).map(p=>({id:String(p.id),name:String(p.name||''),category:p.category||'',price:Number(String(p.price||0).replace(/[^0-9.-]/g,''))||0,cost:Number(p.cost||0),sku:p.sku||null,description:p.description||'',image:p.image||'',images:p.images||[],sizes:p.sizes||{},colors:p.colors||[],active:p.active!==false,featured:Boolean(p.featured)}));
  const customerRows=(d.users||[]).map(u=>({id:String(u.id),name:String(u.name||''),email:String(u.email||'').toLowerCase(),phone:u.phone||'',password_hash:u.password||null,created_at:u.createdAt||undefined}));
  const orderRows=(d.orders||[]).map(o=>({order_id:String(o.orderId),user_id:o.userId||null,name:o.name||'',email:o.email||'',phone:o.phone||'',address:o.address||'',city:o.city||'',pin:o.pin||'',subtotal:Number(o.subtotal||0),discount:Number(o.discount||0),coupon_code:o.couponCode||'',taxable_subtotal:Number(o.taxableSubtotal||0),gst_rate:Number(o.gstRate||0),gst:Number(o.gst||0),shipping:Number(o.shipping||0),total:Number(o.total||0),payment:o.payment||'cod',status:o.status||'New',verified:Boolean(o.verified),awb:o.awb||'',courier:o.courier||'',tracking_url:o.tracking_url||'',order_date:o.date||undefined}));
  const itemRows=[];for(const o of d.orders||[])for(const it of o.items||[])itemRows.push({order_id:String(o.orderId),product_id:it.productId||null,name:it.name||'',image:it.image||'',sku:it.sku||'',price:Number(String(it.price||0).replace(/[^0-9.-]/g,''))||0,size:it.size||'M',color:it.color||'Black',qty:Number(it.qty||1)});
  const reviewRows=(d.reviews||[]).map(r=>({id:String(r.id),product:r.product||'',rating:Number(r.rating||5),title:r.title||'',review_text:r.text||'',customer_name:r.name||'Customer',verified:Boolean(r.verified),status:r.status||'pending',reply:r.reply||'',created_at:r.createdAt||undefined}));
  const couponRows=(d.coupons||[]).map(c=>({id:String(c.id),code:String(c.code||'').toUpperCase(),type:c.type||'percent',value:Number(c.value||0),min_order:Number(c.minOrder||0),expires_at:c.expiresAt||null,active:c.active!==false,created_at:c.createdAt||undefined}));
  const returnRows=(d.returns||[]).map(r=>({id:String(r.id),order_id:r.orderId||null,user_id:r.userId||null,status:r.status||'pending',refund_amount:Number(r.refundAmount||0),data:r.data||{},created_at:r.createdAt||undefined}));
  const newsletterRows=(d.newsletter||[]).map(n=>({email:String(n.email).toLowerCase(),created_at:n.createdAt||undefined}));
  const notificationRows=(d.notifications||[]).map(n=>({id:String(n.id),type:n.type||'',title:n.title||'',message:n.message||'',read:Boolean(n.read),data:n.data||{},created_at:n.createdAt||undefined}));
  const auditRows=(d.audit||[]).map(a=>({id:String(a.id),action:a.action||'',meta:a.meta||{},created_at:a.time||undefined}));
  async function replaceTable(table,rows,key){if(disabledTables.has(table))return;try{const existing=await request(table,'GET',null,'select='+encodeURIComponent(key));const keep=new Set(rows.map(r=>String(r[key])));for(const r of existing||[]){if(!keep.has(String(r[key])))await request(table,'DELETE',null,encodeURIComponent(key)+'=eq.'+encodeURIComponent(String(r[key])))}if(rows.length)await request(table,'POST',rows,'on_conflict='+encodeURIComponent(key));}catch(e){if(/\b404\b/.test(cleanError(e))){disabledTables.add(table);console.warn(`[Supabase] Optional table "${table}" is not available through PostgREST; skipping its sync.`);return}throw e}}
  await replaceTable('products',productRows,'id');await replaceTable('customers',customerRows,'id');await replaceTable('orders',orderRows,'order_id');await request('order_items','DELETE',null,'order_id=not.is.null');if(itemRows.length)await request('order_items','POST',itemRows);await replaceTable('reviews',reviewRows,'id');await replaceTable('coupons',couponRows,'id');await replaceTable('returns',returnRows,'id');await replaceTable('newsletter',newsletterRows,'email');await replaceTable('notifications',notificationRows,'id');await replaceTable('audit',auditRows,'id');
  try{await request('site_config','POST',{id:1,hero:d.site?.hero||'YOUR TYPE',announcement:d.site?.announcement||'',sections:d.site?.sections||{},section_products:d.site?.sectionProducts||{},color_palette:d.site?.colorPalette||[],store:d.site?.store||{},content:d.site?.content||{},categories:d.site?.categories||[]},'on_conflict=id')}catch(e){if(/\b404\b/.test(cleanError(e))){disabledTables.add('site_config');console.warn('[Supabase] Optional table "site_config" is not available through PostgREST; skipping its sync.')}else throw e}
  try{await request('store_settings','POST',{id:1,gst:Number(d.settings?.gst||0),shipping:Number(d.settings?.shipping||0),free_shipping:Number(d.settings?.freeShipping||0),gateway:d.settings?.gateway||{},courier:d.settings?.courier||{},notifications:d.settings?.notifications||{},role:d.settings?.role||'Super Admin'},'on_conflict=id')}catch(e){if(/\b404\b/.test(cleanError(e))){disabledTables.add('store_settings');console.warn('[Supabase] Optional table "store_settings" is not available through PostgREST; skipping its sync.')}else throw e}
  await replaceTable('deleted_product_ids',(d.deletedProductIds||[]).map(id=>({product_id:String(id)})),'product_id');lastSync=new Date().toISOString();lastError=null;return {enabled:true,source:'supabase',initial};
}
function queueSave(db){if(!enabled)return Promise.resolve({enabled:false});const snapshot=deep(db);const job=writeQueue.catch(()=>{}).then(()=>persistDb(snapshot,false));writeQueue=job.catch(e=>{lastError=cleanError(e);console.error('[Supabase]',lastError);});return job;}
async function flush(){return writeQueue;}
function status(){return {enabled,configured:enabled,lastSync,lastError,pending:false};}
module.exports={enabled,hydrateDb,persistDb,queueSave,flush,status,uploadMedia,listMedia,deleteMedia};
