const socket = io();

let myId = socket.id;
let myUsername = "";
let roomCode = "";
let publicState = null;
let privateInfo = null;
let myHand = [];
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
function escHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Landing ────────────────────────────────────────────────────
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
function startGame() { socket.emit("start_game"); }
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
  roomCode = data.roomCode; isHost = true;
  document.getElementById("lobby-code").textContent = roomCode;
  setError("landing-error", "");
  showScreen("screen-lobby");
});
socket.on("room_joined", (data) => {
  roomCode = data.roomCode; isHost = false;
  document.getElementById("lobby-code").textContent = roomCode;
  setError("landing-error", "");
  showScreen("screen-lobby");
});
socket.on("lobby_update", (data) => {
  document.getElementById("lobby-count").textContent = data.players.length;
  document.getElementById("lobby-player-list").innerHTML = data.players.map((p, i) => `
    <div class="player-item">
      <div class="dot"></div>
      <span>${escHtml(p.username)}</span>
      ${i === 0 ? '<span class="host-tag">Host</span>' : ""}
    </div>`).join("");
  document.getElementById("start-btn").disabled = !(isHost && data.players.length >= 5);
});
socket.on("error_msg", (data) => {
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
  // Don't re-render if we're already on the game over screen
  if (publicState.phase === "game_over") return;
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
socket.on("drawn_cards", (data) => {
  myHand = data.cards;
  renderLeaderDiscard();
});
socket.on("assistant_cards", (data) => {
  myHand = data.cards;
  renderAssistantPlay();
});

// Peek power — only the leader receives this
socket.on("power_peek", (data) => {
  const content = document.getElementById("phase-content");
  content.innerHTML = `
    <p style="font-size:15px">🔍 You secretly peeked at the top 3 cards of the deck (in order):</p>
    <div class="card-hand">
      ${data.cards.map((c, i) => `
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
          <div class="playing-card ${c}" style="cursor:default">${c.toUpperCase()}</div>
          <span style="font-size:11px;color:var(--muted)">#${i+1}</span>
        </div>
      `).join("")}
    </div>
    <p style="color:var(--muted);font-size:13px">Only you can see this. You may share or keep this information.</p>
    <button class="btn-red" onclick="peekDone()" style="max-width:160px">Done</button>`;
});

// Investigate result — only the leader receives this
socket.on("power_investigate_result", (data) => {
  const content = document.getElementById("phase-content");
  const teamColor = data.team === "red" ? "var(--red)" : "var(--blue)";
  content.innerHTML = `
    <p style="font-size:15px">🔍 Investigation result:</p>
    <p style="font-size:20px;font-family:'Bebas Neue',sans-serif;color:${teamColor}">
      ${escHtml(data.username)} is on the <span style="color:${teamColor}">${data.team.toUpperCase()}</span> team.
    </p>
    <p style="color:var(--muted);font-size:13px">Only you can see this. You may share or keep this information.</p>`;
});

socket.on("chat_msg", (data) => {
  const box = document.getElementById("chat-messages");
  const line = document.createElement("div");
  line.className = "chat-line" + (data.system ? " system" : "");
  line.innerHTML = data.system
    ? escHtml(data.text)
    : `<span class="chat-name">${escHtml(data.username)}</span>: ${escHtml(data.text)}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
});

socket.on("game_over", (data) => {
  const title = document.getElementById("gameover-title");
  title.textContent = data.winner === "blue" ? "AGENTS WIN" : "SYNDICATE WINS";
  title.className = "gameover-title " + data.winner;
  document.getElementById("gameover-reason").textContent = data.reason;

  // Render identity reveal
  if (data.allPlayers && data.allPlayers.length > 0) {
    const roleLabels = { bigred: "King Crimson", red: "Syndicate", blue: "Agent" };
    const reveal = document.getElementById("gameover-reveal");
    reveal.innerHTML = `
      <p style="font-size:12px;text-transform:uppercase;letter-spacing:2px;color:var(--muted);margin-bottom:12px">Identity Reveal</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center">
        ${data.allPlayers.map(p => {
          const isKC = p.role === "bigred";
          const isSyndicate = p.team === "red";
          const color = isSyndicate ? "var(--red)" : "var(--blue)";
          const border = isSyndicate ? "rgba(192,57,43,0.4)" : "rgba(36,113,163,0.4)";
          return `<div style="background:var(--surface);border:1px solid ${border};border-radius:10px;padding:12px 16px;min-width:120px;text-align:center">
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px">${escHtml(p.username)}</div>
            <div style="font-family:'Bebas Neue',sans-serif;font-size:20px;color:${color};margin-top:4px">${roleLabels[p.role]}</div>
            ${isKC ? '<div style="font-size:16px;margin-top:2px">👑</div>' : ''}
          </div>`;
        }).join("")}
      </div>`;
  }

  showScreen("screen-gameover");
});

// ── Render ─────────────────────────────────────────────────────
function renderRoleCard() {
  if (!privateInfo) return;
  const card = document.getElementById("role-card");
  const roleName = document.getElementById("role-name");
  const roleInfo = document.getElementById("role-info");
  const knownPlayers = document.getElementById("known-players");

  card.className = "role-card " + (privateInfo.team === "blue" ? "blue" : "red");

  if (privateInfo.role === "bigred") {
    roleName.textContent = "King Crimson";
    roleInfo.textContent = privateInfo.knownTeammates?.length > 0
      ? "You know your Syndicate ally (2-person Syndicate)."
      : "You are King Crimson. Stay hidden — don't let the Agents find you.";
  } else if (privateInfo.role === "red") {
    roleName.textContent = "Syndicate";
    roleInfo.textContent = "You know who King Crimson is. Keep their identity hidden.";
  } else {
    roleName.textContent = "Agent";
    roleInfo.textContent = "You know nothing. Find and eliminate King Crimson, or play 5 Agent cards.";
  }

  knownPlayers.innerHTML = "";
  if (privateInfo.knownTeammates?.length > 0) {
    privateInfo.knownTeammates.forEach(p => {
      const tag = document.createElement("div");
      tag.className = "known-tag" + (p.role === "bigred" ? " bigred" : "");
      tag.textContent = p.role === "bigred" ? `🔴 ${p.username} (King Crimson)` : p.username;
      knownPlayers.appendChild(tag);
    });
  }
}

function renderGameState() {
  if (!publicState) return;

  document.getElementById("score-blue").textContent = publicState.blueCardsPlayed;
  document.getElementById("score-red").textContent = publicState.redCardsPlayed;
  document.getElementById("deck-count").textContent = publicState.cardsRemaining;

  for (let i = 0; i < 3; i++) {
    const dot = document.getElementById(`fail-dot-${i}`);
    if (dot) dot.className = "fail-dot" + (i < publicState.failedVoteCounter ? " filled" : "");
  }

  document.getElementById("played-track-cards").innerHTML =
    publicState.playedCards.map(c => `<div class="mini-card ${c}"></div>`).join("");

  // Players sidebar
  const leader = publicState.leaderOrder[publicState.currentLeaderIndex];
  document.getElementById("players-list").innerHTML = publicState.leaderOrder.map(p => {
    const isLeader = p.id === leader?.id;
    const isElim = publicState.eliminatedPlayers.includes(p.id);
    const isMe = p.id === myId;
    let dotClass = "unknown";
    if (isMe && privateInfo) dotClass = privateInfo.team;
    else if (privateInfo?.role !== "blue") {
      const knownRedIds = privateInfo?.knownTeammates?.map(k => k.id) || [];
      if (knownRedIds.includes(p.id)) dotClass = "red";
    }
    return `<div class="player-row ${isLeader?"leader":""} ${isElim?"eliminated":""}">
      <div class="player-dot ${dotClass}"></div>
      <span>${escHtml(p.username)}${isMe?" (you)":""}</span>
      ${isLeader?'<span style="margin-left:auto;font-size:11px">👑</span>':""}
    </div>`;
  }).join("");

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
      const activePlayers = publicState.leaderOrder.filter(p =>
        !publicState.eliminatedPlayers.includes(p.id) && p.id !== myId
      );
      const ineligible = publicState.ineligibleAssistants || [];
      content.innerHTML = `
        <p style="font-size:15px">You are the <strong style="color:var(--red)">Leader</strong>. Nominate an assistant:</p>
        <p style="font-size:12px;color:var(--muted)">Greyed out players are ineligible this round.</p>
        <div class="nominee-grid">
          ${activePlayers.map(p => {
            const disabled = ineligible.includes(p.id);
            return `<button class="nominee-btn" onclick="${disabled ? '' : `nominate('${p.id}')`}"
              style="${disabled ? 'opacity:0.35;cursor:not-allowed;' : ''}"
              ${disabled ? 'disabled' : ''}>${escHtml(p.username)}</button>`;
          }).join("")}
        </div>`;
    } else {
      content.innerHTML = `<p style="color:var(--muted)">Waiting for <strong style="color:var(--text)">${escHtml(leader?.username)}</strong> to nominate an assistant...</p>`;
    }
  }

  else if (publicState.phase === "vote") {
    const isElim = publicState.eliminatedPlayers.includes(myId);
    const hasVoted = publicState.votes?.[myId] !== undefined;
    const voteCount = Object.keys(publicState.votes || {}).length;
    const activeCount = publicState.leaderOrder.filter(p => !publicState.eliminatedPlayers.includes(p.id)).length;
    content.innerHTML = `
      <p style="font-size:15px"><strong style="color:var(--text)">${escHtml(publicState.nominee?.username)}</strong> has been nominated as assistant.</p>
      ${!isElim && !hasVoted ? `
        <div class="vote-buttons">
          <button class="btn-blue" onclick="castVote(true)">✓ Approve</button>
          <button class="btn-red" onclick="castVote(false)">✗ Reject</button>
        </div>` : `<p style="color:var(--muted);font-size:13px">${hasVoted?"You have voted.":"You are eliminated."}</p>`}
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
    if (isLeader && myHand.length > 0) renderLeaderDiscard();
    else content.innerHTML = `<p style="color:var(--muted)">Waiting for <strong style="color:var(--text)">${escHtml(leader?.username)}</strong> to discard a card...</p>`;
  }

  else if (publicState.phase === "assistant_play") {
    if (isNominee && myHand.length > 0) renderAssistantPlay();
    else content.innerHTML = `<p style="color:var(--muted)">Waiting for <strong style="color:var(--text)">${escHtml(publicState.nominee?.username)}</strong> to play a card...</p>`;
  }

  else if (publicState.phase === "power") {
    const power = publicState.pendingPower?.type;
    if (isLeader) {
      renderPowerUI(power);
    } else {
      const powerLabels = {
        eliminate: "eliminate a player",
        investigate: "secretly investigate a player",
        pick_leader: "choose the next leader",
        peek: "peek at the top 3 cards",
      };
      content.innerHTML = `<p style="color:var(--muted)">⚡ Power triggered! <strong style="color:var(--text)">${escHtml(leader?.username)}</strong> is using their power to ${powerLabels[power] || "use a power"}...</p>`;
    }
  }
}

function renderPowerUI(power) {
  const content = document.getElementById("phase-content");
  const activePlayers = publicState.leaderOrder.filter(p =>
    !publicState.eliminatedPlayers.includes(p.id) && p.id !== myId
  );

  if (power === "eliminate") {
    content.innerHTML = `
      <p style="font-size:15px">⚡ <strong style="color:var(--red)">Elimination Power!</strong> Choose a player to eliminate:</p>
      <p style="color:var(--muted);font-size:13px">Their identity will remain secret unless they are Big Red.</p>
      <div class="nominee-grid">
        ${activePlayers.map(p => `<button class="nominee-btn" onclick="powerEliminate('${p.id}')">${escHtml(p.username)}</button>`).join("")}
      </div>`;
  }

  else if (power === "investigate") {
    content.innerHTML = `
      <p style="font-size:15px">⚡ <strong style="color:var(--red)">Investigation Power!</strong> Choose a player to investigate:</p>
      <p style="color:var(--muted);font-size:13px">You'll learn if they're on the red or blue team (Big Red shows as red). Only you will see the result.</p>
      <div class="nominee-grid">
        ${activePlayers.map(p => `<button class="nominee-btn" onclick="powerInvestigate('${p.id}')">${escHtml(p.username)}</button>`).join("")}
      </div>`;
  }

  else if (power === "pick_leader") {
    content.innerHTML = `
      <p style="font-size:15px">⚡ <strong style="color:var(--red)">Choose Next Leader!</strong> Pick who leads next round:</p>
      <div class="nominee-grid">
        ${activePlayers.map(p => `<button class="nominee-btn" onclick="powerPickLeader('${p.id}')">${escHtml(p.username)}</button>`).join("")}
      </div>`;
  }
}

function renderLeaderDiscard() {
  const content = document.getElementById("phase-content");
  content.innerHTML = `
    <p style="font-size:15px">You drew 3 cards. <strong>Click one to discard it.</strong></p>
    <div class="card-hand">
      ${myHand.map((c, i) => `<div class="playing-card ${c}" onclick="leaderDiscard(${i})">${c.toUpperCase()}</div>`).join("")}
    </div>`;
}

function renderAssistantPlay() {
  const content = document.getElementById("phase-content");
  content.innerHTML = `
    <p style="font-size:15px">You are the assistant. <strong>Choose a card to play.</strong></p>
    <div class="card-hand">
      ${myHand.map((c, i) => `<div class="playing-card ${c}" onclick="assistantPlay(${i})">${c.toUpperCase()}</div>`).join("")}
    </div>`;
}

// ── Actions ────────────────────────────────────────────────────
function nominate(id) { socket.emit("nominate", { nomineeId: id }); }
function castVote(approve) { socket.emit("vote", { approve }); }
function leaderDraw() { socket.emit("leader_draw"); }
function leaderDiscard(index) {
  myHand.splice(index, 1);
  socket.emit("leader_discard", { discardIndex: index });
}
function assistantPlay(index) {
  myHand = [];
  socket.emit("assistant_play", { cardIndex: index });
}
function peekDone() { socket.emit("power_peek_done"); }
function powerEliminate(targetId) { socket.emit("power_eliminate", { targetId }); }
function powerInvestigate(targetId) { socket.emit("power_investigate", { targetId }); }
function powerPickLeader(targetId) { socket.emit("power_pick_leader", { targetId }); }