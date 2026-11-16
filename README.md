# Dev Launcher

Start, stop and watch local dev servers, ngrok, Ollama and Docker containers from one window.

## Run

```powershell
npm install
npm start            # run from source
npm run dist         # build dist\Dev Launcher Setup <version>.exe
```

## Configuration

Edit in the app (**⚙ Settings**) or directly in `%APPDATA%\dev-launcher\services.json`.
The first run copies `default-services.json` there. See *Config reference* in the Settings panel.

Key behaviour:

- **Start all** starts every service with `autoStart` not `false`, plus `docker.autoStartContainers`.
- `port`: checked before start (dialog offers to kill the owner), passed as `PORT`, and used to detect *Ready*.
- `dependsOn`: hard dependency, started automatically and must be ready (ngrok → ticket-executor).
- `startAfter`: ordering only; waits if the other service is already starting (keeps port 3000 for ticket-executor).
- `type: "ollama"`: ensures the server runs (`ollama serve` if needed) and preloads `model` with `keep_alive: -1`.
  Stop unloads the model and stops the server only if Dev Launcher started it.
- Closing the window keeps everything running in the tray. **Quit** from the tray stops all services
  (Docker containers are left as they are).
