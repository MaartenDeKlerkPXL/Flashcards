const STATE_KEY = "espanol_v2";
const DAILY_GOAL = 20;
const LEVELS = 10;
const WORDS_PER_LEVEL = 100;
const REVIEW_PERCENT = 0.15;
const VACATION_DATE = "2027-04-01";
const LEITNER_INTERVALS = [0, 1, 2, 4, 7, 14];

let allWords = [];
let queue = [];
let currentIndex = 0;
let revealed = false;
let mode = "practice";
let practiceMode = "flashcard"; // flashcard | type | reverse | cloze
let micMode = false;
let activeCategory = null;
let quizWords = [];
let quizIndex = 0;
let quizErrors = 0;
let activeLevel = 1;
let isListening = false;

const $ = (id) => document.getElementById(id);

// ─── Date utils (timezone-safe) ───
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

// ─── State ───
function loadState() {
  try { return migrateState(JSON.parse(localStorage.getItem(STATE_KEY)) || defaultState()); }
  catch { return defaultState(); }
}

function defaultState() {
  return { wordProgress: {}, currentLevel: 1, completedLevels: [], streak: { count: 0, lastCompletedDate: null }, todayStats: { date: todayStr(), correctCount: 0 }, history: [] };
}

function migrateState(state) {
  if (state.streak.lastDate && !state.streak.lastCompletedDate) {
    if (state.todayStats.correctCount >= DAILY_GOAL) {
      state.streak.lastCompletedDate = state.todayStats.date;
    }
    delete state.streak.lastDate;
  }
  if (!state.history) state.history = [];
  return state;
}

function saveState(s) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch {}
}

function getWP(state, id) {
  return state.wordProgress[id] || { box: 0, nextReview: todayStr(), lastReviewed: null, correctCount: 0, pronouncedCorrectly: false };
}

// ─── Streak ───
function updateStreak(state) {
  const today = todayStr();
  const s = state.streak;
  if (state.todayStats.date !== today) {
    const yesterday = addDays(today, -1);
    if (s.lastCompletedDate && s.lastCompletedDate !== yesterday && s.lastCompletedDate !== today) {
      s.count = 0;
    }
    state.todayStats = { date: today, correctCount: 0 };
  }
}

function checkStreakGoal(state) {
  const today = todayStr();
  const s = state.streak;
  if (state.todayStats.correctCount >= DAILY_GOAL && s.lastCompletedDate !== today) {
    s.count++;
    s.lastCompletedDate = today;
    addHistory(state, today, state.todayStats.correctCount);
  }
}

function addHistory(state, date, count) {
  const existing = state.history.find((h) => h.date === date);
  if (existing) existing.count = count;
  else state.history.push({ date, count });
  if (state.history.length > 90) state.history.shift();
}

// ─── Level helpers ───
function wordsForLevel(lvl) {
  return allWords.filter((w) => w.level === lvl);
}

function isLevelUnlocked(state, lvl) {
  return lvl <= state.currentLevel;
}

function isLevelCompleted(state, lvl) {
  return state.completedLevels.includes(lvl);
}

function isQuizReady(state, lvl) {
  if (isLevelCompleted(state, lvl)) return false;
  const words = wordsForLevel(lvl);
  return words.length > 0 && words.every((w) => {
    const wp = getWP(state, w.id);
    return wp.box >= 3;
  });
}

function getCategoriesForLevel(lvl) {
  const cats = new Set();
  wordsForLevel(lvl).forEach((w) => cats.add(w.category));
  return [...cats].sort();
}

