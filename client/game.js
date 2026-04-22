const socket = io();

// ── State ──────────────────────────────────────────────────────
let myId = socket.id;
let myUsername = "";
let roomCode = "";
let publicState = null;
let privateInfo = null;
let myHand = []; // cards in hand (leader drawn or assistant cards)
let isHost = false;

// ── Helpers ────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function setError(elId, msg) {
  const el = document.getElementById(elId);
  if (el) el.textContent = msg;
}

// ── Landing Actions ────────────────────────────────────────────
function createRoom() {
  const username = document.getElementById("username-input").value.trim();
  if (!username) { setError("landing-error", "Enter your name first."); return; }
  myUsername = username;
  socket.emit("create_room", { username });
}

function joinRoom() {
  const username = document.getElementById("username-input").value.trim();
  const code = document.getElementById("room-code-input").value.trim().toUpperCase();
  if (!username) { setError("landing-error", "Enter your name first."); return; }
  if (!code) { setError("landing-error", "Enter a room code."); return; }
  myUsername = username;
  socket.emit("join_room", { username, roomCode: code });
}

// ── Lobby Actions ──────────────────────────────────────────────
function startGame() {
  socket.emit("start_game");
}

function sendChat() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("chat_msg", { text });
  input.value = "";
}

// ── Socket Events ──────────────────────────────────────────────
socket.on("connect", () => { myId = socket.id; });

socket.on("room_created", (data) => {
  roomCode = data.roomCode;
  isHost = true;
  document.getElementById("lobby-code").textContent = roomCode;
  setError("landing-error", "");
  showScreen("screen-lobby");
});

socket.on("room_joined", (data) => {
  roomCode = data.roomCode;
  isHost = false;
  document.getElementById("lobby-code").textContent = roomCode;
  setError("landing-error", "");
  showScreen("screen-lobby");
});

socket.on("lobby_update", (data) => {
  const list = document.getElementById("lobby-player-list");
  document.getElementById("lobby-count").textContent = data.players.length;
  list.innerHTML = data.players.map((p, i) => `
    <div class="player-item">
      <div class="dot"></div>
      <span>${p.username}</span>
      ${i === 0 ? '<span class="host-tag">Host</span>' : ""}
    </div>
  `).join("");

  const startBtn = document.getElementById("start-btn");
  startBtn.disabled = !(isHost && data.players.length >= 5);
});

socket.on("error_msg", (data) => {
  // Show error in whichever screen is active
  const screens = ["landing-error", "lobby-error"];
  screens.forEach(id => {
    const el = document.getElementById(id);
    if (el && document.getElementById(id.replace("-error", "screen-"))?.classList.contains("active")) {
      el.textContent = data.message;
    }
  });
  setError("lobby-error", data.message);
  console.warn("Server error:", data.message);
});

socket.on("game_started", (data) => {
  publicState = data.publicState;
  privateInfo = data.privateInfo;
  myHand = [];
  showScreen("screen-game");
  renderRoleCard();
  renderGameState();
});

socket.on("state_update", (data) => {
  publicState = data.publicState;
  renderGameState();
});

socket.on("private_update", (data) => {
  privateInfo = data.privateInfo;
  renderRoleCard();
});

socket.on("vote_update", (data) => {
  const el = document.getElementById("vote-tally");
  if (el) el.textContent = `${data.votesIn} / ${data.total} voted`;
});

// Leader receives 3 drawn cards
socket.on("drawn_cards", (data) => {
  myHand = data.cards;
  renderLeaderDiscard();
});

// Assistant receives 2 cards to choose from
socket.on("assistant_cards", (data) => {
  myHand = data.cards;
  renderAssistantPlay();
});

socket.on("chat_msg", (data) => {
  const box = document.getElementById("chat-messages");
  const line = document.createElement("div");
  line.className = "chat-line" + (data.system ? " system" : "");
  if (data.system) {
    line.textContent = data.text;
  } else {
    line.innerHTML = `<span class="chat-name">${escHtml(data.username)}</span>: ${escHtml(data.text)}`;
  }
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
});

socket.on("game_over", (data) => {
  const title = document.getElementById("gameover-title");
  title.textContent = data.winner === "blue" ? "BLUE WINS" : "RED WINS";
  title.className = "gameover-title " + data.winner;
  document.getElementById("gameover-reason").textContent = data.reason;
  showScreen("screen-gameover");
});

