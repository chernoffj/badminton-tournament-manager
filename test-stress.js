/* Stress test for the tournament logic. Loads the inline <script type="text/babel">
   block from index.html, strips the React/JSX components, and evaluates only the
   pure-JS helpers in this Node context. Then runs randomized tournaments and
   asserts the user-reported bug invariants. */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
if (!m) { console.error('script block not found'); process.exit(1); }
let src = m[1];

// Strip everything from the first React component onward (function SetupGuide() ...)
// and anything that depends on Firebase / DOM. We only need the pure-JS helpers.
const cutMatch = src.match(/REACT APPLICATION/);
if (!cutMatch) { console.error('REACT APPLICATION marker not found'); process.exit(1); }
// Walk back to the start of the comment block before this marker
let cutAt = cutMatch.index;
const commentStart = src.lastIndexOf('/*', cutAt);
if (commentStart > 0) cutAt = commentStart;
src = src.slice(0, cutAt);

// Stub out firebase usage. None of the helpers we want to test call db/auth, but
// the IS_CONFIGURED block at the top references firebase.initializeApp.
src = src.replace(
  /let fb = null, db = null, auth = null;[\s\S]*?if \(IS_CONFIGURED\) \{[\s\S]*?\n\}/,
  'const fb = null, db = null, auth = null;'
);

// Skip async firestore helpers — they reference db.
src = src.replace(/async function createTournament[\s\S]*?\n\}\n/, '');
src = src.replace(/async function loadTournamentMeta[\s\S]*?\n\}\n/, '');
src = src.replace(/async function loadTournamentEvents[\s\S]*?\n\}\n/, '');
src = src.replace(/async function saveEventData[\s\S]*?\n\}\n/, '');
src = src.replace(/async function saveAllEvents[\s\S]*?\n\}\n/, '');
src = src.replace(/async function findTournamentByShareCode[\s\S]*?\n\}\n/, '');
src = src.replace(/async function getUserTournaments[\s\S]*?\n\}\n/, '');
src = src.replace(/async function addEditor[\s\S]*?\n\}\n/, '');
src = src.replace(/async function deleteTournament[\s\S]*?\n\}\n/, '');
src = src.replace(/function subscribeToEvent[\s\S]*?\n\}\n/, '');

const ctx = {};
const fn = new Function(src + '\n; const React = { useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({current: null}), useCallback: f => f, useMemo: f => f() };\n; return {createInitialTeams, createEventObject, generateMainDraw, generateConsolationDraw, generateWaterfallDraw, populateDraw, populateWaterfallDynamic, populateAllDraws, shuffleEventTeams, determineMatchWinner, findMatch, findTeamById, findMatchAcrossDraws, getPlayerIdFromSource, whichDrawForMatchId, collectDependentMatchIds, countDownstreamPlayed, resetMatchAndCascade, resetMatchAndCascadeInDraw, EVENT_CODES, NUM_SCHOOLS, TEAMS_PER_SCHOOL, TOTAL_TEAMS, fyShuffle, isPlaceholderName};');
const lib = fn();
Object.assign(ctx, lib);

let assertions = 0;
let failures = 0;
function assert(cond, label) {
  assertions++;
  if (!cond) { failures++; console.error('  ✗', label); }
}

function makeEvent(eventId = 'BS', byeCount = 0) {
  const ev = ctx.createEventObject(eventId);
  // Replace the last `byeCount` teams with BYE-named placeholders so they
  // shuffle into BYEs.
  for (let i = ctx.TOTAL_TEAMS - 1; i >= ctx.TOTAL_TEAMS - byeCount; i--) {
    ev.teams[i].name = `School ${Math.floor(i / 2) + 1} - Team ${(i % 2) + 1}`;
  }
  // Give the rest real names.
  for (let i = 0; i < ctx.TOTAL_TEAMS - byeCount; i++) {
    ev.teams[i].name = `Player_${i+1}`;
  }
  ctx.shuffleEventTeams(ev);
  ctx.populateAllDraws(ev);
  return ev;
}

