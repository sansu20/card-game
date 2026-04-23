const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { createGameState, getPowerForRedCard, shuffle } = require("./gameState");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "../client")));

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

function getPublicState(gs) {
  return {
    currentLeaderIndex: gs.currentLeaderIndex,
    leaderOrder: gs.leaderOrder.map((p) => ({ id: p.id, username: p.username })),
    blueCardsPlayed: gs.blueCardsPlayed,
    redCardsPlayed: gs.redCardsPlayed,
    failedVoteCounter: gs.failedVoteCounter,
    cardsRemaining: gs.deck.length,
    discardCount: gs.discardPile.length,
    playedCards: gs.playedCards,
    eliminatedPlayers: gs.eliminatedPlayers,
    phase: gs.phase,
    pendingPower: gs.pendingPower ? { type: gs.pendingPower.type } : null,
    nominee: gs.nominee ? { id: gs.nominee.id, username: gs.nominee.username } : null,
    votes: gs.votes,
    winner: gs.winner || null,
    totalPlayers: gs.totalPlayers,
    // Send ineligible IDs so client can grey them out
    ineligibleAssistants: gs.ineligibleAssistants || [],
  };
}

function getPrivateInfo(gs, playerId) {
  const player = gs.players.find((p) => p.id === playerId);
  if (!player) return {};
  const info = { team: player.team, role: player.role };
  if (player.role === "bigred") {
    const redPlayers = gs.players.filter((p) => p.team === "red");
    if (redPlayers.length === 2) {
      info.knownTeammates = redPlayers
        .filter((p) => p.id !== playerId)
        .map((p) => ({ id: p.id, username: p.username }));
    } else {
      info.knownTeammates = [];
    }
  } else if (player.role === "red") {
    info.knownTeammates = gs.players
      .filter((p) => p.team === "red")
      .map((p) => ({ id: p.id, username: p.username, role: p.role }));
  } else {
    info.knownTeammates = [];
  }
  return info;
}

function broadcastGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.gameState) return;
  const gs = room.gameState;
  io.to(roomCode).emit("state_update", { publicState: getPublicState(gs) });
  room.players.forEach((player) => {
    io.to(player.id).emit("private_update", { privateInfo: getPrivateInfo(gs, player.id) });
  });
}

function checkAndReshuffle(gs, roomCode) {
  if (gs.deck.length <= 2 && gs.discardPile.length > 0) {
    gs.deck = shuffle([...gs.deck, ...gs.discardPile]);
    gs.discardPile = [];
    io.to(roomCode).emit("chat_msg", { system: true, text: `Deck was running low — discard pile shuffled back in! (${gs.deck.length} cards)` });
  }
}

// Advance clockwise, skipping eliminated players
function advanceLeader(gs) {
  let next = (gs.currentLeaderIndex + 1) % gs.leaderOrder.length;
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
    gs.winner = "blue"; gs.phase = "game_over";
    io.to(roomCode).emit("game_over", { winner: "blue", reason: "5 Agent cards have been played — Agents win!" });
  } else if (gs.redCardsPlayed >= 6) {
    gs.winner = "red"; gs.phase = "game_over";
    io.to(roomCode).emit("game_over", { winner: "red", reason: "6 Syndicate cards have been played — Syndicate wins!" });
  }
}

// Compute which players are ineligible to be nominated as assistant this round.
// For 5 players: only previous assistant is ineligible.
// For 6+ players: previous leader AND previous assistant are both ineligible.
function computeIneligible(gs) {
  const ineligible = [];
  if (gs.prevAssistantId) ineligible.push(gs.prevAssistantId);
  if (gs.totalPlayers >= 6 && gs.prevLeaderId) ineligible.push(gs.prevLeaderId);
  // Also always exclude eliminated players (handled in UI separately)
  return ineligible;
}

