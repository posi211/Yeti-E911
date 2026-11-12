process.env.SESSION_SECRET='t'; process.env.E911_DB_URL='postgres://postgres@/e911?host=/tmp&port=5499'; process.env.ADMIN_EMAILS='a@x.com';
const L=require('../lib'), app=require('../server'), assert=require('assert');
(async()=>{
  const db=L.pool; await db.query('TRUNCATE emergency_calls, dids, users, customers, login_log RESTART IDENTITY CASCADE');
  const srv=app.listen(0); const base='http://127.0.0.1:'+srv.address().port; let ck='';
  let internal=true; const call=async(m,p,b,h={})=>{h={...(internal?{'X-E911-Internal':'1'}:{}),...h};const r=await fetch(base+p,{method:m,headers:{'Content-Type':'application/json',cookie:ck,...h},body:b==null?undefined:(typeof b==='string'||Buffer.isBuffer(b)?b:JSON.stringify(b))});const t=await r.text();let j;try{j=JSON.parse(t)}catch{j=t}
    const sc=r.headers.get('set-cookie'); if(sc) ck=sc.split(';')[0]; return {s:r.status,j}};
  await db.query("INSERT INTO users(username,pass_hash,role) VALUES('adm',$1,'admin')",[L.hashPassword('adminpass123')]);
  assert.strictEqual((await call('GET','/api/calls')).s,401);
  assert.strictEqual((await call('POST','/api/login',{username:'adm',password:'bad'})).s,401);
  assert.strictEqual((await call('POST','/api/login',{username:'adm',password:'adminpass123'})).s,200);
  assert.strictEqual((await call('POST','/api/customers',{name:'NoMail'})).s,400); assert.strictEqual((await call('POST','/api/customers',{name:'NoMail',contact_email:'bad'})).s,400);   // contact email is mandatory
  await call('POST','/api/customers',{name:'Acme',contact_email:'boss@acme.com',notify_emails:'safety@acme.com, sec@acme.com'});
  await call('POST','/api/customers',{name:'Beta',contact_email:'b@beta.com',notify_emails:''});
  const imp=await call('POST','/api/dids/import',"did,customer,facility,elin_address1,city,state,zip\n+1 (970) 555-0101,Acme,HQ,\"1 Main St, Ste 2\",Springfield,ST,00000\n9705550102,Beta,Shop,9 Oak,Vail,CO,81657\nbad,Acme,x,y,,,\n",{'Content-Type':'text/csv'});
  assert.deepStrictEqual([imp.j.imported,imp.j.errors.length],[2,1]);
  const cx=await call('POST','/api/dids/import',"did,customer,facility,elin_address1\n9705550199,Gamma,Depot,5 Elm\n",{'Content-Type':'text/csv'}); assert.strictEqual(cx.j.imported,0);
  const cy=await call('POST','/api/dids/import?create=1',"\uFEFFdid,customer,facility,elin_address1\n9705550199,Gamma,Depot,5 Elm\n",{'Content-Type':'text/csv'}); assert.strictEqual(cy.j.imported,0);   // numbers no longer auto-create customers (a customer needs a contact email)
  const ci=await call('POST','/api/customers/import',"name,contact_email,notify_emails,notes,active\nDelta,d@x.com,\"a@x.com; b@x.com\",hi,true\nAcme,boss@acme.com,new@acme.com,,false\nGamma,g@x.com,,,true\nNoContact,,,,true\n",{'Content-Type':'text/csv'}); assert.deepStrictEqual([ci.j.imported,ci.j.errors.length],[3,1]);
  assert.strictEqual((await call('POST','/api/dids/import',"did,customer,facility,elin_address1\n9705550199,Gamma,Depot,\n",{'Content-Type':'text/csv'})).j.imported,1);   // a number without an ELIN address is fine
  const ce=(await call('GET','/api/customers.csv')).j; assert.ok(String(ce).includes('Delta,d@x.com,a@x.com;b@x.com') && String(ce).includes('Acme,boss@acme.com,new@acme.com'));
  await call('POST','/api/customers',{name:'Acme',contact_email:'boss@acme.com',notify_emails:'safety@acme.com, sec@acme.com'});
  const pats=await L.loadPatterns(); process.env.SMTP2GO_API_KEY='';
  const mk=(id,src,dst)=>({callId:id,src:[src],dstIn:dst,dstRouting:dst,dstOut:dst,start:new Date(),source:'live'});
  let c=mk('c1','19705550101','911'), r=await L.recordCall(c,pats); assert.ok(r.inserted&&r.did&&r.hit.class==='real'); await L.notifyCall(r.id,c,r);
  r=await L.recordCall({...c,source:'cdr',end:new Date(),duration:42,code:200},pats); assert.ok(!r.inserted);       // dedupe + merge
  c=mk('c2','9705550102','933'); r=await L.recordCall(c,pats); assert.ok(r.inserted&&r.hit.class==='test');
  c=mk('c3','9709999999','1911'); r=await L.recordCall(c,pats); assert.ok(r.inserted&&!r.did);                     // unknown caller still captured
  assert.strictEqual(await L.recordCall(mk('c4','9705550101','9115551212'),pats),null);
  const all=(await call('GET','/api/calls')).j; assert.strictEqual(all.length,3);
  const merged=all.find(x=>x.call_id==='c1'); assert.strictEqual(merged.source,'both'); assert.strictEqual(merged.duration_s,42); assert.strictEqual(merged.notify_status,'SMTP2GO_API_KEY not set');
  assert.strictEqual((await call('GET','/api/calls?class=real')).j.length,2);
  // customer user sees only own
  const acme=(await db.query("SELECT id FROM customers WHERE name='Acme'")).rows[0].id;
  await call('POST','/api/users',{username:'acme',password:'acmepassword1',customer_id:acme});
  internal=false; ck=''; assert.strictEqual((await call('POST','/api/login',{username:'adm',password:'adminpass123'})).s,403); ck=''; await call('POST','/api/login',{username:'acme',password:'acmepassword1'});
  const mine=(await call('GET','/api/calls')).j; assert.deepStrictEqual(mine.map(x=>x.call_id),['c1']);
  assert.strictEqual((await call('GET','/api/dids')).j.length,1);
  assert.strictEqual((await call('GET','/api/customers')).s,403);
  assert.strictEqual((await call('POST','/api/dids',{did:'9705550103',customer_id:acme,elin_address1:'x'})).s,403);
  const csv=(await call('GET','/api/calls.csv')).j; assert.ok(String(csv).includes('c1'));
  // ---- Excel round trips ----
  const ExcelJS=require('exceljs'), MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const getX=async p=>{const r=await fetch(base+p,{headers:{cookie:ck,'X-E911-Internal':internal?'1':'0'}}); assert.strictEqual(r.status,200); assert.ok(r.headers.get('content-type').includes('spreadsheetml')); const wb=new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer())); return wb.worksheets[0].getSheetValues().slice(1).map(a=>a.slice(1));};
  const cm=await getX('/api/calls.xlsx'); assert.strictEqual(cm.length,2); assert.strictEqual(cm[0][0],'started_at'); assert.strictEqual(cm[1][14],'c1');   // customer user: header + own call only
  const dx=await getX('/api/dids.xlsx'); assert.strictEqual(dx.length,2); assert.strictEqual(dx[1][0],'9705550101');
  assert.strictEqual((await fetch(base+'/api/customers.xlsx',{headers:{cookie:ck}})).status,403);
  internal=true; ck=''; await call('POST','/api/login',{username:'adm',password:'adminpass123'});
  const cust=await getX('/api/customers.xlsx'); assert.ok(cust.some(r=>r[0]==='Delta'&&r[1]==='d@x.com'&&r[2]==='a@x.com;b@x.com'));
  const wb=new ExcelJS.Workbook(), ws=wb.addWorksheet('x'); ws.addRow(['did','customer','facility','elin_address1','city']); ws.addRow([9705550177,'Epsilon','Lab','7 Pine','Springfield']); ws.addRow([9705550178,'Epsilon','Lab2','','Springfield']); ws.addRow(['','','','','']);
  await call('POST','/api/customers',{name:'Epsilon',contact_email:'e@x.com'});
  const up=await call('POST','/api/dids/import',Buffer.from(await wb.xlsx.writeBuffer()),{'Content-Type':MIME}); assert.deepStrictEqual([up.j.imported,up.j.errors.length],[2,0]);
  assert.ok((await getX('/api/dids.xlsx')).some(r=>r[0]==='9705550177'&&r[1]==='Epsilon'));
  const wb2=new ExcelJS.Workbook(), w2=wb2.addWorksheet('c'); w2.addRow(['name','contact_email','notify_emails','notes','active']); w2.addRow(['Zeta','zc@x.com',{text:'z@x.com',hyperlink:'mailto:z@x.com'},'n',true]);
  const uc=await call('POST','/api/customers/import',Buffer.from(await wb2.xlsx.writeBuffer()),{'Content-Type':MIME}); assert.strictEqual(uc.j.imported,1);
  assert.ok((await getX('/api/customers.xlsx')).some(r=>r[0]==='Zeta'&&r[1]==='zc@x.com'&&r[2]==='z@x.com'));
  assert.strictEqual((await call('POST','/api/dids/import',Buffer.from('not a workbook'),{'Content-Type':MIME})).s,400);   // garbage file is refused
  await db.query("INSERT INTO customers(name,notes) VALUES ('=cmd|x','=1+1')"); assert.ok(String((await call('GET','/api/customers.csv')).j).includes("'=cmd|x"));   // no formula injection

  // ---- v2: portal password, stats, per-number emails, login log, deactivate ----
  const cs=(await call('GET','/api/customers')).j; const acmeC=cs.find(x=>x.name==='Acme'); assert.ok(Array.isArray(acmeC.portal_users)&&acmeC.did_count===1);
  assert.strictEqual((await call('POST','/api/customers/'+acmeC.id+'/portal',{password:'short'})).s,400);
  assert.strictEqual((await call('POST','/api/customers/'+acmeC.id+'/portal',{password:'portalpass12345'})).j.username,'Acme');   // login name defaults to the account name
  const betaId=cs.find(x=>x.name==='Beta').id; assert.strictEqual((await call('POST','/api/customers/'+betaId+'/portal',{username:'Acme',password:'portalpass12345'})).s,409);
  assert.strictEqual((await call('PATCH','/api/customers/'+acmeC.id,{notify_emails:'x@acme.com; y@acme.com'})).s,200);
  assert.deepStrictEqual((await call('GET','/api/customers')).j.find(x=>x.name==='Acme').notify_emails,['x@acme.com','y@acme.com']);
  await call('POST','/api/dids',{did:'9705550101',customer_id:acmeC.id,facility:'HQ',elin_address1:'1 Main St',notify_emails:'front@acme.com, night@acme.com'});
  const d1=(await call('GET','/api/dids')).j.find(x=>x.did==='9705550101'); assert.strictEqual(d1.notify_emails,'front@acme.com;night@acme.com');
  const fd=await L.findDid(['9705550101']); assert.deepStrictEqual([fd.cust_emails.length,fd.notify_emails.length],[2,2]);
  const st=(await call('GET','/api/stats')).j; assert.strictEqual(st.total,3); assert.strictEqual(st.real,2); assert.ok(st.live>=1);
  ck=''; internal=false; assert.strictEqual((await call('POST','/api/login',{username:'Acme',password:'portalpass12345'})).s,200);   // customer signs in by account name
  const stc=(await call('GET','/api/stats')).j; assert.strictEqual(stc.total,1); assert.strictEqual((await call('GET','/api/login-logs')).s,403);
  internal=true; ck=''; await call('POST','/api/login',{username:'adm',password:'adminpass123'});
  const ll=(await call('GET','/api/login-logs')).j; assert.ok(ll.some(x=>x.username==='adm'&&x.success)&&ll.some(x=>x.username==='adm'&&!x.success)&&ll.some(x=>x.username==='Acme'&&x.success));
  await call('PATCH','/api/customers/'+acmeC.id,{active:false}); internal=false; ck='';
  assert.strictEqual((await call('POST','/api/login',{username:'Acme',password:'portalpass12345'})).s,401);   // deactivated customer cannot sign in
  internal=true; ck=''; await call('POST','/api/login',{username:'adm',password:'adminpass123'});
  const xs=await getX('/api/dids.xlsx'); assert.strictEqual(xs[0][9],'notify_emails');

  // ---- v3: manage users ----
  const us=(await call('GET','/api/users')).j; const admU=us.find(x=>x.username==='adm'), acmeU=us.find(x=>x.username==='acme');
  assert.ok(admU&&acmeU&&acmeU.customer==='Acme');
  assert.strictEqual((await call('PATCH','/api/users/'+admU.id,{active:false})).s,400);          // cannot disable yourself
  assert.strictEqual((await call('DELETE','/api/users/'+admU.id)).s,400);
  await call('POST','/api/users',{username:'adm2',password:'adminpass456'});
  const adm2=(await call('GET','/api/users')).j.find(x=>x.username==='adm2');
  assert.strictEqual((await call('PATCH','/api/users/'+adm2.id,{password:'short'})).s,400);
  assert.strictEqual((await call('PATCH','/api/users/'+adm2.id,{password:'newpassword99',username:'ops'})).s,200);
  assert.strictEqual((await call('PATCH','/api/users/'+adm2.id,{username:'acme'})).s,409);       // taken
  ck=''; assert.strictEqual((await call('POST','/api/login',{username:'ops',password:'newpassword99'})).s,200);   // reset password + rename work
  assert.strictEqual((await call('PATCH','/api/users/'+admU.id,{active:false})).s,200);          // now ops (admin) can disable adm
  assert.strictEqual((await call('PATCH','/api/users/'+admU.id,{active:true})).s,200);
  assert.strictEqual((await call('DELETE','/api/users/'+acmeU.id)).s,200);
  ck=''; await call('POST','/api/login',{username:'adm',password:'adminpass123'});
  await call('DELETE','/api/users/'+adm2.id); assert.strictEqual((await call('DELETE','/api/users/'+admU.id)).s,400);   // last admin stays
  console.log('e2e passed'); srv.close(); await db.end();
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
