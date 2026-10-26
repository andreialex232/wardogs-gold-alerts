#!/usr/bin/env node
// WARDOGS gold bar price alerts via ntfy.
//
// One copy of this script checks the daily rate on https://wardogshub.gg/gold-market/
// (fan site; the rate is fixed per day and turns over at midnight UTC) and publishes
// to one ntfy topic per price level. Anyone who subscribes to a level's topic in the
// ntfy app gets pinged when the price drops below it. No dependencies, Node 18+.
//
// Env vars:
//   NTFY_PREFIX  secret topic prefix shared with your friends. Alerts go to
//                <prefix>-under-<level>, e.g. myprefix-under-200k
//   ADMIN_TOPIC  your private topic: gets "it's failing" and "recovered" pings
//                (optional, but this is how you find out when something breaks)
//   THRESHOLDS   comma-separated price levels, default 600000,500000,400000,300000,200000,100000
//   FAIL_ALERT_AFTER  failed runs in a row before ADMIN_TOPIC is pinged, default 2
//   STATE_FILE   where to remember state, default state.json
//
// Usage:
//   node check_gold.mjs          # normal check
//   node check_gold.mjs --test   # send a test ping to ADMIN_TOPIC

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PAGE_URL = "https://wardogshub.gg/gold-market/";
const NTFY_PREFIX = (process.env.NTFY_PREFIX ?? "").trim();
const ADMIN_TOPIC = (process.env.ADMIN_TOPIC ?? "").trim();
const THRESHOLDS_RAW = process.env.THRESHOLDS ?? "1000000,900000,800000,700000,600000,500000,400000,300000,200000,100000";
const STATE_FILE = process.env.STATE_FILE ?? "state.json";
const USER_AGENT = "Mozilla/5.0 (compatible; personal-gold-alert/1.0)";

// Primary: the page's meta description, e.g.
//   "One WARDOGS gold bar costs $862,150 on 25 October 2026."
const PRIMARY = /gold bar costs \$([\d,]+) on (\d{1,2} \w+ \d{4})/i;
// Fallback: the visible hero block, "One gold bar · 25 October 2026 ... $862,150"
const FALLBACK = /One gold bar\s*[·•-]\s*(\d{1,2} \w+ \d{4})[\s\S]{0,400}?\$([\d,]+)/i;

const fmt = (n) => `$${n.toLocaleString("en-US")}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- fetching & parsing ----------

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

// ---------- tiers ----------

export function parseThresholds(raw) {
  const list = [...new Set(raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0))];
  if (list.length === 0) throw new Error("THRESHOLDS has no valid numbers");
  return list.sort((a, b) => b - a);
}

// 200000 -> "200k", 1000000 -> "1m"
export function tierLabel(n) {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}m`;
  if (n % 1_000 === 0) return `${n / 1_000}k`;
  return String(n);
}

// Which levels did the price just drop below? Each level alerts once per drop and
// re-arms when the price goes back above it. The first ever run only records a
// baseline, so a brand-new setup doesn't blast everyone with old news.
export function decideTiers(price, prevTiers, thresholds) {
  const baseline = prevTiers === undefined;
  const tiers = {};
  const crossed = [];
  for (const t of thresholds) {
    const below = price < t;
    tiers[t] = below;
    if (!baseline && below && !prevTiers[t]) crossed.push(t);
  }
  return { tiers, crossed, baseline };
}

// ---------- ntfy ----------

export async function notify(topic, title, message, priority = "default", tags = "") {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) throw new Error(`invalid ntfy topic name: ${topic}`);
  const headers = { Title: title, Priority: priority, "User-Agent": USER_AGENT };
  if (tags) headers.Tags = tags;
  const res = await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers,
    body: message,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`ntfy responded with HTTP ${res.status}`);
}

// ---------- one check, with all the bookkeeping ----------
// Pure orchestration: network and notifications are injected so it can be tested.
// Returns the new state plus the failure (if any); the caller saves the state.

export async function step(state, { getHtml, send, sendAdmin, thresholds, prefix, failAfter = 2 }) {
  const next = { ...state };
  let failure = null;

  try {
    const { price, date } = parse(await getHtml());
    console.log(`Gold bar rate for ${date}: ${fmt(price)}`);

    const { tiers, crossed, baseline } = decideTiers(price, state.tiers, thresholds);
    Object.assign(next, { tiers, last_price: price, last_date: date });

    if (baseline) {
      console.log("First run: baseline recorded, no alerts sent.");
    } else if (crossed.length === 0) {
      console.log("No alert needed.");
    } else {
      if (!prefix) throw new Error("NTFY_PREFIX is not set");
      const errors = [];
      for (const t of crossed) {
        const label = tierLabel(t);
        try {
          await send(`${prefix}-under-${label}`, `WARDOGS gold under ${label}`, `Gold bar is ${fmt(price)} (${date}), below ${fmt(t)}.`, "high", "moneybag");
          console.log(`Alert sent to the under-${label} topic.`);
        } catch (err) {
          tiers[t] = false; // not delivered, so try again on the next run
          errors.push(`${label}: ${err.message}`);
        }
      }
      if (errors.length) throw new Error(`failed to send alert(s): ${errors.join("; ")}`);
    }
  } catch (err) {
    failure = err;
  }

  if (failure) {
    console.error(`ERROR: ${failure.message}`);
    next.consecutive_failures = (state.consecutive_failures ?? 0) + 1;
    // Ping after `failAfter` failed runs in a row (default 2, so a one-off network blip
    // doesn't wake you up). Only one ping per outage, however long it lasts.
    if (next.consecutive_failures >= failAfter && !state.admin_notified) {
      try {
        await sendAdmin("Gold alert is failing", `${next.consecutive_failures} runs in a row. Latest error: ${failure.message}`, "high", "warning");
        next.admin_notified = true;
      } catch (err) {
        console.error(`Could not notify admin: ${err.message}`);
      }
    }
  } else {
    next.consecutive_failures = 0;
    if (state.admin_notified) {
      try {
        await sendAdmin("Gold alert recovered", "It is working again.", "default", "white_check_mark");
        next.admin_notified = false;
      } catch (err) {
        console.error(`Could not notify admin: ${err.message}`);
      }
    }
  }

  return { next, failure };
}

// ---------- entry point ----------

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  if (process.argv.includes("--test")) {
    if (!ADMIN_TOPIC) throw new Error("ADMIN_TOPIC is not set");
    await notify(ADMIN_TOPIC, "Gold alert test", "If you see this, phone notifications work.", "default", "white_check_mark");
    console.log("Test notification sent to your admin topic.");
    return;
  }

  const state = await loadState();
  const { next, failure } = await step(state, {
    getHtml: () => fetchPage(PAGE_URL),
    send: notify,
    sendAdmin: ADMIN_TOPIC
      ? (title, msg, priority, tags) => notify(ADMIN_TOPIC, title, msg, priority, tags)
      : async () => console.log("(ADMIN_TOPIC not set, skipping admin notice)"),
    thresholds: parseThresholds(THRESHOLDS_RAW),
    prefix: NTFY_PREFIX,
    failAfter: Math.max(1, Number(process.env.FAIL_ALERT_AFTER ?? 2) || 2),
  });

  await writeFile(STATE_FILE, JSON.stringify(next, null, 2) + "\n");
  // A non-zero exit marks the run red in GitHub, which also emails the repo owner.
  if (failure) process.exitCode = 1;
}

// Only run when executed directly, so the functions above can be imported for tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}