function pickReadyMatches(ev) {
  const ready = [];
  for (const draw of [ev.mainDraw, ev.consolationDraw, ev.waterfallConsolationDraw]) {
    if (!draw || !draw.rounds) continue;
    for (const round of draw.rounds) {
      for (const m of round) {
        if (m.isComplete) continue;
        if (!m.team1Id || !m.team2Id) continue;
        if (m.team1Id === 'TBD' || m.team2Id === 'TBD') continue;
        if (m.team1Id === 'BYE' || m.team2Id === 'BYE') continue;
        ready.push(m);
      }
    }
  }
  return ready;
}

function drawTypeOf(ev, matchId) {
  return ctx.whichDrawForMatchId(ev, matchId);
}

function randomScoreFor(match, drawType) {
  // Decide a winner uniformly at random and produce valid scores
  const bo3 = (drawType === 'MD' && (match.isSF || match.isFinal)) ||
              (drawType === 'CD' && (match.isFinal || match.isSecondPlacePlayoff));
  const winner = Math.random() < 0.5 ? 1 : 2;
  if (!bo3) {
    return winner === 1 ? { s1: [21], s2: [Math.floor(Math.random() * 19)] }
                        : { s1: [Math.floor(Math.random() * 19)], s2: [21] };
  }
  // bo3
  const games = [];
  let w1 = 0, w2 = 0;
  while (w1 < 2 && w2 < 2) {
    const winThis = (w1 + w2 === 0) ? winner : (Math.random() < 0.6 ? winner : (winner === 1 ? 2 : 1));
    if (winThis === 1) { games.push([21, Math.floor(Math.random()*19)]); w1++; }
    else { games.push([Math.floor(Math.random()*19), 21]); w2++; }
  }
  return {
    s1: games.map(g => g[0]),
    s2: games.map(g => g[1])
  };
}

function playMatch(ev, m) {
  const dt = drawTypeOf(ev, m.id);
  const { s1, s2 } = randomScoreFor(m, dt);
  m.score1 = s1; m.score2 = s2;
  const r = ctx.determineMatchWinner(m, dt);
  if (!r.valid) throw new Error('invalid score');
  m.winnerId = r.winnerId;
  m.loserId = r.loserId;
  m.isComplete = true;
  if (!m.isOverallChampionship && !m.isSecondPlacePlayoff) {
    const loser = ev.teams.find(t => t.id === m.loserId);
    if (loser) {
      if (dt === 'MD') loser.mainDrawLosses = (loser.mainDrawLosses || 0) + 1;
      else if (dt === 'CD') loser.consolationLosses = (loser.consolationLosses || 0) + 1;
    }
  }
  ctx.populateAllDraws(ev);
}

function dumpInvariants(ev, label) {
  // No duplicate placement: a team should appear in at most one not-yet-played
  // match per draw at any time, and total appearances of a team across draws
  // shouldn't form a duplicate (e.g., same team in two different CD R1 slots).
  const draws = { MD: ev.mainDraw, CD: ev.consolationDraw, WCD: ev.waterfallConsolationDraw };
  for (const [dt, draw] of Object.entries(draws)) {
    if (!draw || !draw.rounds) continue;
    const seenInRound = {};
    draw.rounds.forEach((round, ri) => {
      const ids = new Set();
      round.forEach(m => {
        for (const tid of [m.team1Id, m.team2Id]) {
          if (!tid || tid === 'BYE' || tid === 'TBD') continue;
          assert(!ids.has(tid), `${label}: duplicate ${tid} in ${dt} round ${ri}`);
          ids.add(tid);
        }
      });
    });
  }
}

function dumpFinalInvariants(ev, label) {
  // After all playable matches done, WCD should have no TBDs in unplayed slots.
  const wcd = ev.waterfallConsolationDraw;
  if (wcd && wcd.rounds) {
    wcd.rounds.forEach((round, ri) => {
      round.forEach(m => {
        const t1ok = m.team1Id && m.team1Id !== 'TBD';
        const t2ok = m.team2Id && m.team2Id !== 'TBD';
        assert(t1ok, `${label}: WCD R${ri+1} ${m.id} has TBD team1 after full play`);
        assert(t2ok, `${label}: WCD R${ri+1} ${m.id} has TBD team2 after full play`);
      });
    });
  }
}

