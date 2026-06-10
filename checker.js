const https = require("https");
const fs = require("fs");

// ── Config ─────────────────────────────────────────────────
const WATCHES = JSON.parse(fs.readFileSync("watches.json", "utf8"));
const PUSHOVER_USER_KEY  = process.env.PUSHOVER_USER_KEY;
const PUSHOVER_API_TOKEN = process.env.PUSHOVER_API_TOKEN;
const DISCORD_WEBHOOK    = process.env.DISCORD_WEBHOOK;

// AMC Stony Brook 17 — daily snapshot theater (no alerts, just proof of life)
const SNAPSHOT_THEATER = {
  id: "620",                  // AMC Stony Brook 17
  name: "AMC Stony Brook 17",
  slug: "dune-part-three",    // will try a few popular slugs if this 404s
};

// ── HTTP helpers ───────────────────────────────────────────
function httpGet(hostname, path, headers = {}) {
  return new Promise(resolve => {
    const req = https.request({
      hostname, path, method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        Accept: "application/json, text/html, */*",
        ...headers,
      },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ ok: res.statusCode < 400, status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ ok: res.statusCode < 400, status: res.statusCode, body: d }); }
      });
    });
    req.on("error", () => resolve({ ok: false, body: null }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ ok: false, body: null }); });
    req.end();
  });
}

