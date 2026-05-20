const socket = io();

let myId = socket.id;
let myUsername = "";
let roomCode = "";
let publicState = null;
let privateInfo = null;
let myHand = [];
let isHost = false;
let currentMode = "normal";

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
function showAlert(msg, duration = 5000) {
  const el = document.getElementById("alert-banner");
  el.textContent = msg;
  el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), duration);
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
function setMode(mode) {
  if (!isHost) return;
  currentMode = mode;
  socket.emit("set_mode", { mode });
  updateModeUI(mode);
}
function updateModeUI(mode) {
  const normalBtn = document.getElementById("mode-btn-normal");
  const chaosBtn = document.getElementById("mode-btn-chaos");
  const desc = document.getElementById("mode-desc");
  if (!normalBtn) return;
  normalBtn.className = "mode-btn" + (mode === "normal" ? " active-normal" : "");
  chaosBtn.className = "mode-btn" + (mode === "chaos" ? " active-chaos" : "");
  desc.textContent = mode === "chaos"
    ? "Chaos mode — a Double Agent lurks among the Agents. New powers and win conditions!"
    : "Standard rules — Agents vs. Syndicate.";
}

// ── Socket Events ──────────────────────────────────────────────
socket.on("connect", () => { myId = socket.id; });

socket.on("room_created", (data) => {
  roomCode = data.roomCode; isHost = true;
  document.getElementById("lobby-code").textContent = roomCode;
  document.getElementById("mode-toggle-section").style.display = "block";
  setError("landing-error", "");
  showScreen("screen-lobby");
});
socket.on("room_joined", (data) => {
  roomCode = data.roomCode; isHost = false;
  document.getElementById("lobby-code").textContent = roomCode;
  document.getElementById("mode-toggle-section").style.display = "none";
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
  if (data.mode) updateModeUI(data.mode);
});
socket.on("error_msg", (data) => {
  setError("lobby-error", data.message);
  console.warn("Server error:", data.message);
});

