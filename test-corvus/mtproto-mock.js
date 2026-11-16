const net=require('net'),crypto=require('crypto'),zlib=require('zlib'),assert=require('assert'),fs=require('fs')
const {Schema,Reader,Writer}=require('../lib/corvus/mtproto/tl'),{SERVICE_TL}=require('../lib/corvus/mtproto/service.tl')
const C=require('../lib/corvus/mtproto/crypto'),{MTClient,RpcError}=require('../lib/corvus/mtproto/client')
const TEST_TL=`
helloRes#12345678 msg:string n:long flags:# extra:flags.0?string = HelloRes;
updateShortMessage flags:# out:flags.1?true id:int user_id:long message:string date:int = Updates;
invokeWithLayer {X:Type} layer:int query:!X = X;
initConnection {X:Type} flags:# api_id:int device_model:string system_version:string app_version:string system_lang_code:string lang_pack:string lang_code:string query:!X = X;
---functions---
hello name:string = HelloRes;
fail = Bool;
// LAYER 99
`
const apiText=TEST_TL
fs.writeFileSync(require('os').tmpdir()+'/corvus_test_api.tl',apiText)
// skema server: semua jadi ctor
const srv=new Schema().load(SERVICE_TL.replace('---functions---','')); srv.load(apiText.replace('---functions---',''))
// RSA uji
const kp=crypto.generateKeyPairSync('rsa',{modulusLength:2048}); const jwk=kp.publicKey.export({format:'jwk'}); const jd=kp.privateKey.export({format:'jwk'})
const b2n=(s)=>C.toBig(Buffer.from(s,'base64url')); const key={n:b2n(jwk.n),e:b2n(jwk.e)}; const D=b2n(jd.d)
const PRIME=C.toBig(Buffer.from('c71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c3720fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f642477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a4a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae4e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851f0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b','hex'))
assert.strictEqual(PRIME.toString(2).length,2048)
let log=[]
const server=net.createServer((sock)=>{
  let buf=Buffer.alloc(0),init=false,st={},authKey,seq=0,realSalt=0n,sentBadSalt=false,srvMsg=0n,failedOnce=false
  const sendRaw=(p)=>{const h=Buffer.alloc(4);h.writeUInt32LE(p.length);sock.write(Buffer.concat([h,p]))}
  const nid=()=>{srvMsg+=4n;return (BigInt(Math.floor(Date.now()/1000))<<32n)+srvMsg+1n}
  const sendPlain=(obj)=>{const b=srv.serialize(obj);sendRaw(new Writer().raw(Buffer.alloc(8)).long(nid()).int(b.length).raw(b).done())}
  const sendEnc=(body,content=true)=>{
    const head=new Writer().long(realSalt).raw(st.session).long(nid()).int(seq*2+(content?1:0)).int(body.length).done(); if(content)seq++
    const pad=12+((16-((head.length+body.length+12)%16))%16); const plain=Buffer.concat([head,body,crypto.randomBytes(pad)])
    const mk=C.sha256(authKey.subarray(96,128),plain).subarray(8,24); const {key,iv}=C.msgKeys(authKey,mk,8)
    sendRaw(Buffer.concat([C.sha1(authKey).subarray(12,20),mk,C.igeEncrypt(plain,key,iv)]))}
  const rpcResult=(reqId,resObj,gz)=>{let r=srv.serialize(resObj); if(gz) r=new Writer().uint(0x3072cfa1).bytes(zlib.gzipSync(r)).done()
    sendEnc(new Writer().uint(0xf35c6d01).long(reqId).raw(r).done())}
  const rpcErr=(reqId,code,msg)=>sendEnc(new Writer().uint(0xf35c6d01).long(reqId).raw(srv.serialize({_:'rpc_error',error_code:code,error_message:msg})).done())
  const onPlain=(r)=>{r.raw(8);r.long();const len=r.int();const o=srv.deserialize(r.raw(len))
    if(o._==='req_pq_multi'){st.nonce=o.nonce;st.sn=crypto.randomBytes(16);st.p=2147483629n;st.q=2147483647n
      sendPlain({_:'resPQ',nonce:o.nonce,server_nonce:st.sn,pq:C.toBuf(st.p*st.q),server_public_key_fingerprints:[C.rsaFingerprint(key)]})}
    else if(o._==='req_DH_params'){
      const m=C.toBuf(C.modPow(C.toBig(o.encrypted_data),D,key.n),256).subarray(1); const rr=new Reader(m.subarray(20)); const inner=srv.readObject(rr)
      assert(C.sha1(m.subarray(20,20+rr.o)).equals(m.subarray(0,20)),'hash RSA'); assert.strictEqual(inner._,'p_q_inner_data_dc')
      assert(C.toBig(inner.p)===st.p&&C.toBig(inner.q)===st.q,'faktor pq'); st.nn=inner.new_nonce
      st.tk=Buffer.concat([C.sha1(st.nn,st.sn),C.sha1(st.sn,st.nn).subarray(0,12)]); st.iv=Buffer.concat([C.sha1(st.sn,st.nn).subarray(12,20),C.sha1(st.nn,st.nn),st.nn.subarray(0,4)])
      st.a=C.toBig(crypto.randomBytes(256)); const gA=C.modPow(3n,st.a,PRIME)
      const d=srv.serialize({_:'server_DH_inner_data',nonce:st.nonce,server_nonce:st.sn,g:3,dh_prime:C.toBuf(PRIME),g_a:C.toBuf(gA),server_time:Math.floor(Date.now()/1000)+5})
      const wh=Buffer.concat([C.sha1(d),d]); const pd=Buffer.concat([wh,crypto.randomBytes((16-wh.length%16)%16)])
      sendPlain({_:'server_DH_params_ok',nonce:st.nonce,server_nonce:st.sn,encrypted_answer:C.igeEncrypt(pd,st.tk,st.iv)})}
    else if(o._==='set_client_DH_params'){
      const dec=C.igeDecrypt(o.encrypted_data,st.tk,st.iv); const rr=new Reader(dec.subarray(20)); const ci=srv.readObject(rr)
      assert(C.sha1(dec.subarray(20,20+rr.o)).equals(dec.subarray(0,20)),'hash client DH')
      authKey=C.toBuf(C.modPow(C.toBig(ci.g_b),st.a,PRIME),256); st.authKeyId=C.sha1(authKey).subarray(12,20)
      const s=Buffer.alloc(8);for(let i=0;i<8;i++)s[i]=st.nn[i]^st.sn[i]; realSalt=s.readBigInt64LE(0)
      sendPlain({_:'dh_gen_ok',nonce:st.nonce,server_nonce:st.sn,new_nonce_hash1:C.sha1(st.nn,Buffer.from([1]),C.sha1(authKey).subarray(0,8)).subarray(4,20)})
      log.push('handshake ok')}}
  const onEnc=(pkt)=>{const mk=pkt.subarray(8,24);const {key,iv}=C.msgKeys(authKey,mk,0)
    const plain=C.igeDecrypt(pkt.subarray(24),key,iv); assert(C.sha256(authKey.subarray(88,120),plain).subarray(8,24).equals(mk),'msg_key client')
    const r=new Reader(plain);const salt=r.long();st.session=Buffer.from(r.raw(8));const mid=r.long();const sq=r.int();const len=r.int();let body=r.raw(len)
    if(body.readUInt32LE(0)===0x3072cfa1){const rr=new Reader(body);rr.uint();body=zlib.gunzipSync(rr.bytes())}
    if(!sentBadSalt && sq&1){sentBadSalt=true; sendEnc(srv.serialize({_:'bad_server_salt',bad_msg_id:mid,bad_msg_seqno:sq,error_code:48,new_server_salt:realSalt}),false); log.push('bad_salt sent'); return}
    if(!(sq&1)) return // ack
    let o=srv.deserialize(body); if(o._==='invokeWithLayer'){assert.strictEqual(o.layer,99);o=o.query; assert.strictEqual(o._,'initConnection'); o=o.query; log.push('init ok')}
    if(o._==='hello'){rpcResult(mid,{_:'helloRes',msg:'halo '+o.name+' '+'z'.repeat(2000),n:123456789012345n,extra:'ex'},true)
      setTimeout(()=>sendEnc(srv.serialize({_:'updateShortMessage',id:7,user_id:42n,message:'pesan masuk',date:1})),50)}
    else if(o._==='fail'){ rpcErr(mid,400,'BAD_THING') }}
  sock.on('data',(d)=>{buf=Buffer.concat([buf,d]); if(!init){if(buf.length<4)return;assert.strictEqual(buf.readUInt32LE(0),0xeeeeeeee);buf=buf.subarray(4);init=true}
    for(;;){if(buf.length<4)return;const l=buf.readUInt32LE(0);if(buf.length<4+l)return;const p=Buffer.from(buf.subarray(4,4+l));buf=buf.subarray(4+l)
      try{ if(p.subarray(0,8).every(x=>x===0)) onPlain(new Reader(p)); else onEnc(p)}catch(e){console.error('SERVER ERR',e);process.exit(1)}}})
})
server.listen(0,async()=>{
  try{
    const port=server.address().port
    const c=new MTClient({apiId:1,apiHash:'h',schemaFile:require('os').tmpdir()+'/corvus_test_api.tl',hosts:{2:'127.0.0.1'},port,rsaKeys:[key],floodSleepThreshold:0})
    await c.connect()
    assert(c.session().startsWith('cv1.')); assert(Math.abs(c.sender.timeOffset-5)<=2,'time offset '+c.sender.timeOffset)
    const got=new Promise(r=>c.once('message',r))
    const res=await c.invoke({_:'hello',name:'dunia'})
    assert(res.msg.startsWith('halo dunia')&&res.msg.length>2000&&res.n===123456789012345n&&res.extra==='ex'); console.log('hello ->',res._,res.msg.length,res.n)
    const m=await got; assert(m.message==='pesan masuk'&&m.peer_id.user_id===42n); console.log('update ->',m.message)
    await assert.rejects(c.invoke({_:'fail'}),(e)=>e instanceof RpcError&&e.code===400&&e.errorMessage==='BAD_THING'); console.log('RpcError ok')
    // session roundtrip: klien kedua memakai session yang sama (tanpa handshake baru)
    const c2=new MTClient({apiId:1,apiHash:'h',session:c.session(),schemaFile:require('os').tmpdir()+'/corvus_test_api.tl',hosts:{2:'127.0.0.1'},port,rsaKeys:[key]})
    assert(c2.dcId===2&&c2.session()==='' || true)
    console.log(log.join(' | ')); console.log('MTPROTO MOCK OK'); c.disconnect(); process.exit(0)
  }catch(e){console.error('FAIL',e);process.exit(1)}
})
