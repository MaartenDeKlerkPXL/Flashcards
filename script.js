// ─── Subject Config ───
const SUBJECTS = {
  espanol: {
    stateKey: "espanol_v2",
    dataFile: "data.json",
    title: "Español",
    goalType: "daily",
    dailyGoal: 20,
    targetDate: "2027-04-01",
    targetLabel: "vakantie",
    targetStart: "2026-09-23",
    hasLevels: true,
    levelCount: 20,
    levelVersion: 2,
    esNlTarget: 3,        // zo vaak goed bij ES → NL voordat een woord naar NL → ES gaat
    requeueWrong: 3,      // fout woord komt na zoveel kaarten terug
    requeueCorrect: 6,    // goed (maar nog niet klaar) woord komt na zoveel kaarten terug
  },
  pm: {
    stateKey: "pm_v1",
    dataFile: "pm-data.json",
    title: "Project Management",
    goalType: "weekly",
    weeklyGoalMin: 2,
    weeklyGoalRec: 3,
    cardsPerSession: 35,
    targetDate: "2027-01-01",
    targetLabel: "examen",
    targetStart: "2026-09-23",
    leitnerIntervals: [0, 2, 5, 10, 21, 42],
    hasLevels: false,
    reviewPercent: 0.30,
  },
};

let currentSubject = "espanol";
let allWords = [];
let queue = [];
let currentIndex = 0;
let revealed = false;
let practiceMode = "es-nl";
let activeCategory = null;
let activeLevel = 1;
let reviewMode = false;          // Español: fase-doel gehaald, eindeloos herhalen
let answered = false;            // Español: huidige kaart is al nagekeken
let pendingWrong = false;        // Español: fout antwoord, wacht op "Verder"
let pendingTransition = null;    // Español: "phase1" of "level" na het laatste antwoord
let clozeTimer = null;
const clozeCache = new Map();
let sessionCards = 0;
let rating = false; // voorkomt dubbele beoordeling van dezelfde kaart

const $ = (id) => document.getElementById(id);

function cfg() { return SUBJECTS[currentSubject]; }

// ─── Date utils ───
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function daysBetween(a, b) {
  const da = new Date(a), db = new Date(b);
  return Math.round((db - da) / 86400000);
}

