const STORAGE_KEY = "espanol_progress";

let words = [];
let todayQueue = [];
let currentIndex = 0;
let revealed = false;

const cardContainer = document.getElementById("cardContainer");
const ratingContainer = document.getElementById("ratingContainer");
const btnEasy = document.getElementById("btnEasy");
const btnHard = document.getElementById("btnHard");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");
const statNew = document.getElementById("statNew");
const statHard = document.getElementById("statHard");
const statMastered = document.getElementById("statMastered");

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveProgress(progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {}
}

function getWordProgress(progress, id) {
  return progress[id] || {
    status: "nieuw",
    lastReviewedDate: null,
    nextReviewDate: todayStr()
  };
}

function buildQueue(progress) {
  const today = todayStr();
  return words.filter((w) => {
    const p = getWordProgress(progress, w.id);
    return p.nextReviewDate <= today;
  });
}

function updateStats(progress) {
  let nNew = 0, nHard = 0, nMastered = 0;
  words.forEach((w) => {
    const s = getWordProgress(progress, w.id).status;
    if (s === "nieuw") nNew++;
    else if (s === "moeilijk") nHard++;
    else nMastered++;
  });
  statNew.textContent = nNew;
  statHard.textContent = nHard;
  statMastered.textContent = nMastered;
}

function updateProgress() {
  const total = todayQueue.length;
  const done = currentIndex;
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  progressFill.style.width = pct + "%";
  progressText.textContent = total === 0
    ? "Alles klaar!"
    : `${done} / ${total} vandaag`;
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = "es-ES";
  const voices = speechSynthesis.getVoices();
  const esVoice = voices.find((v) => v.lang.startsWith("es"));
  if (esVoice) utt.voice = esVoice;
  utt.rate = 0.9;
  speechSynthesis.speak(utt);
}

function renderCard(word) {
  revealed = false;
  ratingContainer.classList.add("hidden");

  cardContainer.innerHTML = `
    <div class="flashcard">
      <img class="card-image" src="${word.image}" alt="${word.spanish}" loading="eager">
      <div class="card-body">
        <div class="word-spanish">${word.spanish}</div>
        <div class="word-dutch hidden" id="dutchWord">${word.dutch}</div>
        <div class="card-actions">
          <button class="btn-audio" id="btnAudio" aria-label="Uitspraak afspelen">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
            </svg>
          </button>
          <button class="btn-reveal" id="btnReveal">Toon vertaling</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("btnAudio").addEventListener("click", () => speak(word.spanish));
  document.getElementById("btnReveal").addEventListener("click", revealCard);
}

function revealCard() {
  if (revealed) return;
  revealed = true;
  const dutchEl = document.getElementById("dutchWord");
  if (dutchEl) dutchEl.classList.remove("hidden");
  ratingContainer.classList.remove("hidden");
}

function showDone() {
  ratingContainer.classList.add("hidden");
  cardContainer.innerHTML = `
    <div class="done-screen">
      <div class="done-icon">&#127881;</div>
      <h2>Klaar voor vandaag!</h2>
      <p>Je hebt alle woorden voor vandaag geoefend.<br>Kom morgen terug voor meer.</p>
    </div>
  `;
}

function showNext() {
  updateProgress();
  if (currentIndex >= todayQueue.length) {
    showDone();
    return;
  }
  renderCard(todayQueue[currentIndex]);
}

function rateWord(rating) {
  const word = todayQueue[currentIndex];
  const progress = loadProgress();
  const today = todayStr();

  const wp = getWordProgress(progress, word.id);

  if (rating === "hard") {
    wp.status = "moeilijk";
    wp.nextReviewDate = addDays(today, 1);
  } else {
    wp.status = "beheerst";
    const days = 3 + Math.floor(Math.random() * 3);
    wp.nextReviewDate = addDays(today, days);
  }

  wp.lastReviewedDate = today;
  progress[word.id] = wp;
  saveProgress(progress);
  updateStats(progress);

  currentIndex++;
  showNext();
}

btnEasy.addEventListener("click", () => rateWord("easy"));
btnHard.addEventListener("click", () => rateWord("hard"));

if ("speechSynthesis" in window) {
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
}

fetch("data.json")
  .then((r) => r.json())
  .then((data) => {
    words = data;
    const progress = loadProgress();
    todayQueue = buildQueue(progress);

    // Shuffle the queue
    for (let i = todayQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [todayQueue[i], todayQueue[j]] = [todayQueue[j], todayQueue[i]];
    }

    updateStats(progress);
    showNext();
  });
