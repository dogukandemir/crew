# dev/mock — run the UI with no backend

A single-file, zero-dependency stand-in for the backend's REST contract. Its purpose is
the one thing that used to require the whole stack, provider keys and spend: **seeing the
office**.

```bash
node dev/mock/server.mjs          # http://127.0.0.1:8788

# and point the UI at it
cd frontend
echo 'VITE_API_BASE=http://127.0.0.1:8788' > .env.local
npm run dev                       # http://localhost:5173
```

## What it does

- Serves the read endpoints the control room needs (org, tasks, events, metrics,
  leaderboard, brains, approvals) in the shapes of `docs/11`.
- **Grows while you watch.** The org is a function of the clock, evaluated per request:
  at t+12 a second engineer joins an existing department, at t+30 a hire into nothing opens
  the Growth department — a new room on the canvas — and t+48/t+64 grow it further. The
  clock starts on the **first request**, not at boot, so the growth begins when you open
  the page rather than before you looked.
- `POST /api/dev/reset` restarts that clock (the temporary reset-clock button on the
  office floor calls it).
- Notices when you have been staring at it: the events it serves are re-timestamped per
  request, because a snapshot taken at boot ages out of the six-second activity windows
  and makes working features look broken.

## What it is not

- Not a backend. No persistence, no auth, no orchestration — every write answers with a
  generic `ack`.
- Not the contract's source of truth. `docs/11` is; when they disagree, this file is wrong
  and should be fixed or deleted rather than trusted.
- Not for production. It exists so that a reader with no API keys can still see what the
  system does, and so the office can be exercised in a browser without spending anything.
