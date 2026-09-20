import express from "express";
import http from "http";
import crypto from "crypto";
import { WebSocketServer } from "ws";

import {
  cert,
  getApps,
  initializeApp
} from "firebase-admin/app";

import {
  getAuth
} from "firebase-admin/auth";


// ======================================================
// CONFIG
// ======================================================

const PORT =
  Number(process.env.PORT) || 3000;


// Firebase Admin credentials
//
// Railway Variables:
//
// FIREBASE_PROJECT_ID
// FIREBASE_CLIENT_EMAIL
// FIREBASE_PRIVATE_KEY
//
// Never put the private key in frontend code.
//

if (!process.env.FIREBASE_PROJECT_ID) {
  console.warn(
    "WARNING: FIREBASE_PROJECT_ID is missing"
  );
}

if (!process.env.FIREBASE_CLIENT_EMAIL) {
  console.warn(
    "WARNING: FIREBASE_CLIENT_EMAIL is missing"
  );
}

if (!process.env.FIREBASE_PRIVATE_KEY) {
  console.warn(
    "WARNING: FIREBASE_PRIVATE_KEY is missing"
  );
}


// ======================================================
// FIREBASE ADMIN
// ======================================================

let firebaseAuth = null;

try {

  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {

    const privateKey =
      process.env.FIREBASE_PRIVATE_KEY
        .replace(/\\n/g, "\n");


    const firebaseApp =
      getApps().length
        ? getApps()[0]
        : initializeApp({
            credential: cert({
              projectId:
                process.env.FIREBASE_PROJECT_ID,

              clientEmail:
                process.env.FIREBASE_CLIENT_EMAIL,

              privateKey
            })
          });


    firebaseAuth =
      getAuth(firebaseApp);


    console.log(
      "Firebase Admin initialized"
    );

  } else {

    console.warn(
      "Firebase Admin is NOT configured."
    );

  }

} catch (error) {

  console.error(
    "Firebase Admin initialization failed:",
    error.message
  );
}


// ======================================================
// EXPRESS
// ======================================================

const app = express();

app.disable("x-powered-by");

app.get("/", (_req, res) => {

  res.json({
    name: "MG World Server",
    status: "online",
    players: players.size,
    time: Date.now()
  });

});


app.get("/health", (_req, res) => {

  res.json({
    status: "ok",
    players: players.size
  });

});


// ======================================================
// HTTP SERVER
// ======================================================

const httpServer =
  http.createServer(app);


// ======================================================
// WEBSOCKET
// ======================================================

const wss =
  new WebSocketServer({
    server: httpServer,

    maxPayload: 16 * 1024
  });


// ======================================================
// WORLD
// ======================================================

const players =
  new Map();


// ======================================================
// LIMITS
// ======================================================

const MAX_USERNAME_LENGTH = 20;

const MAX_CHAT_LENGTH = 300;

const MAX_COORDINATE = 100000;

const MOVEMENT_INTERVAL = 50;


// ======================================================
// HELPERS
// ======================================================

function send(ws, data) {

  if (
    ws.readyState === ws.OPEN
  ) {

    ws.send(
      JSON.stringify(data)
    );

  }

}


function broadcast(
  data,
  except = null
) {

  const message =
    JSON.stringify(data);


  for (
    const player of players.values()
  ) {

    if (
      player === except
    ) {
      continue;
    }


    if (
      player.ws.readyState === player.ws.OPEN
    ) {

      player.ws.send(message);

    }

  }

}


function publicPlayer(player) {

  return {

    id: player.id,

    uid: player.uid,

    username: player.username,

    x: player.x,

    y: player.y,

    z: player.z,

    rotation: player.rotation,

    online: true

  };

}


// ======================================================
// AUTHENTICATION
// ======================================================

async function verifyToken(token) {

  if (!firebaseAuth) {

    throw new Error(
      "Firebase Admin is not configured"
    );

  }


  if (
    typeof token !== "string" ||
    token.length < 20
  ) {

    throw new Error(
      "Invalid Firebase token"
    );

  }


  return await firebaseAuth.verifyIdToken(
    token
  );

}


// ======================================================
// CONNECTION
// ======================================================

wss.on(
  "connection",
  (ws, request) => {

    const player = {

      id:
        crypto.randomUUID(),

      uid: null,

      username: "Player",

      x: 0,

      y: 0,

      z: 0,

      rotation: 0,

      ws,

      authenticated: false,

      joined: false,

      lastMove: 0,

      connectedAt: Date.now()

    };


    players.set(
      player.id,
      player
    );


    console.log(
      "Connection:",
      player.id
    );


    // --------------------------------------------------
    // INITIAL CONNECTION
    // --------------------------------------------------

    send(ws, {

      type: "connection:ready",

      playerId:
        player.id

    });


    // --------------------------------------------------
    // MESSAGE
    // --------------------------------------------------

    ws.on(
      "message",
      async (raw) => {

        try {

          const message =
            JSON.parse(
              raw.toString()
            );


          await handleMessage(
            player,
            message
          );

        } catch (error) {

          console.error(
            "Message error:",
            error.message
          );


          send(ws, {

            type: "error",

            message:
              "Invalid request"

          });

        }

      }
    );


    // --------------------------------------------------
    // CLOSE
    // --------------------------------------------------

    ws.on(
      "close",
      () => {

        handleDisconnect(
          player
        );

      }
    );


    // --------------------------------------------------
    // ERROR
    // --------------------------------------------------

    ws.on(
      "error",
      (error) => {

        console.error(
          "WebSocket error:",
          error.message
        );

      }
    );

  }
);