function runTournament(seed, byeCount = 0) {
  // Seed Math.random for reproducibility
  let s = seed >>> 0 || 1;
  const orig = Math.random;
  Math.random = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    const ev = makeEvent('BS', byeCount);
    let safety = 0;
    while (true) {
      const ready = pickReadyMatches(ev);
      if (ready.length === 0) break;
      // play one random match
      const m = ready[Math.floor(Math.random() * ready.length)];
      playMatch(ev, m);
      dumpInvariants(ev, `seed=${seed} byes=${byeCount}`);
      if (++safety > 500) { failures++; console.error('safety break'); break; }
    }
    dumpFinalInvariants(ev, `seed=${seed} byes=${byeCount}`);
    return ev;
  } finally {
    Math.random = orig;
  }
}

function testCdR1Stability() {
  // Bug 3: a CD R1 placement, once made via natural feed, should never
  // change as additional MD R1 matches complete.
  for (let seed = 1; seed <= 20; seed++) {
    let s = seed >>> 0;
    const orig = Math.random;
    Math.random = () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    try {
      const ev = makeEvent('BS', 4);
      const cdR1 = ev.consolationDraw.rounds[0];
      const snapshots = []; // record (matchId, team1Id, team2Id) after each MD R1 played
      const mdR1Order = [...ev.mainDraw.rounds[0].keys()].sort(() => Math.random() - 0.5);
      for (const idx of mdR1Order) {
        const m = ev.mainDraw.rounds[0][idx];
        if (m.isComplete) continue;
        if (m.team1Id === 'BYE' || m.team2Id === 'BYE') continue;
        playMatch(ev, m);
        const snap = cdR1.map(c => `${c.id}:${c.team1Id || '_'}|${c.team2Id || '_'}`).join('\n');
        snapshots.push(snap);
      }
      // Compare the last snapshot's "real-team-where" mapping to all earlier
      // ones: a real team that appeared in slot X must still be in slot X.
      const place = (snap) => {
        const map = new Map();
        snap.split('\n').forEach(line => {
          const [id, slots] = line.split(':');
          const [a, b] = slots.split('|');
          if (a && a !== '_' && a !== 'BYE') map.set(a, `${id}/1`);
          if (b && b !== '_' && b !== 'BYE') map.set(b, `${id}/2`);
        });
        return map;
      };
      const finalMap = place(snapshots[snapshots.length - 1]);
      for (let k = 0; k < snapshots.length - 1; k++) {
        const earlier = place(snapshots[k]);
        for (const [tid, slot] of earlier) {
          const finalSlot = finalMap.get(tid);
          assert(finalSlot === slot, `bug3: ${tid} moved from ${slot} to ${finalSlot} (snapshot ${k})`);
        }
      }
    } finally {
      Math.random = orig;
    }
  }
}

function testWcdEventuallyResolves() {
  // Bug 1: after every CD match plays out, WCD R1 must have no TBDs.
  for (let seed = 1; seed <= 20; seed++) {
    let s = seed >>> 0;
    const orig = Math.random;
    Math.random = () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    try {
      const ev = makeEvent('BS', 0);
      // Play only MD and CD matches to completion (skip WCD).
      let safety = 0;
      while (safety++ < 500) {
        const ready = [];
        for (const draw of [ev.mainDraw, ev.consolationDraw]) {
          for (const round of draw.rounds) {
            for (const m of round) {
              if (m.isComplete || !m.team1Id || !m.team2Id) continue;
              if (m.team1Id === 'BYE' || m.team2Id === 'BYE' || m.team1Id === 'TBD' || m.team2Id === 'TBD') continue;
              ready.push(m);
            }
          }
        }
        if (ready.length === 0) break;
        playMatch(ev, ready[Math.floor(Math.random() * ready.length)]);
      }
      // Force one final populate
      ctx.populateAllDraws(ev);
      // Verify WCD R1 has no TBDs
      const wcdR1 = ev.waterfallConsolationDraw.rounds[0];
      wcdR1.forEach(m => {
        assert(m.team1Id && m.team1Id !== 'TBD', `bug1: ${m.id} team1 still TBD after CD complete (got ${m.team1Id})`);
        assert(m.team2Id && m.team2Id !== 'TBD', `bug1: ${m.id} team2 still TBD after CD complete (got ${m.team2Id})`);
      });
    } finally {
      Math.random = orig;
    }
  }
}