// ─── Queue building ───
function buildQueue(state, lvl) {
  const today = todayStr();
  let levelWords;

  if (micMode) {
    levelWords = wordsForLevel(lvl).filter((w) => !getWP(state, w.id).pronouncedCorrectly);
    levelWords.sort((a, b) => getWP(state, b.id).box - getWP(state, a.id).box);
  } else {
    levelWords = wordsForLevel(lvl).filter((w) => {
      const wp = getWP(state, w.id);
      return wp.nextReview <= today;
    });
  }

  if (activeCategory) {
    levelWords = levelWords.filter((w) => w.category === activeCategory);
  }

  if (micMode) {
    return levelWords;
  }

  let reviewWords = [];
  if (lvl > 1 && !activeCategory) {
    const prevWords = allWords.filter((w) => w.level < lvl && isLevelUnlocked(state, w.level));
    const dueReview = prevWords.filter((w) => {
      const wp = getWP(state, w.id);
      return wp.nextReview <= today;
    });
    shuffle(dueReview);
    const reviewCount = Math.max(2, Math.ceil(levelWords.length * REVIEW_PERCENT));
    reviewWords = dueReview.slice(0, reviewCount);
  }

  const combined = [...levelWords, ...reviewWords];
  const unique = [...new Map(combined.map((w) => [w.id, w])).values()];
  shuffle(unique);
  return unique;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ─── Audio ───
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

// ─── Speech Recognition ───
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1);
    row[0] = i;
    return row;
  });
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function normalizeSpanish(s) {
  return s.toLowerCase()
    .replace(/^(el |la |los |las |un |una )/, "")
    .replace(/^[¿¡]+|[?!.,]+$/g, "")
    .trim();
}

function fuzzyMatch(heard, target) {
  const h = heard.toLowerCase().trim();
  const t = normalizeSpanish(target);
  const tFull = target.toLowerCase().trim();
  if (h === t || h === tFull || h.includes(t)) return true;
  const dist = levenshtein(h, t);
  const threshold = t.length <= 4 ? 1 : Math.ceil(t.length * 0.3);
  return dist <= threshold;
}

function showMicFeedback(micBtn, type, message) {
  let fb = $("micFeedback");
  if (!fb) {
    fb = document.createElement("div");
    fb.id = "micFeedback";
    fb.className = "mic-feedback";
    micBtn.parentNode.appendChild(fb);
  }
  fb.textContent = message;
  fb.className = "mic-feedback " + type;
  fb.classList.remove("hidden");
  if (type !== "listening") {
    setTimeout(() => fb.classList.add("hidden"), 3000);
  }
}

function startRecognition(word, state, onDone) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    const micBtn = $("btnMic");
    if (micBtn) showMicFeedback(micBtn, "error", "Mic niet beschikbaar in deze browser");
    return;
  }
  if (isListening) return;

  const recognition = new SR();
  recognition.lang = "es-ES";
  recognition.interimResults = true;
  recognition.maxAlternatives = 5;
  recognition.continuous = false;
  isListening = true;

  const micBtn = $("btnMic");
  if (micBtn) {
    micBtn.classList.add("active", "listening");
    showMicFeedback(micBtn, "listening", "Luisteren...");
  }

  let matched = false;
  let bestHeard = "";
  const timeout = setTimeout(() => {
    if (isListening) recognition.stop();
  }, 6000);

  recognition.onresult = (e) => {
    const allTranscripts = [];
    for (let i = 0; i < e.results.length; i++) {
      for (let j = 0; j < e.results[i].length; j++) {
        allTranscripts.push(e.results[i][j].transcript);
      }
    }

    bestHeard = allTranscripts[0] || "";
    matched = allTranscripts.some((t) => fuzzyMatch(t, word.spanish));

    if (e.results[0] && !e.results[0].isFinal) {
      if (micBtn) showMicFeedback(micBtn, "listening", `"${bestHeard.trim()}..."`);
    }
  };

  recognition.onend = () => {
    clearTimeout(timeout);
    isListening = false;
    if (micBtn) micBtn.classList.remove("active", "listening");

    if (matched) {
      const wp = getWP(state, word.id);
      wp.pronouncedCorrectly = true;
      state.wordProgress[word.id] = wp;
      saveState(state);
      if (micBtn) micBtn.classList.add("success");
      showMicFeedback(micBtn, "success", "Correct!");
      updatePronunciationUI(state);
      if (onDone) onDone(true);
    } else if (bestHeard.trim()) {
      showMicFeedback(micBtn, "error", `Ik hoorde "${bestHeard.trim()}" — probeer opnieuw`);
      if (onDone) onDone(false);
    } else {
      showMicFeedback(micBtn, "error", "Niet herkend — spreek duidelijker");
      if (onDone) onDone(false);
    }
  };

  recognition.onerror = (e) => {
    clearTimeout(timeout);
    isListening = false;
    if (micBtn) micBtn.classList.remove("active", "listening");
    const messages = {
      "not-allowed": "Microfoon geblokkeerd — sta toegang toe",
      "no-speech": "Geen spraak gedetecteerd — probeer opnieuw",
      "audio-capture": "Geen microfoon gevonden",
      "network": "Netwerkfout — check je verbinding"
    };
    showMicFeedback(micBtn, "error", messages[e.error] || "Fout — probeer opnieuw");
    if (onDone) onDone(false);
  };

  recognition.start();
}