function resolveCardPlayed(roomCode, playedCard) {
  const room = rooms[roomCode];
  const gs = room.gameState;

  // Big Red win condition: 3+ red cards must have been on the table BEFORE this card was played.
  // gs.redCardsBeforeThisRound is captured in the assistant_play handler before incrementing.
  const bigRed = gs.players.find((p) => p.role === "bigred");
  if (gs.redCardsBeforeThisRound >= 3 && gs.nominee?.id === bigRed?.id) {
    gs.winner = "red"; gs.phase = "game_over";
    io.to(roomCode).emit("game_over", { winner: "red", reason: "King Crimson was the assistant with 3+ Syndicate cards already in play — Syndicate wins!" });
    broadcastGameState(roomCode);
    return;
  }

  checkWinConditions(roomCode);
  if (gs.phase === "game_over") { broadcastGameState(roomCode); return; }

  // Check if a red card power triggers
  if (playedCard === "red") {
    const power = getPowerForRedCard(gs.redCardsPlayed, gs.totalPlayers);
    if (power) {
      gs.phase = "power";
      gs.pendingPower = { type: power };
      const currentLeader = gs.leaderOrder[gs.currentLeaderIndex];

      if (power === "peek") {
        const peekCards = gs.deck.slice(0, 3);
        io.to(currentLeader.id).emit("power_peek", { cards: peekCards });
        io.to(roomCode).emit("chat_msg", { system: true, text: `A power was triggered! ${currentLeader.username} is secretly examining the top 3 cards of the deck.` });
        finishRound(roomCode, false);
        return;
      }

      const powerMessages = {
        eliminate: `A power was triggered! ${currentLeader.username} must eliminate a player.`,
        investigate: `A power was triggered! ${currentLeader.username} is secretly investigating a player's identity.`,
        pick_leader: `A power was triggered! ${currentLeader.username} gets to choose the next leader.`,
      };
      io.to(roomCode).emit("chat_msg", { system: true, text: powerMessages[power] });
      broadcastGameState(roomCode);
      return;
    }
  }

  finishRound(roomCode, false);
}