function testResetCascade() {
  // Play through MD R1 + R2, then reset an MD R1 match and check that the
  // displaced loser is no longer present in CD R1.
  const ev = makeEvent('BS', 0);
  // Play all of MD R1 first
  for (const m of ev.mainDraw.rounds[0]) {
    if (m.team1Id === 'BYE' || m.team2Id === 'BYE' || m.isBye) continue;
    playMatch(ev, m);
  }
  // Pick the first played MD R1 match and reset it
  const target = ev.mainDraw.rounds[0].find(m => m.isComplete && !m.isBye);
  if (!target) return;
  const displacedLoser = target.loserId;
  ctx.resetMatchAndCascade(ev, target.id);
  ctx.populateAllDraws(ev);
  // The displaced loser should no longer be in any CD/WCD slot until target
  // is replayed.
  for (const draw of [ev.consolationDraw, ev.waterfallConsolationDraw]) {
    if (!draw || !draw.rounds) continue;
    for (const round of draw.rounds) {
      for (const m of round) {
        assert(m.team1Id !== displacedLoser, `cascade: loser ${displacedLoser} still in ${m.id} team1`);
        assert(m.team2Id !== displacedLoser, `cascade: loser ${displacedLoser} still in ${m.id} team2`);
      }
    }
  }
}

function testFeature1Add() {
  const ev = makeEvent('BS', 8); // 8 byes
  const byeIdx = ev.teams.findIndex(t => t.id === 'BYE');
  if (byeIdx < 0) return;
  // simulate handleAddPlayer logic
  const newId = `BS_late_${Date.now()}_xxx`;
  ev.teams[byeIdx] = {
    id: newId, name: 'LateEntry', customDisplayName: '',
    originalPlayerSlot: byeIdx, mainDrawLosses: 0, consolationLosses: 0
  };
  const mdR1Idx = Math.floor(byeIdx / 2);
  const m = ev.mainDraw.rounds[0][mdR1Idx];
  if (m) {
    m.team1Id = null; m.team2Id = null;
    m.score1 = []; m.score2 = [];
    m.winnerId = null; m.loserId = null;
    m.isComplete = false; m.isBye = false;
    m.marshalled = false;
    ctx.resetMatchAndCascade(ev, m.id);
  }
  ctx.populateAllDraws(ev);
  assert(m.team1Id === newId || m.team2Id === newId, 'feature1: late entry placed in MD R1');
}

function testFeature2Manual() {
  const ev = makeEvent('BS', 0);
  // Manually reset WCD R1.1 with custom names
  const target = ev.waterfallConsolationDraw.rounds[0][0];
  ctx.resetMatchAndCascadeInDraw(ev, target.id, 'WCD');
  target.team1Id = null; target.team2Id = null;
  target.score1 = []; target.score2 = [];
  target.winnerId = null; target.loserId = null;
  target.isComplete = false; target.isBye = false;
  target.manualOverride = true;
  if (!ev.adhocTeams) ev.adhocTeams = [];
  const id1 = `BS_adhoc_a1`;
  const id2 = `BS_adhoc_a2`;
  ev.adhocTeams.push({ id: id1, name: 'Custom A', customDisplayName: '', originalPlayerSlot: -1, mainDrawLosses: 0, consolationLosses: 0 });
  ev.adhocTeams.push({ id: id2, name: 'Custom B', customDisplayName: '', originalPlayerSlot: -1, mainDrawLosses: 0, consolationLosses: 0 });
  target.team1Id = id1;
  target.team2Id = id2;
  ctx.populateAllDraws(ev);
  // After populate, the manual override should still hold.
  assert(target.team1Id === id1, 'feature2: manual team1 preserved');
  assert(target.team2Id === id2, 'feature2: manual team2 preserved');
  // populateWaterfallDynamic should not reshuffle WCD — the manual override
  // exempts it from eligibility-based clearing.
  assert(target.manualOverride === true, 'feature2: manualOverride flag preserved');
  // findTeamById should locate adhoc teams
  const found = ctx.findTeamById(ev, id1);
  assert(found && found.name === 'Custom A', 'feature2: findTeamById finds adhoc team');
}

