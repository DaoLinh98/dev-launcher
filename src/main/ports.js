const net = require('net');
const { execFile } = require('child_process');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = (stderr || '').trim() || err.message;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function canConnect(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// Dev servers bind to IPv4 or IPv6 loopback depending on the tool, so check both.
async function isPortOpen(port) {
  return (await canConnect(port, '127.0.0.1')) || (await canConnect(port, '::1'));
}

async function waitFor(check, timeoutMs, intervalMs = 500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function findPortOwner(port) {
  const script =
    `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
    `if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; "$($c.OwningProcess)|$($p.ProcessName)" }`;
  try {
    const out = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).trim();
    if (!out) return null;
    const [pid, name] = out.split('|');
    return { pid: Number(pid), name: name || 'unknown' };
  } catch {
    return null;
  }
}

async function listProcesses(selector) {
  const script = `Get-Process ${selector} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.ProcessName)" }`;
  try {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [pid, name] = line.split('|');
        return { pid: Number(pid), name: name || 'unknown' };
      });
  } catch {
    return [];
  }
}

// All processes with this image name, e.g. "ngrok" (no extension).
function findProcessesByName(name) {
  if (!/^[\w.-]+$/.test(name)) return [];
  return listProcesses(`-Name '${name}'`);
}

async function findProcessById(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return (await listProcesses(`-Id ${pid}`))[0] || null;
}

// Commands run through cmd.exe, so the whole process tree must be killed to free the port.
async function killTree(pid) {
  if (!pid) return;
  try {
    await run('taskkill', ['/PID', String(pid), '/T', '/F']);
  } catch {
    // Process already gone.
  }
}

module.exports = { sleep, run, isPortOpen, waitFor, findPortOwner, findProcessesByName, findProcessById, killTree };
