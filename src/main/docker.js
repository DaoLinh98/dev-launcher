const { spawn } = require('child_process');
const fs = require('fs');
const { run, waitFor } = require('./ports');

async function isEngineUp() {
  try {
    await run('docker', ['info', '--format', '{{.ServerVersion}}'], 8000);
    return true;
  } catch {
    return false;
  }
}

function simplifyPorts(ports) {
  const mapped = new Set();
  for (const m of (ports || '').matchAll(/:(\d+)->(\d+)\/\w+/g)) mapped.add(`${m[1]}:${m[2]}`);
  return [...mapped].join(', ');
}

async function listContainers() {
  const out = await run('docker', ['ps', '-a', '--format', '{{json .}}'], 10000);
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const c = JSON.parse(line);
      const project = /com\.docker\.compose\.project=([^,]+)/.exec(c.Labels || '');
      return {
        id: c.ID,
        name: c.Names,
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: simplifyPorts(c.Ports),
        project: project ? project[1] : '',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function list() {
  if (!(await isEngineUp())) return { available: false, containers: [] };
  return { available: true, containers: await listContainers() };
}

async function start(ids) {
  await run('docker', ['start', ...ids], 120000);
}

async function stop(ids) {
  await run('docker', ['stop', ...ids], 120000);
}

async function logs(id) {
  // docker writes container stderr to its own stderr, so merge both streams.
  return new Promise((resolve) => {
    const child = spawn('docker', ['logs', '--tail', '500', id], { windowsHide: true });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('close', () => resolve(text));
    child.on('error', (e) => resolve(String(e.message)));
  });
}

async function ensureEngine(desktopPath, timeoutMs = 180000) {
  if (await isEngineUp()) return true;
  if (!fs.existsSync(desktopPath)) throw new Error(`Docker Desktop not found at ${desktopPath}`);
  spawn(desktopPath, [], { detached: true, stdio: 'ignore' }).unref();
  return waitFor(isEngineUp, timeoutMs, 3000);
}

module.exports = { list, start, stop, logs, ensureEngine };
