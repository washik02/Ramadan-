const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const moment = require("moment-timezone");

let createCanvas;
try {
  const canvas = require("canvas");
  createCanvas = canvas.createCanvas;
} catch (e) {
  console.log("Canvas not supported. Using text mode.");
}

const TZ = "Asia/Dhaka";
const cacheDir = path.join(__dirname, "cache");

// ==================== আপনার GitHub রিপোজিটরির Raw URL ====================
const GITHUB_BASE = "https://raw.githubusercontent.com/washik02/Ramadan-/main/";
const DISTRICTS_URL = `${GITHUB_BASE}bd_districts.json`;
const CONFIG_URL = `${GITHUB_BASE}ramadan_config.json`;
const APIS_URL = `${GITHUB_BASE}Prayer_apis.json`;

// ক্যাশ ফাইলের পাথ
const DISTRICTS_CACHE = path.join(cacheDir, "bd_districts.json");
const CONFIG_CACHE = path.join(cacheDir, "ramadan_config.json");
const APIS_CACHE = path.join(cacheDir, "Prayer_apis.json");

// ==================== গ্লোবাল ভেরিয়েবল ====================
let BD_DISTRICTS = [];
let GLOBAL_CONFIG = {};
let PRAYER_APIS = [];

// ==================== GitHub থেকে JSON লোড করার ফাংশন ====================
async function loadJsonFromGitHub(url, cachePath, defaultValue = null) {
  try {
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;
    if (data) {
      await fs.ensureDir(cacheDir);
      await fs.writeJson(cachePath, data);
      console.log(`✅ Loaded: ${url}`);
      return data;
    }
  } catch (error) {
    console.log(`GitHub fetch failed for ${url}, trying cache...`);
    if (await fs.pathExists(cachePath)) {
      return await fs.readJson(cachePath);
    }
  }
  return defaultValue;
}

// ==================== সব ডাটা একসাথে লোড করা ====================
async function loadAllData() {
  BD_DISTRICTS = await loadJsonFromGitHub(DISTRICTS_URL, DISTRICTS_CACHE, []);
  GLOBAL_CONFIG = await loadJsonFromGitHub(CONFIG_URL, CONFIG_CACHE, {});
  PRAYER_APIS = await loadJsonFromGitHub(APIS_URL, APIS_CACHE, []);

  if (!BD_DISTRICTS.length) console.error("❌ No districts loaded!");
  if (!Object.keys(GLOBAL_CONFIG).length) console.error("❌ No config loaded!");
  if (!PRAYER_APIS.length) console.error("❌ No APIs loaded!");
}

// স্টার্টআপে ডাটা লোড করুন
loadAllData();

// ==================== হেল্পার ফাংশন ====================
function convertTo12Hour(time24) {
  if (!time24) return "N/A";
  const [hours, minutes] = time24.split(":").map(Number);
  const period = hours >= 12 ? "PM" : "AM";
  let hours12 = hours % 12;
  hours12 = hours12 ? hours12 : 12;
  return `${hours12.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')} ${period}`;
}

// একাধিক API ট্রাই করে ডাটা আনার ফাংশন
async function fetchPrayerTimes(district, date) {
  const activeApis = PRAYER_APIS.filter(api => api.enabled);
  
  if (activeApis.length === 0) {
    throw new Error("No active APIs configured in Prayer_apis.json");
  }

  let lastError = null;
  for (const api of activeApis) {
    try {
      let url = api.url
        .replace("{date}", date)
        .replace("{lat}", district.lat)
        .replace("{lon}", district.lon);

      console.log(`Trying API: ${api.name} -> ${url}`);
      const res = await axios.get(url, { timeout: 8000 });

      if (res.data && res.data.data && res.data.data.timings) {
        const timings = res.data.data.timings;
        const hijri = res.data.data.date.hijri;
        return {
          imsak: timings.Imsak || timings.Fajr,
          fajr: timings.Fajr,
          maghrib: timings.Maghrib,
          hijriYear: hijri.year,
          hijriMonth: hijri.month.en,
          hijriMonthBn: hijri.month.ar,
          hijriDay: hijri.day
        };
      } else {
        throw new Error("Invalid API response structure");
      }
    } catch (error) {
      console.log(`❌ API ${api.name} failed:`, error.message);
      lastError = error;
      continue;
    }
  }
  
  throw lastError || new Error("All APIs failed");
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  return ctx;
}

