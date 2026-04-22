// Team split table based on total player count
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
  // 6 blue cards + 11 red cards = 17 total
  const deck = [
    ...Array(6).fill("blue"),
    ...Array(11).fill("red"),
  ];
  return shuffle(deck);
}

function createGameState(players) {
  const count = players.length;
  const split = TEAM_SPLITS[count];
  if (!split) throw new Error(`Invalid player count: ${count}`);

  // Shuffle players to randomly assign teams
  const shuffledPlayers = shuffle(players);

  // Assign roles
  const assignedPlayers = shuffledPlayers.map((player, index) => {
    let team, role;
    if (index < split.blue) {
      team = "blue";
      role = "blue";
    } else if (index === split.blue) {
      // First red player is Big Red
      team = "red";
      role = "bigred";
    } else {
      team = "red";
      role = "red";
    }
    return { ...player, team, role };
  });

  // Leader order is the shuffled player order (clockwise circle)
  // Skip eliminated players when advancing
  const leaderOrder = [...assignedPlayers];

  return {
    players: assignedPlayers,
    leaderOrder,
    currentLeaderIndex: 0,
    deck: createDeck(),
    drawnCards: [],
    playedCards: [],
    blueCardsPlayed: 0,
    redCardsPlayed: 0,
    failedVoteCounter: 0,
    eliminatedPlayers: [], // array of socket IDs
    phase: "nominate",     // nominate | vote | leader_draw | leader_discard | assistant_play | game_over
    nominee: null,
    votes: {},
    winner: null,
  };
}

module.exports = { createGameState };
