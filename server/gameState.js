// Normal mode team splits
const TEAM_SPLITS_NORMAL = {
  5:  { blue: 3, red: 2 },
  6:  { blue: 4, red: 2 },
  7:  { blue: 4, red: 3 },
  8:  { blue: 5, red: 3 },
  9:  { blue: 5, red: 4 },
  10: { blue: 6, red: 4 },
};

// Chaos mode team splits (1 double agent replaces a blue)
const TEAM_SPLITS_CHAOS = {
  5:  { blue: 2, red: 2, doubleAgent: 1 },
  6:  { blue: 3, red: 2, doubleAgent: 1 },
  7:  { blue: 3, red: 3, doubleAgent: 1 },
  8:  { blue: 4, red: 3, doubleAgent: 1 },
  9:  { blue: 4, red: 4, doubleAgent: 1 },
  10: { blue: 5, red: 4, doubleAgent: 1 },
};

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createDeck() {
  return shuffle([...Array(6).fill("blue"), ...Array(11).fill("red")]);
}

// Red card powers — same in both modes
function getPowerForRedCard(redCardNumber, playerCount) {
  if (redCardNumber === 4 || redCardNumber === 5) return "eliminate";
  if (playerCount <= 6) {
    if (redCardNumber === 3) return "peek";
  } else if (playerCount <= 8) {
    if (redCardNumber === 2) return "investigate";
    if (redCardNumber === 3) return "pick_leader";
  } else {
    if (redCardNumber === 1) return "investigate";
    if (redCardNumber === 2) return "investigate";
    if (redCardNumber === 3) return "pick_leader";
  }
  return null;
}

// Blue card powers — chaos mode only
function getPowerForBlueCard(blueCardNumber, isChaos) {
  if (!isChaos) return null;
  if (blueCardNumber === 3) return "chaos_investigate";
  if (blueCardNumber === 4) return "chaos_interrogate";
  return null;
}

function createGameState(players, mode = "normal") {
  const count = players.length;
  const isChaos = mode === "chaos";
  const splits = isChaos ? TEAM_SPLITS_CHAOS : TEAM_SPLITS_NORMAL;
  const split = splits[count];
  if (!split) throw new Error(`Invalid player count: ${count}`);

  const shuffledPlayers = shuffle(players);
  const assignedPlayers = shuffledPlayers.map((player, index) => {
    let team, role;
    if (index < split.blue) {
      team = "blue"; role = "blue";
    } else if (index === split.blue) {
      // First red is King Crimson
      team = "red"; role = "bigred";
    } else if (isChaos && index === split.blue + split.red) {
      // Last slot in chaos mode is double agent
      team = "doubleagent"; role = "doubleagent";
    } else {
      team = "red"; role = "red";
    }
    return { ...player, team, role };
  });

  return {
    players: assignedPlayers,
    leaderOrder: [...assignedPlayers],
    currentLeaderIndex: 0,
    deck: createDeck(),
    discardPile: [],
    drawnCards: [],
    playedCards: [],
    blueCardsPlayed: 0,
    redCardsPlayed: 0,
    redCardsBeforeThisRound: 0,
    blueCardsBeforeThisRound: 0,
    failedVoteCounter: 0,
    eliminatedPlayers: [],
    phase: "nominate",
    pendingPower: null,
    nominee: null,
    votes: {},
    winner: null,
    totalPlayers: count,
    mode,
    isChaos,
    prevLeaderId: null,
    prevAssistantId: null,
    ineligibleAssistants: [],
    clockwiseResumeIndex: null,
    // Investigate result held here until leader dismisses it
    pendingInvestigateResult: null,
  };
}

module.exports = { createGameState, getPowerForRedCard, getPowerForBlueCard, shuffle };