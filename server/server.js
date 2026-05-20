const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { createGameState, getPowerForRedCard, getPowerForBlueCard, shuffle } = require("./gameState");

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
    mode: room.mode || "normal",
  });
}

function allPlayersForReveal(gs) {
  return gs.players.map(p => ({ id: p.id, username: p.username, role: p.role, team: p.team }));
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
    ineligibleAssistants: gs.ineligibleAssistants || [],
    mode: gs.mode,
  };
}

function getPrivateInfo(gs, playerId) {
  const player = gs.players.find((p) => p.id === playerId);
  if (!player) return {};
  const info = { team: player.team, role: player.role, mode: gs.mode };

  if (player.role === "bigred") {
    const redPlayers = gs.players.filter((p) => p.team === "red");
    if (redPlayers.length === 2 && !gs.isChaos) {
      info.knownTeammates = redPlayers
        .filter((p) => p.id !== playerId)
        .map((p) => ({ id: p.id, username: p.username }));
    } else if (gs.isChaos) {
      // In chaos, KC knows all red teammates (but not double agent)
      info.knownTeammates = redPlayers
        .filter((p) => p.id !== playerId)
        .map((p) => ({ id: p.id, username: p.username, role: p.role }));
    } else {
      info.knownTeammates = [];
    }
  } else if (player.role === "red") {
    info.knownTeammates = gs.players
      .filter((p) => p.team === "red")
      .map((p) => ({ id: p.id, username: p.username, role: p.role }));
  } else if (player.role === "doubleagent") {
    // Double agent knows everyone
    info.knownTeammates = gs.players
      .filter((p) => p.id !== playerId)
      .map((p) => ({ id: p.id, username: p.username, role: p.role, team: p.team }));
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

function advanceLeader(gs) {
  let next = (gs.currentLeaderIndex + 1) % gs.leaderOrder.length;
  while (gs.eliminatedPlayers.includes(gs.leaderOrder[next].id)) {
    next = (next + 1) % gs.leaderOrder.length;
  }
  gs.currentLeaderIndex = next;
}

function computeIneligible(gs) {
  const ineligible = [];
  if (gs.prevAssistantId) ineligible.push(gs.prevAssistantId);
  if (gs.totalPlayers >= 6 && gs.prevLeaderId) ineligible.push(gs.prevLeaderId);
  return ineligible;
}

function emitGameOver(roomCode, winner, reason) {
  const room = rooms[roomCode];
  const gs = room.gameState;
  gs.winner = winner;
  gs.phase = "game_over";
  io.to(roomCode).emit("game_over", { winner, reason, allPlayers: allPlayersForReveal(gs) });
}

function checkWinConditions(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.gameState) return;
  const gs = room.gameState;

  // Double agent wins if all cards for one side are placed and they're still alive
  if (gs.isChaos) {
    const doubleAgent = gs.players.find(p => p.role === "doubleagent");
    const daAlive = doubleAgent && !gs.eliminatedPlayers.includes(doubleAgent.id);
    if (gs.blueCardsPlayed >= 5 && daAlive) {
      emitGameOver(roomCode, "doubleagent", `All Agent cards played — ${doubleAgent.username} (Double Agent) survived and wins!`);
      return;
    }
    if (gs.redCardsPlayed >= 6 && daAlive) {
      emitGameOver(roomCode, "doubleagent", `All Syndicate cards played — ${doubleAgent.username} (Double Agent) survived and wins!`);
      return;
    }
    // If DA is eliminated, normal win conditions apply
    if (gs.blueCardsPlayed >= 5) { emitGameOver(roomCode, "blue", "5 Agent cards have been played — Agents win!"); return; }
    if (gs.redCardsPlayed >= 6) { emitGameOver(roomCode, "red", "6 Syndicate cards have been played — Syndicate wins!"); return; }
  } else {
    if (gs.blueCardsPlayed >= 5) { emitGameOver(roomCode, "blue", "5 Agent cards have been played — Agents win!"); return; }
    if (gs.redCardsPlayed >= 6) { emitGameOver(roomCode, "red", "6 Syndicate cards have been played — Syndicate wins!"); return; }
  }
}

function resolveCardPlayed(roomCode, card) {
  const room = rooms[roomCode];
  const gs = room.gameState;

  // King Crimson win condition: 3+ red cards on table BEFORE this round
  const bigRed = gs.players.find((p) => p.role === "bigred");
  if (gs.redCardsBeforeThisRound >= 3 && gs.nominee?.id === bigRed?.id) {
    emitGameOver(roomCode, "red", "King Crimson was the assistant with 3+ Syndicate cards already in play — Syndicate wins!");
    broadcastGameState(roomCode);
    return;
  }

  checkWinConditions(roomCode);
  if (gs.phase === "game_over") { broadcastGameState(roomCode); return; }

  // Check red card powers
  if (card === "red") {
    const power = getPowerForRedCard(gs.redCardsPlayed, gs.totalPlayers);
    if (power) {
      gs.phase = "power";
      gs.pendingPower = { type: power };
      const leader = gs.leaderOrder[gs.currentLeaderIndex];
      if (power === "peek") {
        const peekCards = gs.deck.slice(0, 3);
        io.to(leader.id).emit("power_peek", { cards: peekCards });
        io.to(roomCode).emit("chat_msg", { system: true, text: `A power was triggered! ${leader.username} is secretly examining the top 3 cards of the deck.` });
        broadcastGameState(roomCode);
        return;
      }
      const msgs = {
        eliminate: `A power was triggered! ${leader.username} must eliminate a player.`,
        investigate: `A power was triggered! ${leader.username} is secretly investigating a player.`,
        pick_leader: `A power was triggered! ${leader.username} gets to choose the next leader.`,
      };
      io.to(roomCode).emit("chat_msg", { system: true, text: msgs[power] });
      broadcastGameState(roomCode);
      return;
    }
  }

  // Check blue card powers (chaos mode only)
  if (card === "blue" && gs.isChaos) {
    const power = getPowerForBlueCard(gs.blueCardsPlayed, gs.isChaos);
    if (power) {
      gs.phase = "power";
      gs.pendingPower = { type: power };
      const leader = gs.leaderOrder[gs.currentLeaderIndex];
      const msgs = {
        chaos_investigate: `A power was triggered! ${leader.username} is secretly investigating a player.`,
        chaos_interrogate: `A power was triggered! ${leader.username} is interrogating a player.`,
      };
      io.to(roomCode).emit("chat_msg", { system: true, text: msgs[power] });
      broadcastGameState(roomCode);
      return;
    }
  }

  finishRound(roomCode, false);
}

function finishRound(roomCode, pickLeaderUsed) {
  const room = rooms[roomCode];
  const gs = room.gameState;

  if (!pickLeaderUsed) {
    gs.prevLeaderId = gs.leaderOrder[gs.currentLeaderIndex].id;
    gs.prevAssistantId = gs.nominee ? gs.nominee.id : null;
  }

  if (!pickLeaderUsed) {
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
  gs.pendingInvestigateResult = null;
  gs.redCardsBeforeThisRound = 0;
  gs.blueCardsBeforeThisRound = 0;
  gs.ineligibleAssistants = computeIneligible(gs);
  checkAndReshuffle(gs, roomCode);
  broadcastGameState(roomCode);
}

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("create_room", ({ username }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = { players: [], gameStarted: false, gameState: null, mode: "normal" };
    rooms[roomCode].players.push({ id: socket.id, username });
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.username = username;
    socket.emit("room_created", { roomCode });
    broadcastLobby(roomCode);
  });

  socket.on("join_room", ({ username, roomCode }) => {
    const room = rooms[roomCode];
    if (!room) { socket.emit("error_msg", { message: "Room not found." }); return; }
    if (room.gameStarted) { socket.emit("error_msg", { message: "Game already in progress." }); return; }
    if (room.players.length >= 10) { socket.emit("error_msg", { message: "Room is full (max 10 players)." }); return; }
    room.players.push({ id: socket.id, username });
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.username = username;
    socket.emit("room_joined", { roomCode });
    broadcastLobby(roomCode);
  });

  // Host can toggle mode before game starts
  socket.on("set_mode", ({ mode }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.gameStarted) return;
    if (room.players[0].id !== socket.id) return;
    room.mode = mode;
    broadcastLobby(roomCode);
  });

  socket.on("start_game", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (room.players.length < 5) { socket.emit("error_msg", { message: "Need at least 5 players to start." }); return; }
    if (room.players[0].id !== socket.id) { socket.emit("error_msg", { message: "Only the host can start the game." }); return; }
    room.gameStarted = true;
    room.gameState = createGameState(room.players, room.mode || "normal");
    room.players.forEach((player) => {
      io.to(player.id).emit("game_started", {
        publicState: getPublicState(room.gameState),
        privateInfo: getPrivateInfo(room.gameState, player.id),
      });
    });
  });

  socket.on("nominate", ({ nomineeId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const currentLeader = gs.leaderOrder[gs.currentLeaderIndex];
    if (currentLeader.id !== socket.id) { socket.emit("error_msg", { message: "You are not the current leader." }); return; }
    if (gs.phase !== "nominate") { socket.emit("error_msg", { message: "Not in nomination phase." }); return; }
    if (gs.ineligibleAssistants.includes(nomineeId)) { socket.emit("error_msg", { message: "That player is ineligible this round." }); return; }
    const nominee = gs.players.find((p) => p.id === nomineeId && !gs.eliminatedPlayers.includes(nomineeId));
    if (!nominee) { socket.emit("error_msg", { message: "Invalid nominee." }); return; }
    gs.nominee = nominee;
    gs.phase = "vote";
    gs.votes = {};
    broadcastGameState(roomCode);
    io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} nominated ${nominee.username} as assistant.` });
  });

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
        // King Crimson auto-win: elected assistant with 3+ red cards already on table
        const bigRed = gs.players.find((p) => p.role === "bigred");
        if (gs.redCardsPlayed >= 3 && gs.nominee?.id === bigRed?.id) {
          emitGameOver(roomCode, "red", "King Crimson was elected assistant with 3+ Syndicate cards in play — Syndicate wins!");
          broadcastGameState(roomCode);
          return;
        }
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
    gs.redCardsBeforeThisRound = gs.redCardsPlayed;
    gs.blueCardsBeforeThisRound = gs.blueCardsPlayed;
    gs.playedCards.push(card);
    if (card === "blue") gs.blueCardsPlayed++;
    else gs.redCardsPlayed++;
    gs.discardPile.push(otherCard);
    gs.drawnCards = [];
    io.to(roomCode).emit("chat_msg", { system: true, text: `${gs.nominee.username} played a ${card.toUpperCase()} card.` });
    resolveCardPlayed(roomCode, card);
  });

  // POWER: PEEK — leader clicks Done to finish round
  socket.on("power_peek_done", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const currentLeader = gs.leaderOrder[gs.currentLeaderIndex];
    if (currentLeader.id !== socket.id) return;
    if (gs.phase !== "power" || gs.pendingPower?.type !== "peek") return;
    finishRound(roomCode, false);
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

    if (target.role === "bigred") {
      io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} eliminated ${target.username} — they were King Crimson! Agents win!` });
      emitGameOver(roomCode, "blue", `${target.username} was King Crimson! Agents win!`);
      broadcastGameState(roomCode);
      return;
    }
    if (target.role === "doubleagent") {
      io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} eliminated ${target.username} — they were the Double Agent! Their cover is blown.` });
      io.to(roomCode).emit("double_agent_revealed", { username: target.username });
    } else {
      io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} eliminated ${target.username}. Their identity remains secret.` });
    }
    finishRound(roomCode, false);
  });

  // POWER: INVESTIGATE (normal mode — reveals red or blue)
  // Leader picks target, result is sent privately, leader clicks Done to finish round
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
    // King Crimson and red both show as "red"
    const revealedTeam = target.team === "blue" ? "blue" : "red";
    socket.emit("power_investigate_result", { username: target.username, result: revealedTeam, mode: "normal" });
    io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} secretly investigated ${target.username}.` });
    // Store that we're waiting for leader to dismiss before finishing round
    gs.pendingInvestigateResult = true;
    broadcastGameState(roomCode);
  });

  // POWER: CHAOS INVESTIGATE (chaos mode — reveals "blue" or "not blue")
  socket.on("power_chaos_investigate", ({ targetId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const currentLeader = gs.leaderOrder[gs.currentLeaderIndex];
    if (currentLeader.id !== socket.id) { socket.emit("error_msg", { message: "You are not the current leader." }); return; }
    const validPowers = ["chaos_investigate", "chaos_interrogate"];
    if (gs.phase !== "power" || !validPowers.includes(gs.pendingPower?.type)) { socket.emit("error_msg", { message: "No investigation power active." }); return; }
    const target = gs.players.find((p) => p.id === targetId && !gs.eliminatedPlayers.includes(targetId));
    if (!target) { socket.emit("error_msg", { message: "Invalid target." }); return; }

    const isBlue = target.role === "blue";
    const result = isBlue ? "blue" : "not blue";

    // Interrogate: if double agent, eliminate them and reveal
    if (gs.pendingPower.type === "chaos_interrogate" && target.role === "doubleagent") {
      gs.eliminatedPlayers.push(targetId);
      socket.emit("power_investigate_result", { username: target.username, result: "double agent", mode: "chaos_interrogate" });
      io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} interrogated ${target.username} — they were the Double Agent! Eliminated and revealed!` });
      io.to(roomCode).emit("double_agent_revealed", { username: target.username });
      gs.pendingInvestigateResult = true;
      broadcastGameState(roomCode);
      return;
    }

    socket.emit("power_investigate_result", { username: target.username, result, mode: "chaos" });
    io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} secretly investigated ${target.username}.` });
    gs.pendingInvestigateResult = true;
    broadcastGameState(roomCode);
  });

  // Leader dismisses investigate result — finish the round
  socket.on("power_investigate_done", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const currentLeader = gs.leaderOrder[gs.currentLeaderIndex];
    if (currentLeader.id !== socket.id) return;
    if (!gs.pendingInvestigateResult) return;
    finishRound(roomCode, false);
  });

  // POWER: PICK LEADER
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
    let clockwiseNext = (gs.currentLeaderIndex + 1) % gs.leaderOrder.length;
    while (gs.eliminatedPlayers.includes(gs.leaderOrder[clockwiseNext].id)) {
      clockwiseNext = (clockwiseNext + 1) % gs.leaderOrder.length;
    }
    gs.clockwiseResumeIndex = clockwiseNext;
    gs.currentLeaderIndex = targetIndex;
    gs.prevLeaderId = currentLeader.id;
    gs.prevAssistantId = gs.nominee ? gs.nominee.id : null;
    io.to(roomCode).emit("chat_msg", { system: true, text: `${currentLeader.username} chose ${target.username} as the next leader.` });
    gs.phase = "nominate";
    gs.nominee = null;
    gs.votes = {};
    gs.drawnCards = [];
    gs.failedVoteCounter = 0;
    gs.pendingPower = null;
    gs.pendingInvestigateResult = null;
    gs.redCardsBeforeThisRound = 0;
    gs.blueCardsBeforeThisRound = 0;
    gs.ineligibleAssistants = computeIneligible(gs);
    checkAndReshuffle(gs, roomCode);
    broadcastGameState(roomCode);
  });

  socket.on("chat_msg", ({ text }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    io.to(roomCode).emit("chat_msg", { system: false, username: socket.data.username, text });
  });

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