// ── Render Functions ───────────────────────────────────────────
function renderRoleCard() {
  if (!privateInfo) return;
  const card = document.getElementById("role-card");
  const roleName = document.getElementById("role-name");
  const roleInfo = document.getElementById("role-info");
  const knownPlayers = document.getElementById("known-players");

  card.className = "role-card " + (privateInfo.team === "blue" ? "blue" : "red");

  if (privateInfo.role === "bigred") {
    roleName.textContent = "Big Red";
    roleInfo.textContent = privateInfo.knownTeammates?.length > 0
      ? "You know your red teammate (2-player red team)."
      : "You are Big Red. You don't know who your red teammates are. Stay hidden.";
  } else if (privateInfo.role === "red") {
    roleName.textContent = "Red Team";
    roleInfo.textContent = "You know who Big Red is and your teammates. Help Big Red stay hidden.";
  } else {
    roleName.textContent = "Blue Team";
    roleInfo.textContent = "You don't know anyone's identity. Find and eliminate Big Red, or play 5 blue cards.";
  }

  knownPlayers.innerHTML = "";
  if (privateInfo.knownTeammates?.length > 0) {
    privateInfo.knownTeammates.forEach(p => {
      const tag = document.createElement("div");
      tag.className = "known-tag" + (p.role === "bigred" ? " bigred" : "");
      tag.textContent = p.role === "bigred" ? `🔴 ${p.username} (Big Red)` : p.username;
      knownPlayers.appendChild(tag);
    });
  }
}

function renderGameState() {
  if (!publicState) return;

  // Scores
  document.getElementById("score-blue").textContent = publicState.blueCardsPlayed;
  document.getElementById("score-red").textContent = publicState.redCardsPlayed;
  document.getElementById("deck-count").textContent = publicState.cardsRemaining;

  // Failed vote dots
  for (let i = 0; i < 3; i++) {
    const dot = document.getElementById(`fail-dot-${i}`);
    if (dot) dot.className = "fail-dot" + (i < publicState.failedVoteCounter ? " filled" : "");
  }

  // Played cards track
  const track = document.getElementById("played-track-cards");
  track.innerHTML = publicState.playedCards.map(c =>
    `<div class="mini-card ${c}"></div>`
  ).join("");

  // Players list
  const pList = document.getElementById("players-list");
  const leader = publicState.leaderOrder[publicState.currentLeaderIndex];
  pList.innerHTML = publicState.leaderOrder.map(p => {
    const isLeader = p.id === leader?.id;
    const isElim = publicState.eliminatedPlayers.includes(p.id);
    const isMe = p.id === myId;

    // Dot color: show team color if known, else unknown
    let dotClass = "unknown";
    if (isMe && privateInfo) dotClass = privateInfo.team;
    else if (privateInfo?.role !== "blue") {
      // red/bigred can see red team dots
      const knownRed = privateInfo?.knownTeammates?.map(k => k.id) || [];
      if (knownRed.includes(p.id)) dotClass = "red";
    }

    return `<div class="player-row ${isLeader ? "leader" : ""} ${isElim ? "eliminated" : ""}">
      <div class="player-dot ${dotClass}"></div>
      <span>${escHtml(p.username)}${isMe ? " (you)" : ""}</span>
      ${isLeader ? '<span style="margin-left:auto;font-size:11px">👑 Leader</span>' : ""}
    </div>`;
  }).join("");

  // Phase UI
  renderPhase();
}

