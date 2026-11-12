// Mock Yeti: checks the watcher turns live-call changes into initiated / answered / hangup events.
const http=require('http'), assert=require('assert');
let active=[]; const yeti=http.createServer((q,r)=>{r.setHeader('Content-Type','application/json'); if(q.method==='POST'){r.end(JSON.stringify({jwt:'x'}));} else r.end(JSON.stringify({data:active}));});
yeti.listen(0,async()=>{
  process.env.YETI_API_URL='http://127.0.0.1:'+yeti.address().port; process.env.SESSION_SECRET='t'; process.env.E911_DB_URL='postgres://postgres@/e911?host=/tmp&port=5499'; process.env.ADMIN_EMAILS='';
  const L=require('../lib'), W=require('../watcher'), app=require('../server'); const db=L.pool;
  await db.query('TRUNCATE emergency_calls, call_events, dids, users, customers, settings RESTART IDENTITY CASCADE');
  await db.query("INSERT INTO customers(name,contact_email) VALUES ('Acme','contact@acme.com')"); await db.query("INSERT INTO dids(customer_id,did,facility,elin_address1) VALUES (1,'9705550101','HQ','1 Main')");
  await db.query("INSERT INTO users(username,pass_hash,role,customer_id) VALUES ('adm',$1,'admin',NULL),('acme',$2,'customer',1)",[L.hashPassword('adminpass123'),L.hashPassword('acmepassword1')]);
  const call=(id,conn)=>({id,attributes:{'orig-call-id':id,'src-prefix-in':'login','src-prefix-routing':'19705550101','dst-prefix-in':'911','dst-prefix-routing':'911','dst-prefix-out':'911','start-time':new Date().toISOString(),'connect-time':conn||null}});
  const ev=async()=>(await db.query('SELECT call_id,event_type,class FROM call_events ORDER BY id')).rows.map(r=>r.call_id+':'+r.event_type+':'+r.class);
  active=[call('c1'),{id:'x',attributes:{'orig-call-id':'x','dst-prefix-in':'15551234567','src-prefix-in':'a'}}]; await W.pollLive(); await W.pollLive();
  assert.deepStrictEqual(await ev(),['c1:call.initiated:real']);                     // ordinary call ignored, no duplicate on 2nd poll
  active=[call('c1',new Date().toISOString())]; await W.pollLive(); await W.pollLive();
  assert.deepStrictEqual(await ev(),['c1:call.initiated:real','c1:call.answered:real']);
  active=[]; await W.pollLive();
  assert.deepStrictEqual(await ev(),['c1:call.initiated:real','c1:call.answered:real','c1:call.hangup:real']);
  await L.recordEvent('c1','call.hangup',new Date('2026-01-01T00:00:00Z'),{src:['9705550101'],dstIn:'911'},{hit:{class:'real'},did:null},true);   // CDR corrects the end time
  assert.strictEqual((await db.query("SELECT ts FROM call_events WHERE event_type='call.hangup'")).rows[0].ts.toISOString(),'2026-01-01T00:00:00.000Z');
  const srv=app.listen(0), base='http://127.0.0.1:'+srv.address().port; let ck='';
  const get=async(u,internal)=>{const r=await fetch(base+u,{headers:{cookie:ck,'X-E911-Internal':internal?'1':'0'}});return r.json()};
  const login=async(u,p,internal)=>{const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-E911-Internal':internal?'1':'0'},body:JSON.stringify({username:u,password:p})});ck=r.headers.get('set-cookie').split(';')[0]};
  await login('adm','adminpass123',true); const all=await get('/api/events',true); assert.strictEqual(all.length,3); assert.strictEqual((await get('/api/events?type=call.answered',true)).length,1);
  await login('acme','acmepassword1',false); assert.strictEqual((await get('/api/events',false)).length,3);   // customer sees events for own number only

  // ---- customers manage their own emails ----
  await db.query("INSERT INTO customers(name) VALUES ('Beta')"); await db.query("INSERT INTO dids(customer_id,did,facility,elin_address1) VALUES (2,'9705550102','Shop','9 Oak')");
  const rq=async(m,u,b,internal)=>{const r=await fetch(base+u,{method:m,headers:{'Content-Type':'application/json',cookie:ck,'X-E911-Internal':internal?'1':'0'},body:b==null?undefined:JSON.stringify(b)});return {s:r.status,j:await r.json().catch(()=>null)}};
  await login('acme','acmepassword1',false); const mine=(await get('/api/dids',false))[0];
  assert.strictEqual((await rq('PUT','/api/my/notify',{notify_emails:'safety@acme.com; Boss@Acme.com, safety@acme.com'})).j.notify_emails.join('|'),'safety@acme.com|boss@acme.com');   // cleaned + deduped
  assert.strictEqual((await rq('PUT','/api/my/notify',{notify_emails:'not-an-email'})).s,400);
  assert.strictEqual((await rq('PUT','/api/my/dids/'+mine.id+'/emails',{notify_emails:'front@acme.com'})).s,200);
  const other=(await db.query("SELECT id FROM dids WHERE did='9705550102'")).rows[0].id;
  assert.strictEqual((await rq('PUT','/api/my/dids/'+other+'/emails',{notify_emails:'x@y.com'})).s,404);          // another customer's number
  assert.strictEqual((await get('/api/my/notify',false)).notify_emails.length,2); assert.strictEqual((await get('/api/dids',false))[0].notify_emails,'front@acme.com');
  assert.strictEqual((await rq('POST','/api/my/notify-test',{})).j.sent,3); assert.strictEqual((await rq('POST','/api/my/notify-test',{})).s,429);   // throttled
  await login('adm','adminpass123',true); assert.strictEqual((await rq('PUT','/api/my/notify',{notify_emails:'a@b.com'},true)).s,403);   // admins use the Directory page

  // ---- internal (hidden) admin emails, preview, test send ----
  await login('adm','adminpass123',true);
  assert.strictEqual((await rq('PATCH','/api/customers/1',{admin_emails:'ops@example.com, Oncall@example.com'},true)).s,200);
  assert.strictEqual((await rq('PATCH','/api/customers/1',{admin_emails:'nope'},true)).s,400);
  const pv=(await rq('GET','/api/customers/1/email-preview',null,true)).j; assert.ok(pv.to.includes('safety@acme.com')&&pv.to.includes('front@acme.com')&&!pv.to.includes('ops@example.com'));
  assert.deepStrictEqual(pv.staff,['ops@example.com','oncall@example.com']); assert.ok(pv.html.includes('SAMPLE ONLY')&&pv.subject.startsWith('TEST:'));
  await login('acme','acmepassword1',false); assert.strictEqual((await get('/api/my/notify',false)).admin_emails,undefined);      // customer never sees internal list
  assert.ok(!JSON.stringify(await get('/api/dids',false)).includes('ops@example.com'));
  assert.strictEqual((await rq('GET','/api/customers/1/email-preview')).s,403); assert.strictEqual((await rq('GET','/api/admin-emails')).s,403); assert.strictEqual((await rq('PUT','/api/admin-emails',{emails:'x@y.com'})).s,403);
  // portal-managed global staff list
  await login('adm','adminpass123',true); assert.deepStrictEqual((await rq('PUT','/api/admin-emails',{emails:'Noc@example.com, noc@example.com'},true)).j.emails,['noc@example.com']);
  // what actually goes to SMTP2GO: TWO separate emails, customer one never contains a staff address
  const sent=[]; const realFetch=global.fetch; global.fetch=async(u,o)=>{ if(String(u).includes('smtp2go')){sent.push(JSON.parse(o.body)); return {ok:true,status:200,text:async()=>JSON.stringify({data:{succeeded:1,failed:0}})};} return realFetch(u,o); };
  process.env.SMTP2GO_API_KEY='k'; process.env.MAIL_FROM='alerts@example.com'; process.env.NO_ELIN_FEE='100'; process.env.ADMIN_EMAILS='env@example.com'; await L.refreshAdminEmails(true);
  const did=await L.findDid(['9705550101']); assert.deepStrictEqual(did.cust_admin_emails,['ops@example.com','oncall@example.com']);
  const c={callId:'z1',src:['9705550101'],dstIn:'911',dstRouting:'911',dstOut:'911',start:new Date(),source:'live'}; const recd=await L.recordCall(c,await L.loadPatterns()); await L.notifyCall(recd.id,c,recd);
  assert.strictEqual(sent.length,2); const [cust,staff]=sent;
  assert.ok(cust.to.includes('safety@acme.com')&&cust.bcc===undefined&&!/example\.com/.test(JSON.stringify({to:cust.to,bcc:cust.bcc,cc:cust.cc,subject:cust.subject,html:cust.html_body})));          // no staff address anywhere in the customer email
  assert.ok(staff.subject.startsWith('[Staff copy]')&&staff.html_body.includes('safety@acme.com')); assert.deepStrictEqual([...staff.to].sort(),['env@example.com','noc@example.com','oncall@example.com','ops@example.com']);
  assert.strictEqual((await db.query("SELECT notify_status FROM emergency_calls WHERE call_id='z1'")).rows[0].notify_status,'sent');
  // preview/test endpoint sends both too
  sent.length=0; const tr=(await rq('POST','/api/customers/1/test-email',{},true)).j; assert.strictEqual(sent.length,2); assert.strictEqual(tr.status,'sent'); assert.strictEqual(tr.staffStatus,'sent');
  // customer with no addresses: staff email only
  sent.length=0; await L.sendAlert({to:[],staff:['a@example.com']},'s','<p>x</p>'); assert.strictEqual(sent.length,1); assert.ok(sent[0].html_body.includes('NO customer addresses'));
  // a failed send must not leak addresses to the customer through the API
  await db.query("UPDATE emergency_calls SET notify_status=$1 WHERE call_id='z1'",['error 400 {"failures":["ops@example.com"]}']);
  await login('acme','acmepassword1',false); const cl=await get('/api/calls',false); assert.ok(!JSON.stringify(cl).includes('example.com')&&cl.find(x=>x.call_id==='z1').notify_status==='failed');
  // real 911 from a number NOT in the ELIN list: ONE urgent staff email, high priority, fee shown, nothing to customers
  sent.length=0; const u={callId:'n1',src:['9705559999'],dstIn:'911',dstRouting:'911',dstOut:'911',start:new Date(),source:'live'}; const ur=await L.recordCall(u,await L.loadPatterns()); await L.notifyCall(ur.id,u,ur);
  assert.strictEqual(sent.length,1); const n=sent[0];
  assert.ok(n.subject.includes('URGENT')&&n.subject.includes('NO ELIN MATCH')&&n.subject.includes('9705559999')&&!n.subject.startsWith('[Staff copy]'));
  assert.ok(n.html_body.includes('NO ELIN MATCH')&&n.html_body.includes('$100')&&n.html_body.includes('Address not on file'));
  assert.deepStrictEqual(n.custom_headers,[{header:'X-Priority',value:'1'},{header:'Importance',value:'High'}]);
  assert.ok(n.to.includes('env@example.com')&&!n.to.includes('safety@acme.com'));
  // known caller is NOT flagged, not high priority, and the contact email is not on ordinary alerts
  assert.ok(!staff.html_body.includes('NO ELIN MATCH')&&cust.custom_headers===undefined&&!cust.to.includes('contact@acme.com'));
  // portal: stats + filter
  await login('adm','adminpass123',true); const st=await get('/api/stats',true); assert.strictEqual(st.no_elin_30d,1); assert.strictEqual(st.fee,100);
  const ne=await get('/api/calls?noelin=1',true); assert.strictEqual(ne.length,1); assert.strictEqual(ne[0].call_id,'n1');
  // number loaded for a customer but WITHOUT an ELIN address: customer (contact email + notify list) AND staff both get a NO ELIN alert
  await db.query("INSERT INTO dids(customer_id,did,facility) VALUES (1,'9705550202','Annex')");
  sent.length=0; const m={callId:'m1',src:['9705550202'],dstIn:'911',dstRouting:'911',dstOut:'911',start:new Date(),source:'live'}; const mr=await L.recordCall(m,await L.loadPatterns()); await L.notifyCall(mr.id,m,mr);
  assert.strictEqual(sent.length,2); const [mc,ms]=sent;
  assert.ok(mc.subject.includes('NO ELIN MATCH')&&mc.subject.includes('ANNEX')&&!mc.subject.startsWith('[Staff copy]'));
  assert.ok(mc.to.includes('contact@acme.com')&&mc.to.includes('safety@acme.com'));
  assert.ok(!/example\.com/.test(JSON.stringify({to:mc.to,subject:mc.subject,h:mc.html_body}))&&!mc.html_body.includes('$100')&&mc.html_body.includes('Please send Yeti-E911 the dispatchable address'));   // customer sees no staff addresses and no fee
  assert.strictEqual(mc.custom_headers[0].value,'1');
  assert.ok(ms.subject.startsWith('[Staff copy]')&&ms.html_body.includes('$100')&&!ms.to.includes('contact@acme.com'));
  const st2=await get('/api/stats',true); assert.strictEqual(st2.no_elin_30d,2);
  assert.deepStrictEqual((await get('/api/calls?noelin=1',true)).map(x=>x.call_id).sort(),['m1','n1']);
  // test call (933) from that number: staff only, never customers
  sent.length=0; const t={callId:'t9',src:['9705550202'],dstIn:'933',dstRouting:'933',dstOut:'933',start:new Date(),source:'live'}; process.env.NOTIFY_TEST='1'; const tr2=await L.recordCall(t,await L.loadPatterns()); await L.notifyCall(tr2.id,t,tr2); process.env.NOTIFY_TEST='';
  assert.strictEqual(sent.length,1); assert.ok(!sent[0].to.includes('contact@acme.com')&&sent[0].subject.includes('NO ELIN'));
  // fee is optional: with NO_ELIN_FEE unset the staff alert mentions no charge; brand falls back to Yeti-E911
  delete process.env.NO_ELIN_FEE; assert.ok(!L.alertHtml({isReal:true,label:'911',did:null,c:{src:['9705550000'],dstIn:'911',start:new Date(),callId:'q'},staff:true}).includes('charged')); assert.strictEqual(L.brand(),'Yeti-E911');
  global.fetch=realFetch;
  console.log('events passed'); srv.close(); yeti.close(); await db.end(); process.exit(0);
});
