# Vocalis speech to text

Vocalis is a regular web application: the browser frontend is in `public/`, and the Node.js/Express API stores transcription history in PostgreSQL.

## Run PostgreSQL in Docker

1. Start Docker Desktop.
2. Run `docker compose up -d` in this folder. `compose.yaml` starts PostgreSQL 18 with a persistent Docker volume; `.env` contains the local connection settings and password.
3. Run `npm install`, then `npm start`; open http://localhost:3000. The app creates the account, session, and transcription tables on startup.

Use `docker compose stop` to stop PostgreSQL and `docker compose start` to start it again. The volume keeps the database when the container stops or is recreated. For hosted PostgreSQL, set `DATABASE_URL` to the provider's connection string and `DB_SSL=true` if the provider requires TLS. Keep `.env` and database credentials private.

Signed-out visitors can create drafts, but must sign up or sign in to save and view transcription history. Passwords are stored as scrypt hashes, and sign-in sessions expire after seven days. Existing transcription rows created before accounts were added are left unassigned and do not appear in any account. Speech recognition uses the browser Web Speech API and requires a supported browser and microphone permission.

## Deploy to Netlify

Netlify serves `public/` and runs the Express API through `netlify/functions/api.js`. The rewrite in `netlify.toml` keeps the frontend's `/api` requests on the same domain. Connect this repository to Netlify and set these environment variables in the site's environment settings:

- `DATABASE_URL`: connection string for a hosted PostgreSQL database that allows connections from Netlify.
- `DB_SSL=true` if the database provider requires TLS.
- `NODE_ENV=production` so account cookies are sent securely over HTTPS.

The PostgreSQL database in Docker on your computer is only reachable locally; Netlify needs a hosted database. Never commit `.env` or put database credentials in frontend files. You can deploy the same repository to GitHub and link it to Netlify for automatic deployments on pushes.