// ─── UI Updates ───
function renderModeBar() {
  document.querySelectorAll(".mode-btn:not(.mic-toggle)").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === practiceMode);
  });
  $("modeMic").classList.toggle("active", micMode);
}

function renderCategoryBar(state) {
  const cats = getCategoriesForLevel(activeLevel);
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

function rebuildAndShow(state) {
  currentIndex = 0;
  queue = buildQueue(state, activeLevel);
  renderCategoryBar(state);
  showNext(state);
}

function renderLevelNav(state) {
  const nav = $("levelNav");
  nav.innerHTML = "";
  for (let i = 1; i <= LEVELS; i++) {
    const btn = document.createElement("button");
    btn.className = "level-btn";
    btn.textContent = i;
    if (i === activeLevel) btn.classList.add("active");
    if (isLevelCompleted(state, i)) btn.classList.add("completed");
    else if (!isLevelUnlocked(state, i)) btn.classList.add("locked");
    else if (isQuizReady(state, i)) btn.classList.add("quiz-ready");

    btn.addEventListener("click", () => {
      if (!isLevelUnlocked(state, i) && !isLevelCompleted(state, i)) return;
      activeLevel = i;
      activeCategory = null;
      mode = "practice";
      currentIndex = 0;
      queue = buildQueue(state, i);
      renderLevelNav(state);
      renderCategoryBar(state);
      showNext(state);
    });
    nav.appendChild(btn);
  }
}

function updateStreakUI(state) {
  $("streakCount").textContent = state.streak.count;
}

function updateDailyUI(state) {
  const count = state.todayStats.date === todayStr() ? state.todayStats.correctCount : 0;
  $("dailyCount").textContent = count;
  const chip = $("dailyGoal");
  if (count >= DAILY_GOAL) chip.style.background = "rgba(46,204,113,.2)";
  else chip.style.background = "";
}

function updateVacationUI() {
  const days = daysBetween(todayStr(), VACATION_DATE);
  const total = daysBetween("2026-09-23", VACATION_DATE);
  const elapsed = total - days;
  const pct = Math.min(100, Math.max(0, (elapsed / total) * 100));
  $("vacationLabel").textContent = days > 0 ? `${days} dagen tot vakantie` : "Vakantie!";
  $("vacationFill").style.width = pct + "%";
}

function updatePronunciationUI(state) {
  const unlocked = allWords.filter((w) => isLevelUnlocked(state, w.level));
  const pronounced = unlocked.filter((w) => getWP(state, w.id).pronouncedCorrectly).length;
  $("pronCount").textContent = pronounced;
  $("pronTotal").textContent = unlocked.length;
}

function updateStatsUI(state) {
  const unlocked = allWords.filter((w) => isLevelUnlocked(state, w.level));
  let nNew = 0, nLearn = 0, nMaster = 0;
  unlocked.forEach((w) => {
    const b = getWP(state, w.id).box;
    if (b === 0) nNew++;
    else if (b < 2) nLearn++;
    else nMaster++;
  });
  $("statNew").textContent = nNew;
  $("statLearning").textContent = nLearn;
  $("statMastered").textContent = nMaster;
  $("statTotal").textContent = unlocked.length;
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
  const unlocked = allWords.filter((w) => isLevelUnlocked(state, w.level));
  unlocked.forEach((w) => { counts[getWP(state, w.id).box]++; });
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
  for (let i = 1; i <= LEVELS; i++) {
    const words = wordsForLevel(i);
    if (!isLevelUnlocked(state, i)) continue;
    const mastered = words.filter((w) => getWP(state, w.id).box >= 3).length;
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

function renderCategoryChart(state) {
  const catStats = {};
  const unlocked = allWords.filter((w) => isLevelUnlocked(state, w.level));
  unlocked.forEach((w) => {
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
      <div class="cat-chart-bar-bg">
        <div class="cat-chart-bar-fill" style="width:${c.pct}%"></div>
      </div>
      <div class="cat-chart-pct">${c.pct}%</div>
    </div>
  `).join("");
}

function renderStreakInfo(state) {
  const s = state.streak;
  const todayDone = state.todayStats.date === todayStr() ? state.todayStats.correctCount : 0;
  $("streakInfo").innerHTML = `
    <div class="streak-info-row">
      <span class="streak-info-label">Huidige streak</span>
      <span class="streak-info-value">🔥 ${s.count} ${s.count === 1 ? "dag" : "dagen"}</span>
    </div>
    <div class="streak-info-row">
      <span class="streak-info-label">Vandaag</span>
      <span class="streak-info-value">${todayDone} / ${DAILY_GOAL} woorden</span>
    </div>
    <div class="streak-info-row">
      <span class="streak-info-label">Laatste voltooide dag</span>
      <span class="streak-info-value">${s.lastCompletedDate || "—"}</span>
    </div>
  `;
}

function renderOverviewStats(state) {
  const unlocked = allWords.filter((w) => isLevelUnlocked(state, w.level));
  const total = allWords.length;
  const reviewed = unlocked.filter((w) => getWP(state, w.id).lastReviewed).length;
  const mastered = unlocked.filter((w) => getWP(state, w.id).box >= 3).length;
  const pronounced = unlocked.filter((w) => getWP(state, w.id).pronouncedCorrectly).length;
  const daysLeft = daysBetween(todayStr(), VACATION_DATE);
  const levelsComplete = state.completedLevels.length;

  $("overviewStats").innerHTML = `
    <div class="overview-stat">
      <div class="overview-stat-value">${reviewed}</div>
      <div class="overview-stat-label">Geoefend</div>
    </div>
    <div class="overview-stat">
      <div class="overview-stat-value">${mastered}</div>
      <div class="overview-stat-label">Beheerst</div>
    </div>
    <div class="overview-stat">
      <div class="overview-stat-value">${pronounced}</div>
      <div class="overview-stat-label">Uitgesproken</div>
    </div>
    <div class="overview-stat">
      <div class="overview-stat-value">${levelsComplete}/${LEVELS}</div>
      <div class="overview-stat-label">Levels klaar</div>
    </div>
    <div class="overview-stat">
      <div class="overview-stat-value">${total}</div>
      <div class="overview-stat-label">Totaal woorden</div>
    </div>
    <div class="overview-stat">
      <div class="overview-stat-value">${daysLeft > 0 ? daysLeft : "0"}</div>
      <div class="overview-stat-label">Dagen tot vakantie</div>
    </div>
  `;
}

// ─── Card Rendering ───
function renderCard(word, state) {
  revealed = false;
  if (clozeTimer) { clearTimeout(clozeTimer); clozeTimer = null; }
  $("ratingContainer").classList.add("hidden");
  $("quizContainer").classList.add("hidden");
  $("typeContainer").classList.add("hidden");
  $("clozeContainer").classList.add("hidden");

  const wp = getWP(state, word.id);
  const isReverse = practiceMode === "reverse";

  const showWord = isReverse ? word.dutch : word.spanish;
  const hiddenWord = isReverse ? word.spanish : word.dutch;

  $("cardContainer").innerHTML = `
    <div class="flashcard">
      <img class="card-image" src="${word.image}" alt="${word.spanish}" loading="eager"
           onerror="this.style.display='none'">
      <div class="card-body">
        <div class="word-spanish">${showWord}</div>
        <div class="word-dutch hidden" id="dutchWord">${hiddenWord}</div>
        <div class="word-example hidden" id="exampleWord">${word.example || ""}</div>
        <div class="card-actions">
          <button class="btn-icon" id="btnAudio" aria-label="Audio">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
            </svg>
          </button>
          <button class="btn-icon mic ${wp.pronouncedCorrectly ? "success" : ""}" id="btnMic" aria-label="Microfoon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
          </button>
          <button class="btn-reveal" id="btnReveal">Toon vertaling</button>
        </div>
      </div>
    </div>
  `;

  $("btnAudio").addEventListener("click", () => playAudio(word));
  $("btnMic").addEventListener("click", () => {
    startRecognition(word, state, (success) => {
      if (success && micMode) {
        setTimeout(() => {
          rateWord("easy", loadState());
        }, 600);
      }
    });
  });
  $("btnReveal").addEventListener("click", () => revealCard());

  if (practiceMode === "type") {
    $("btnReveal").style.display = "none";
    $("typeContainer").classList.remove("hidden");
    $("typeInput").value = "";
    $("typeFeedback").classList.add("hidden");
    $("typeInput").focus();
  } else if (practiceMode === "cloze") {
    renderCloze(word, state);
  } else if (micMode) {
    setTimeout(() => startRecognition(word, state, (success) => {
      if (success) {
        revealCard();
        setTimeout(() => rateWord("easy", loadState()), 600);
      }
    }), 300);
  }
}

let clozeTimer = null;

function clozeTargetFor(word) {
  return word.spanish.toLowerCase().replace(/^(el |la |los |las |un |una )/, "").replace(/^[¿¡]+|[?!.]+$/g, "").trim();
}

function clozeMakeBlanked(sentence, target) {
  const regex = new RegExp(`(${escapeRegex(target)})`, "gi");
  let html = sentence.replace(regex, '<span class="cloze-blank">____</span>');
  if (!html.includes("cloze-blank")) {
    const words = target.split(/\s+/);
    const mainWord = words.length > 1 ? words[words.length - 1] : words[0];
    const fallback = new RegExp(`(${escapeRegex(mainWord)})`, "gi");
    html = sentence.replace(fallback, '<span class="cloze-blank">____</span>');
  }
  if (!html.includes("cloze-blank")) {
    const stem = target.replace(/[oa]s?$/, "");
    if (stem.length >= 3) {
      const stemRegex = new RegExp(`\\b(${escapeRegex(stem)}[a-záéíóúñ]*)\\b`, "gi");
      html = sentence.replace(stemRegex, '<span class="cloze-blank">____</span>');
    }
  }
  return html;
}

function clozeShowSentence(word) {
  if (clozeTimer) clearTimeout(clozeTimer);
  $("clozeSentence").textContent = word.example;
  $("clozeSentence").classList.remove("cloze-hidden");
  $("clozeInput").classList.add("hidden");
  $("clozeSubmit").classList.add("hidden");
  $("btnPeek").classList.add("hidden");

  clozeTimer = setTimeout(() => {
    const target = clozeTargetFor(word);
    $("clozeSentence").innerHTML = clozeMakeBlanked(word.example, target);
    $("clozeSentence").classList.remove("cloze-hidden");
    $("clozeInput").classList.remove("hidden");
    $("clozeSubmit").classList.remove("hidden");
    $("btnPeek").classList.remove("hidden");
    $("clozeInput").focus();
  }, 5000);
}

function renderCloze(word, state) {
  if (!word.example) {
    revealCard();
    return;
  }

  $("btnReveal").style.display = "none";
  $("clozeContainer").classList.remove("hidden");
  $("clozeTranslation").textContent = word.dutch;
  $("clozeInput").value = "";
  $("clozeFeedback").classList.add("hidden");

  $("btnPeek").onclick = () => clozeShowSentence(word);

  clozeShowSentence(word);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function revealCard() {
  if (revealed) return;
  revealed = true;
  const d = $("dutchWord");
  const e = $("exampleWord");
  if (d) d.classList.remove("hidden");
  if (e) e.classList.remove("hidden");
  $("ratingContainer").classList.remove("hidden");
}

function animateOut(cb) {
  const card = document.querySelector(".flashcard");
  if (card) {
    card.classList.add("card-out");
    setTimeout(cb, 250);
  } else {
    cb();
  }
}

// ─── Type mode check ───
function checkTypeAnswer(state) {
  const word = queue[currentIndex];
  if (!word) return;

  const input = $("typeInput").value.trim().toLowerCase();
  const target = word.spanish.toLowerCase().replace(/^(el |la |los |las |un |una )/, "").trim();
  const targetFull = word.spanish.toLowerCase().trim();
  const fb = $("typeFeedback");

  if (input === target || input === targetFull) {
    fb.textContent = "Correct!";
    fb.className = "quiz-feedback correct";
    revealCard();
    setTimeout(() => rateWord("easy", loadState()), 800);
  } else {
    fb.textContent = `Fout! Het was: ${word.spanish}`;
    fb.className = "quiz-feedback wrong";
    revealCard();
    setTimeout(() => rateWord("hard", loadState()), 1200);
  }
}

// ─── Cloze mode check ───
function checkClozeAnswer(state) {
  const word = queue[currentIndex];
  if (!word) return;

  const input = $("clozeInput").value.trim().toLowerCase();
  const target = word.spanish.toLowerCase().replace(/^(el |la |los |las |un |una )/, "").trim();
  const targetFull = word.spanish.toLowerCase().trim();
  const fb = $("clozeFeedback");

  if (input === target || input === targetFull) {
    fb.textContent = "Correct!";
    fb.className = "quiz-feedback correct";
    document.querySelectorAll(".cloze-blank").forEach((el) => el.textContent = target);
    revealCard();
    setTimeout(() => rateWord("easy", loadState()), 800);
  } else {
    fb.textContent = `Fout! Het was: ${target}`;
    fb.className = "quiz-feedback wrong";
    document.querySelectorAll(".cloze-blank").forEach((el) => el.textContent = target);
    revealCard();
    setTimeout(() => rateWord("hard", loadState()), 1200);
  }
}

// ─── Rating ───
function rateWord(rating, state) {
  const word = queue[currentIndex];
  if (!word) return;

  const today = todayStr();
  const wp = getWP(state, word.id);

  if (rating === "easy") {
    wp.box = Math.min(5, wp.box + 1);
    wp.nextReview = addDays(today, LEITNER_INTERVALS[wp.box] || 14);
    const isNew = wp.correctCount === 0;
    wp.correctCount++;
    if (isNew) {
      if (state.todayStats.date === today) state.todayStats.correctCount++;
      else state.todayStats = { date: today, correctCount: 1 };
      checkStreakGoal(state);
    }
  } else {
    wp.box = 1;
    wp.nextReview = addDays(today, 1);
  }

  wp.lastReviewed = today;
  state.wordProgress[word.id] = wp;
  addHistory(state, today, state.todayStats.correctCount);
  saveState(state);

  updateDailyUI(state);
  updateStatsUI(state);
  updateStreakUI(state);

  animateOut(() => {
    currentIndex++;
    showNext(state);
  });
}

// ─── Quiz ───
function startQuiz(state, lvl) {
  mode = "quiz";
  quizWords = [...wordsForLevel(lvl)];
  shuffle(quizWords);
  quizIndex = 0;
  quizErrors = 0;
  $("ratingContainer").classList.add("hidden");
  $("typeContainer").classList.add("hidden");
  $("clozeContainer").classList.add("hidden");
  showQuizWord(state);
}

function showQuizWord(state) {
  if (quizIndex >= quizWords.length) {
    if (quizErrors === 0) {
      if (!state.completedLevels.includes(activeLevel)) {
        state.completedLevels.push(activeLevel);
      }
      if (activeLevel < LEVELS) {
        state.currentLevel = Math.max(state.currentLevel, activeLevel + 1);
      }
      saveState(state);
      renderLevelNav(state);
      showQuizComplete(state);
    } else {
      showQuizFailed(state);
    }
    return;
  }

  const word = quizWords[quizIndex];
  renderCard(word, state);
  $("typeContainer").classList.add("hidden");
  $("clozeContainer").classList.add("hidden");
  $("dutchWord").classList.remove("hidden");
  $("dutchWord").textContent = "???";
  const ex = $("exampleWord");
  if (ex) { ex.classList.remove("hidden"); ex.textContent = word.example || ""; }

  $("quizContainer").classList.remove("hidden");
  $("quizProgress").textContent = `Quiz: ${quizIndex + 1}/${quizWords.length} (${quizErrors} fouten)`;
  $("quizInput").value = "";
  $("quizInput").focus();
  $("quizFeedback").classList.add("hidden");

  $("btnReveal").style.display = "none";
}

function checkQuizAnswer(state) {
  const word = quizWords[quizIndex];
  const input = $("quizInput").value.trim().toLowerCase();
  const correct = word.dutch.toLowerCase().replace(/^(de |het |een )/, "").trim();
  const fullCorrect = word.dutch.toLowerCase().trim();
  const fb = $("quizFeedback");

  if (input === correct || input === fullCorrect) {
    fb.textContent = "Correct!";
    fb.className = "quiz-feedback correct";
    quizIndex++;
    setTimeout(() => {
      animateOut(() => showQuizWord(state));
    }, 600);
  } else {
    fb.textContent = `Fout! Het was: ${word.dutch}`;
    fb.className = "quiz-feedback wrong";
    quizErrors++;
    quizIndex++;
    $("quizProgress").textContent = `Quiz: ${quizIndex}/${quizWords.length} (${quizErrors} fouten)`;
    setTimeout(() => {
      animateOut(() => showQuizWord(state));
    }, 1500);
  }
}

function showQuizComplete(state) {
  $("quizContainer").classList.add("hidden");
  $("cardContainer").innerHTML = `
    <div class="done-screen">
      <div class="done-icon">🏆</div>
      <h2>Level ${activeLevel} voltooid!</h2>
      <p>Je hebt alle woorden foutloos doorlopen.<br>Level ${activeLevel + 1} is nu ontgrendeld!</p>
      <button class="btn-action" id="btnNextLevel">Ga naar Level ${activeLevel + 1}</button>
    </div>
  `;
  $("btnNextLevel")?.addEventListener("click", () => {
    activeLevel = Math.min(LEVELS, activeLevel + 1);
    mode = "practice";
    currentIndex = 0;
    queue = buildQueue(state, activeLevel);
    renderLevelNav(state);
    renderCategoryBar(state);
    showNext(state);
  });
}

function showQuizFailed(state) {
  $("quizContainer").classList.add("hidden");
  $("cardContainer").innerHTML = `
    <div class="done-screen">
      <div class="done-icon">😤</div>
      <h2>Niet gehaald</h2>
      <p>${quizErrors} fout${quizErrors > 1 ? "en" : ""} gemaakt. Je moet ze allemaal foutloos doorlopen.<br>Oefen verder en probeer opnieuw!</p>
      <button class="btn-action" id="btnRetryQuiz">Opnieuw proberen</button>
      <button class="btn-action" id="btnBackPractice" style="background:var(--surface);margin-left:8px">Terug naar oefenen</button>
    </div>
  `;
  $("btnRetryQuiz")?.addEventListener("click", () => startQuiz(state, activeLevel));
  $("btnBackPractice")?.addEventListener("click", () => {
    mode = "practice";
    currentIndex = 0;
    queue = buildQueue(state, activeLevel);
    showNext(state);
  });
}

// ─── Show Next ───
function showNext(state) {
  if (mode === "quiz") return;

  const qReady = isQuizReady(state, activeLevel) && !isLevelCompleted(state, activeLevel);

  if (currentIndex >= queue.length) {
    $("ratingContainer").classList.add("hidden");
    $("quizContainer").classList.add("hidden");
    $("typeContainer").classList.add("hidden");
    $("clozeContainer").classList.add("hidden");

    if (qReady && !activeCategory) {
      $("cardContainer").innerHTML = `
        <div class="done-screen">
          <div class="done-icon">📝</div>
          <h2>Quiz beschikbaar!</h2>
          <p>Je hebt alle woorden van Level ${activeLevel} geoefend.<br>Doe de quiz om het volgende level te ontgrendelen.</p>
          <button class="btn-action" id="btnStartQuiz">Start Quiz</button>
        </div>
      `;
      $("btnStartQuiz")?.addEventListener("click", () => startQuiz(state, activeLevel));
    } else {
      const extra = micMode ? "<br>Alle woorden in dit level zijn uitgesproken!" : "";
      const catMsg = activeCategory ? ` (${activeCategory})` : "";
      $("cardContainer").innerHTML = `
        <div class="done-screen">
          <div class="done-icon">🎉</div>
          <h2>Klaar voor vandaag!</h2>
          <p>Geen woorden meer voor nu in Level ${activeLevel}${catMsg}.${extra}<br>Kom morgen terug of kies een ander level.</p>
        </div>
      `;
    }
    renderLevelNav(state);
    return;
  }

  renderCard(queue[currentIndex], state);
  renderLevelNav(state);
}

// ─── Keyboard shortcuts ───
document.addEventListener("keydown", (e) => {
  if ($("statsPanel") && !$("statsPanel").classList.contains("hidden")) {
    if (e.key === "Escape") $("statsPanel").classList.add("hidden");
    return;
  }

  if (mode === "quiz") {
    if (e.key === "Enter") {
      e.preventDefault();
      checkQuizAnswer(loadState());
    }
    return;
  }

  if (practiceMode === "type" && !revealed) {
    if (e.key === "Enter") {
      e.preventDefault();
      checkTypeAnswer(loadState());
    }
    return;
  }

  if (practiceMode === "cloze" && !revealed) {
    if (e.key === "Enter") {
      e.preventDefault();
      checkClozeAnswer(loadState());
    }
    return;
  }

  const state = loadState();
  const word = queue[currentIndex];

  switch (e.key) {
    case " ":
      e.preventDefault();
      if (practiceMode === "flashcard" || practiceMode === "reverse") revealCard();
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
      if (word) playAudio(word);
      break;
    case "ArrowUp":
      e.preventDefault();
      if (word) startRecognition(word, state);
      break;
  }
});

// ─── Mode switching ───
document.querySelectorAll(".mode-btn:not(.mic-toggle)").forEach((btn) => {
  btn.addEventListener("click", () => {
    practiceMode = btn.dataset.mode;
    renderModeBar();
    const state = loadState();
    currentIndex = 0;
    queue = buildQueue(state, activeLevel);
    showNext(state);
  });
});

$("modeMic").addEventListener("click", () => {
  micMode = !micMode;
  renderModeBar();
  const state = loadState();
  currentIndex = 0;
  queue = buildQueue(state, activeLevel);
  showNext(state);
});

// ─── Stats panel ───
$("btnStats").addEventListener("click", () => showStatsPanel(loadState()));
$("btnCloseStats").addEventListener("click", () => $("statsPanel").classList.add("hidden"));

// ─── Init ───
if ("speechSynthesis" in window) {
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
}

$("btnEasy").addEventListener("click", () => rateWord("easy", loadState()));
$("btnHard").addEventListener("click", () => rateWord("hard", loadState()));
$("quizSubmit").addEventListener("click", () => checkQuizAnswer(loadState()));
$("quizInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); checkQuizAnswer(loadState()); }
});
$("typeSubmit").addEventListener("click", () => checkTypeAnswer(loadState()));
$("typeInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); checkTypeAnswer(loadState()); }
});
$("clozeSubmit").addEventListener("click", () => checkClozeAnswer(loadState()));
$("clozeInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); checkClozeAnswer(loadState()); }
});

fetch("data.json")
  .then((r) => r.json())
  .then((data) => {
    allWords = data;
    const state = loadState();
    updateStreak(state);
    saveState(state);

    activeLevel = state.currentLevel;
    queue = buildQueue(state, activeLevel);

    renderModeBar();
    renderCategoryBar(state);
    renderLevelNav(state);
    updateStreakUI(state);
    updateDailyUI(state);
    updateVacationUI();
    updatePronunciationUI(state);
    updateStatsUI(state);
    showNext(state);
  });