function httpPost(hostname, path, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

// ── ID parsers ─────────────────────────────────────────────
function parseAMCIds(theaterUrl = "", movieUrl = "") {
  const tm = theaterUrl.match(/theatres\/(\d+)-/);
  const mm = movieUrl.match(/movies\/([^/?#]+)/);
  return {
    theaterId:  tm ? tm[1] : null,
    movieSlug:  mm ? mm[1].replace(/-\d{4,}$/, "") : null,
  };
}

function parseFandangoIds(theaterUrl = "", movieUrl = "") {
  const tm = theaterUrl.match(/_([a-z0-9]{4,})(?:\/|$)/i);
  const mm = movieUrl.match(/_([a-z0-9]{4,})(?:\/|$)/i);
  return {
    fanTheaterId: tm ? tm[1].toUpperCase() : null,
    fanMovieId:   mm ? mm[1] : null,
  };
}

// ── Pushover ───────────────────────────────────────────────
async function pushover(title, message, url, urlTitle) {
  if (!PUSHOVER_USER_KEY || !PUSHOVER_API_TOKEN) return;
  try {
    await httpPost("api.pushover.net", "/1/messages.json", {
      token: PUSHOVER_API_TOKEN, user: PUSHOVER_USER_KEY,
      title, message,
      url: url || "", url_title: urlTitle || "Buy Now",
      priority: 2, retry: 30, expire: 600,
      sound: "cashregister",
    });
    console.log("📲 Pushover sent");
  } catch(e) { console.error("Pushover error:", e.message); }
}

// ── Discord ────────────────────────────────────────────────
async function discord(content, embeds) {
  if (!DISCORD_WEBHOOK) return;
  try {
    const u = new URL(DISCORD_WEBHOOK);
    await httpPost(u.hostname, u.pathname + u.search, {
      content: content || null,
      embeds: embeds || [],
    });
    console.log("💬 Discord sent");
  } catch(e) { console.error("Discord error:", e.message); }
}

// ── Seat helpers ───────────────────────────────────────────
function parseAMCSeats(m) {
  if (!m) return [];
  const seats = [];
  for (const row of (m?.seatMap?.rows || m?.rows || [])) {
    const r = row.physicalName || row.label || row.id || "?";
    for (const s of (row.seats || row.seatList || [])) {
      const avail = s.status === "AVAILABLE" || s.status === "available" || s.seatStatusCode === "A";
      if (avail) seats.push(`Row ${r} Seat ${s.physicalName || s.seatNumber || s.id || "?"}`);
    }
  }
  return seats;
}

function parseFandangoSeats(m) {
  if (!m) return [];
  const seats = [];
  for (const row of (m?.seatMap?.rows || m?.rows || m?.data?.rows || [])) {
    const r = row.rowId || row.label || row.name || "?";
    for (const s of (row.seats || [])) {
      const avail = s.status === "AVAILABLE" || s.status === "available" || s.seatStatus === "A" || s.isAvailable;
      if (avail) seats.push(`Row ${r} Seat ${s.seatNumber || s.number || s.id || "?"}`);
    }
  }
  return seats;
}

// Render a text seat map grid for Discord (max 20 rows, 24 cols)
function seatGrid(rawMap, availSeats) {
  const rows = rawMap?.seatMap?.rows || rawMap?.rows || rawMap?.data?.rows || [];
  if (!rows.length) {
    return availSeats > 0
      ? `💺 ${availSeats} seat(s) available — seat map not loaded`
      : "🔴 No seats — seat map not available";
  }

  const SCREEN = "▬▬▬▬▬▬  SCREEN  ▬▬▬▬▬▬";
  const lines = [SCREEN, ""];

  for (const row of rows.slice(0, 20)) {
    const label = (row.physicalName || row.label || row.rowId || row.id || "?").toString().padEnd(3);
    const seatList = (row.seats || row.seatList || []).slice(0, 24);
    const cells = seatList.map(s => {
      const avail = s.status === "AVAILABLE" || s.status === "available" ||
                    s.seatStatusCode === "A" || s.isAvailable === true;
      const aisle = s.type === "AISLE" || s.seatType === "aisle";
      if (aisle) return " ";
      return avail ? "🟩" : "🟥";
    }).join("");
    lines.push(`${label}${cells}`);
  }

  lines.push("");
  lines.push(`🟩 Available (${availSeats})  🟥 Taken`);
  return lines.join("\n");
}

// ── AMC showtime fetch ─────────────────────────────────────
async function fetchAMCShowtimes(theaterId, movieSlug, date) {
  const r = await httpGet(
    "www.amctheatres.com",
    `/api/v3/theatres/${theaterId}/showtimes/${movieSlug}?date=${date}&countryId=US`,
    { "X-AMC-Vendor-Key": "amc-theatres", Referer: "https://www.amctheatres.com/" }
  );
  if (!r.ok || !r.body) return [];
  return r.body?.showtimes || r.body?.data?.showtimes || [];
}

async function fetchAMCSeatMap(showtimeId) {
  const r = await httpGet(
    "www.amctheatres.com",
    `/api/v3/showtimes/${showtimeId}/seatmap`,
    { "X-AMC-Vendor-Key": "amc-theatres", Referer: "https://www.amctheatres.com/" }
  );
  return r.ok ? r.body : null;
}

// ── Fandango showtime fetch ────────────────────────────────
async function fetchFandangoShowtimes(theaterId, movieId, date) {
  const r = await httpGet(
    "www.fandango.com",
    `/api/v3/showtime/showDateList?theaterId=${theaterId}&movieId=${movieId}&date=${date}&filter=all`,
    { Referer: "https://www.fandango.com/", "x-fandango-app": "FAN_WEB" }
  );
  if (!r.ok || !r.body) return [];
  return r.body?.showDates?.[0]?.theaters?.[0]?.showtimes || r.body?.showtimes || [];
}

async function fetchFandangoSeatMap(performanceId, theaterId) {
  const r = await httpGet(
    "www.fandango.com",
    `/api/v3/seatmap?performanceId=${performanceId}&theaterId=${theaterId}`,
    { Referer: "https://www.fandango.com/", "x-fandango-app": "FAN_WEB" }
  );
  return r.ok ? r.body : null;
}

// ── Main checkers ──────────────────────────────────────────
async function checkAMC(watch) {
  const { theaterId, movieSlug } = parseAMCIds(watch.amcTheaterUrl, watch.amcMovieUrl);
  if (!theaterId || !movieSlug) {
    console.log(`  ⚠️  [AMC] Can't parse IDs for "${watch.name}"`);
    return;
  }
  console.log(`\n🎬 [AMC] ${watch.name} — theater:${theaterId} slug:${movieSlug}`);

  for (const date of watch.dates) {
    const showtimes = await fetchAMCShowtimes(theaterId, movieSlug, date);
    console.log(`  📅 ${date} — ${showtimes.length} showtime(s)`);

    for (const st of showtimes) {
      const id       = st.id || st.showtimeId;
      const time     = st.showDateTimeLocal || st.showtime || "?";
      const fmt      = st.movieFormat || st.format || "";
      const avail    = st.seatsAvailable ?? st.availableSeats ?? null;
      const soldOut  = avail === 0 || st.isSoldOut;
      console.log(`    🕐 [${fmt}] ${time} — seats:${avail ?? "?"} soldOut:${soldOut}`);

      if (soldOut) continue;

      const seatMap  = id ? await fetchAMCSeatMap(id) : null;
      const seats    = parseAMCSeats(seatMap);
      const buyUrl   = `https://www.amctheatres.com/movies/${movieSlug}/showtimes/${id}`;

      if (seats.length > 0 || (avail !== null && avail > 0)) {
        const count    = seats.length || avail;
        const seatList = seats.length
          ? seats.slice(0, 15).join(", ") + (seats.length > 15 ? ` (+${seats.length - 15} more)` : "")
          : `~${avail} seats (seat map unavailable)`;
        const grid     = seatGrid(seatMap, count);

        console.log(`  🎉 SEATS OPEN: ${count}`);

        // Pushover — emergency priority (bypasses Do Not Disturb)
        await pushover(
          `🎟️ AMC SEATS OPEN — ${watch.name}!`,
          `📍 ${watch.theater}\n📅 ${date}\n🕐 ${fmt} ${time}\n💺 ${count} seat(s):\n${seatList}\n\nBUY NOW — seats sell in seconds!`,
          buyUrl, "Buy on AMC →"
        );

        // Discord — @everyone ping + full seat grid
        await discord(`<@everyone> 🚨 **SEATS AVAILABLE — BUY NOW** 🚨`, [{
          title: `🎟️ ${watch.name} — SEATS OPEN at ${watch.theater}!`,
          description: `**${count} seat(s) available right now!**\n\`\`\`\n${grid}\n\`\`\``,
          color: 0x2ec27e,
          fields: [
            { name: "📍 Theater",  value: watch.theater,        inline: true },
            { name: "📅 Date",     value: date,                 inline: true },
            { name: "🕐 Showtime", value: `${fmt} ${time}`,     inline: true },
            { name: "💺 Seats",    value: seatList,             inline: false },
          ],
          url: buyUrl,
          footer: { text: "Act FAST — tap the title to buy • Seats can sell in seconds" },
          timestamp: new Date().toISOString(),
        }]);
      }
    }
  }
}

async function checkFandango(watch) {
  const { fanTheaterId, fanMovieId } = parseFandangoIds(watch.fanTheaterUrl, watch.fanMovieUrl);
  if (!fanTheaterId || !fanMovieId) {
    console.log(`  ⚠️  [Fandango] Can't parse IDs for "${watch.name}" — skipping`);
    return;
  }
  console.log(`\n🎬 [Fandango] ${watch.name} — theater:${fanTheaterId} movie:${fanMovieId}`);

  for (const date of watch.dates) {
    const showtimes = await fetchFandangoShowtimes(fanTheaterId, fanMovieId, date);
    console.log(`  📅 ${date} — ${showtimes.length} showtime(s)`);

    for (const st of showtimes) {
      const id       = st.id || st.showtimeId || st.performanceId;
      const time     = st.showTime || st.startTime || "?";
      const fmt      = st.screenType || st.format || "";
      const avail    = st.seatsRemaining ?? st.availableSeats ?? null;
      const soldOut  = st.isSoldOut || st.soldOut || avail === 0;
      console.log(`    🕐 [${fmt}] ${time} — seats:${avail ?? "?"}`);

      if (soldOut) continue;

      const seatMap  = id ? await fetchFandangoSeatMap(id, fanTheaterId) : null;
      const seats    = parseFandangoSeats(seatMap);
      const buyUrl   = `https://www.fandango.com/${fanTheaterId.toLowerCase()}/tickets?performanceId=${id}`;

      if (seats.length > 0 || (avail !== null && avail > 0)) {
        const count    = seats.length || avail;
        const seatList = seats.length
          ? seats.slice(0, 15).join(", ") + (seats.length > 15 ? ` (+${seats.length - 15} more)` : "")
          : `~${avail} seats (seat map unavailable)`;
        const grid     = seatGrid(seatMap, count);

        console.log(`  🎉 FANDANGO SEATS: ${count}`);

        await pushover(
          `🎟️ Fandango SEATS OPEN — ${watch.name}!`,
          `📍 ${watch.theater}\n📅 ${date}\n🕐 ${fmt} ${time}\n💺 ${count} seat(s):\n${seatList}\n\nBUY NOW!`,
          buyUrl, "Buy on Fandango →"
        );

        await discord(`<@everyone> 🚨 **FANDANGO SEATS AVAILABLE — BUY NOW** 🚨`, [{
          title: `🎟️ ${watch.name} — SEATS OPEN on Fandango!`,
          description: `**${count} seat(s) available right now!**\n\`\`\`\n${grid}\n\`\`\``,
          color: 0x2ec27e,
          fields: [
            { name: "📍 Theater",  value: watch.theater,    inline: true },
            { name: "📅 Date",     value: date,             inline: true },
            { name: "🕐 Showtime", value: `${fmt} ${time}`, inline: true },
            { name: "💺 Seats",    value: seatList,         inline: false },
          ],
          url: buyUrl,
          footer: { text: "Act FAST — tap title to buy" },
          timestamp: new Date().toISOString(),
        }]);
      }
    }
  }
}

// ── Daily snapshot — AMC Stony Brook 17 ───────────────────
// Runs once a day, no pings, no Pushover — just proof the bot is alive
// Picks a random upcoming showtime and posts its seat map to Discord
async function dailySnapshot() {
  console.log("\n📸 Daily snapshot — AMC Stony Brook 17");

  // Try today + next 3 days to find any showtime
  const dates = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }

  // Try a handful of popular movie slugs in case Dune isn't showing
  const slugsToTry = [
    SNAPSHOT_THEATER.slug,
    "mission-impossible-the-final-reckoning",
    "lilo-and-stitch",
    "a-minecraft-movie",
    "thunderbolts",
    "sinners",
  ];

  let found = null;

  outer:
  for (const slug of slugsToTry) {
    for (const date of dates) {
      const showtimes = await fetchAMCShowtimes(SNAPSHOT_THEATER.id, slug, date);
      if (showtimes.length) {
        // Pick a random showtime
        const st = showtimes[Math.floor(Math.random() * showtimes.length)];
        found = { slug, date, st };
        break outer;
      }
    }
  }

  if (!found) {
    await discord(null, [{
      title: "📸 Daily Bot Snapshot — AMC Stony Brook 17",
      description: "✅ Bot is alive and running!\n\nCouldn't find any current showtimes to display today — this is normal if your target movie isn't showing yet.",
      color: 0x4a9eff,
      footer: { text: "Checking every 5 min for your target movies • No alert = no seats found" },
      timestamp: new Date().toISOString(),
    }]);
    return;
  }

  const { slug, date, st } = found;
  const id      = st.id || st.showtimeId;
  const time    = st.showDateTimeLocal || st.showtime || "?";
  const fmt     = st.movieFormat || st.format || "";
  const avail   = st.seatsAvailable ?? st.availableSeats ?? "?";
  const title   = st.movieTitle || st.movieName || slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

  const seatMap = id ? await fetchAMCSeatMap(id) : null;
  const seats   = parseAMCSeats(seatMap);
  const grid    = seatGrid(seatMap, seats.length);

  const now = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true
  });

  // No @everyone — just a quiet status post
  await discord(null, [{
    title: `📸 Daily Bot Snapshot — ${now}`,
    description: `**Bot is alive and running!** ✅\nChecking your target movies every 5 minutes. No alert = no seats found yet.\n\nHere's a random showing from AMC Stony Brook 17 to confirm the seat map is working:`,
    color: 0x4a9eff,
    fields: [
      { name: "🎬 Movie",    value: title,              inline: true  },
      { name: "📅 Date",     value: date,               inline: true  },
      { name: "🕐 Showtime", value: `${fmt} ${time}`,   inline: true  },
      { name: "💺 Availability", value: `${seats.length || avail} seat(s) found`, inline: true },
      { name: "🗺️ Seat Map", value: `\`\`\`\n${grid}\n\`\`\``, inline: false },
    ],
    footer: { text: "AMC Stony Brook 17 • Snapshot only — no alert unless your target movie has seats" },
    timestamp: new Date().toISOString(),
  }]);

  console.log(`✅ Snapshot sent — ${title} on ${date} at ${time}`);
}

// ── Test ───────────────────────────────────────────────────
async function runTest() {
  console.log("🧪 Test run...");
  await pushover(
    "🧪 Ticket Bot — Live!",
    "Your bot is running on GitHub Actions.\n\nWatching:\n" +
    WATCHES.map(w => `• ${w.name} @ ${w.theater}`).join("\n") +
    "\n\nYou'll be notified INSTANTLY when seats open.",
    "https://www.amctheatres.com", "Visit AMC"
  );
  await discord(null, [{
    title: "🧪 Ticket Bot — Test Successful! ✅",
    description: "Bot is live on GitHub Actions!\n\n**Currently watching:**",
    color: 0x4a9eff,
    fields: WATCHES.map(w => ({
      name: `🎬 ${w.name}`,
      value: `📍 ${w.theater}\n📅 ${w.dates.join(" • ")}\n📡 ${w.source?.toUpperCase() || "AMC + FANDANGO"}`,
      inline: false,
    })),
    footer: { text: "Checking every 5 min • Daily snapshot @ 9AM ET from AMC Stony Brook 17" },
    timestamp: new Date().toISOString(),
  }]);
  console.log("✅ Test done!");
}

// ── Entry point ────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--test")) { await runTest(); return; }
  if (args.includes("--daily-snapshot")) { await dailySnapshot(); return; }

  console.log(`\n🤖 Ticket Bot — ${new Date().toISOString()}`);
  console.log(`Watching ${WATCHES.length} entr${WATCHES.length === 1 ? "y" : "ies"}...\n`);

  for (const w of WATCHES.filter(w => w.active !== false)) {
    if (w.source === "amc"      || w.source === "both") await checkAMC(w);
    if (w.source === "fandango" || w.source === "both") await checkFandango(w);
  }

  console.log("\n✅ Check complete.");
}

main().catch(err => { console.error("❌ Fatal:", err); process.exit(1); });