// finishRound: advance clockwise as normal.
// pickLeaderOverride: if true, currentLeaderIndex has already been set to the picked player,
// so we DON'T advance — but we DO store the clockwise position so next round continues correctly.
function finishRound(roomCode, pickLeaderUsed) {
  const room = rooms[roomCode];
  const gs = room.gameState;

  // Store term limits (pick_leader handler sets these itself)
  if (!pickLeaderUsed) {
    gs.prevLeaderId = gs.leaderOrder[gs.currentLeaderIndex].id;
    gs.prevAssistantId = gs.nominee ? gs.nominee.id : null;
  }

  if (!pickLeaderUsed) {
    // If resuming after a pick_leader turn, continue from the stored clockwise position
    if (gs.clockwiseResumeIndex !== null) {
      gs.currentLeaderIndex = gs.clockwiseResumeIndex;
      gs.clockwiseResumeIndex = null;
      while (gs.eliminatedPlayers.includes(gs.leaderOrder[gs.currentLeaderIndex].id)) {
        gs.currentLeaderIndex = (gs.currentLeaderIndex + 1) % gs.leaderOrder.length;
      }
    } else {
      advanceLeader(gs);
    }
  }

  gs.phase = "nominate";
  gs.nominee = null;
  gs.votes = {};
  gs.drawnCards = [];
  gs.failedVoteCounter = 0;
  gs.pendingPower = null;
  gs.redCardsBeforeThisRound = 0;
  gs.ineligibleAssistants = computeIneligible(gs);
  checkAndReshuffle(gs, roomCode);
  broadcastGameState(roomCode);
}

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // CREATE ROOM
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
  });

  // JOIN ROOM
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
  });

  // START GAME
  socket.on("start_game", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (room.players.length < 5) { socket.emit("error_msg", { message: "Need at least 5 players to start." }); return; }
    if (room.players[0].id !== socket.id) { socket.emit("error_msg", { message: "Only the host can start the game." }); return; }
    room.gameStarted = true;
    room.gameState = createGameState(room.players);
    room.players.forEach((player) => {
      io.to(player.id).emit("game_started", {
        publicState: getPublicState(room.gameState),
        privateInfo: getPrivateInfo(room.gameState, player.id),
      });
    });
  });

  // NOMINATE
  socket.on("nominate", ({ nomineeId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const currentLeader = gs.leaderOrder[gs.currentLeaderIndex];
    if (currentLeader.id !== socket.id) { socket.emit("error_msg", { message: "You are not the current leader." }); return; }
    if (gs.phase !== "nominate") { socket.emit("error_msg", { message: "Not in nomination phase." }); return; }

    // Check eligibility
    if (gs.ineligibleAssistants.includes(nomineeId)) {
      socket.emit("error_msg", { message: "That player is ineligible to be assistant this round." }); return;
    }
    const nominee = gs.players.find((p) => p.id === nomineeId && !gs.eliminatedPlayers.includes(nomineeId));
    if (!nominee) { socket.emit("error_msg", { message: "Invalid nominee." }); return; }

    gs.nominee = nominee;
    gs.phase = "vote";
    gs.votes = {};
    broadcastGameState(roomCode);
    io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} nominated ${nominee.username} as assistant.` });
  });

  // VOTE
  socket.on("vote", ({ approve }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (gs.phase !== "vote") { socket.emit("error_msg", { message: "Not in voting phase." }); return; }
    if (gs.eliminatedPlayers.includes(socket.id)) { socket.emit("error_msg", { message: "You have been eliminated." }); return; }
    gs.votes[socket.id] = approve;
    const activePlayers = gs.players.filter((p) => !gs.eliminatedPlayers.includes(p.id));
    if (Object.keys(gs.votes).length >= activePlayers.length) {
      const yesVotes = Object.values(gs.votes).filter(Boolean).length;
      const passed = yesVotes > activePlayers.length / 2;
      if (passed) {
        gs.phase = "leader_draw";
        io.to(roomCode).emit("chat_msg", { system: true, text: `Vote passed! ${gs.nominee.username} is the assistant.` });
      } else {
        gs.failedVoteCounter++;
        io.to(roomCode).emit("chat_msg", { system: true, text: `Vote failed. (${gs.failedVoteCounter}/3 failed votes)` });
        if (gs.failedVoteCounter >= 3) {
          const card = gs.deck.shift();
          gs.playedCards.push(card);
          if (card === "blue") gs.blueCardsPlayed++;
          else gs.redCardsPlayed++;
          gs.failedVoteCounter = 0;
          io.to(roomCode).emit("chat_msg", { system: true, text: `3 failed votes! Top card auto-played: ${card.toUpperCase()}.` });
          checkWinConditions(roomCode);
          if (gs.phase !== "game_over") {
            // Auto-played cards don't trigger powers or update term limits
            checkAndReshuffle(gs, roomCode);
            advanceLeader(gs);
            gs.phase = "nominate";
            gs.nominee = null;
            gs.votes = {};
          }
        } else {
          advanceLeader(gs);
          gs.phase = "nominate";
          gs.nominee = null;
          gs.votes = {};
        }
      }
      broadcastGameState(roomCode);
    } else {
      io.to(roomCode).emit("vote_update", { votesIn: Object.keys(gs.votes).length, total: activePlayers.length });
    }
  });

  // LEADER DRAWS 3 CARDS
  socket.on("leader_draw", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const currentLeader = gs.leaderOrder[gs.currentLeaderIndex];
    if (currentLeader.id !== socket.id) { socket.emit("error_msg", { message: "You are not the current leader." }); return; }
    if (gs.phase !== "leader_draw") { socket.emit("error_msg", { message: "Not in draw phase." }); return; }
    gs.drawnCards = gs.deck.splice(0, 3);
    gs.phase = "leader_discard";
    socket.emit("drawn_cards", { cards: gs.drawnCards });
    broadcastGameState(roomCode);
    io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} drew 3 cards and must discard one.` });
  });

  // LEADER DISCARDS 1 CARD
  socket.on("leader_discard", ({ discardIndex }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const currentLeader = gs.leaderOrder[gs.currentLeaderIndex];
    if (currentLeader.id !== socket.id) { socket.emit("error_msg", { message: "You are not the current leader." }); return; }
    if (gs.phase !== "leader_discard") { socket.emit("error_msg", { message: "Not in discard phase." }); return; }
    if (discardIndex < 0 || discardIndex >= gs.drawnCards.length) { socket.emit("error_msg", { message: "Invalid discard index." }); return; }
    const discarded = gs.drawnCards.splice(discardIndex, 1)[0];
    gs.discardPile.push(discarded);
    gs.phase = "assistant_play";
    const assistantSocket = io.sockets.sockets.get(gs.nominee.id);
    if (assistantSocket) assistantSocket.emit("assistant_cards", { cards: gs.drawnCards });
    broadcastGameState(roomCode);
    io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} discarded a card. ${gs.nominee.username} must choose a card to play.` });
  });

  // ASSISTANT PLAYS A CARD
  socket.on("assistant_play", ({ cardIndex }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (gs.nominee?.id !== socket.id) { socket.emit("error_msg", { message: "You are not the assistant." }); return; }
    if (gs.phase !== "assistant_play") { socket.emit("error_msg", { message: "Not in play phase." }); return; }
    if (cardIndex < 0 || cardIndex >= gs.drawnCards.length) { socket.emit("error_msg", { message: "Invalid card index." }); return; }

    const card = gs.drawnCards[cardIndex];
    const otherCard = gs.drawnCards[cardIndex === 0 ? 1 : 0];

    // Capture red card count BEFORE this card is added — used for Big Red win condition check
    gs.redCardsBeforeThisRound = gs.redCardsPlayed;

    gs.playedCards.push(card);
    if (card === "blue") gs.blueCardsPlayed++;
    else gs.redCardsPlayed++;

    gs.discardPile.push(otherCard);
    gs.drawnCards = [];

    io.to(roomCode).emit("chat_msg", { system: true, text: `${gs.nominee.username} played a ${card.toUpperCase()} card.` });
    resolveCardPlayed(roomCode, card);
  });

  // POWER: ELIMINATE
  socket.on("power_eliminate", ({ targetId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const currentLeader = gs.leaderOrder[gs.currentLeaderIndex];
    if (currentLeader.id !== socket.id) { socket.emit("error_msg", { message: "You are not the current leader." }); return; }
    if (gs.phase !== "power" || gs.pendingPower?.type !== "eliminate") { socket.emit("error_msg", { message: "No elimination power active." }); return; }
    if (targetId === socket.id) { socket.emit("error_msg", { message: "You cannot eliminate yourself." }); return; }
    const target = gs.players.find((p) => p.id === targetId && !gs.eliminatedPlayers.includes(targetId));
    if (!target) { socket.emit("error_msg", { message: "Invalid target." }); return; }

    gs.eliminatedPlayers.push(targetId);
    io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} eliminated ${target.username}. Their identity remains secret.` });

    if (target.role === "bigred") {
      gs.winner = "blue"; gs.phase = "game_over";
      io.to(roomCode).emit("game_over", { winner: "blue", reason: `${target.username} was King Crimson! Agents win!` });
      broadcastGameState(roomCode);
      return;
    }

    finishRound(roomCode, false);
  });

  // POWER: INVESTIGATE
  socket.on("power_investigate", ({ targetId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const currentLeader = gs.leaderOrder[gs.currentLeaderIndex];
    if (currentLeader.id !== socket.id) { socket.emit("error_msg", { message: "You are not the current leader." }); return; }
    if (gs.phase !== "power" || gs.pendingPower?.type !== "investigate") { socket.emit("error_msg", { message: "No investigation power active." }); return; }
    const target = gs.players.find((p) => p.id === targetId && !gs.eliminatedPlayers.includes(targetId));
    if (!target) { socket.emit("error_msg", { message: "Invalid target." }); return; }

    // Big Red shows as "red" — never reveals "bigred"
    socket.emit("power_investigate_result", { username: target.username, team: target.team });
    io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} secretly investigated a player's identity.` });
    finishRound(roomCode, false);
  });

  // POWER: PICK LEADER
  // No term-limit restrictions apply here.
  // After the picked leader's turn, clockwise rotation resumes from the CURRENT leader's
  // position (not the picked player's), so we store the clockwise next index separately.
  socket.on("power_pick_leader", ({ targetId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const currentLeader = gs.leaderOrder[gs.currentLeaderIndex];
    if (currentLeader.id !== socket.id) { socket.emit("error_msg", { message: "You are not the current leader." }); return; }
    if (gs.phase !== "power" || gs.pendingPower?.type !== "pick_leader") { socket.emit("error_msg", { message: "No pick leader power active." }); return; }

    const targetIndex = gs.leaderOrder.findIndex((p) => p.id === targetId && !gs.eliminatedPlayers.includes(targetId));
    if (targetIndex === -1) { socket.emit("error_msg", { message: "Invalid target." }); return; }

    const target = gs.leaderOrder[targetIndex];

    // Compute what the clockwise-next index WOULD have been from the current leader.
    // After the picked leader's turn, rotation resumes from there.
    let clockwiseNext = (gs.currentLeaderIndex + 1) % gs.leaderOrder.length;
    while (gs.eliminatedPlayers.includes(gs.leaderOrder[clockwiseNext].id)) {
      clockwiseNext = (clockwiseNext + 1) % gs.leaderOrder.length;
    }
    gs.clockwiseResumeIndex = clockwiseNext;

    // Set picked player as current leader
    gs.currentLeaderIndex = targetIndex;

    io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} chose ${target.username} as the next leader.` });

    // Store term limits: the person who used pick_leader was the "prev leader",
    // and the current nominee was the "prev assistant"
    gs.prevLeaderId = currentLeader.id;
    gs.prevAssistantId = gs.nominee ? gs.nominee.id : null;

    gs.phase = "nominate";
    gs.nominee = null;
    gs.votes = {};
    gs.drawnCards = [];
    gs.failedVoteCounter = 0;
    gs.pendingPower = null;
    gs.redCardsBeforeThisRound = 0;
    gs.ineligibleAssistants = computeIneligible(gs);
    checkAndReshuffle(gs, roomCode);
    broadcastGameState(roomCode);
  });

  // CHAT
  socket.on("chat_msg", ({ text }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    io.to(roomCode).emit("chat_msg", { system: false, username: socket.data.username, text });
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    room.players = room.players.filter((p) => p.id !== socket.id);
    if (room.players.length === 0) delete rooms[roomCode];
    else broadcastLobby(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));