function renderPhase() {
  if (!publicState) return;
  const content = document.getElementById("phase-content");
  const leader = publicState.leaderOrder[publicState.currentLeaderIndex];
  const isLeader = leader?.id === myId;
  const isNominee = publicState.nominee?.id === myId;

  if (publicState.phase === "nominate") {
    if (isLeader) {
      // Show nominee buttons for all active, non-leader players
      const activePlayers = publicState.leaderOrder.filter(p =>
        !publicState.eliminatedPlayers.includes(p.id) && p.id !== myId
      );
      content.innerHTML = `
        <p style="font-size:15px">You are the <strong style="color:var(--red)">Leader</strong>. Nominate an assistant:</p>
        <div class="nominee-grid">
          ${activePlayers.map(p => `
            <button class="nominee-btn" onclick="nominate('${p.id}')">${escHtml(p.username)}</button>
          `).join("")}
        </div>`;
    } else {
      content.innerHTML = `<p style="color:var(--muted)">Waiting for <strong style="color:var(--text)">${escHtml(leader?.username)}</strong> to nominate an assistant...</p>`;
    }
  }

  else if (publicState.phase === "vote") {
    const isElim = publicState.eliminatedPlayers.includes(myId);
    const hasVoted = publicState.votes && publicState.votes[myId] !== undefined;
    const voteCount = Object.keys(publicState.votes || {}).length;
    const activeCount = publicState.leaderOrder.filter(p => !publicState.eliminatedPlayers.includes(p.id)).length;

    content.innerHTML = `
      <p style="font-size:15px"><strong style="color:var(--text)">${escHtml(publicState.nominee?.username)}</strong> has been nominated as assistant.</p>
      <p style="color:var(--muted);font-size:13px">Vote to approve or reject:</p>
      ${!isElim && !hasVoted ? `
        <div class="vote-buttons">
          <button class="btn-blue" onclick="castVote(true)">✓ Approve</button>
          <button class="btn-red" onclick="castVote(false)">✗ Reject</button>
        </div>` : `<p style="color:var(--muted);font-size:13px">${hasVoted ? "You have voted." : "You are eliminated."}</p>`}
      <p id="vote-tally" style="color:var(--muted);font-size:13px">${voteCount} / ${activeCount} voted</p>`;
  }

  else if (publicState.phase === "leader_draw") {
    if (isLeader) {
      content.innerHTML = `
        <p>You are the leader. Draw 3 cards from the deck:</p>
        <button class="btn-red" onclick="leaderDraw()">Draw 3 Cards</button>`;
    } else {
      content.innerHTML = `<p style="color:var(--muted)">Waiting for <strong style="color:var(--text)">${escHtml(leader?.username)}</strong> to draw cards...</p>`;
    }
  }

  else if (publicState.phase === "leader_discard") {
    if (isLeader && myHand.length > 0) {
      renderLeaderDiscard();
    } else {
      content.innerHTML = `<p style="color:var(--muted)">Waiting for <strong style="color:var(--text)">${escHtml(leader?.username)}</strong> to discard a card...</p>`;
    }
  }

  else if (publicState.phase === "assistant_play") {
    if (isNominee && myHand.length > 0) {
      renderAssistantPlay();
    } else {
      content.innerHTML = `<p style="color:var(--muted)">Waiting for <strong style="color:var(--text)">${escHtml(publicState.nominee?.username)}</strong> to play a card...</p>`;
    }
  }

  else if (publicState.phase === "game_over") {
    content.innerHTML = `<p style="color:var(--muted)">Game over!</p>`;
  }
}

function renderLeaderDiscard() {
  const content = document.getElementById("phase-content");
  content.innerHTML = `
    <p style="font-size:15px">You drew 3 cards. <strong>Click one to discard it.</strong> The other two go to the assistant.</p>
    <div class="card-hand">
      ${myHand.map((c, i) => `
        <div class="playing-card ${c}" onclick="leaderDiscard(${i})">${c.toUpperCase()}</div>
      `).join("")}
    </div>`;
}

function renderAssistantPlay() {
  const content = document.getElementById("phase-content");
  content.innerHTML = `
    <p style="font-size:15px">You are the assistant. <strong>Choose a card to play.</strong></p>
    <div class="card-hand">
      ${myHand.map((c, i) => `
        <div class="playing-card ${c}" onclick="assistantPlay(${i})">${c.toUpperCase()}</div>
      `).join("")}
    </div>`;
}

// ── Game Action Emitters ───────────────────────────────────────
function nominate(nomineeId) {
  socket.emit("nominate", { nomineeId });
}

function castVote(approve) {
  socket.emit("vote", { approve });
}

function leaderDraw() {
  socket.emit("leader_draw");
}

function leaderDiscard(index) {
  myHand.splice(index, 1); // Optimistically remove from local hand
  socket.emit("leader_discard", { discardIndex: index });
}

function assistantPlay(index) {
  myHand = [];
  socket.emit("assistant_play", { cardIndex: index });
}

// ── Utils ──────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
