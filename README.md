# WARDOGS gold price alerts

Gets your phone to buzz when the WARDOGS gold bar price drops below a level you care about.

The rate comes from the fan site https://wardogshub.gg/gold-market/. It is one price per
day for everyone and changes at midnight UTC. One script checks it once a day at 4 AM
Danish time (change `cron` and `timezone` in the workflow for your own time) and pushes
alerts through [ntfy](https://ntfy.sh), a free push-notification service with no accounts.

## For friends (30 seconds)

1. Install the **ntfy** app (Android or iOS).
2. Tap **+** and subscribe to the topic for the level you want:
   - `PREFIX-under-500k` pings when gold drops below $500,000
   - `PREFIX-under-300k`, `PREFIX-under-200k`, `PREFIX-under-100k` work the same way
   - (the real `PREFIX` is only shared privately by whoever runs this instance)
3. Done. You get one ping each time the price drops below that level, and another one
   only after it has gone back above it and dropped again.

You can subscribe to several levels. Nothing to install, no GitHub account needed.

## For the maintainer (one-time setup)

1. Create a GitHub repo (public or private, your secrets never go in the code). Put
   `check_gold.mjs` in the root and `gold-alert.yml` in `.github/workflows/`.
2. Pick two ntfy topic names with long random parts and keep both secret. Generate
   each random part with `node -e "console.log(require('crypto').randomBytes(8).toString('hex'))"`.
   - `NTFY_PREFIX`, like `wardogs-<random>`. This is the part friends need.
   - `ADMIN_TOPIC`, like `admin-<another-random>`. Only you subscribe to this one.

   Never write your real topic names into this repo (not in this file, not in the
   workflow). They belong only in the Actions secrets below.
3. Repo Settings -> Secrets and variables -> Actions -> add secrets `NTFY_PREFIX` and
   `ADMIN_TOPIC`.
4. Subscribe to `ADMIN_TOPIC` in the ntfy app, then Actions -> "Gold price alert" ->
   Run workflow with the test box ticked. Your phone should buzz.
5. Run the workflow once more without the box. The first run only records the current
   price (no alerts), then every day at 4 AM it checks for drops.

Levels live in the `THRESHOLDS` line of the workflow file. Change the list, and tell
friends which new topics exist (`PREFIX-under-<level>`, written like 250k or 1m).

### Failures

Only you hear about them. If a run fails (for example the site changed its layout),
`ADMIN_TOPIC` gets one ping, then another when it recovers. Friends never get failure
messages. GitHub will also email you about failed runs as the repo owner. The check runs
once a day, so the workflow sets `FAIL_ALERT_AFTER: "1"`. If you run it more often,
raise it (the script's default is 2) so a one-off network blip doesn't ping you.

### Want your own thresholds instead?

Fork or copy the repo, add your own `NTFY_PREFIX` and `ADMIN_TOPIC` secrets, and edit
`THRESHOLDS`. Failures then go to your own admin topic.

## Notes

- The topic names are the only access control: anyone who learns `PREFIX` can subscribe
  (and post fake alerts), so share it only with friends.
- It makes one request a day to the site no matter how many people subscribe.
- You only learn about a price drop at the next 4 AM check, so a drop that recovers
  within the same day is never seen. The site publishes just one price per day, so
  nothing is lost.
- If the site goes away or changes its layout the alerts stop until the parser is updated.