function testManualMode() {
  // Toggling manual mode must:
  //   - preserve every existing team1Id/team2Id, score, winner, isComplete, isBye flag
  //   - cause populateAllDraws to be a no-op afterward (no auto-fill of TBDs, no
  //     auto-completion of new BYEs, no waterfall placement)
  //   - allow manual editing via direct match.team1Id / team2Id mutation, then
  //     keep the mutation stable across populate calls
  const ev = makeEvent('BS', 4);
  // Play half of MD R1 to exercise both played and pending matches
  let played = 0;
  for (const m of ev.mainDraw.rounds[0]) {
    if (m.team1Id === 'BYE' || m.team2Id === 'BYE' || m.isBye) continue;
    if (played >= 4) break;
    playMatch(ev, m);
    played++;
  }
  ctx.populateAllDraws(ev);

  // Snapshot the entire state shape
  const snap = JSON.stringify(ev);

  // Turn on manual mode
  ev.manualMode = true;

  // Run populateAllDraws — should be a complete no-op
  ctx.populateAllDraws(ev);
  ev.manualMode = true;
  assert(JSON.stringify(ev) === JSON.stringify({ ...JSON.parse(snap), manualMode: true }),
    'manualMode: populateAllDraws is a no-op after toggle ON');

  // Manually populate a CD R1 match's empty slot with an adhoc team
  const cd1 = ev.consolationDraw.rounds[0][0];
  // ensure adhocTeams exists
  if (!ev.adhocTeams) ev.adhocTeams = [];
  const adId = 'BS_manual_test_1';
  ev.adhocTeams.push({ id: adId, name: 'Manual Player A', customDisplayName: '',
    originalPlayerSlot: -1, mainDrawLosses: 0, consolationLosses: 0 });
  cd1.team1Id = adId;

  // populate again — manual entry must persist
  ctx.populateAllDraws(ev);
  assert(cd1.team1Id === adId, 'manualMode: manually-set team1Id persists across populate');

  // findTeamById should find adhoc
  const found = ctx.findTeamById(ev, adId);
  assert(found && found.name === 'Manual Player A', 'manualMode: findTeamById resolves adhoc team');

  // Toggle off — populate runs and may fill TBDs from sources, but it must
  // NOT clobber the manually-set adId (since adId came from sources for cd1
  // — actually cd1 source is loser of M1.1; if M1.1 isn't played, cd1 should
  // keep adId. If M1.1 is played, cd1.team1Id was already adId so source
  // resolution skips it). Verify the manual adId stays.
  ev.manualMode = false;
  ctx.populateAllDraws(ev);
  assert(cd1.team1Id === adId, 'manualMode: turning OFF preserves manually-set teamIds (no overwrite)');
}

function testManualModeStability() {
  // Manual mode must not reshuffle WCD R1 even when eligibility changes.
  const ev = makeEvent('BS', 0);
  // Play to a state where WCD R1 has placements
  let safety = 0;
  while (safety++ < 80) {
    const ready = pickReadyMatches(ev);
    if (ready.length === 0) break;
    playMatch(ev, ready[0]);
  }
  // Capture WCD R1 state
  const wcdR1 = ev.waterfallConsolationDraw.rounds[0];
  const beforeSnap = wcdR1.map(m => `${m.id}:${m.team1Id}|${m.team2Id}:${m.isComplete}`).join(';');
  // Turn on manual mode
  ev.manualMode = true;
  ctx.populateAllDraws(ev);
  const afterSnap = wcdR1.map(m => `${m.id}:${m.team1Id}|${m.team2Id}:${m.isComplete}`).join(';');
  assert(beforeSnap === afterSnap, 'manualMode: WCD R1 state preserved when toggling on');
}

console.log('=== Stress tournament runs ===');
for (let s = 1; s <= 30; s++) {
  for (const byes of [0, 4, 8, 12]) {
    runTournament(s * 1000003, byes);
  }
}
console.log('=== Bug 3: CD R1 stability ===');
testCdR1Stability();
console.log('=== Bug 1: WCD eventually resolves ===');
testWcdEventuallyResolves();
console.log('=== Reset cascade ===');
testResetCascade();
console.log('=== Feature 1 (add player) ===');
testFeature1Add();
console.log('=== Feature 2 (manual populate) ===');
testFeature2Manual();
console.log('=== Feature 3 (manual mode toggle) ===');
testManualMode();
testManualModeStability();

console.log(`\n${assertions} assertions, ${failures} failures`);
if (failures > 0) process.exit(1);
