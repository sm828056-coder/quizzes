const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const QRCode = require("qrcode");
const questions = require("./questions.cjs");

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const ROOT = __dirname;
const rooms = new Map();
const LETTERS = ["A", "B", "C", "D"];

function lanAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal && isPrivateAddress(entry.address)) {
        return entry.address;
      }
    }
  }
  return "127.0.0.1";
}

function isPrivateAddress(address) {
  return address.startsWith("10.")
    || address.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

function token() {
  return randomBytes(24).toString("hex");
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const otherIndex = randomBytes(4).readUInt32BE(0) % (index + 1);
    [result[index], result[otherIndex]] = [result[otherIndex], result[index]];
  }
  return result;
}

function createQuestions() {
  return shuffle(questions).map((item) => {
    const options = shuffle(item.answers.map((text, index) => ({
      text,
      correct: index === item.correct
    })));
    return {
      category: item.category,
      question: item.question,
      answers: options.map((option) => option.text),
      correct: options.findIndex((option) => option.correct)
    };
  });
}

function publicQuestion(room) {
  const question = room.questions[room.questionIndex];
  return question ? {
    category: question.category,
    question: question.question,
    answers: question.answers
  } : null;
}

function publicRoom(room, playerToken) {
  const player = room.players.get(playerToken);
  const currentAnswer = player?.answers[room.questionIndex];
  return {
    code: room.code,
    state: room.state,
    questionIndex: room.questionIndex,
    questionCount: room.questions.length,
    question: room.state === "playing" ? publicQuestion(room) : null,
    players: [...room.players.values()]
      .map((entry) => ({
        name: entry.name,
        score: entry.score,
        isHost: entry.isHost,
        hasAnswered: room.state === "playing" && entry.answers[room.questionIndex] !== undefined
      }))
      .sort((a, b) => Number(b.isHost) - Number(a.isHost) || b.score - a.score || a.name.localeCompare(b.name)),
    answer: currentAnswer === undefined ? null : {
      index: currentAnswer,
      correct: currentAnswer === room.questions[room.questionIndex]?.correct,
      points: currentAnswer === room.questions[room.questionIndex]?.correct ? 10 : 0
    },
    responseCount: [...room.players.values()]
      .filter((entry) => entry.answers[room.questionIndex] !== undefined).length,
    results: room.state === "finished"
      ? [...room.players.values()]
        .map((entry) => ({ name: entry.name, score: entry.score, isHost: entry.isHost }))
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      : null
  };
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

function errorResponse(response, status, message) {
  sendJson(response, status, { error: message });
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8192) {
      throw Object.assign(new Error("Request body is too large."), { status: 413 });
    }
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

function getRoom(request, response, code) {
  const room = rooms.get(code);
  if (!room) {
    errorResponse(response, 404, "That game was not found. Ask the host for a current room code.");
    return null;
  }
  room.lastActivity = Date.now();
  return room;
}

function requireHost(request, response, room) {
  if (request.headers["x-host-token"] !== room.hostToken) {
    errorResponse(response, 403, "Only the person who created this game can do that.");
    return false;
  }
  return true;
}

function getPlayer(request, response, room) {
  const playerToken = request.headers["x-player-token"];
  const player = room.players.get(playerToken);
  if (!player) {
    errorResponse(response, 401, "You are not in this game. Join again with the room code.");
    return null;
  }
  return { playerToken, player };
}

async function handleApi(request, response, url) {
  const segments = url.pathname.split("/").filter(Boolean);
  if (request.method === "POST" && url.pathname === "/api/rooms") {
    const data = await readJson(request);
    const name = typeof data.name === "string" ? data.name.trim().slice(0, 24) : "";
    if (!name) {
      errorResponse(response, 400, "Enter a player name before creating a game.");
      return;
    }
    let code;
    do {
      code = randomBytes(3).toString("hex").toUpperCase();
    } while (rooms.has(code));

    const hostToken = token();
    const playerToken = token();
    const room = {
      code,
      hostToken,
      state: "lobby",
      questionIndex: 0,
      questions: createQuestions(),
      players: new Map([[playerToken, {
        name,
        score: 0,
        isHost: true,
        answers: []
      }]]),
      lastActivity: Date.now()
    };
    rooms.set(code, room);
    const joinUrl = `http://${lanAddress()}:${PORT}/?room=${code}`;
    const qrCode = await QRCode.toDataURL(joinUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 240,
      color: { dark: "#101426", light: "#ffffff" }
    });
    sendJson(response, 201, {
      code,
      hostToken,
      playerToken,
      joinUrl,
      qrCode,
      room: publicRoom(room, playerToken)
    });
    return;
  }

  if (segments[0] !== "api" || segments[1] !== "rooms" || !segments[2]) {
    errorResponse(response, 404, "API route not found.");
    return;
  }

  const room = getRoom(request, response, segments[2]);
  if (!room) return;

  if (request.method === "POST" && segments[3] === "join") {
    if (room.state !== "lobby") {
      errorResponse(response, 409, "This game has already started.");
      return;
    }
    const data = await readJson(request);
    const name = typeof data.name === "string" ? data.name.trim().slice(0, 24) : "";
    if (!name) {
      errorResponse(response, 400, "Enter a player name to join.");
      return;
    }
    if ([...room.players.values()].some((player) => player.name.toLowerCase() === name.toLowerCase())) {
      errorResponse(response, 409, "That name is already in this game. Try another one.");
      return;
    }
    const playerToken = token();
    room.players.set(playerToken, { name, score: 0, isHost: false, answers: [] });
    sendJson(response, 201, { playerToken, room: publicRoom(room, playerToken) });
    return;
  }

  if (request.method === "GET" && segments.length === 3) {
    const player = getPlayer(request, response, room);
    if (!player) return;
    sendJson(response, 200, { room: publicRoom(room, player.playerToken) });
    return;
  }

  if (request.method === "POST" && segments[3] === "start") {
    if (!requireHost(request, response, room)) return;
    if (room.state !== "lobby") {
      errorResponse(response, 409, "This game has already started.");
      return;
    }
    room.state = "playing";
    room.questionIndex = 0;
    sendJson(response, 200, { room: publicRoom(room, request.headers["x-player-token"]) });
    return;
  }

  if (request.method === "POST" && segments[3] === "answer") {
    const authenticated = getPlayer(request, response, room);
    if (!authenticated) return;
    if (room.state !== "playing") {
      errorResponse(response, 409, "The quiz is not accepting answers right now.");
      return;
    }
    const data = await readJson(request);
    if (!Number.isInteger(data.answerIndex) || data.answerIndex < 0 || data.answerIndex > 3) {
      errorResponse(response, 400, "Choose one of the four answer options.");
      return;
    }
    if (authenticated.player.answers[room.questionIndex] !== undefined) {
      errorResponse(response, 409, "You have already answered this question.");
      return;
    }
    const correct = data.answerIndex === room.questions[room.questionIndex].correct;
    authenticated.player.answers[room.questionIndex] = data.answerIndex;
    if (correct) authenticated.player.score += 10;
    sendJson(response, 200, {
      correct,
      points: correct ? 10 : 0,
      room: publicRoom(room, authenticated.playerToken)
    });
    return;
  }

  if (request.method === "POST" && segments[3] === "next") {
    if (!requireHost(request, response, room)) return;
    if (room.state !== "playing") {
      errorResponse(response, 409, "The quiz is not in progress.");
      return;
    }
    room.questionIndex += 1;
    if (room.questionIndex >= room.questions.length) room.state = "finished";
    sendJson(response, 200, { room: publicRoom(room, request.headers["x-player-token"]) });
    return;
  }

  if (request.method === "POST" && segments[3] === "stop") {
    if (!requireHost(request, response, room)) return;
    if (room.state === "finished") {
      errorResponse(response, 409, "This game has already ended.");
      return;
    }
    room.state = "finished";
    sendJson(response, 200, { room: publicRoom(room, request.headers["x-player-token"]) });
    return;
  }

  errorResponse(response, 404, "API route not found.");
}

function serveFile(response, filePath) {
  const extension = path.extname(filePath);
  const contentType = extension === ".html"
    ? "text/html; charset=utf-8"
    : extension === ".js" || extension === ".cjs"
      ? "text/javascript; charset=utf-8"
      : "application/octet-stream";
  fs.readFile(filePath, (error, content) => {
    if (error) {
      errorResponse(response, 404, "File not found.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(request, response, url);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      console.error("Request failed:", error);
      errorResponse(response, error.status || 500, error.status ? error.message : "Something went wrong. Please try again.");
    }
    return;
  }
  if (request.method !== "GET" || (url.pathname !== "/" && url.pathname !== "/index.html")) {
    errorResponse(response, 404, "Page not found.");
    return;
  }
  serveFile(response, path.join(ROOT, "index.html"));
});

setInterval(() => {
  const expiredAt = Date.now() - 6 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.lastActivity < expiredAt) rooms.delete(code);
  }
}, 30 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Seoul Quest is ready at http://localhost:${PORT}`);
  console.log(`Players on your Wi-Fi can join at http://${lanAddress()}:${PORT}`);
  console.log("Keep this server running while the game is in progress.");
});