socket.on("game_started", (data) => {
  publicState = data.publicState;
  privateInfo = data.privateInfo;
  currentMode = publicState.mode;
  myHand = [];
  showScreen("screen-game");
  renderRoleCard();
  renderGameState();
});
socket.on("state_update", (data) => {
  publicState = data.publicState;
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

// Peek — leader sees top 3 cards with a Done button
socket.on("power_peek", (data) => {
  const content = document.getElementById("phase-content");
  content.innerHTML = `
    <p style="font-size:15px">🔍 You secretly peeked at the top 3 cards of the deck (in order):</p>
    <div class="card-hand">
      ${data.cards.map((c, i) => `
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
          <div class="playing-card ${c}" style="cursor:default">${c.toUpperCase()}</div>
          <span style="font-size:11px;color:var(--muted)">#${i+1}</span>
        </div>`).join("")}
    </div>
    <p style="color:var(--muted);font-size:13px">Only you can see this. You may share or keep this information.</p>
    <button class="btn-red" onclick="peekDone()" style="max-width:160px">Done</button>`;
});

// Investigate result — shown to leader only, with Done button to finish round
socket.on("power_investigate_result", (data) => {
  const content = document.getElementById("phase-content");
  let resultColor, resultText;

  if (data.mode === "normal") {
    resultColor = data.result === "blue" ? "var(--blue)" : "var(--red)";
    resultText = data.result === "blue" ? "AGENT (Blue)" : "SYNDICATE (Red)";
  } else if (data.mode === "chaos_interrogate" && data.result === "double agent") {
    resultColor = "var(--gold)";
    resultText = "DOUBLE AGENT — Eliminated!";
  } else {
    // chaos investigate
    resultColor = data.result === "blue" ? "var(--blue)" : "var(--muted)";
    resultText = data.result === "blue" ? "BLUE" : "NOT BLUE";
  }

  content.innerHTML = `
    <p style="font-size:15px">🔍 Investigation result for <strong>${escHtml(data.username)}</strong>:</p>
    <p style="font-family:'Bebas Neue',sans-serif;font-size:28px;color:${resultColor}">${resultText}</p>
    <p style="color:var(--muted);font-size:13px">Only you can see this. You may share or keep this information.</p>
    <button class="btn-red" onclick="investigateDone()" style="max-width:160px">Done</button>`;
});

socket.on("double_agent_revealed", (data) => {
  showAlert(`⚠️ ${escHtml(data.username)} was the Double Agent — their cover is blown!`, 8000);
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
  const winnerLabels = { blue: "AGENTS WIN", red: "SYNDICATE WINS", doubleagent: "DOUBLE AGENT WINS" };
  title.textContent = winnerLabels[data.winner] || "GAME OVER";
  title.className = "gameover-title " + data.winner;
  document.getElementById("gameover-reason").textContent = data.reason;

  if (data.allPlayers && data.allPlayers.length > 0) {
    const roleLabels = { bigred: "King Crimson", red: "Syndicate", blue: "Agent", doubleagent: "Double Agent" };
    const roleColors = { bigred: "var(--red)", red: "var(--red)", blue: "var(--blue)", doubleagent: "var(--gold)" };
    const roleBorders = { bigred: "rgba(192,57,43,0.4)", red: "rgba(192,57,43,0.3)", blue: "rgba(36,113,163,0.3)", doubleagent: "rgba(212,172,13,0.4)" };
    const reveal = document.getElementById("gameover-reveal");
    reveal.innerHTML = `
      <p style="font-size:12px;text-transform:uppercase;letter-spacing:2px;color:var(--muted);margin-bottom:12px">Identity Reveal</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center">
        ${data.allPlayers.map(p => `
          <div style="background:var(--surface);border:1px solid ${roleBorders[p.role]};border-radius:10px;padding:12px 16px;min-width:120px;text-align:center">
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px">${escHtml(p.username)}</div>
            <div style="font-family:'Bebas Neue',sans-serif;font-size:20px;color:${roleColors[p.role]};margin-top:4px">${roleLabels[p.role]}</div>
            ${p.role === "bigred" ? '<div style="font-size:16px;margin-top:2px">👑</div>' : ""}
            ${p.role === "doubleagent" ? '<div style="font-size:16px;margin-top:2px">🕵️</div>' : ""}
          </div>`).join("")}
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
  const knownPlayersEl = document.getElementById("known-players");
  const isChaos = currentMode === "chaos";

  card.className = "role-card " + (privateInfo.role === "doubleagent" ? "doubleagent" : privateInfo.team === "blue" ? "blue" : "red");

  if (privateInfo.role === "bigred") {
    roleName.textContent = "King Crimson";
    roleInfo.textContent = privateInfo.knownTeammates?.length > 0
      ? `You know your Syndicate ${isChaos ? "allies" : "ally"}.`
      : "You are King Crimson. Stay hidden — don't let the Agents find you.";
  } else if (privateInfo.role === "red") {
    roleName.textContent = "Syndicate";
    roleInfo.textContent = "You know who King Crimson is. Keep their identity hidden.";
  } else if (privateInfo.role === "doubleagent") {
    roleName.textContent = "Double Agent";
    roleInfo.textContent = "You know everyone. Win by surviving until all cards for one side are played. You're on your own.";
  } else {
    roleName.textContent = "Agent";
    roleInfo.textContent = isChaos
      ? "You know nothing. Find King Crimson or the Double Agent — or play 5 Agent cards."
      : "You know nothing. Find and eliminate King Crimson, or play 5 Agent cards.";
  }

  knownPlayersEl.innerHTML = "";
  if (privateInfo.knownTeammates?.length > 0) {
    privateInfo.knownTeammates.forEach(p => {
      const tag = document.createElement("div");
      const isKC = p.role === "bigred";
      const isDA = p.role === "doubleagent";
      tag.className = "known-tag" + (isKC ? " bigred" : isDA ? " doubleagent" : "");
      tag.textContent = isKC ? `👑 ${p.username} (King Crimson)` : isDA ? `🕵️ ${p.username} (Double Agent)` : p.username;
      knownPlayersEl.appendChild(tag);
    });
  }
}

function renderGameState() {
  if (!publicState) return;

  document.getElementById("score-blue").textContent = publicState.blueCardsPlayed;
  document.getElementById("score-red").textContent = publicState.redCardsPlayed;
  document.getElementById("deck-count").textContent = publicState.cardsRemaining;

  const badge = document.getElementById("mode-badge");
  if (publicState.mode === "chaos") {
    badge.textContent = "⚡ Chaos";
    badge.className = "mode-badge chaos";
  } else {
    badge.textContent = "Normal";
    badge.className = "mode-badge normal";
  }

  for (let i = 0; i < 3; i++) {
    const dot = document.getElementById(`fail-dot-${i}`);
    if (dot) dot.className = "fail-dot" + (i < publicState.failedVoteCounter ? " filled" : "");
  }

  document.getElementById("played-track-cards").innerHTML =
    publicState.playedCards.map(c => `<div class="mini-card ${c}"></div>`).join("");

  const leader = publicState.leaderOrder[publicState.currentLeaderIndex];
  document.getElementById("players-list").innerHTML = publicState.leaderOrder.map(p => {
    const isLeader = p.id === leader?.id;
    const isElim = publicState.eliminatedPlayers.includes(p.id);
    const isMe = p.id === myId;
    let dotClass = "unknown";
    if (isMe && privateInfo) {
      dotClass = privateInfo.role === "doubleagent" ? "doubleagent" : privateInfo.team;
    } else if (privateInfo) {
      const knownIds = privateInfo.knownTeammates?.map(k => k.id) || [];
      const knownEntry = privateInfo.knownTeammates?.find(k => k.id === p.id);
      if (knownEntry) {
        dotClass = knownEntry.role === "doubleagent" ? "doubleagent" : knownEntry.team || "red";
      }
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
  const isChaos = publicState.mode === "chaos";

  if (publicState.phase === "nominate") {
    if (isLeader) {
      const ineligible = publicState.ineligibleAssistants || [];
      const activePlayers = publicState.leaderOrder.filter(p =>
        !publicState.eliminatedPlayers.includes(p.id) && p.id !== myId
      );
      content.innerHTML = `
        <p style="font-size:15px">You are the <strong style="color:var(--red)">Leader</strong>. Nominate an assistant:</p>
        <p style="font-size:12px;color:var(--muted)">Greyed out players are ineligible this round.</p>
        <div class="nominee-grid">
          ${activePlayers.map(p => {
            const disabled = ineligible.includes(p.id);
            return `<button class="nominee-btn" onclick="${disabled?'':` nominate('${p.id}')`}"
              style="${disabled?'opacity:0.35;cursor:not-allowed;':''}" ${disabled?'disabled':''}>
              ${escHtml(p.username)}</button>`;
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
      renderPowerUI(power, isChaos);
    } else {
      const powerLabels = {
        eliminate: "eliminate a player",
        investigate: "secretly investigate a player",
        chaos_investigate: "secretly investigate a player",
        chaos_interrogate: "interrogate a player",
        pick_leader: "choose the next leader",
        peek: "peek at the top 3 cards",
      };
      content.innerHTML = `<p style="color:var(--muted)">⚡ Power triggered! <strong style="color:var(--text)">${escHtml(leader?.username)}</strong> is using their power to ${powerLabels[power] || "use a power"}...</p>`;
    }
  }
}

function renderPowerUI(power, isChaos) {
  const content = document.getElementById("phase-content");
  const activePlayers = publicState.leaderOrder.filter(p =>
    !publicState.eliminatedPlayers.includes(p.id) && p.id !== myId
  );

  if (power === "eliminate") {
    content.innerHTML = `
      <p style="font-size:15px">⚡ <strong style="color:var(--red)">Elimination Power!</strong> Choose a player to eliminate:</p>
      <p style="color:var(--muted);font-size:13px">Their identity will remain secret unless they are King Crimson${isChaos?" or the Double Agent":""}.
      </p>
      <div class="nominee-grid">
        ${activePlayers.map(p => `<button class="nominee-btn" onclick="powerEliminate('${p.id}')">${escHtml(p.username)}</button>`).join("")}
      </div>`;
  }
  else if (power === "investigate") {
    content.innerHTML = `
      <p style="font-size:15px">⚡ <strong style="color:var(--red)">Investigation Power!</strong> Choose a player to investigate:</p>
      <p style="color:var(--muted);font-size:13px">You'll privately learn if they're an Agent or Syndicate (King Crimson shows as Syndicate).</p>
      <div class="nominee-grid">
        ${activePlayers.map(p => `<button class="nominee-btn" onclick="powerInvestigate('${p.id}')">${escHtml(p.username)}</button>`).join("")}
      </div>`;
  }
  else if (power === "chaos_investigate") {
    content.innerHTML = `
      <p style="font-size:15px">⚡ <strong style="color:var(--gold)">Investigation Power!</strong> Choose a player to investigate:</p>
      <p style="color:var(--muted);font-size:13px">You'll privately learn if they are "Blue" or "Not Blue". Syndicate and Double Agent both show as "Not Blue".</p>
      <div class="nominee-grid">
        ${activePlayers.map(p => `<button class="nominee-btn" onclick="powerChaosInvestigate('${p.id}')">${escHtml(p.username)}</button>`).join("")}
      </div>`;
  }
  else if (power === "chaos_interrogate") {
    content.innerHTML = `
      <p style="font-size:15px">⚡ <strong style="color:var(--gold)">Interrogation Power!</strong> Choose a player to interrogate:</p>
      <p style="color:var(--muted);font-size:13px">If they're the Double Agent, they're eliminated immediately. Otherwise you'll privately learn their team.</p>
      <div class="nominee-grid">
        ${activePlayers.map(p => `<button class="nominee-btn" onclick="powerChaosInvestigate('${p.id}')">${escHtml(p.username)}</button>`).join("")}
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
function investigateDone() { socket.emit("power_investigate_done"); }
function powerEliminate(targetId) { socket.emit("power_eliminate", { targetId }); }
function powerInvestigate(targetId) { socket.emit("power_investigate", { targetId }); }
function powerChaosInvestigate(targetId) { socket.emit("power_chaos_investigate", { targetId }); }
function powerPickLeader(targetId) { socket.emit("power_pick_leader", { targetId }); }