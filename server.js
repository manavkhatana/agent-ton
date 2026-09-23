import express from "express";
import http from "http";
import {WebSocketServer} from "ws";
import admin from "firebase-admin";

const app=express();
app.get("/",(_,res)=>res.send("MG World server online"));
app.get("/health",(_,res)=>res.json({ok:true,players:players.size}));

const server=http.createServer(app);
const wss=new WebSocketServer({server});
const players=new Map();

const projectId=process.env.FIREBASE_PROJECT_ID;
const clientEmail=process.env.FIREBASE_CLIENT_EMAIL;
const privateKey=(process.env.FIREBASE_PRIVATE_KEY||"").replace(/\\n/g,"\n");

if(!projectId||!clientEmail||!privateKey){
  console.warn("Firebase Admin env vars missing. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.");
}
const db=projectId&&clientEmail&&privateKey
  ? admin.initializeApp({credential:admin.credential.cert({projectId,clientEmail,privateKey}),databaseURL:"https://mgworld-dcf17-default-rtdb.asia-southeast1.firebasedatabase.app"}).database()
  : null;

const world={blocks:{}};
async function loadWorld(){
  if(!db)return;
  const snap=await db.ref("world/blocks").once("value");
  world.blocks=snap.val()||{};
}
async function savePlayer(p,online){
  if(!db)return;
  await db.ref(`players/${p.uid}`).update({
    uid:p.uid,username:p.username,x:p.x,y:p.y,z:p.z,rotation:p.rotation,headRotation:p.headRotation,
    grounded:p.grounded,moving:p.moving,online,lastSeen:admin.database.ServerValue.TIMESTAMP
  });
}
async function verifyUser(uid,username){
  if(!db)return true;
  const snap=await db.ref(`users/${uid}`).once("value");
  const u=snap.val();
  return !!u && u.username===username;
}
function send(ws,obj){if(ws.readyState===1)ws.send(JSON.stringify(obj))}
function broadcast(obj,except=null){
  const s=JSON.stringify(obj);
  for(const p of players.values())if(p.ws!==except&&p.ws.readyState===1)p.ws.send(s);
}
function cleanPlayer(p){
  players.delete(p.uid);
  savePlayer(p,false).catch(console.error);
  broadcast({type:"player_leave",uid:p.uid});
  broadcast({type:"count",count:players.size});
}

wss.on("connection",(ws)=>{
  let current=null;
  ws.on("message",async raw=>{
    let m;try{m=JSON.parse(raw.toString())}catch{return}
    if(m.type==="auth"){
      if(current)return;
      if(!(await verifyUser(m.uid,m.username))){
        return send(ws,{type:"error",message:"User verification failed"});
      }
      current={
        uid:m.uid,username:m.username,ws,
        x:Number(m.x)||10,y:Number(m.y)||0,z:Number(m.z)||0,
        rotation:Number(m.rotation)||0,headRotation:Number(m.headRotation)||0,
        grounded:true,moving:false
      };
      players.set(current.uid,current);
      await savePlayer(current,true);
      send(ws,{type:"init",world,players:Object.fromEntries([...players].map(([id,p])=>[id,{...p,ws:undefined}]))});
      broadcast({type:"player_join",player:{...current,ws:undefined}},ws);
      broadcast({type:"count",count:players.size});
      return;
    }
    if(!current)return;
    if(m.type==="move"){
      current.x=Number(m.x)||0;current.y=Number(m.y)||0;current.z=Number(m.z)||0;
      current.rotation=Number(m.rotation)||0;current.headRotation=Number(m.headRotation)||0;
      current.grounded=!!m.grounded;current.moving=!!m.moving;
      if(db)db.ref(`players/${current.uid}`).update({
        x:current.x,y:current.y,z:current.z,rotation:current.rotation,headRotation:current.headRotation,
        grounded:current.grounded,moving:current.moving,online:true,lastSeen:admin.database.ServerValue.TIMESTAMP
      }).catch(console.error);
      broadcast({type:"player_update",player:{...current,ws:undefined}},ws);
    }
    if(m.type==="block_set"){
      const x=Math.floor(Number(m.x)),y=Math.floor(Number(m.y)),z=Math.floor(Number(m.z));
      if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z)||y<0||y>=64)return;
      const key=`${x},${y},${z}`;
      world.blocks[key]={color:Number(m.color)||0x9b7653,by:current.uid,updatedAt:Date.now()};
      if(db)db.ref(`world/blocks/${key.replace(/\./g,"_")}`).set(world.blocks[key]).catch(console.error);
      broadcast({type:"block_set",blocks:{[key]:world.blocks[key]}});
      send(ws,{type:"world_state",blocks:{[key]:world.blocks[key]}});
    }
    if(m.type==="block_remove"){
      const key=String(m.key||"");
      if(!world.blocks[key])return;
      delete world.blocks[key];
      if(db)db.ref(`world/blocks/${key.replace(/\./g,"_")}`).remove().catch(console.error);
      broadcast({type:"block_set",blocks:world.blocks});
      send(ws,{type:"world_state",blocks:world.blocks});
    }
  });
  ws.on("close",()=>{if(current&&players.get(current.uid)===current)cleanPlayer(current)});
});

loadWorld().then(()=>{
  const port=process.env.PORT||3000;
  server.listen(port,()=>console.log(`MG World server listening on ${port}`));
}).catch(e=>{console.error(e);process.exit(1)});
