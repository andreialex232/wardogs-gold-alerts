#!/usr/bin/env node
// Ping a phone (via ntfy) when the WARDOGS gold bar price drops below a threshold.
//
// Reads the daily rate from https://wardogshub.gg/gold-market/ (fan site; the rate
// is fixed per day and turns over at midnight UTC). No dependencies, Node 18+.
//
// Env vars:
//   NTFY_TOPIC  (required) your ntfy topic name
//   THRESHOLD   (optional) alert when price is below this, default 200000
//   STATE_FILE  (optional) where to remember the last state, default state.json
//
// Usage:
//   node check_gold.mjs          # normal check
//   node check_gold.mjs --test   # just send a test notification

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PAGE_URL = "https://wardogshub.gg/gold-market/";
const THRESHOLD = Number(process.env.THRESHOLD ?? "200000");
const NTFY_TOPIC = (process.env.NTFY_TOPIC ?? "").trim();
const STATE_FILE = process.env.STATE_FILE ?? "state.json";
const USER_AGENT = "Mozilla/5.0 (compatible; personal-gold-alert/1.0)";

// Primary: the page's meta description, e.g.
//   "One WARDOGS gold bar costs $862,150 on 25 October 2026."
const PRIMARY = /gold bar costs \$([\d,]+) on (\d{1,2} \w+ \d{4})/i;
// Fallback: the visible hero block, "One gold bar · 25 October 2026 ... $862,150"
const FALLBACK = /One gold bar\s*[·•-]\s*(\d{1,2} \w+ \d{4})[\s\S]{0,400}?\$([\d,]+)/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchPage(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await sleep(3000 * (i + 1));
    }
  }
  throw new Error(`could not fetch ${url}: ${lastErr}`);
}

// Returns { price, date }. Throws if the page layout changed.
export function parse(html) {
  let price, date;
  let m = PRIMARY.exec(html);
  if (m) {
    [, price, date] = m;
  } else {
    m = FALLBACK.exec(html);
    if (!m) throw new Error("could not find the gold price on the page (layout changed?)");
    [, date, price] = m;
  }
  const value = Number(price.replace(/,/g, ""));
  if (!(value >= 1_000 && value <= 1_000_000_000)) {
    throw new Error(`parsed an implausible price: ${value}`); // sanity check
  }
  return { price: value, date };
}

export async function notify(title, message, priority = "default", tags = "") {
  if (!NTFY_TOPIC) throw new Error("NTFY_TOPIC is not set");
  const headers = { Title: title, Priority: priority, "User-Agent": USER_AGENT };
  if (tags) headers.Tags = tags;
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    headers,
    body: message,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`ntfy responded with HTTP ${res.status}`);
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

// Alerts once per drop below the threshold, then stays quiet until it recovers.
export function decide(price, state, threshold = THRESHOLD) {
  const wasBelow = Boolean(state.below);
  const isBelow = price < threshold;
  return { shouldAlert: isBelow && !wasBelow, newState: { below: isBelow } };
}

async function main() {
  if (process.argv.includes("--test")) {
    await notify("Gold alert test", "If you see this, phone notifications work.", "default", "white_check_mark");
    console.log("Test notification sent.");
    return;
  }

  const { price, date } = parse(await fetchPage(PAGE_URL));
  console.log(`Gold bar rate for ${date}: $${price.toLocaleString("en-US")} (threshold $${THRESHOLD.toLocaleString("en-US")})`);

  const state = await loadState();
  const { shouldAlert, newState } = decide(price, state);
  Object.assign(newState, { last_price: price, last_date: date });

  if (shouldAlert) {
    await notify(
      "WARDOGS gold is cheap",
      `Gold bar is $${price.toLocaleString("en-US")} (${date}), below your $${THRESHOLD.toLocaleString("en-US")} alert.`,
      "high",
      "moneybag",
    );
    console.log("Alert sent.");
  } else {
    console.log("No alert needed.");
  }

  await saveState(newState);
}

// Only run when executed directly, so the functions above can be imported for tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    // Fail loudly so GitHub emails you instead of silently watching nothing.
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}
