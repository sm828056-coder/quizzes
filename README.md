# Seoul Quest

Seoul Quest is a multiplayer South Korea quiz. GitHub Pages hosts the browser interface, and the Node API stores rooms and scores.

## Deploy the API

1. Push this repository to GitHub.
2. In Render, create a new **Blueprint** and connect this repository. Render uses `render.yaml` to deploy the `seoul-quest-api` service.
3. Wait for the service health check to pass, then copy its public URL from the Render dashboard.
4. Put that URL in `config.js` as `apiBaseUrl`, without a trailing slash, and push the change to GitHub.

## Publish the page

1. In GitHub, open **Settings > Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, select your branch and `/(root)`, then save.
3. Open the Pages URL shown in Settings. The site works from a repository subpath, and room invites link back to this page.

## Run locally

Run `node server.cjs` and open `http://localhost:3000`. Leave the server running while the game is in progress.

Rooms are held in server memory, so they end if the API service restarts or redeploys. Render's free service may take a short time to wake after inactivity.
