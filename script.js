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
let mode = "practice"; // practice | quiz | done
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
  try { return JSON.parse(localStorage.getItem(STATE_KEY)) || defaultState(); }
  catch { return defaultState(); }
}

function defaultState() {
  return { wordProgress: {}, currentLevel: 1, completedLevels: [], streak: { count: 0, lastDate: null }, todayStats: { date: todayStr(), correctCount: 0 } };
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
  if (s.lastDate === today) return;
  if (s.lastDate === addDays(today, -1)) {
    const prev = state.todayStats;
    if (prev.date === s.lastDate && prev.correctCount >= DAILY_GOAL) {
      s.count++;
    } else {
      s.count = 0;
    }
  } else if (s.lastDate !== today) {
    s.count = 0;
  }
  s.lastDate = today;
  if (state.todayStats.date !== today) {
    state.todayStats = { date: today, correctCount: 0 };
  }
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

// ─── Queue building ───
function buildQueue(state, lvl) {
  const today = todayStr();
  const levelWords = wordsForLevel(lvl).filter((w) => {
    const wp = getWP(state, w.id);
    return wp.nextReview <= today;
  });

  let reviewWords = [];
  if (lvl > 1) {
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
function startRecognition(word, state) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  if (isListening) return;

  const recognition = new SR();
  recognition.lang = "es-ES";
  recognition.interimResults = false;
  recognition.maxAlternatives = 3;
  isListening = true;
  const micBtn = $("btnMic");
  if (micBtn) micBtn.classList.add("active");

  recognition.onresult = (e) => {
    const results = Array.from(e.results[0]).map((r) => r.transcript.toLowerCase().trim());
    const target = word.spanish.toLowerCase().replace(/^(el |la |los |las |un |una )/, "").trim();
    const targetFull = word.spanish.toLowerCase().trim();
    const match = results.some((r) => r === target || r === targetFull || r.includes(target));

    if (match) {
      const wp = getWP(state, word.id);
      wp.pronouncedCorrectly = true;
      state.wordProgress[word.id] = wp;
      saveState(state);
      if (micBtn) { micBtn.classList.remove("active"); micBtn.classList.add("success"); }
      updatePronunciationUI(state);
    } else {
      if (micBtn) micBtn.classList.remove("active");
    }
    isListening = false;
  };

  recognition.onerror = () => { isListening = false; if (micBtn) micBtn.classList.remove("active"); };
  recognition.onend = () => { isListening = false; };
  recognition.start();
}

// ─── UI Updates ───
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
      mode = "practice";
      currentIndex = 0;
      queue = buildQueue(state, i);
      renderLevelNav(state);
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
    else if (b < 3) nLearn++;
    else nMaster++;
  });
  $("statNew").textContent = nNew;
  $("statLearning").textContent = nLearn;
  $("statMastered").textContent = nMaster;
  $("statTotal").textContent = unlocked.length;
}

// ─── Card Rendering ───
function renderCard(word, state) {
  revealed = false;
  $("ratingContainer").classList.add("hidden");
  $("quizContainer").classList.add("hidden");

  const wp = getWP(state, word.id);

  $("cardContainer").innerHTML = `
    <div class="flashcard">
      <img class="card-image" src="${word.image}" alt="${word.spanish}" loading="eager"
           onerror="this.style.display='none'">
      <div class="card-body">
        <div class="word-spanish">${word.spanish}</div>
        <div class="word-dutch hidden" id="dutchWord">${word.dutch}</div>
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
  $("btnMic").addEventListener("click", () => startRecognition(word, state));
  $("btnReveal").addEventListener("click", () => revealCard());
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

// ─── Rating ───
function rateWord(rating, state) {
  const word = queue[currentIndex];
  if (!word) return;

  const today = todayStr();
  const wp = getWP(state, word.id);

  if (rating === "easy") {
    wp.box = Math.min(5, wp.box + 1);
    wp.nextReview = addDays(today, LEITNER_INTERVALS[wp.box] || 14);
    wp.correctCount++;
    if (state.todayStats.date === today) state.todayStats.correctCount++;
    else state.todayStats = { date: today, correctCount: 1 };
  } else {
    wp.box = 1;
    wp.nextReview = addDays(today, 1);
  }

  wp.lastReviewed = today;
  state.wordProgress[word.id] = wp;
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

    if (qReady) {
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
      $("cardContainer").innerHTML = `
        <div class="done-screen">
          <div class="done-icon">🎉</div>
          <h2>Klaar voor vandaag!</h2>
          <p>Geen woorden meer voor nu in Level ${activeLevel}.<br>Kom morgen terug of kies een ander level.</p>
        </div>
      `;
    }
    renderLevelNav(state);
    return;
  }

  renderCard(queue[currentIndex], state);
  updateProgressUI();
  renderLevelNav(state);
}

function updateProgressUI() {
  // no separate progress bar in new design, covered by daily goal
}

// ─── Keyboard shortcuts ───
document.addEventListener("keydown", (e) => {
  if (mode === "quiz") {
    if (e.key === "Enter") {
      e.preventDefault();
      const state = loadState();
      checkQuizAnswer(state);
    }
    return;
  }

  const state = loadState();
  const word = queue[currentIndex];

  switch (e.key) {
    case " ":
      e.preventDefault();
      revealCard();
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

fetch("data.json")
  .then((r) => r.json())
  .then((data) => {
    allWords = data;
    const state = loadState();
    updateStreak(state);
    saveState(state);

    activeLevel = state.currentLevel;
    queue = buildQueue(state, activeLevel);

    renderLevelNav(state);
    updateStreakUI(state);
    updateDailyUI(state);
    updateVacationUI();
    updatePronunciationUI(state);
    updateStatsUI(state);
    showNext(state);
  });
