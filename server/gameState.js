const TEAM_SPLITS = {
  5:  { blue: 3, red: 2 },
  6:  { blue: 4, red: 2 },
  7:  { blue: 4, red: 3 },
  8:  { blue: 5, red: 3 },
  9:  { blue: 5, red: 4 },
  10: { blue: 6, red: 4 },
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

// Returns which power triggers for a given red card number and player count.
// Returns null if no power.
function getPowerForRedCard(redCardNumber, playerCount) {
  // Universal powers
  if (redCardNumber === 4 || redCardNumber === 5) return "eliminate";

  // Player-count-specific powers
  if (playerCount <= 6) {
    if (redCardNumber === 3) return "peek";
  } else if (playerCount <= 8) {
    if (redCardNumber === 2) return "investigate";
    if (redCardNumber === 3) return "pick_leader";
  } else {
    // 9-10 players
    if (redCardNumber === 1) return "investigate";
    if (redCardNumber === 2) return "investigate";
    if (redCardNumber === 3) return "pick_leader";
  }

  return null;
}

function createGameState(players) {
  const count = players.length;
  const split = TEAM_SPLITS[count];
  if (!split) throw new Error(`Invalid player count: ${count}`);

  const shuffledPlayers = shuffle(players);

  const assignedPlayers = shuffledPlayers.map((player, index) => {
    let team, role;
    if (index < split.blue) {
      team = "blue"; role = "blue";
    } else if (index === split.blue) {
      team = "red"; role = "bigred";
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
    redCardsBeforeThisRound: 0,  // captured before playing a card, for Big Red win check
    failedVoteCounter: 0,
    eliminatedPlayers: [],
    phase: "nominate",  // nominate | vote | leader_draw | leader_discard | assistant_play | power | game_over
    pendingPower: null, // { type: 'eliminate' | 'peek' | 'investigate' | 'pick_leader' }
    nominee: null,
    votes: {},
    winner: null,
    totalPlayers: count,
    prevLeaderId: null,       // for term limits
    prevAssistantId: null,    // for term limits
    ineligibleAssistants: [], // computed each round
    clockwiseResumeIndex: null, // set when pick_leader is used; next round resumes from here
  };
}

module.exports = { createGameState, getPowerForRedCard, shuffle };