function getWeekStart(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ─── State ───
function loadState() {
  try { return migrateState(JSON.parse(localStorage.getItem(cfg().stateKey)) || defaultState()); }
  catch { return defaultState(); }
}

function defaultState() {
  if (currentSubject === "pm") {
    return { wordProgress: {}, sessions: [], history: [], weekStats: { week: getWeekStart(todayStr()), sessionCount: 0 }, todayStats: { date: todayStr(), correctCount: 0 } };
  }
  return { wordProgress: {}, currentLevel: 1, completedLevels: [], levelVersion: cfg().levelVersion, streak: { count: 0, lastCompletedDate: null }, todayStats: { date: todayStr(), correctCount: 0 }, history: [] };
}

function migrateState(state) {
  if (currentSubject === "espanol") {
    if (state.streak && state.streak.lastDate && !state.streak.lastCompletedDate) {
      if (state.todayStats.correctCount >= cfg().dailyGoal) {
        state.streak.lastCompletedDate = state.todayStats.date;
      }
      delete state.streak.lastDate;
    }
    if (state.levelVersion !== cfg().levelVersion) {
      // Level indeling is gewijzigd: voltooide levels herberekenen op basis van woordvoortgang
      state.completedLevels = [];
      let lvl = 1;
      while (lvl < cfg().levelCount && wordsForLevel(lvl).every((w) => getWP(state, w.id).box >= 3)) {
        state.completedLevels.push(lvl);
        lvl++;
      }
      state.currentLevel = lvl;
      state.levelVersion = cfg().levelVersion;
    }
  }
  if (!state.history) state.history = [];
  if (currentSubject === "pm") {
    if (!state.sessions) state.sessions = [];
    if (!state.weekStats) state.weekStats = { week: getWeekStart(todayStr()), sessionCount: 0 };
  }
  if (!state.todayStats) state.todayStats = { date: todayStr(), correctCount: 0 };
  return state;
}

function saveState(s) {
  try { localStorage.setItem(cfg().stateKey, JSON.stringify(s)); } catch {}
}

function getWP(state, id) {
  const wp = state.wordProgress[id] || { box: 0, nextReview: todayStr(), lastReviewed: null, correctCount: 0 };
  if (currentSubject === "espanol") {
    // esCorrect: aantal keer goed bij ES → NL · nlCorrect: aantal keer goed bij NL → ES
    // Oude voortgang: keren "makkelijk" in Flashcards tellen mee voor ES → NL
    if (wp.esCorrect === undefined) wp.esCorrect = Math.min(cfg().esNlTarget, wp.correctCount || 0);
    if (wp.nlCorrect === undefined) wp.nlCorrect = 0;
  }
  return wp;
}

// ─── Streak / Weekly goal ───
function updateStreak(state) {
  const today = todayStr();
  if (currentSubject === "espanol") {
    const s = state.streak;
    if (state.todayStats.date !== today) {
      const yesterday = addDays(today, -1);
      if (s.lastCompletedDate && s.lastCompletedDate !== yesterday && s.lastCompletedDate !== today) {
        s.count = 0;
      }
      state.todayStats = { date: today, correctCount: 0 };
    }
  } else {
    if (state.todayStats.date !== today) {
      state.todayStats = { date: today, correctCount: 0 };
    }
    const currentWeek = getWeekStart(today);
    if (state.weekStats.week !== currentWeek) {
      state.weekStats = { week: currentWeek, sessionCount: 0 };
    }
  }
}

function checkStreakGoal(state) {
  if (currentSubject === "espanol") {
    const today = todayStr();
    const s = state.streak;
    if (state.todayStats.correctCount >= cfg().dailyGoal && s.lastCompletedDate !== today) {
      s.count++;
      s.lastCompletedDate = today;
      addHistory(state, today, state.todayStats.correctCount);
    }
  }
}

function checkPMSession(state) {
  if (currentSubject !== "pm") return;
  const today = todayStr();
  const alreadyToday = state.sessions.some((s) => s.date === today);
  if (!alreadyToday && sessionCards >= cfg().cardsPerSession) {
    state.sessions.push({ date: today, cards: sessionCards });
    const currentWeek = getWeekStart(today);
    if (state.weekStats.week === currentWeek) {
      state.weekStats.sessionCount++;
    }
    if (state.sessions.length > 100) state.sessions = state.sessions.slice(-50);
    saveState(state);
  }
}

function addHistory(state, date, count) {
  const existing = state.history.find((h) => h.date === date);
  if (existing) existing.count = count;
  else state.history.push({ date, count });
  if (state.history.length > 90) state.history.shift();
}

// ─── Level/Chapter helpers ───
function getChapters() {
  const chapters = new Set();
  allWords.forEach((w) => chapters.add(w.chapter || w.level));
  return [...chapters].sort((a, b) => a - b);
}

function wordsForLevel(lvl) {
  if (currentSubject === "pm") return allWords.filter((w) => w.chapter === lvl);
  return allWords.filter((w) => w.level === lvl);
}

function isLevelUnlocked(state, lvl) {
  if (currentSubject === "pm") return wordsForLevel(lvl).length > 0;
  return lvl <= (state.currentLevel || 1);
}

function isLevelCompleted(state, lvl) {
  if (currentSubject === "pm") return false;
  return (state.completedLevels || []).includes(lvl);
}

// Español: fase 1 = elk woord 3× goed bij ES → NL, fase 2 = elk woord 1× goed bij NL → ES
function phase1Done(state, lvl) {
  return wordsForLevel(lvl).every((w) => getWP(state, w.id).esCorrect >= cfg().esNlTarget);
}

function phase2Done(state, lvl) {
  return wordsForLevel(lvl).every((w) => getWP(state, w.id).nlCorrect >= 1);
}

function isNlUnlocked(state, lvl) {
  return isLevelCompleted(state, lvl) || phase1Done(state, lvl);
}

function defaultPracticeMode(state, lvl) {
  if (!phase1Done(state, lvl)) return "es-nl";
  if (!phase2Done(state, lvl)) return "nl-es";
  return "es-nl";
}

function isMastered(state, w) {
  const wp = getWP(state, w.id);
  if (currentSubject === "pm") return wp.box >= 3;
  return wp.esCorrect >= cfg().esNlTarget && wp.nlCorrect >= 1;
}

function getCategoriesForLevel(lvl) {
  const cats = new Set();
  wordsForLevel(lvl).forEach((w) => cats.add(w.category));
  return [...cats].sort();
}

// ─── Queue building ───
function buildQueue(state, lvl) {
  if (currentSubject === "pm") {
    return buildPMQueue(state, lvl);
  }

  return buildEspanolQueue(state, lvl);
}

function phaseGoalMet(state, w) {
  const wp = getWP(state, w.id);
  return practiceMode === "nl-es" ? wp.nlCorrect >= 1 : wp.esCorrect >= cfg().esNlTarget;
}

// Fase-modus: alleen woorden die het doel nog niet halen (al begonnen woorden eerst).
// Is het doel voor alle woorden gehaald, dan eindeloos herhalen (zwakste woorden eerst).
function buildEspanolQueue(state, lvl) {
  let words = wordsForLevel(lvl);
  if (activeCategory) words = words.filter((w) => w.category === activeCategory);

  if (practiceMode === "cloze") {
    reviewMode = false;
    words = words.filter((w) => getWP(state, w.id).esCorrect >= cfg().esNlTarget && clozeFor(w));
    shuffle(words);
    return words;
  }
  if (practiceMode === "nl-es" && !isNlUnlocked(state, lvl)) { reviewMode = false; return []; }

  const open = words.filter((w) => !phaseGoalMet(state, w));
  reviewMode = open.length === 0;
  if (!reviewMode) {
    const started = open.filter((w) => getWP(state, w.id).lastReviewed);
    const fresh = open.filter((w) => !getWP(state, w.id).lastReviewed);
    shuffle(started); shuffle(fresh);
    return [...started, ...fresh];
  }
  const all = [...words];
  shuffle(all);
  all.sort((a, b) => getWP(state, a.id).box - getWP(state, b.id).box);
  return all;
}

// Woord na het antwoord terug in de wachtrij zetten als het doel nog niet gehaald is
function requeue(state, word, correct) {
  const done = practiceMode === "cloze" || reviewMode ? correct : phaseGoalMet(state, word);
  if (done) return;
  const gap = correct ? cfg().requeueCorrect : cfg().requeueWrong;
  queue.splice(Math.min(currentIndex + 1 + gap, queue.length), 0, word);
}

function buildPMQueue(state, lvl) {
  const today = todayStr();
  let cards;

  if (lvl === 0) {
    cards = allWords.filter((w) => getWP(state, w.id).nextReview <= today);
  } else {
    const chapterCards = wordsForLevel(lvl).filter((w) => getWP(state, w.id).nextReview <= today);
    const otherCards = allWords.filter((w) => w.chapter !== lvl && getWP(state, w.id).nextReview <= today);
    shuffle(otherCards);
    const reviewCount = Math.max(3, Math.ceil(chapterCards.length * cfg().reviewPercent));
    cards = [...chapterCards, ...otherCards.slice(0, reviewCount)];
  }

  if (activeCategory) cards = cards.filter((w) => w.category === activeCategory);

  if (practiceMode === "begrippen") cards = cards.filter((w) => w.type === "definition");
  else if (practiceMode === "vragen") cards = cards.filter((w) => ["open", "case", "multichoice"].includes(w.type));
  else if (practiceMode === "invullen") cards = cards.filter((w) => ["fillin", "order"].includes(w.type));

  const unique = [...new Map(cards.map((w) => [w.id, w])).values()];
  shuffle(unique);
  return unique.slice(0, cfg().cardsPerSession);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ─── Audio (Español only) ───
function playAudio(word) {
  const audio = new Audio(`audio/audio-${word.id}.mp3`);
  audio.play().catch(() => {
    if ("speechSynthesis" in window) {
      speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(word.spanish);
      utt.lang = "es-ES";
      utt.rate = 0.9;
      const voices = speechSynthesis.getVoices();
      const v = voices.find((v) => v.lang.startsWith("es"));
      if (v) utt.voice = v;
      speechSynthesis.speak(utt);
    }
  });
}

// ─── Answer checking (Español) ───
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => { const row = new Array(n + 1); row[0] = i; return row; });
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

const ARTICLES_ES = /^(el|la|los|las|un|una) /;
const ARTICLES_NL = /^(de|het|een) /;

function cleanAnswer(s) {
  return s.toLowerCase().replace(/[¿¡?!.,;:"]/g, "").replace(/\s+/g, " ").trim();
}

function stripAccents(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// "warm/heet" → warm, heet · "ik vind het lekker/leuk" → ik vind het lekker, ik vind het leuk · "zijn (toestand)" → zijn
function answerVariants(target, articles) {
  const base = target.replace(/\([^)]*\)/g, "");
  const parts = base.split("/").map(cleanAnswer).filter(Boolean);
  const variants = new Set([cleanAnswer(target), cleanAnswer(base)]);
  parts.forEach((part, i) => {
    if (i > 0 && !part.includes(" ") && parts[0].includes(" ")) variants.add(parts[0].replace(/\S+$/, part));
    else variants.add(part);
  });
  [...variants].forEach((v) => variants.add(v.replace(articles, "")));
  return [...variants].filter(Boolean);
}

// Returns "exact", "accent" (alleen accenten fout), "typo" (1 letter fout) of null
function checkAnswer(input, targets, articles) {
  const given = cleanAnswer(input);
  if (!given) return null;
  const variants = targets.flatMap((t) => answerVariants(t, articles));
  if (variants.includes(given)) return "exact";
  const plain = stripAccents(given);
  if (variants.some((v) => stripAccents(v) === plain)) return "accent";
  if (variants.some((v) => v.length >= 5 && levenshtein(stripAccents(v), plain) <= 1)) return "typo";
  return null;
}

function answerFeedback(result, correct) {
  if (result === "exact") return "Correct!";
  if (result === "accent") return `Goed! Let op de accenten: ${correct}`;
  return `Bijna goed! Het is: ${correct}`;
}

// ─── UI Updates ───
function renderModeBar() {
  const bar = $("modeBar");
  if (currentSubject === "pm") {
    bar.innerHTML = "";
    const pmModes = [
      { mode: "mix", label: "Mix" },
      { mode: "begrippen", label: "Begrippen" },
      { mode: "vragen", label: "Vragen" },
      { mode: "invullen", label: "Invullen" },
    ];
    pmModes.forEach((m) => {
      const btn = document.createElement("button");
      btn.className = "mode-btn" + (practiceMode === m.mode ? " active" : "");
      btn.dataset.mode = m.mode;
      btn.textContent = m.label;
      btn.addEventListener("click", () => {
        practiceMode = m.mode;
        renderModeBar();
        const state = loadState();
        currentIndex = 0;
        queue = buildQueue(state, activeLevel);
        showNext(state);
      });
      bar.appendChild(btn);
    });
  } else {
    bar.innerHTML = "";
    const state = loadState();
    const nlLocked = !isNlUnlocked(state, activeLevel);
    const esModes = [
      { mode: "es-nl", label: "ES → NL" },
      { mode: "nl-es", label: nlLocked ? "🔒 NL → ES" : "NL → ES", locked: nlLocked },
      { mode: "cloze", label: "Zinnen" },
    ];
    esModes.forEach((m) => {
      const btn = document.createElement("button");
      btn.className = "mode-btn" + (practiceMode === m.mode ? " active" : "") + (m.locked ? " locked" : "");
      btn.dataset.mode = m.mode;
      btn.textContent = m.label;
      btn.addEventListener("click", () => setEspanolMode(m.mode));
      bar.appendChild(btn);
    });
  }
}

function setEspanolMode(newMode) {
  practiceMode = newMode;
  pendingTransition = null;
  renderModeBar();
  const state = loadState();
  currentIndex = 0;
  queue = buildQueue(state, activeLevel);
  showNext(state);
}

function renderCategoryBar(state) {
  const cats = activeLevel === 0 ? getAllCategories() : getCategoriesForLevel(activeLevel);
  const bar = $("categoryBar");
  if (cats.length <= 1) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  bar.innerHTML = "";
  const allBtn = document.createElement("button");
  allBtn.className = "cat-btn" + (activeCategory === null ? " active" : "");
  allBtn.textContent = "Alles";
  allBtn.addEventListener("click", () => { activeCategory = null; rebuildAndShow(state); });
  bar.appendChild(allBtn);
  cats.forEach((cat) => {
    const btn = document.createElement("button");
    btn.className = "cat-btn" + (activeCategory === cat ? " active" : "");
    btn.textContent = cat;
    btn.addEventListener("click", () => { activeCategory = cat; rebuildAndShow(state); });
    bar.appendChild(btn);
  });
}

function getAllCategories() {
  const cats = new Set();
  allWords.forEach((w) => cats.add(w.category));
  return [...cats].sort();
}

function rebuildAndShow(state) {
  currentIndex = 0;
  queue = buildQueue(state, activeLevel);
  renderCategoryBar(state);
  showNext(state);
}

function renderLevelNav(state) {
  const nav = $("levelNav");
  nav.innerHTML = "";

  if (currentSubject === "pm") {
    const chapters = getChapters();
    const allBtn = document.createElement("button");
    allBtn.className = "level-btn" + (activeLevel === 0 ? " active" : "");
    allBtn.textContent = "∀";
    allBtn.title = "Alle hoofdstukken";
    allBtn.addEventListener("click", () => {
      activeLevel = 0;
      activeCategory = null;
      currentIndex = 0;
      queue = buildQueue(state, 0);
      renderLevelNav(state);
      renderCategoryBar(state);
      showNext(state);
    });
    nav.appendChild(allBtn);

    chapters.forEach((ch) => {
      const btn = document.createElement("button");
      btn.className = "level-btn" + (activeLevel === ch ? " active" : "");
      btn.textContent = "H" + ch;
      btn.title = allWords.find((w) => w.chapter === ch)?.chapterName || `Hoofdstuk ${ch}`;

      const words = wordsForLevel(ch);
      const mastered = words.filter((w) => getWP(state, w.id).box >= 3).length;
      if (mastered === words.length && words.length > 0) btn.classList.add("completed");

      btn.addEventListener("click", () => {
        activeLevel = ch;
        activeCategory = null;
        currentIndex = 0;
        queue = buildQueue(state, ch);
        renderLevelNav(state);
        renderCategoryBar(state);
        showNext(state);
      });
      nav.appendChild(btn);
    });
    return;
  }

  for (let i = 1; i <= cfg().levelCount; i++) {
    const btn = document.createElement("button");
    btn.className = "level-btn";
    btn.textContent = i;
    if (i === activeLevel) btn.classList.add("active");
    if (isLevelCompleted(state, i)) btn.classList.add("completed");
    else if (!isLevelUnlocked(state, i)) btn.classList.add("locked");
    else if (phase1Done(state, i)) btn.classList.add("phase-two");
    btn.addEventListener("click", () => {
      if (!isLevelUnlocked(state, i) && !isLevelCompleted(state, i)) return;
      goToLevel(i);
    });
    nav.appendChild(btn);
  }
  const activeBtn = nav.querySelector(".level-btn.active");
  if (activeBtn) nav.scrollLeft = activeBtn.offsetLeft - nav.offsetLeft - (nav.clientWidth - activeBtn.offsetWidth) / 2;
}

function goToLevel(lvl) {
  const state = loadState();
  activeLevel = lvl;
  activeCategory = null;
  pendingTransition = null;
  practiceMode = defaultPracticeMode(state, lvl);
  currentIndex = 0;
  queue = buildQueue(state, lvl);
  renderModeBar();
  renderLevelNav(state);
  renderCategoryBar(state);
  updateSessionProgress(state);
  showNext(state);
}

function updateStreakUI(state) {
  if (currentSubject === "espanol") {
    $("streakIcon").textContent = "🔥";
    $("streakCount").textContent = state.streak?.count || 0;
  } else {
    $("streakIcon").textContent = "📅";
    const ws = state.weekStats || { sessionCount: 0 };
    $("streakCount").textContent = `${ws.sessionCount}/${cfg().weeklyGoalMin}`;
  }
}

function updateDailyUI(state) {
  if (currentSubject === "espanol") {
    const count = state.todayStats.date === todayStr() ? state.todayStats.correctCount : 0;
    $("goalLabel").innerHTML = `<span id="dailyCount">${count}</span>/${cfg().dailyGoal} vandaag`;
    const chip = $("dailyGoal");
    if (count >= cfg().dailyGoal) chip.style.background = "rgba(46,204,113,.2)";
    else chip.style.background = "";
  } else {
    $("goalLabel").innerHTML = `${sessionCards}/${cfg().cardsPerSession} deze sessie`;
    const chip = $("dailyGoal");
    if (sessionCards >= cfg().cardsPerSession) chip.style.background = "rgba(46,204,113,.2)";
    else chip.style.background = "";
  }
}

function updateVacationUI() {
  const days = daysBetween(todayStr(), cfg().targetDate);
  const total = daysBetween(cfg().targetStart, cfg().targetDate);
  const elapsed = total - days;
  const pct = Math.min(100, Math.max(0, (elapsed / total) * 100));
  $("vacationLabel").textContent = days > 0 ? `${days} dagen tot ${cfg().targetLabel}` : `${cfg().targetLabel[0].toUpperCase() + cfg().targetLabel.slice(1)}!`;
  $("vacationFill").style.width = pct + "%";
}

function updateSessionProgress(state) {
  const sp = $("sessionProgress");
  sp.classList.remove("hidden");
  if (currentSubject === "espanol") {
    state = state || loadState();
    const words = wordsForLevel(activeLevel);
    const es = words.filter((w) => getWP(state, w.id).esCorrect >= cfg().esNlTarget).length;
    const nl = words.filter((w) => getWP(state, w.id).nlCorrect >= 1).length;
    let label, pct;
    if (isLevelCompleted(state, activeLevel)) { label = `Level ${activeLevel} voltooid ✓ — blijf herhalen`; pct = 100; }
    else if (es < words.length) { label = `Stap 1 · ES → NL: ${es}/${words.length} woorden ${cfg().esNlTarget}× goed`; pct = es / words.length * 50; }
    else { label = `Stap 2 · NL → ES: ${nl}/${words.length} woorden goed`; pct = 50 + nl / words.length * 50; }
    $("sessionLabel").textContent = label;
    $("sessionFill").style.width = pct + "%";
    return;
  }
  const pct = Math.min(100, (sessionCards / cfg().cardsPerSession) * 100);
  $("sessionLabel").textContent = `${sessionCards}/${cfg().cardsPerSession} deze sessie`;
  $("sessionFill").style.width = pct + "%";
}

function updateStatsUI(state) {
  const items = currentSubject === "pm" ? allWords : allWords.filter((w) => isLevelUnlocked(state, w.level));
  let nNew = 0, nLearn = 0, nMaster = 0;
  items.forEach((w) => {
    if (isMastered(state, w)) nMaster++;
    else if (getWP(state, w.id).box === 0) nNew++;
    else nLearn++;
  });
  $("statNew").textContent = nNew;
  $("statLearning").textContent = nLearn;
  $("statMastered").textContent = nMaster;
  $("statTotal").textContent = items.length;
}

// ─── Stats Panel ───
function showStatsPanel(state) {
  $("statsPanel").classList.remove("hidden");
  renderLeitnerChart(state);
  renderLevelChart(state);
  renderCategoryChart(state);
  renderStreakInfo(state);
  renderOverviewStats(state);
}

function renderLeitnerChart(state) {
  const counts = [0, 0, 0, 0, 0, 0];
  const items = currentSubject === "pm" ? allWords : allWords.filter((w) => isLevelUnlocked(state, w.level));
  items.forEach((w) => { counts[getWP(state, w.id).box]++; });
  const max = Math.max(...counts, 1);
  const labels = ["Nieuw", "Box 1", "Box 2", "Box 3", "Box 4", "Box 5"];
  const colors = ["var(--text-muted)", "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#27ae60"];
  $("leitnerChart").innerHTML = counts.map((c, i) => `
    <div class="leitner-bar-wrap">
      <div class="leitner-bar-count">${c}</div>
      <div class="leitner-bar" style="height:${(c / max) * 100}%;background:${colors[i]}"></div>
      <div class="leitner-bar-label">${labels[i]}</div>
    </div>
  `).join("");
}

function renderLevelChart(state) {
  $("levelChart").innerHTML = "";
  if (currentSubject === "pm") {
    $("levelChartTitle").textContent = "Voortgang per Hoofdstuk";
    getChapters().forEach((ch) => {
      const words = wordsForLevel(ch);
      const mastered = words.filter((w) => getWP(state, w.id).box >= 3).length;
      const pct = Math.round((mastered / words.length) * 100);
      const name = allWords.find((w) => w.chapter === ch)?.chapterName || `H${ch}`;
      $("levelChart").innerHTML += `
        <div class="level-chart-row">
          <div class="level-chart-label" style="width:auto">${name}</div>
          <div class="level-chart-bar-bg">
            <div class="level-chart-bar-fill" style="width:${pct}%;background:var(--accent)"></div>
          </div>
          <div class="level-chart-pct">${pct}%</div>
        </div>
      `;
    });
  } else {
    $("levelChartTitle").textContent = "Voortgang per Level";
    for (let i = 1; i <= cfg().levelCount; i++) {
      if (!isLevelUnlocked(state, i)) continue;
      const words = wordsForLevel(i);
      const mastered = words.filter((w) => isMastered(state, w)).length;
      const pct = Math.round((mastered / words.length) * 100);
      const color = isLevelCompleted(state, i) ? "var(--easy)" : "var(--accent)";
      $("levelChart").innerHTML += `
        <div class="level-chart-row">
          <div class="level-chart-label">${i}</div>
          <div class="level-chart-bar-bg">
            <div class="level-chart-bar-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <div class="level-chart-pct">${pct}%</div>
        </div>
      `;
    }
  }
}

function renderCategoryChart(state) {
  const catStats = {};
  const items = currentSubject === "pm" ? allWords : allWords.filter((w) => isLevelUnlocked(state, w.level));
  items.forEach((w) => {
    if (!catStats[w.category]) catStats[w.category] = { total: 0, hard: 0 };
    catStats[w.category].total++;
    const wp = getWP(state, w.id);
    if (wp.box < 2 && wp.lastReviewed) catStats[w.category].hard++;
  });
  const sorted = Object.entries(catStats)
    .map(([cat, s]) => ({ cat, pct: s.total > 0 ? Math.round((s.hard / s.total) * 100) : 0, hard: s.hard }))
    .filter((c) => c.hard > 0)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 8);
  if (sorted.length === 0) {
    $("categoryChart").innerHTML = '<div style="font-size:.85rem;color:var(--text-muted)">Nog geen data — begin met oefenen!</div>';
    return;
  }
  $("categoryChart").innerHTML = sorted.map((c) => `
    <div class="cat-chart-row">
      <div class="cat-chart-label">${c.cat}</div>
      <div class="cat-chart-bar-bg"><div class="cat-chart-bar-fill" style="width:${c.pct}%"></div></div>
      <div class="cat-chart-pct">${c.pct}%</div>
    </div>
  `).join("");
}

function renderStreakInfo(state) {
  if (currentSubject === "espanol") {
    $("streakTitle").textContent = "Streak Historie";
    const s = state.streak || { count: 0 };
    const todayDone = state.todayStats.date === todayStr() ? state.todayStats.correctCount : 0;
    $("streakInfo").innerHTML = `
      <div class="streak-info-row"><span class="streak-info-label">Huidige streak</span><span class="streak-info-value">🔥 ${s.count} ${s.count === 1 ? "dag" : "dagen"}</span></div>
      <div class="streak-info-row"><span class="streak-info-label">Vandaag</span><span class="streak-info-value">${todayDone} / ${cfg().dailyGoal} woorden</span></div>
      <div class="streak-info-row"><span class="streak-info-label">Laatste voltooide dag</span><span class="streak-info-value">${s.lastCompletedDate || "—"}</span></div>
    `;
  } else {
    $("streakTitle").textContent = "Week Overzicht";
    const ws = state.weekStats || { sessionCount: 0 };
    const totalSessions = state.sessions?.length || 0;
    const weekHistory = getWeekHistory(state);
    const weekRows = weekHistory.length > 0 ? weekHistory.map((w) => {
      const weekLabel = w.week === getWeekStart(todayStr()) ? "Deze week" : `Week ${w.week.slice(5)}`;
      const goalMet = w.count >= cfg().weeklyGoalMin;
      return `<div class="streak-info-row"><span class="streak-info-label">${weekLabel}</span><span class="streak-info-value">${goalMet ? "✅" : "⚠️"} ${w.count} sessie${w.count !== 1 ? "s" : ""}</span></div>`;
    }).join("") : "";
    $("streakInfo").innerHTML = `
      <div class="streak-info-row"><span class="streak-info-label">Deze week</span><span class="streak-info-value">📅 ${ws.sessionCount}/${cfg().weeklyGoalMin} sessies</span></div>
      <div class="streak-info-row"><span class="streak-info-label">Aanbevolen</span><span class="streak-info-value">${cfg().weeklyGoalRec}x per week</span></div>
      <div class="streak-info-row"><span class="streak-info-label">Totaal sessies</span><span class="streak-info-value">${totalSessions}</span></div>
      <div class="streak-info-row"><span class="streak-info-label">Kaarten per sessie</span><span class="streak-info-value">${cfg().cardsPerSession}</span></div>
      ${weekRows ? '<div style="margin-top:12px;font-size:.8rem;color:var(--text-muted);font-weight:600">WEEK HISTORIE</div>' + weekRows : ""}
    `;
  }
}

function renderOverviewStats(state) {
  const items = currentSubject === "pm" ? allWords : allWords.filter((w) => isLevelUnlocked(state, w.level));
  const total = allWords.length;
  const reviewed = items.filter((w) => getWP(state, w.id).lastReviewed).length;
  const mastered = items.filter((w) => isMastered(state, w)).length;
  const daysLeft = daysBetween(todayStr(), cfg().targetDate);

  if (currentSubject === "espanol") {
    const active = items.filter((w) => getWP(state, w.id).nlCorrect >= 1).length;
    const levelsComplete = (state.completedLevels || []).length;
    $("overviewStats").innerHTML = `
      <div class="overview-stat"><div class="overview-stat-value">${reviewed}</div><div class="overview-stat-label">Geoefend</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${mastered}</div><div class="overview-stat-label">Beheerst</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${active}</div><div class="overview-stat-label">Actief (NL → ES)</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${levelsComplete}/${cfg().levelCount}</div><div class="overview-stat-label">Levels klaar</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${total}</div><div class="overview-stat-label">Totaal woorden</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${daysLeft > 0 ? daysLeft : "0"}</div><div class="overview-stat-label">Dagen tot ${cfg().targetLabel}</div></div>
    `;
  } else {
    const chapters = getChapters();
    const typeCounts = {};
    allWords.forEach((w) => { typeCounts[w.type] = (typeCounts[w.type] || 0) + 1; });
    const typeLabels = { definition: "Begrippen", multichoice: "Meerkeuze", open: "Open", case: "Casus", fillin: "Invullen", order: "Volgorde" };
    const typeBreakdown = Object.entries(typeCounts).map(([t, c]) => `${typeLabels[t] || t}: ${c}`).join(" · ");
    const weeksGoalMet = getWeekHistory(state).filter((w) => w.count >= cfg().weeklyGoalMin).length;
    $("overviewStats").innerHTML = `
      <div class="overview-stat"><div class="overview-stat-value">${reviewed}</div><div class="overview-stat-label">Geoefend</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${mastered}</div><div class="overview-stat-label">Beheerst</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${chapters.length}</div><div class="overview-stat-label">Hoofdstukken</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${total}</div><div class="overview-stat-label">Totaal kaarten</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${daysLeft > 0 ? daysLeft : "0"}</div><div class="overview-stat-label">Dagen tot ${cfg().targetLabel}</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${state.sessions?.length || 0}</div><div class="overview-stat-label">Sessies totaal</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${weeksGoalMet}</div><div class="overview-stat-label">Weken doel gehaald</div></div>
      <div class="overview-stat" style="grid-column:1/-1"><div class="overview-stat-value" style="font-size:.85rem">${typeBreakdown}</div><div class="overview-stat-label">Kaarttypes</div></div>
    `;
  }
}

// ─── Card Rendering: Español ───
// ES → NL: Spaans tonen, Nederlands typen · NL → ES en Zinnen: Nederlands tonen, Spaans typen
function renderEspanolCard(word, state) {
  revealed = false;
  answered = false;
  pendingWrong = false;
  if (clozeTimer) { clearTimeout(clozeTimer); clozeTimer = null; }
  hideAllContainers();

  const toSpanish = practiceMode !== "es-nl";
  const showWord = toSpanish ? word.dutch : word.spanish;
  const hiddenWord = toSpanish ? word.spanish : word.dutch;
  const wp = getWP(state, word.id);

  let tag;
  if (reviewMode) tag = '<span class="card-tag">Herhaling</span>';
  else if (practiceMode === "es-nl") {
    const target = cfg().esNlTarget;
    const dots = Array.from({ length: target }, (_, i) => `<span class="dot${i < wp.esCorrect ? " on" : ""}"></span>`).join("");
    tag = `<span class="word-progress" title="${wp.esCorrect}/${target} keer goed">${dots}</span>`;
  } else if (practiceMode === "nl-es") tag = '<span class="card-tag">NL → ES</span>';
  else tag = '<span class="card-tag">Zinnen</span>';

  $("cardContainer").innerHTML = `
    <div class="flashcard">
      <img class="card-image" src="${word.image}" alt="" loading="eager" onerror="this.style.display='none'">
      <div class="card-body">
        <div class="card-tag-row">${tag}</div>
        <div class="word-spanish">${showWord}</div>
        <div class="word-dutch hidden" id="dutchWord">${hiddenWord}</div>
        <div class="word-example hidden" id="exampleWord">${word.example || ""}</div>
        <div class="card-actions">
          <button class="btn-icon${toSpanish ? " hidden" : ""}" id="btnAudio" aria-label="Audio">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
  $("btnAudio").addEventListener("click", () => playAudio(word));

  if (practiceMode === "cloze") { renderCloze(word); return; }
  $("typeContainer").classList.remove("hidden");
  $("typeInput").value = "";
  $("typeInput").readOnly = false;
  $("typeInput").placeholder = toSpanish ? "Typ het Spaanse woord..." : "Typ de Nederlandse vertaling...";
  $("typeFeedback").classList.add("hidden");
  $("typeInput").focus();
}

// ─── Card Rendering: PM ───
function renderPMCard(card, state) {
  revealed = false;
  hideAllContainers();

  const chapterLabel = card.chapterName ? `H${card.chapter}: ${card.chapterName}` : `Hoofdstuk ${card.chapter}`;

  switch (card.type) {
    case "definition": renderPMMultichoice(definitionAsMultichoice(card), state, chapterLabel, "Begrip"); break;
    case "multichoice": renderPMMultichoice(card, state, chapterLabel); break;
    case "open": renderPMOpen(card, chapterLabel); break;
    case "case": renderPMCase(card, chapterLabel); break;
    case "fillin": renderPMFillin(card, chapterLabel); break;
    case "order": renderPMOrder(card, state, chapterLabel); break;
    default: renderPMOpen(card, chapterLabel); break;
  }
}

function renderPMOpen(card, chapterLabel) {
  $("cardContainer").innerHTML = `
    <div class="pm-card">
      <div class="pm-card-body">
        <div class="pm-chapter-tag">${chapterLabel}</div>
        <span class="pm-card-type type-open">Open vraag</span>
        <div class="pm-question">${card.question}</div>
        <div class="pm-answer hidden" id="pmAnswer">${card.answer}</div>
        <div class="card-actions" style="margin-top:16px">
          <button class="btn-reveal" id="btnReveal">Toon antwoord</button>
        </div>
      </div>
    </div>
  `;
  $("btnReveal").addEventListener("click", () => revealPMCard("self"));
}

function renderPMCase(card, chapterLabel) {
  $("cardContainer").innerHTML = `
    <div class="pm-card">
      <div class="pm-card-body">
        <div class="pm-chapter-tag">${chapterLabel}</div>
        <span class="pm-card-type type-case">Casus</span>
        <div class="pm-situation">${card.situation}</div>
        <div class="pm-question">${card.question}</div>
        <div class="pm-answer hidden" id="pmAnswer">${card.answer}</div>
        <div class="card-actions" style="margin-top:16px">
          <button class="btn-reveal" id="btnReveal">Toon antwoord</button>
        </div>
      </div>
    </div>
  `;
  $("btnReveal").addEventListener("click", () => revealPMCard("self"));
}

// Begrip als meerkeuzevraag: omschrijving tonen, kiezen uit 4 begrippen.
// Foute opties komen uit hetzelfde hoofdstuk, bij voorkeur dezelfde categorie.
function definitionAsMultichoice(card) {
  const others = allWords.filter((w) => w.type === "definition" && w.id !== card.id && w.chapter === card.chapter);
  const sameCat = others.filter((w) => w.category === card.category);
  const rest = others.filter((w) => w.category !== card.category);
  shuffle(sameCat); shuffle(rest);
  const distractors = [...sameCat, ...rest].slice(0, 3).map((w) => w.term);

  // Woorden uit het begrip zelf in de omschrijving wegmaskeren, anders verraadt die het antwoord
  let question = card.definition;
  card.term.split(/[^\p{L}]+/u).filter((t) => t.length >= 4 && !/^project(en)?$/i.test(t)).forEach((t) => {
    question = question.replace(new RegExp(`(?<!\\p{L})${escapeRegex(t)}(?!\\p{L})`, "giu"), "…");
  });

  return {
    question: `<div class="pm-question-label">Welk begrip past bij deze omschrijving?</div>${question}`,
    options: [card.term, ...distractors],
    correct: 0,
    explanation: `${card.term}${card.hint ? ` — ${card.hint}` : ""}`,
  };
}

function renderPMMultichoice(card, state, chapterLabel, typeLabel = "Meerkeuze") {
  const letters = ["A", "B", "C", "D"];
  $("cardContainer").innerHTML = `
    <div class="pm-card">
      <div class="pm-card-body">
        <div class="pm-chapter-tag">${chapterLabel}</div>
        <span class="pm-card-type type-mc">${typeLabel}</span>
        <div class="pm-question">${card.question}</div>
      </div>
    </div>
  `;
  $("mcContainer").classList.remove("hidden");
  $("mcFeedback").classList.add("hidden");

  const shuffledOptions = card.options.map((opt, i) => ({ text: opt, originalIndex: i }));
  shuffle(shuffledOptions);

  $("mcOptions").innerHTML = shuffledOptions.map((opt, i) => `
    <button class="mc-option" data-idx="${opt.originalIndex}">
      <span class="mc-option-letter">${letters[i]}</span>${opt.text}
    </button>
  `).join("");

  $("mcOptions").querySelectorAll(".mc-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      const fb = $("mcFeedback");
      $("mcOptions").querySelectorAll(".mc-option").forEach((b) => b.classList.add("disabled"));

      if (idx === card.correct) {
        btn.classList.add("correct");
        fb.textContent = card.explanation || "Correct!";
        fb.className = "quiz-feedback correct";
        setTimeout(() => rateWord("easy", loadState()), 1000);
      } else {
        btn.classList.add("wrong");
        $("mcOptions").querySelector(`[data-idx="${card.correct}"]`).classList.add("correct");
        fb.textContent = card.explanation || "Fout!";
        fb.className = "quiz-feedback wrong";
        setTimeout(() => rateWord("hard", loadState()), 1500);
      }
    });
  });
}

function renderPMFillin(card, chapterLabel) {
  const sentenceHTML = card.sentence.replace("___", '<span class="pm-fillin-blank">___</span>');
  $("cardContainer").innerHTML = `
    <div class="pm-card">
      <div class="pm-card-body">
        <div class="pm-chapter-tag">${chapterLabel}</div>
        <span class="pm-card-type type-fillin">Invullen</span>
        <div class="pm-fillin-sentence">${sentenceHTML}</div>
      </div>
    </div>
  `;
  $("fillinContainer").classList.remove("hidden");
  $("fillinInput").value = "";
  $("fillinFeedback").classList.add("hidden");
  $("fillinInput").focus();
}

function renderPMOrder(card, state, chapterLabel) {
  $("cardContainer").innerHTML = `
    <div class="pm-card">
      <div class="pm-card-body">
        <div class="pm-chapter-tag">${chapterLabel}</div>
        <span class="pm-card-type type-order">Volgorde</span>
        <div class="pm-question">${card.question}</div>
      </div>
    </div>
  `;

  $("orderContainer").classList.remove("hidden");
  $("orderFeedback").classList.add("hidden");
  $("orderReset").classList.add("hidden");

  const shuffled = [...card.items];
  shuffle(shuffled);
  const placed = [];

  function renderOrderState() {
    $("orderPlaced").innerHTML = placed.map((item, i) => `
      <div class="order-slot"><span class="order-slot-num">${i + 1}</span>${item}</div>
    `).join("");

    $("orderOptions").innerHTML = shuffled
      .filter((item) => !placed.includes(item))
      .map((item) => `<button class="order-item">${item}</button>`)
      .join("");

    $("orderOptions").querySelectorAll(".order-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        placed.push(btn.textContent);
        renderOrderState();
        if (placed.length === card.items.length) checkOrderAnswer(card, placed);
      });
    });
  }

  renderOrderState();
}

function checkOrderAnswer(card, placed) {
  const correct = placed.every((item, i) => item === card.items[i]);
  const fb = $("orderFeedback");
  const container = $("orderPlaced");

  if (correct) {
    container.classList.add("order-correct");
    fb.textContent = card.explanation || "Correcte volgorde!";
    fb.className = "quiz-feedback correct";
    setTimeout(() => {
      container.classList.remove("order-correct");
      rateWord("easy", loadState());
    }, 1200);
  } else {
    container.classList.add("order-wrong");
    fb.textContent = `Fout! De juiste volgorde is: ${card.items.join(" → ")}`;
    fb.className = "quiz-feedback wrong";
    $("orderReset").classList.remove("hidden");
    $("orderReset").onclick = () => {
      container.classList.remove("order-wrong");
      rateWord("hard", loadState());
    };
    setTimeout(() => {
      container.classList.remove("order-wrong");
      rateWord("hard", loadState());
    }, 3000);
  }
}

function revealPMCard(ratingType) {
  if (revealed) return;
  revealed = true;
  const ans = $("pmAnswer");
  if (ans) ans.classList.remove("hidden");
  if (ratingType === "self") {
    $("ratingContainer3").classList.remove("hidden");
  } else {
    $("ratingContainer").classList.remove("hidden");
  }
}

function hideAllContainers() {
  $("ratingContainer").classList.add("hidden");
  $("ratingContainer3").classList.add("hidden");
  $("wrongActions").classList.add("hidden");
  $("typeContainer").classList.add("hidden");
  $("clozeContainer").classList.add("hidden");
  $("mcContainer").classList.add("hidden");
  $("fillinContainer").classList.add("hidden");
  $("orderContainer").classList.add("hidden");
}

// ─── Cloze (Español) ───
// Zoekt het woord in de voorbeeldzin. Geeft { html, answer } terug, of null als het woord
// (bv. een vervoegd werkwoord: "ser" → "Soy holandés") niet in de zin te vinden is.
function clozeFor(word) {
  if (clozeCache.has(word.id)) return clozeCache.get(word.id);
  let result = null;
  if (word.example) {
    const target = cleanAnswer(word.spanish).replace(ARTICLES_ES, "");
    const words = target.split(" ");
    const stem = target.replace(/(os|as|es|o|a|e)$/, "");
    const patterns = [words.map(escapeRegex).join("[\\s,]+") + "(?:e?s)?"];
    if (words.length > 1 && words[words.length - 1].length >= 3) patterns.push(escapeRegex(words[words.length - 1]));
    if (words.length === 1 && stem.length >= 3) patterns.push(escapeRegex(stem) + "\\p{L}*");
    for (const pat of patterns) {
      const m = new RegExp(`(?<!\\p{L})${pat}(?!\\p{L})`, "iu").exec(word.example);
      if (m) {
        const before = word.example.slice(0, m.index), after = word.example.slice(m.index + m[0].length);
        result = { html: `${before}<span class="cloze-blank">____</span>${after}`, answer: m[0] };
        break;
      }
    }
  }
  clozeCache.set(word.id, result);
  return result;
}

function clozeShowSentence(word) {
  if (clozeTimer) clearTimeout(clozeTimer);
  $("clozeSentence").textContent = word.example;
  $("clozeInput").classList.add("hidden");
  $("clozeSubmit").classList.add("hidden");
  $("btnPeek").classList.add("hidden");
  clozeTimer = setTimeout(() => {
    $("clozeSentence").innerHTML = clozeFor(word).html;
    $("clozeInput").classList.remove("hidden");
    $("clozeSubmit").classList.remove("hidden");
    $("btnPeek").classList.remove("hidden");
    $("clozeInput").focus();
  }, 5000);
}

function renderCloze(word) {
  $("clozeContainer").classList.remove("hidden");
  $("clozeTranslation").textContent = "";
  $("clozeInput").value = "";
  $("clozeInput").readOnly = false;
  $("clozeFeedback").classList.add("hidden");
  $("btnPeek").onclick = () => clozeShowSentence(word);
  clozeShowSentence(word);
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Español: vertaling, voorbeeldzin en audio tonen na het nakijken
function revealAnswer() {
  revealed = true;
  if (clozeTimer) { clearTimeout(clozeTimer); clozeTimer = null; }
  const d = $("dutchWord"), e = $("exampleWord"), a = $("btnAudio");
  if (d) d.classList.remove("hidden");
  if (e) e.classList.remove("hidden");
  if (a) a.classList.remove("hidden");
}

function animateOut(cb) {
  const card = document.querySelector(".flashcard, .pm-card");
  if (card) { card.classList.add("card-out"); setTimeout(cb, 250); }
  else cb();
}

// ─── Check answers ───
// Goed → na korte pauze "makkelijk". Fout → antwoord tonen en wachten op "Verder" ("moeilijk")
// of "Ik had het goed" (bv. een synoniem dat niet in de lijst staat).
function handleResult(word, result, correctText, feedbackEl, inputEl) {
  answered = true;
  inputEl.readOnly = true;
  revealAnswer();
  if (result) {
    feedbackEl.textContent = answerFeedback(result, correctText); feedbackEl.className = "quiz-feedback correct";
    setTimeout(() => recordAnswer(word, true), result === "exact" ? 900 : 1800);
  } else {
    feedbackEl.textContent = inputEl.value.trim() ? `Fout! Het is: ${correctText}` : `Het is: ${correctText}`;
    feedbackEl.className = "quiz-feedback wrong";
    pendingWrong = true;
    $("wrongActions").classList.remove("hidden");
  }
}

function checkTypedAnswer() {
  const word = queue[currentIndex];
  if (!word || answered) return;
  const toSpanish = practiceMode === "nl-es";
  const correctText = toSpanish ? word.spanish : word.dutch;
  const result = checkAnswer($("typeInput").value, [correctText], toSpanish ? ARTICLES_ES : ARTICLES_NL);
  handleResult(word, result, correctText, $("typeFeedback"), $("typeInput"));
}

function checkClozeAnswer() {
  const word = queue[currentIndex];
  const cloze = word && clozeFor(word);
  if (!cloze || answered || $("clozeInput").classList.contains("hidden")) return;
  const result = checkAnswer($("clozeInput").value, [cloze.answer, word.spanish], ARTICLES_ES);
  document.querySelectorAll(".cloze-blank").forEach((el) => el.textContent = cloze.answer);
  handleResult(word, result, cloze.answer, $("clozeFeedback"), $("clozeInput"));
}

function continueAfterWrong(override) {
  if (!pendingWrong) return;
  pendingWrong = false;
  $("wrongActions").classList.add("hidden");
  recordAnswer(queue[currentIndex], override);
}

function checkFillinAnswer(state) {
  const card = queue[currentIndex];
  if (!card) return;
  const input = $("fillinInput").value.trim().toLowerCase();
  const correct = card.answer.toLowerCase();
  const alts = (card.alternatives || []).map((a) => a.toLowerCase());
  const fb = $("fillinFeedback");
  if (input === correct || alts.includes(input)) {
    fb.textContent = "Correct!"; fb.className = "quiz-feedback correct";
    document.querySelectorAll(".pm-fillin-blank").forEach((el) => el.textContent = card.answer);
    setTimeout(() => rateWord("easy", loadState()), 800);
  } else {
    fb.textContent = `Fout! Het was: ${card.answer}`; fb.className = "quiz-feedback wrong";
    document.querySelectorAll(".pm-fillin-blank").forEach((el) => el.textContent = card.answer);
    setTimeout(() => rateWord("hard", loadState()), 1200);
  }
}

// ─── Rating ───
function rateWord(result, state) {
  const word = queue[currentIndex];
  if (!word || rating) return;
  rating = true;

  updateStreak(state); // dag kan omgeslagen zijn terwijl de app openstond
  const today = todayStr();
  const wp = getWP(state, word.id);
  const intervals = cfg().leitnerIntervals;

  if (result === "easy") {
    wp.box = Math.min(5, wp.box + 1);
    wp.nextReview = addDays(today, intervals[wp.box] || 42);
    const isNew = wp.correctCount === 0;
    wp.correctCount++;
    if (isNew) {
      if (state.todayStats.date === today) state.todayStats.correctCount++;
      else state.todayStats = { date: today, correctCount: 1 };
    }
  } else if (result === "partial") {
    wp.nextReview = addDays(today, 1);
  } else {
    wp.box = Math.max(1, wp.box - 1);
    wp.nextReview = addDays(today, intervals[1] || 1);
  }

  wp.lastReviewed = today;
  state.wordProgress[word.id] = wp;
  addHistory(state, today, state.todayStats.correctCount);
  saveState(state);

  sessionCards++;
  checkPMSession(state);
  updateSessionProgress();
  updateDailyUI(state);
  updateStatsUI(state);
  updateStreakUI(state);

  animateOut(() => { currentIndex++; showNext(state); });
}

// Español: goed = makkelijk (box omhoog), fout = moeilijk (box omlaag)
function recordAnswer(word, correct) {
  if (!word || rating || queue[currentIndex] !== word) return;
  rating = true;

  const state = loadState();
  updateStreak(state); // dag kan omgeslagen zijn terwijl de app openstond
  const today = todayStr();
  const wasPhase1 = phase1Done(state, activeLevel);
  const wp = getWP(state, word.id);

  if (correct) {
    wp.box = Math.min(5, wp.box + 1);
    if (wp.correctCount === 0) {
      state.todayStats.correctCount++; // dagdoel telt nieuwe woorden
      checkStreakGoal(state);
    }
    wp.correctCount++;
    if (practiceMode === "es-nl") wp.esCorrect++;
    if (practiceMode === "nl-es") wp.nlCorrect++;
  } else {
    wp.box = Math.max(1, wp.box - 1);
  }
  wp.lastReviewed = today;
  state.wordProgress[word.id] = wp;

  if (practiceMode === "es-nl" && !wasPhase1 && phase1Done(state, activeLevel)) {
    pendingTransition = "phase1";
  } else if (practiceMode === "nl-es" && !isLevelCompleted(state, activeLevel) && phase2Done(state, activeLevel)) {
    if (!state.completedLevels) state.completedLevels = [];
    state.completedLevels.push(activeLevel);
    state.currentLevel = Math.min(cfg().levelCount, Math.max(state.currentLevel || 1, activeLevel + 1));
    pendingTransition = "level";
  }

  addHistory(state, today, state.todayStats.correctCount);
  saveState(state);
  requeue(state, word, correct);

  updateDailyUI(state);
  updateStatsUI(state);
  updateStreakUI(state);
  updateSessionProgress(state);

  animateOut(() => { currentIndex++; showNext(state); });
}

// ─── Tussenschermen (Español) ───
function showPhase1Complete() {
  const n = wordsForLevel(activeLevel).length;
  $("cardContainer").innerHTML = `
    <div class="done-screen"><div class="done-icon">🎯</div><h2>Je hebt alle woorden gehad!</h2>
    <p>Alle ${n} woorden van Level ${activeLevel} heb je ${cfg().esNlTarget}× goed vertaald.<br>
    Nu andersom: je ziet het Nederlandse woord en typt het Spaans.<br>Heb je ze allemaal 1× goed, dan gaat Level ${activeLevel + 1} open.</p>
    <button class="btn-action" id="btnTransition">Volgende: NL → ES</button></div>
  `;
  $("btnTransition").addEventListener("click", () => setEspanolMode("nl-es"));
}

function showLevelComplete() {
  const last = activeLevel >= cfg().levelCount;
  $("cardContainer").innerHTML = `
    <div class="done-screen"><div class="done-icon">🏆</div><h2>Level ${activeLevel} voltooid!</h2>
    <p>Je kent alle woorden in beide richtingen.<br>${last ? "Dat was het laatste level — ¡felicidades!" : `Level ${activeLevel + 1} is nu ontgrendeld!`}</p>
    <button class="btn-action" id="btnTransition">${last ? "Blijf herhalen" : `Ga naar Level ${activeLevel + 1}`}</button></div>
  `;
  showSessionCelebration();
  $("btnTransition").addEventListener("click", () => goToLevel(Math.min(cfg().levelCount, activeLevel + 1)));
}

function showEspanolEmpty(state) {
  let icon = "📚", title, text, button = null;
  if (practiceMode === "nl-es") {
    const words = wordsForLevel(activeLevel);
    const es = words.filter((w) => getWP(state, w.id).esCorrect >= cfg().esNlTarget).length;
    icon = "🔒"; title = "NL → ES is nog op slot";
    text = `Vertaal eerst alle woorden van Level ${activeLevel} ${cfg().esNlTarget}× goed bij ES → NL.<br>Je bent op ${es}/${words.length}.`;
    button = { label: "Naar ES → NL", action: () => setEspanolMode("es-nl") };
  } else if (practiceMode === "cloze") {
    title = "Nog geen zinnen";
    text = `Zinnen gebruikt woorden die je al ${cfg().esNlTarget}× goed hebt bij ES → NL${activeCategory ? ` (${activeCategory})` : ""}.`;
    button = { label: "Naar ES → NL", action: () => setEspanolMode("es-nl") };
  } else {
    icon = "✅"; title = `Alle woorden van ${activeCategory} gehad`;
    text = "Ga verder met de andere woorden van dit level.";
    button = { label: "Verder met alle woorden", action: () => { activeCategory = null; rebuildAndShow(loadState()); } };
  }
  $("cardContainer").innerHTML = `
    <div class="done-screen"><div class="done-icon">${icon}</div><h2>${title}</h2><p>${text}</p>
    ${button ? `<button class="btn-action" id="btnTransition">${button.label}</button>` : ""}</div>
  `;
  if (button) $("btnTransition").addEventListener("click", button.action);
}

// ─── Show Next ───
function showNext(state) {
  rating = false;

  if (currentSubject === "espanol") {
    if (pendingTransition) {
      hideAllContainers();
      const t = pendingTransition;
      pendingTransition = null;
      renderModeBar();
      renderLevelNav(state);
      if (t === "phase1") showPhase1Complete();
      else showLevelComplete();
      return;
    }
    // Nooit "klaar voor vandaag": is de ronde op, dan begint een nieuwe ronde
    if (currentIndex >= queue.length) {
      currentIndex = 0;
      queue = buildQueue(state, activeLevel);
    }
    if (queue.length === 0) {
      hideAllContainers();
      showEspanolEmpty(state);
      renderLevelNav(state);
      return;
    }
    renderEspanolCard(queue[currentIndex], state);
    renderLevelNav(state);
    return;
  }

  if (currentIndex >= queue.length) {
    hideAllContainers();
    const sessionDone = sessionCards >= cfg().cardsPerSession;
    $("cardContainer").innerHTML = `
      <div class="done-screen">
        <div class="done-icon">${sessionDone ? "🎉" : "✅"}</div>
        <h2>${sessionDone ? "Sessie voltooid!" : "Alle kaarten gehad!"}</h2>
        <p>${sessionDone ? `Je hebt ${sessionCards} kaarten geoefend deze sessie.` : "Er zijn geen kaarten meer voor nu."}<br>
        ${sessionDone ? "Goed bezig! Kom over een paar dagen terug." : "Probeer later opnieuw of wissel van hoofdstuk."}</p>
      </div>
    `;
    if (sessionDone) showSessionCelebration();
    renderLevelNav(state);
    return;
  }

  renderPMCard(queue[currentIndex], state);
  renderLevelNav(state);
}

// ─── Subject switching ───
function switchSubject(subject) {
  if (subject === currentSubject && allWords.length > 0) return;
  currentSubject = subject;

  document.querySelectorAll(".subject-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.subject === subject);
  });

  $("pageTitle").innerHTML = `<span class="accent">${cfg().title}</span>`;
  document.title = `${cfg().title} — Leren`;
  updateKeyHints();

  practiceMode = "mix";
  activeCategory = null;
  pendingTransition = null;
  currentIndex = 0;
  sessionCards = 0;
  allWords = [];
  queue = [];

  fetch(cfg().dataFile)
    .then((r) => r.json())
    .then((data) => {
      allWords = data;
      const state = loadState();
      updateStreak(state);
      saveState(state);

      if (currentSubject === "pm") {
        activeLevel = 0;
      } else {
        activeLevel = state.currentLevel || 1;
        practiceMode = defaultPracticeMode(state, activeLevel);
      }

      queue = buildQueue(state, activeLevel);

      renderModeBar();
      renderCategoryBar(state);
      renderLevelNav(state);
      updateStreakUI(state);
      updateDailyUI(state);
      updateVacationUI();
      updateSessionProgress(state);
      updateStatsUI(state);
      showNext(state);
    });
}

// ─── Keyboard shortcuts ───
document.addEventListener("keydown", (e) => {
  if ($("statsPanel") && !$("statsPanel").classList.contains("hidden")) {
    if (e.key === "Escape") $("statsPanel").classList.add("hidden");
    return;
  }

  if (currentSubject === "espanol") {
    const word = queue[currentIndex];
    if (e.key === "Enter") {
      e.preventDefault();
      const transition = $("btnTransition");
      if (transition) transition.click();
      else if (pendingWrong) continueAfterWrong(false);
      else if (practiceMode === "cloze") checkClozeAnswer();
      else checkTypedAnswer();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (word && (answered || practiceMode === "es-nl")) playAudio(word);
    }
    return;
  }

  const card = queue[currentIndex];
  if (card?.type === "fillin" && e.key === "Enter") {
    e.preventDefault(); checkFillinAnswer(loadState()); return;
  }

  if (e.target.tagName === "INPUT") return; // spaties/pijltjes in invoervelden niet afvangen

  const state = loadState();
  switch (e.key) {
    case " ":
      e.preventDefault();
      if (["open", "case"].includes(card?.type)) revealPMCard("self");
      break;
    case "ArrowLeft":
      e.preventDefault();
      if (revealed) rateWord("hard", state);
      break;
    case "ArrowRight":
      e.preventDefault();
      if (revealed) rateWord("easy", state);
      break;
    case "ArrowDown":
      e.preventDefault();
      if (revealed) rateWord("partial", state);
      break;
  }
});

// ─── Event listeners ───
$("btnStats").addEventListener("click", () => showStatsPanel(loadState()));
$("btnCloseStats").addEventListener("click", () => $("statsPanel").classList.add("hidden"));
$("btnEasy").addEventListener("click", () => rateWord("easy", loadState()));
$("btnHard").addEventListener("click", () => rateWord("hard", loadState()));
$("btnGoed").addEventListener("click", () => rateWord("easy", loadState()));
$("btnDeels").addEventListener("click", () => rateWord("partial", loadState()));
$("btnNiet").addEventListener("click", () => rateWord("hard", loadState()));
$("typeSubmit").addEventListener("click", () => checkTypedAnswer());
$("clozeSubmit").addEventListener("click", () => checkClozeAnswer());
$("btnContinue").addEventListener("click", () => continueAfterWrong(false));
$("btnOverride").addEventListener("click", () => continueAfterWrong(true));
$("fillinSubmit").addEventListener("click", () => checkFillinAnswer(loadState()));

document.querySelectorAll(".subject-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchSubject(btn.dataset.subject));
});

// ─── Keyboard hints ───
function updateKeyHints() {
  const hints = $("keyHints");
  if (currentSubject === "pm") {
    hints.innerHTML = "<span>Spatie = toon</span><span>← niet geweten</span><span>↓ deels</span><span>→ goed</span>";
  } else {
    hints.innerHTML = "<span>Enter = controleer / verder</span><span>leeg + Enter = weet ik niet</span><span>↓ audio</span>";
  }
}

// ─── Session celebration ───
function showSessionCelebration() {
  const overlay = document.createElement("div");
  overlay.className = "celebration-overlay";
  overlay.innerHTML = '<div class="celebration-particles"></div>';
  document.body.appendChild(overlay);
  const particles = overlay.querySelector(".celebration-particles");
  const colors = ["#2ecc71", "#3498db", "#9b59b6", "#f1c40f", "#e74c3c", "#1abc9c"];
  for (let i = 0; i < 40; i++) {
    const p = document.createElement("div");
    p.className = "confetti";
    p.style.left = Math.random() * 100 + "%";
    p.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    p.style.animationDelay = Math.random() * 0.5 + "s";
    p.style.animationDuration = (1.5 + Math.random()) + "s";
    particles.appendChild(p);
  }
  setTimeout(() => overlay.remove(), 3000);
}

// ─── Week history ───
function getWeekHistory(state) {
  if (currentSubject !== "pm" || !state.sessions) return [];
  const weeks = {};
  state.sessions.forEach((s) => {
    const w = getWeekStart(s.date);
    if (!weeks[w]) weeks[w] = 0;
    weeks[w]++;
  });
  return Object.entries(weeks)
    .map(([week, count]) => ({ week, count }))
    .sort((a, b) => b.week.localeCompare(a.week))
    .slice(0, 8);
}

// ─── Init ───
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
switchSubject("espanol");
