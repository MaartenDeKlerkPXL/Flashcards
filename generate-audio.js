const fs = require("fs");
const path = require("path");
const googleTTS = require("google-tts-api");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "data.json"), "utf8"));
const audioDir = path.join(__dirname, "audio");

if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

async function generate() {
  for (const word of data) {
    const file = path.join(audioDir, `audio-${word.id}.mp3`);
    if (fs.existsSync(file)) {
      console.log(`Skip ${word.id}: ${word.spanish}`);
      continue;
    }
    try {
      const url = googleTTS.getAudioUrl(word.spanish, { lang: "es", slow: false });
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      console.log(`OK ${word.id}: ${word.spanish}`);
      await new Promise((r) => setTimeout(r, 200));
    } catch (e) {
      console.error(`FAIL ${word.id}: ${word.spanish} — ${e.message}`);
    }
  }
  console.log("Done!");
}

generate();
