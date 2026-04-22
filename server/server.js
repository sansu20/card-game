const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { createGameState } = require("./gameState");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "../client")));

// rooms[roomCode] = { players: [], gameStarted: false, gameState: null }
const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function broadcastLobby(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit("lobby_update", {
    players: room.players.map((p) => ({ id: p.id, username: p.username })),
    roomCode,
  });
}

// Returns only what every player can publicly see
function getPublicState(gs) {
  return {
    currentLeaderIndex: gs.currentLeaderIndex,
    leaderOrder: gs.leaderOrder.map((p) => ({ id: p.id, username: p.username })),
    blueCardsPlayed: gs.blueCardsPlayed,
    redCardsPlayed: gs.redCardsPlayed,
    failedVoteCounter: gs.failedVoteCounter,
    cardsRemaining: gs.deck.length,
    playedCards: gs.playedCards,
    eliminatedPlayers: gs.eliminatedPlayers,
    phase: gs.phase,
    nominee: gs.nominee ? { id: gs.nominee.id, username: gs.nominee.username } : null,
    votes: gs.votes,
    winner: gs.winner || null,
  };
}

// Returns secret role info for a specific player
function getPrivateInfo(gs, playerId) {
  const player = gs.players.find((p) => p.id === playerId);
  if (!player) return {};

  const info = {
    team: player.team,
    role: player.role, // 'bigred' | 'red' | 'blue'
  };

  if (player.role === "bigred") {
    const redPlayers = gs.players.filter((p) => p.team === "red");
    // Big Red only knows teammate if there are exactly 2 red players
    if (redPlayers.length === 2) {
      info.knownTeammates = redPlayers
        .filter((p) => p.id !== playerId)
        .map((p) => ({ id: p.id, username: p.username }));
    } else {
      info.knownTeammates = [];
    }
  } else if (player.role === "red") {
    // Regular red knows ALL red players including Big Red
    info.knownTeammates = gs.players
      .filter((p) => p.team === "red")
      .map((p) => ({ id: p.id, username: p.username, role: p.role }));
  } else {
    // Blue knows nothing
    info.knownTeammates = [];
  }

  return info;
}

function broadcastGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.gameState) return;
  const gs = room.gameState;

  // Send public state to everyone
  io.to(roomCode).emit("state_update", { publicState: getPublicState(gs) });

  // Send each player their private info (roles don't change, but re-send for reconnect safety)
  room.players.forEach((player) => {
    const privateInfo = getPrivateInfo(gs, player.id);
    io.to(player.id).emit("private_update", { privateInfo });
  });
}

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // --- CREATE ROOM ---
  socket.on("create_room", ({ username }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = { players: [], gameStarted: false, gameState: null };

    const player = { id: socket.id, username };
    rooms[roomCode].players.push(player);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.username = username;

    socket.emit("room_created", { roomCode });
    broadcastLobby(roomCode);
    console.log(`Room ${roomCode} created by ${username}`);
  });

  // --- JOIN ROOM ---
  socket.on("join_room", ({ username, roomCode }) => {
    const room = rooms[roomCode];
    if (!room) { socket.emit("error_msg", { message: "Room not found." }); return; }
    if (room.gameStarted) { socket.emit("error_msg", { message: "Game already in progress." }); return; }
    if (room.players.length >= 10) { socket.emit("error_msg", { message: "Room is full (max 10 players)." }); return; }

    const player = { id: socket.id, username };
    room.players.push(player);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.username = username;

    socket.emit("room_joined", { roomCode });
    broadcastLobby(roomCode);
    console.log(`${username} joined room ${roomCode}`);
  });

  // --- START GAME ---
  socket.on("start_game", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (room.players.length < 5) { socket.emit("error_msg", { message: "Need at least 5 players to start." }); return; }
    if (room.players[0].id !== socket.id) { socket.emit("error_msg", { message: "Only the host can start the game." }); return; }

    room.gameStarted = true;
    room.gameState = createGameState(room.players);

    // Send each player their private role info + initial public state
    room.players.forEach((player) => {
      const privateInfo = getPrivateInfo(room.gameState, player.id);
      io.to(player.id).emit("game_started", {
        publicState: getPublicState(room.gameState),
        privateInfo,
      });
    });

    console.log(`Game started in room ${roomCode}`);
  });

  // --- NOMINATE ASSISTANT ---
  socket.on("nominate", ({ nomineeId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;

    const currentLeader = gs.leaderOrder[gs.currentLeaderIndex];
    if (currentLeader.id !== socket.id) { socket.emit("error_msg", { message: "You are not the current leader." }); return; }
    if (gs.phase !== "nominate") { socket.emit("error_msg", { message: "Not in nomination phase." }); return; }

    const nominee = gs.players.find((p) => p.id === nomineeId && !gs.eliminatedPlayers.includes(nomineeId));
    if (!nominee) { socket.emit("error_msg", { message: "Invalid nominee." }); return; }

    gs.nominee = nominee;
    gs.phase = "vote";
    gs.votes = {};

    broadcastGameState(roomCode);
    io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} nominated ${nominee.username} as assistant.` });
  });

  // --- VOTE ---
  socket.on("vote", ({ approve }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;

    if (gs.phase !== "vote") { socket.emit("error_msg", { message: "Not in voting phase." }); return; }
    if (gs.eliminatedPlayers.includes(socket.id)) { socket.emit("error_msg", { message: "You have been eliminated." }); return; }

    gs.votes[socket.id] = approve;

    // Check if all active players have voted
    const activePlayers = gs.players.filter((p) => !gs.eliminatedPlayers.includes(p.id));
    if (Object.keys(gs.votes).length >= activePlayers.length) {
      const yesVotes = Object.values(gs.votes).filter(Boolean).length;
      const passed = yesVotes > activePlayers.length / 2;

      if (passed) {
        gs.phase = "leader_draw";
        io.to(roomCode).emit("chat_msg", { system: true, text: `Vote passed! ${gs.nominee.username} is the assistant. Waiting for leader to draw cards.` });
      } else {
        gs.failedVoteCounter++;
        io.to(roomCode).emit("chat_msg", { system: true, text: `Vote failed. (${gs.failedVoteCounter}/3 failed votes)` });

        if (gs.failedVoteCounter >= 3) {
          // Auto-play top card
          const card = gs.deck.shift();
          gs.playedCards.push(card);
          if (card === "blue") gs.blueCardsPlayed++;
          else gs.redCardsPlayed++;
          gs.failedVoteCounter = 0;
          io.to(roomCode).emit("chat_msg", { system: true, text: `3 failed votes! The top card was auto-played: ${card.toUpperCase()}.` });
          checkWinConditions(roomCode);
        }

        // Advance leader
        advanceLeader(gs);
        gs.phase = "nominate";
        gs.nominee = null;
        gs.votes = {};
      }
      broadcastGameState(roomCode);
    } else {
      // Just update vote count for UI
      io.to(roomCode).emit("vote_update", { votesIn: Object.keys(gs.votes).length, total: activePlayers.length });
    }
  });

  // --- LEADER DRAWS 3 CARDS ---
  socket.on("leader_draw", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;

    const currentLeader = gs.leaderOrder[gs.currentLeaderIndex];
    if (currentLeader.id !== socket.id) { socket.emit("error_msg", { message: "You are not the current leader." }); return; }
    if (gs.phase !== "leader_draw") { socket.emit("error_msg", { message: "Not in draw phase." }); return; }

    // Draw 3 cards
    gs.drawnCards = gs.deck.splice(0, 3);
    gs.phase = "leader_discard";

    // Only send drawn cards to the leader
    socket.emit("drawn_cards", { cards: gs.drawnCards });
    broadcastGameState(roomCode);
    io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} has drawn 3 cards and must discard one.` });
  });

  // --- LEADER DISCARDS 1 CARD ---
  socket.on("leader_discard", ({ discardIndex }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;

    const currentLeader = gs.leaderOrder[gs.currentLeaderIndex];
    if (currentLeader.id !== socket.id) { socket.emit("error_msg", { message: "You are not the current leader." }); return; }
    if (gs.phase !== "leader_discard") { socket.emit("error_msg", { message: "Not in discard phase." }); return; }
    if (discardIndex < 0 || discardIndex >= gs.drawnCards.length) { socket.emit("error_msg", { message: "Invalid discard index." }); return; }

    gs.drawnCards.splice(discardIndex, 1); // Remove discarded card
    gs.phase = "assistant_play";

    // Send remaining 2 cards to the assistant
    const assistantSocket = io.sockets.sockets.get(gs.nominee.id);
    if (assistantSocket) {
      assistantSocket.emit("assistant_cards", { cards: gs.drawnCards });
    }

    broadcastGameState(roomCode);
    io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} discarded a card. ${gs.nominee.username} must now choose a card to play.` });
  });

  // --- ASSISTANT PLAYS A CARD ---
  socket.on("assistant_play", ({ cardIndex }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;

    if (gs.nominee?.id !== socket.id) { socket.emit("error_msg", { message: "You are not the assistant." }); return; }
    if (gs.phase !== "assistant_play") { socket.emit("error_msg", { message: "Not in play phase." }); return; }
    if (cardIndex < 0 || cardIndex >= gs.drawnCards.length) { socket.emit("error_msg", { message: "Invalid card index." }); return; }

    const card = gs.drawnCards[cardIndex];
    gs.playedCards.push(card);
    if (card === "blue") gs.blueCardsPlayed++;
    else gs.redCardsPlayed++;

    // Put the other card back into a random position in the deck
    const otherCard = gs.drawnCards[cardIndex === 0 ? 1 : 0];
    const insertAt = Math.floor(Math.random() * (gs.deck.length + 1));
    gs.deck.splice(insertAt, 0, otherCard);

    io.to(roomCode).emit("chat_msg", { system: true, text: `${gs.nominee.username} played a ${card.toUpperCase()} card.` });

    // Check Big Red win condition (3+ red cards played and Big Red is assistant)
    const bigRed = gs.players.find((p) => p.role === "bigred");
    if (gs.redCardsPlayed >= 3 && gs.nominee.id === bigRed?.id) {
      gs.winner = "red";
      gs.phase = "game_over";
      io.to(roomCode).emit("game_over", { winner: "red", reason: "Big Red was the assistant with 3+ red cards played!" });
      broadcastGameState(roomCode);
      return;
    }

    checkWinConditions(roomCode);
    if (gs.phase !== "game_over") {
      advanceLeader(gs);
      gs.phase = "nominate";
      gs.nominee = null;
      gs.votes = {};
      gs.drawnCards = [];
      gs.failedVoteCounter = 0;
    }

    broadcastGameState(roomCode);
  });

  // --- CHAT ---
  socket.on("chat_msg", ({ text }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const username = socket.data.username;
    io.to(roomCode).emit("chat_msg", { system: false, username, text });
  });

  // --- DISCONNECT ---
  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    room.players = room.players.filter((p) => p.id !== socket.id);
    if (room.players.length === 0) {
      delete rooms[roomCode];
    } else {
      broadcastLobby(roomCode);
    }
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

function advanceLeader(gs) {
  let next = (gs.currentLeaderIndex + 1) % gs.leaderOrder.length;
  // Skip eliminated players
  while (gs.eliminatedPlayers.includes(gs.leaderOrder[next].id)) {
    next = (next + 1) % gs.leaderOrder.length;
  }
  gs.currentLeaderIndex = next;
}

function checkWinConditions(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.gameState) return;
  const gs = room.gameState;

  if (gs.blueCardsPlayed >= 5) {
    gs.winner = "blue";
    gs.phase = "game_over";
    io.to(roomCode).emit("game_over", { winner: "blue", reason: "5 blue cards have been played!" });
  } else if (gs.redCardsPlayed >= 6) {
    gs.winner = "red";
    gs.phase = "game_over";
    io.to(roomCode).emit("game_over", { winner: "red", reason: "6 red cards have been played!" });
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