// ==================== মেইন ফাংশন (যেটা প্রতিবার রান করবে) ====================
async function runRamadanCommand(message, args, event) {
  try {
    if (BD_DISTRICTS.length === 0 || Object.keys(GLOBAL_CONFIG).length === 0 || PRAYER_APIS.length === 0) {
      await loadAllData();
    }

    if (!BD_DISTRICTS || BD_DISTRICTS.length === 0) {
      return message.reply("❌ জেলার তালিকা লোড করা যায়নি। আবার চেষ্টা করুন।");
    }

    const query = (args[0] || "").trim().toLowerCase();

    if (!query) {
      const sampleDistricts = BD_DISTRICTS.slice(0, 10).map(d => `${d.bn} (${d.en})`).join("\n");
      return message.reply(
        `🕌 নামাজের সময়\n\n` +
        `জেলার নাম লিখুন:\n` +
        `!ramadan dhaka\n` +
        `!ramadan চট্টগ্রাম\n\n` +
        `উদাহরণ:\n${sampleDistricts}\n\n` +
        `মোট ${BD_DISTRICTS.length}টি জেলা`
      );
    }

    const district = BD_DISTRICTS.find(d =>
      d.en.toLowerCase() === query ||
      d.bn === query ||
      d.en.toLowerCase().includes(query) ||
      d.bn.includes(query)
    );

    if (!district) {
      return message.reply(`❌ জেলা "${query}" খুঁজে পাওয়া যায়নি।\n\nসঠিক নাম লিখুন যেমন: ঢাকা, চট্টগ্রাম, সিলেট`);
    }

    let dateMoment = moment().tz(TZ);
    if (args[1]?.toLowerCase() === "tomorrow" || args[1] === "আগামীকাল") {
      dateMoment.add(1, "day");
    }

    const dateStr = dateMoment.format("DD-MM-YYYY");
    const waitMsg = await message.reply(`⏳ ${district.en} এর জন্য সময় আনা হচ্ছে...`);

    try {
      const timings = await fetchPrayerTimes(district, dateStr);

      const imsak12 = convertTo12Hour(timings.imsak);
      const fajr12 = convertTo12Hour(timings.fajr);
      const maghrib12 = convertTo12Hour(timings.maghrib);

      const hijriMonth = timings.hijriMonth;
      const hijriMonthBn = timings.hijriMonthBn;
      const hijriYear = timings.hijriYear;
      const isRamadan = hijriMonth === "Ramadan";

      // মাসের নাম ইংরেজি না আরবি হবে সেটা কনফিগ থেকে নিন
      const hijriMonthToShow = GLOBAL_CONFIG.text?.hijriMonthFormat === "en" ? hijriMonth : hijriMonthBn;
      
      const info = {
        districtBn: district.bn,
        districtEn: district.en,
        date: dateMoment.format("DD MMMM, YYYY"),
        hijriDate: `${timings.hijriDay} ${hijriMonthToShow} ${hijriYear}`,
        hijriMonth: hijriMonth,
        hijriYear: hijriYear,
        isRamadan: isRamadan,
        imsak12: imsak12,
        fajr12: fajr12,
        maghrib12: maghrib12
      };

      // টেক্সট মেসেজ তৈরি
      const textHeader = `🕌 ${hijriMonthToShow} ${hijriYear}`;
      
      let textBody;
      if (isRamadan) {
        textBody =
`${GLOBAL_CONFIG.text?.labels?.district || "📍 জেলা"}: ${info.districtBn}
${GLOBAL_CONFIG.text?.labels?.date || "📅 তারিখ"}: ${info.date}
${GLOBAL_CONFIG.text?.labels?.hijri || "📆 হিজরি"}: ${info.hijriDate}
════════════════════
${GLOBAL_CONFIG.text?.sehri || "🌙 সেহরির শেষ"}: ${info.imsak12}
${GLOBAL_CONFIG.text?.fajr || "📢 ফজর"}: ${info.fajr12}
${GLOBAL_CONFIG.text?.iftar || "🌅 ইফতার"}: ${info.maghrib12}
════════════════════
${GLOBAL_CONFIG.text?.footer || "রাহা এআই - ২০২৬"}`;
      } else {
        textBody =
`${GLOBAL_CONFIG.text?.labels?.district || "📍 জেলা"}: ${info.districtBn}
${GLOBAL_CONFIG.text?.labels?.date || "📅 তারিখ"}: ${info.date}
${GLOBAL_CONFIG.text?.labels?.hijri || "📆 হিজরি"}: ${info.hijriDate}
════════════════════
${GLOBAL_CONFIG.text?.fajr || "📢 ফজর"}: ${info.fajr12}
${GLOBAL_CONFIG.text?.maghrib || "🌅 মাগরিব"}: ${info.maghrib12}
════════════════════
${GLOBAL_CONFIG.text?.footer || "রাহা এআই - ২০২৬"}`;
      }
      const textMsg = `${textHeader}\n════════════════════\n${textBody}`;

      // ক্যানভাস ইমেজ তৈরি
      if (createCanvas) {
        try {
          await fs.ensureDir(cacheDir);
          const canvas = createCanvas(800, 480);
          const ctx = canvas.getContext("2d");

          ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.background || "#0a472e";
          ctx.fillRect(0, 0, 800, 480);

          ctx.font = "bold 40px Arial";
          ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.gold || "#ffd700";
          const canvasHeader = `${hijriMonth} ${hijriYear}`;
          const textWidth = ctx.measureText(canvasHeader).width;
          ctx.fillText(canvasHeader, (800 - textWidth) / 2, 60);

          ctx.font = "bold 25px Arial";
          ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.white || "#ffffff";
          ctx.fillText(info.districtEn, 50, 130);

          ctx.font = "16px Arial";
          ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.gray || "#cccccc";
          ctx.fillText(info.date, 50, 165);

          ctx.font = "16px Arial";
          ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.gold || "#ffd700";
          ctx.fillText(`${timings.hijriDay} ${hijriMonth} ${hijriYear}`, 50, 195);

          ctx.strokeStyle = GLOBAL_CONFIG.canvas?.colors?.gold || "#ffd700";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(40, 220);
          ctx.lineTo(760, 220);
          ctx.stroke();

          if (isRamadan) {
            // Sehri Box
            ctx.fillStyle = "rgba(255, 107, 107, 0.2)";
            drawRoundedRect(ctx, 60, 240, 200, 130, 10);
            ctx.fill();
            ctx.strokeStyle = GLOBAL_CONFIG.canvas?.colors?.sehri || "#ff6b6b";
            ctx.lineWidth = 2;
            drawRoundedRect(ctx, 60, 240, 200, 130, 10);
            ctx.stroke();
            ctx.font = "bold 16px Arial";
            ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.white || "#ffffff";
            ctx.fillText(GLOBAL_CONFIG.canvas?.sehri || "SEHRI ENDS", 110, 280);
            ctx.font = "bold 28px Arial";
            ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.sehri || "#ff6b6b";
            ctx.fillText(info.imsak12, 80, 340);

            // Fajr Box
            ctx.fillStyle = "rgba(78, 205, 196, 0.2)";
            drawRoundedRect(ctx, 300, 240, 200, 130, 10);
            ctx.fill();
            ctx.strokeStyle = GLOBAL_CONFIG.canvas?.colors?.fajr || "#4ecdc4";
            ctx.lineWidth = 2;
            drawRoundedRect(ctx, 300, 240, 200, 130, 10);
            ctx.stroke();
            ctx.font = "bold 16px Arial";
            ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.white || "#ffffff";
            ctx.fillText(GLOBAL_CONFIG.canvas?.fajr || "FAJR", 380, 280);
            ctx.font = "bold 28px Arial";
            ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.fajr || "#4ecdc4";
            ctx.fillText(info.fajr12, 330, 340);

            // Iftar Box
            ctx.fillStyle = "rgba(255, 217, 61, 0.2)";
            drawRoundedRect(ctx, 540, 240, 200, 130, 10);
            ctx.fill();
            ctx.strokeStyle = GLOBAL_CONFIG.canvas?.colors?.iftar || "#ffd93d";
            ctx.lineWidth = 2;
            drawRoundedRect(ctx, 540, 240, 200, 130, 10);
            ctx.stroke();
            ctx.font = "bold 16px Arial";
            ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.white || "#ffffff";
            ctx.fillText(GLOBAL_CONFIG.canvas?.iftar || "IFTAR", 620, 280);
            ctx.font = "bold 28px Arial";
            ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.iftar || "#ffd93d";
            ctx.fillText(info.maghrib12, 570, 340);
          } else {
            // Fajr Box
            ctx.fillStyle = "rgba(78, 205, 196, 0.2)";
            drawRoundedRect(ctx, 150, 240, 200, 130, 10);
            ctx.fill();
            ctx.strokeStyle = GLOBAL_CONFIG.canvas?.colors?.fajr || "#4ecdc4";
            ctx.lineWidth = 2;
            drawRoundedRect(ctx, 150, 240, 200, 130, 10);
            ctx.stroke();
            ctx.font = "bold 16px Arial";
            ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.white || "#ffffff";
            ctx.fillText(GLOBAL_CONFIG.canvas?.fajr || "FAJR", 230, 280);
            ctx.font = "bold 28px Arial";
            ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.fajr || "#4ecdc4";
            ctx.fillText(info.fajr12, 180, 340);

            // Maghrib Box
            ctx.fillStyle = "rgba(255, 217, 61, 0.2)";
            drawRoundedRect(ctx, 450, 240, 200, 130, 10);
            ctx.fill();
            ctx.strokeStyle = GLOBAL_CONFIG.canvas?.colors?.maghrib || "#ffd93d";
            ctx.lineWidth = 2;
            drawRoundedRect(ctx, 450, 240, 200, 130, 10);
            ctx.stroke();
            ctx.font = "bold 16px Arial";
            ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.white || "#ffffff";
            ctx.fillText(GLOBAL_CONFIG.canvas?.maghrib || "MAGHRIB", 500, 280);
            ctx.font = "bold 28px Arial";
            ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.maghrib || "#ffd93d";
            ctx.fillText(info.maghrib12, 480, 340);
          }

          ctx.font = "14px Arial";
          ctx.fillStyle = GLOBAL_CONFIG.canvas?.colors?.gold || "#ffd700";
          ctx.fillText(GLOBAL_CONFIG.canvas?.footer || "Raha AI - 2026", 340, 430);

          const imgPath = path.join(cacheDir, `prayer_${Date.now()}.png`);
          await fs.writeFile(imgPath, canvas.toBuffer("image/png"));

          await message.unsend((await waitMsg).messageID);
          await message.reply({ body: textMsg, attachment: fs.createReadStream(imgPath) });
          setTimeout(() => fs.unlink(imgPath).catch(() => {}), 10000);

        } catch (canvasError) {
          console.log("Canvas error:", canvasError);
          await message.unsend((await waitMsg).messageID);
          await message.reply(textMsg);
        }
      } else {
        await message.unsend((await waitMsg).messageID);
        await message.reply(textMsg);
      }

    } catch (apiError) {
      console.log("API Error details:", apiError);
      await message.unsend((await waitMsg).messageID);
      const fallbackMsg =
`🕌 নামাজের সময়
════════════════════
📍 জেলা: ${district.bn}
📅 তারিখ: ${dateMoment.format("DD MMMM, YYYY")}
════════════════════
📢 ফজর: ${GLOBAL_CONFIG.defaultTimings?.fajr || "০৫:০৬ AM"}
🌅 মাগরিব: ${GLOBAL_CONFIG.defaultTimings?.maghrib || "০৫:৫৪ PM"}
════════════════════
⚠️ সার্ভার সমস্যা
♡🎀˚₊· ͟͟͞͞➳❥ 𝐑𝐚𝐡𝐚 𝐀𝐈 ࿐🎀 - ২০২৬`;
      return message.reply(fallbackMsg);
    }

  } catch (err) {
    console.error("Main error:", err);
    return message.reply("❌ ত্রুটি হয়েছে। আবার চেষ্টা করুন।");
  }
}

// ==================== সিমুলেটেড মেসেজ ফাংশন (Render-এর জন্য) ====================
async function simulateBot() {
  console.log("🤖 Ramadan Bot is running...");
  console.log("📅 Current time:", moment().tz(TZ).format("DD MMMM YYYY, hh:mm A"));
  console.log("⏳ Waiting for commands...");
  
  // এখানে আপনার বটের লুপ থাকবে
  // যেমন: WhatsApp API, Messenger API ইত্যাদির সাথে কানেক্ট করা
  
  setInterval(() => {
    console.log("✅ Bot is alive -", moment().tz(TZ).format("hh:mm A"));
  }, 60000); // প্রতি ১ মিনিটে alive message
}

// ==================== স্টার্ট ====================
simulateBot();

// এক্সপোর্ট ফাংশন (যাতে অন্য ফাইল থেকে কল করা যায়)
module.exports = {
  runRamadanCommand
};
