

import {WebSocketServer,WebSocket} from "ws"
import jwt from 'jsonwebtoken';
import { JwtPayload } from 'jsonwebtoken';
import 'dotenv/config';
//@ts-ignore
import { prismaClient } from "my-prisma-client";





interface User {
  ws:WebSocket,
  rooms:string[],
  userId:string,
  name?: string,
  photo?: string,
  isReadOnly?: boolean
}

const users:User[]=[];
console.log("prismaClient");
const port = process.env.PORT || 8080;
const wss=new WebSocketServer({port:Number(port)});

function checkUser(token:string):string | null{
  try{
    console.log('[WebSocket Backend] Received token:', token);
    console.log("JWT_SECRET",process.env.JWT_SECRET);
    const decoded=jwt.verify(token,process.env.JWT_SECRET || "");
    console.log('[WebSocket Backend] Decoded JWT:', decoded);
    if(typeof decoded=="string")return null;
    if(!decoded ||  !(decoded as JwtPayload).userId) return null;
    return (decoded as JwtPayload).userId;
  }catch(e){
    console.log('[WebSocket Backend] JWT verification error:', e);
    return null;
  }
  return null;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (typeof name === 'string' && name.length > 0) {
      cookies[name] = decodeURIComponent(rest.join('='));
    }
  });
  return cookies;
}

wss.on('connection',function connection(ws,request){
  
  const url=request.url;
  if(!url)return;
  const queryParams=new URLSearchParams(url.split('?')[1]);
  let token=queryParams.get('token') || "";
  const isReadOnly = queryParams.get('readonly') === '1';


  if (!token && request.headers.cookie) {
    const cookies = parseCookies(request.headers.cookie);
    token = cookies['token'] || '';
  }
  
  let userId = checkUser(token);
  if (!userId && isReadOnly) {
    userId = 'guest';
  }
  if (!userId) {
    ws.close();
    return;
  }


  const userObj: User = { userId, rooms: [], ws, isReadOnly };
  users.push(userObj);

  if (!isReadOnly && userId !== 'guest') {
    prismaClient.user.findUnique({ where: { id: userId }, select: { name: true, photo: true } })
      .then((userInfo: { name: string; photo: string | null; } | null) => {
        userObj.name = userInfo?.name;
        userObj.photo = userInfo?.photo || undefined;
      });
  }

  function broadcastPresence(roomId: string) {

    const editors = users.filter(u => u.rooms.includes(roomId) && !u.isReadOnly && u.userId !== 'guest');
 
    const unique: Record<string, { id: string, name?: string, photo?: string }> = {};
    editors.forEach(u => {
      if (!unique[u.userId]) {
        unique[u.userId] = { id: u.userId, name: u.name, photo: u.photo };
      }
    });
    const presence = Object.values(unique);
    editors.forEach(u => {
      u.ws.send(JSON.stringify({ type: 'presence', users: presence }));
    });
  }

  ws.on('message',async function message(data){
    console.log('[WebSocket Backend] Received message:', data);
   let parsedData;
   console.log(typeof data);

    if(typeof data !== "string"){
      console.log("converting to string")
      parsedData=JSON.parse(data.toString());
      console.log(parsedData);
    }else{
      parsedData=JSON.parse(data);
    }
    console.log("before join room");
    if(parsedData.type==="join_room"){
      console.log(`inside join room`);
      const user=users.find(x=> x.ws===ws);
      console.log(`validated now adding to room`);
      user?.rooms.push(String(parsedData.roomId));
      ws.send(JSON.stringify({ type: "joined_room", roomId: parsedData.roomId }));
      
      const designId = Number(parsedData.roomId);
      const messages = await prismaClient.chat.findMany({
        where: { designId },
        orderBy: { createdAt: 'asc' },
        select: { message: true },
      });
      const shapes = messages.map((m: { message: string }) => {
        try {
          const parsed = JSON.parse(m.message);
          return parsed.shape;
        } catch {
          return null;
        }
      }).filter(Boolean);
      ws.send(JSON.stringify({ type: 'history', shapes }));
      broadcastPresence(String(parsedData.roomId));
    }else{
      console.log("not join room");
    }

    if(parsedData.type==="leave_room"){
      const user=users.find(x=>x.ws===ws);
      if(!user){
        return;
      }
      user.rooms=user?.rooms.filter(x=> x===parsedData.room);
      
      broadcastPresence(String(parsedData.room));
    }

    if(parsedData.type==="chat"){
      
      const user=users.find(x=> x.ws===ws);
      if (!userId || userId === 'guest') {
        ws.send(JSON.stringify({ type: "error", message: "Read-only users cannot send messages." }));
        return;
      }
      const designId=parsedData.roomId; 
      const message=parsedData.message;

      const designExists=await prismaClient.design.findUnique({
        where:{id:Number(designId)}
      });
      
      if(!designExists){
        console.log("design doesn't exist");
        ws.send(JSON.stringify({
          type:"error",
          message:"design doesn't exist"
        }));
        return;
      }
      try {
        await prismaClient.chat.create({
          data:{
            designId:Number(designId),
            message,
            userId
          }
        });
      } catch (err) {
        console.error('[WebSocket Backend] Error creating chat:', err);
        ws.send(JSON.stringify({ type: "error", message: "Failed to save chat message." }));
        return;
      }
      console.log("after chat");
      users.forEach(user=>{
        if(user.rooms.includes(String(designId))){
          user.ws.send(JSON.stringify({
            type:"chat",
            message:message,
            roomId: designId
          })) 
        }
      })
    }
   
  });

  ws.on('close', (code, reason) => {
    console.log(`[WebSocket Backend] Connection closed. Code: ${code}, Reason: ${reason}`);

    const idx = users.findIndex(u => u.ws === ws);
    let leftUser: User | undefined = undefined;
    if (idx !== -1) {
      leftUser = users[idx];
      users.splice(idx, 1);
    }
        
    if (leftUser && leftUser.rooms) {
      leftUser.rooms.forEach(roomId => broadcastPresence(roomId));
    }
  });
});