// ======================================================
// MESSAGE ROUTER
// ======================================================

async function handleMessage(
  player,
  message
) {

  if (
    !message ||
    typeof message.type !== "string"
  ) {

    return;

  }


  switch (message.type) {

    case "auth":

      await handleAuth(
        player,
        message
      );

      break;


    case "player:join":

      await handleJoin(
        player,
        message
      );

      break;


    case "player:move":

      handleMovement(
        player,
        message
      );

      break;


    case "chat":

      handleChat(
        player,
        message
      );

      break;


    case "ping":

      send(player.ws, {

        type: "pong",

        time: Date.now()

      });

      break;


    default:

      send(player.ws, {

        type: "error",

        message:
          "Unknown message type"

      });

  }

}


// ======================================================
// AUTH
// ======================================================

async function handleAuth(
  player,
  message
) {

  if (
    player.authenticated
  ) {

    return;

  }


  const token =
    message.token;


  try {

    const decoded =
      await verifyToken(
        token
      );


    player.uid =
      decoded.uid;


    player.authenticated =
      true;


    send(player.ws, {

      type: "auth:success",

      uid:
        player.uid

    });


    console.log(
      "Authenticated:",
      player.uid
    );


  } catch (error) {

    console.error(
      "Authentication failed:",
      error.message
    );


    send(player.ws, {

      type: "auth:failed",

      message:
        "Firebase authentication failed"

    });


    player.ws.close(
      1008,
      "Authentication failed"
    );

  }

}


// ======================================================
// JOIN WORLD
// ======================================================

async function handleJoin(
  player,
  message
) {

  if (
    !player.authenticated
  ) {

    send(player.ws, {

      type: "error",

      message:
        "Authenticate first"

    });

    return;

  }


  if (
    player.joined
  ) {

    return;

  }


  const username =
    String(
      message.username || "Player"
    )
    .trim()
    .slice(
      0,
      MAX_USERNAME_LENGTH
    );


  player.username =
    username || "Player";


  // Optional spawn position

  player.x =
    safeNumber(
      message.x,
      0
    );

  player.y =
    safeNumber(
      message.y,
      0
    );

  player.z =
    safeNumber(
      message.z,
      0
    );

  player.rotation =
    safeNumber(
      message.rotation,
      0
    );


  player.joined =
    true;


  // ----------------------------------------------------
  // Send existing world to this player
  // ----------------------------------------------------

  send(player.ws, {

    type: "world:init",

    playerId:
      player.id,

    players:
      [...players.values()]
        .filter(
          p =>
            p.joined &&
            p !== player
        )
        .map(publicPlayer)

  });


  // ----------------------------------------------------
  // Notify other players
  // ----------------------------------------------------

  broadcast({

    type: "player:join",

    player:
      publicPlayer(player)

  }, player);


  console.log(
    `${player.username} joined`
  );

}


// ======================================================
// MOVEMENT
// ======================================================

function handleMovement(
  player,
  message
) {

  if (
    !player.authenticated ||
    !player.joined
  ) {

    return;

  }


  const now =
    Date.now();


  // Basic packet-rate protection

  if (
    now - player.lastMove <
    MOVEMENT_INTERVAL
  ) {

    return;

  }


  player.lastMove =
    now;


  const x =
    Number(message.x);

  const y =
    Number(message.y);

  const z =
    Number(message.z);

  const rotation =
    Number(message.rotation);


  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  ) {

    return;

  }


  if (
    Math.abs(x) >
      MAX_COORDINATE ||

    Math.abs(y) >
      MAX_COORDINATE ||

    Math.abs(z) >
      MAX_COORDINATE
  ) {

    return;

  }


  player.x = x;

  player.y = y;

  player.z = z;


  if (
    Number.isFinite(rotation)
  ) {

    player.rotation =
      rotation;

  }


  broadcast({

    type: "player:move",

    player:
      publicPlayer(player)

  }, player);

}


// ======================================================
// CHAT
// ======================================================

function handleChat(
  player,
  message
) {

  if (
    !player.authenticated ||
    !player.joined
  ) {

    return;

  }


  const text =
    String(
      message.text || ""
    )
    .trim()
    .slice(
      0,
      MAX_CHAT_LENGTH
    );


  if (!text) {
    return;
  }


  broadcast({

    type: "chat",

    playerId:
      player.id,

    username:
      player.username,

    text

  });

}


// ======================================================
// DISCONNECT
// ======================================================

function handleDisconnect(
  player
) {

  if (
    player.joined
  ) {

    broadcast({

      type: "player:leave",

      id:
        player.id,

      uid:
        player.uid

    }, player);

  }


  players.delete(
    player.id
  );


  console.log(
    "Disconnected:",
    player.username,
    player.uid
  );

}


// ======================================================
// NUMBER SAFETY
// ======================================================

function safeNumber(
  value,
  fallback
) {

  const number =
    Number(value);


  if (
    Number.isFinite(number)
  ) {

    return number;

  }


  return fallback;

}


// ======================================================
// SERVER START
// ======================================================

httpServer.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `MG World server running on port ${PORT}`
    );

  }
);