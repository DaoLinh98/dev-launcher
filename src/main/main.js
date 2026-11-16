const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, clipboard, Notification, nativeImage } = require('electron');
const path = require('path');
const config = require('./config');
const docker = require('./docker');
const { ServiceManager } = require('./serviceManager');

const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const isAutostart = process.argv.includes('--autostart');

const manager = new ServiceManager();
let cfg;
let win = null;
let tray = null;
let quitting = false;
let cleanedUp = false;

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function applyLoginItem(settings) {
  app.setLoginItemSettings({
    openAtLogin: !!settings.openAtLogin,
    path: process.execPath,
    args: app.isPackaged ? ['--autostart'] : [app.getAppPath(), '--autostart'],
  });
}

async function startDockerContainers() {
  const names = cfg.docker.enabled ? cfg.docker.autoStartContainers || [] : [];
  if (!names.length) return;
  try {
    if (!(await docker.ensureEngine(cfg.docker.desktopPath))) throw new Error('Docker Engine did not start in time');
    await docker.start(names);
  } catch (err) {
    notify('Docker', `Cannot start containers: ${err.message}`);
  }
}

async function startAll() {
  await Promise.all([manager.startAll(), startDockerContainers()]);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
}

function createWindow(startHidden) {
  win = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 900,
    minHeight: 520,
    show: false,
    title: 'Dev Launcher',
    icon: ICON,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });
  // Closing the window keeps servers running in the tray; Quit stops them.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Dev Launcher');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Dev Launcher', click: showWindow },
      { type: 'separator' },
      { label: 'Start all', click: () => startAll() },
      { label: 'Stop all', click: () => manager.stopAll() },
      { type: 'separator' },
      { label: 'Quit (stop all services)', click: () => app.quit() },
    ])
  );
  tray.on('click', showWindow);
}

async function askPortConflict({ service, port, owner }) {
  const who = owner ? `${owner.name} (PID ${owner.pid})` : 'another process';
  const parent = win && win.isVisible() ? win : undefined;
  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    title: 'Port in use',
    message: `Port ${port} is already in use`,
    detail: `"${service.name || service.id}" needs port ${port}, but it is held by ${who}.`,
    buttons: ['Kill it and continue', 'Start anyway', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  return ['kill', 'ignore', 'cancel'][response];
}

function registerIpc() {
  const fireAndForget = (promise) => {
    promise.catch((err) => console.error(err));
    return true;
  };

  ipcMain.handle('state:get', () => manager.snapshot());
  ipcMain.handle('log:get', (_e, id) => manager.getLog(id));
  ipcMain.handle('log:clear', (_e, id) => manager.clearLog(id));
  ipcMain.handle('svc:start', (_e, id) => fireAndForget(manager.start(id)));
  ipcMain.handle('svc:stop', (_e, id) => fireAndForget(manager.stop(id)));
  ipcMain.handle('svc:restart', (_e, id) => fireAndForget(manager.restart(id)));
  ipcMain.handle('svc:killLeftovers', async (_e, id) => {
    try {
      const killed = await manager.killLeftovers(id);
      return { ok: true, killed: killed.map(({ pid, name }) => ({ pid, name })) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('svc:startAll', () => fireAndForget(startAll()));
  ipcMain.handle('svc:stopAll', () => fireAndForget(manager.stopAll()));

  ipcMain.handle('open:folder', (_e, dir) => shell.openPath(dir));
  ipcMain.handle('open:url', (_e, url) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));

  const dockerCall = async (fn) => {
    try {
      await fn();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };
  ipcMain.handle('docker:list', async () => {
    if (!cfg.docker.enabled) return { enabled: false, available: false, containers: [] };
    try {
      return { enabled: true, ...(await docker.list()) };
    } catch (err) {
      return { enabled: true, available: false, containers: [], error: err.message };
    }
  });
  ipcMain.handle('docker:start', (_e, ids) => dockerCall(() => docker.start(ids)));
  ipcMain.handle('docker:stop', (_e, ids) => dockerCall(() => docker.stop(ids)));
  ipcMain.handle('docker:logs', (_e, id) => docker.logs(id));
  ipcMain.handle('docker:startDesktop', () =>
    dockerCall(async () => {
      if (!(await docker.ensureEngine(cfg.docker.desktopPath))) throw new Error('Docker Engine did not start in time');
    })
  );

  ipcMain.handle('config:get', () => ({ path: config.configPath(app), text: config.readText(app) }));
  ipcMain.handle('config:openFile', () => shell.openPath(config.configPath(app)));
  ipcMain.handle('config:save', async (_e, text) => {
    try {
      const next = config.saveText(app, text);
      const kept = new Set(next.services.map((s) => s.id));
      await Promise.all(cfg.services.filter((s) => !kept.has(s.id)).map((s) => manager.stop(s.id)));
      cfg = next;
      manager.setConfig(cfg);
      applyLoginItem(cfg.settings);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function init() {
  app.setAppUserModelId('local.devlauncher');

  try {
    cfg = config.load(app);
  } catch (err) {
    dialog.showErrorBox('Dev Launcher', `Invalid config at ${config.configPath(app)}:\n\n${err.message}`);
    app.exit(1);
    return;
  }

  manager.onPortConflict = askPortConflict;
  manager.on('state', (snapshot) => send('state', snapshot));
  manager.on('log', (entry) => send('log', entry));
  manager.on('failed', ({ name, message }) => notify(`${name} failed`, message));
  manager.setConfig(cfg);

  registerIpc();
  createTray();
  createWindow(isAutostart || cfg.settings.startMinimized);
  applyLoginItem(cfg.settings);

  manager.probe();
  setInterval(() => manager.probe(), 5000);
  if (cfg.settings.startAllOnLaunch) startAll();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(init);
  app.on('before-quit', (e) => {
    quitting = true;
    if (cleanedUp) return;
    e.preventDefault();
    manager
      .stopAll()
      .catch(() => {})
      .finally(() => {
        cleanedUp = true;
        app.quit();
      });
  });
}
