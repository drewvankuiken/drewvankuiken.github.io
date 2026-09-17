#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = process.cwd();
const defaultChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function usage() {
  console.error(
    'Usage: node scripts/export_modernslides_pdf.js ' +
      '--input mar_26/transmission.txt ' +
      '--output mar_26/transmission.pdf ' +
      '[--port 4173] [--chrome-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]'
  );
}

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    port: 4173,
    chromePath: defaultChromePath,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      opts.input = argv[++i];
    } else if (arg === '--output') {
      opts.output = argv[++i];
    } else if (arg === '--port') {
      opts.port = Number.parseInt(argv[++i], 10);
    } else if (arg === '--chrome-path') {
      opts.chromePath = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.input || !opts.output || !Number.isFinite(opts.port)) {
    usage();
    throw new Error('Missing or invalid required arguments.');
  }

  return opts;
}

function toAbsoluteRepoPath(relativePath) {
  return path.resolve(repoRoot, relativePath);
}

function toUrlPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return '/' + normalized.split('/').map(encodeURIComponent).join('/');
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

function startStaticServer(port) {
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);
    const requestedPath = decodeURIComponent(reqUrl.pathname);
    const relativePath = requestedPath === '/' ? '/index.html' : requestedPath;
    const filePath = path.resolve(repoRoot, '.' + relativePath);

    if (!filePath.startsWith(repoRoot)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      if (stats.isDirectory()) {
        const indexPath = path.join(filePath, 'index.html');
        fs.readFile(indexPath, (indexErr, data) => {
          if (indexErr) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(data);
        });
        return;
      }

      const stream = fs.createReadStream(filePath);
      res.writeHead(200, { 'Content-Type': contentType(filePath) });
      stream.pipe(res);
      stream.on('error', () => {
        res.writeHead(500);
        res.end('Read error');
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function waitForPdfOrChromeFailure(child, filePath, timeoutMs) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';

    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      fn(value);
    };

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => finish(reject, err));
    child.on('exit', (code) => {
      fs.stat(filePath, (err, stats) => {
        if (!err && stats.size > 0) {
          finish(resolve);
          return;
        }
        const message =
          code === 0
            ? `Chrome exited before writing PDF: ${filePath}`
            : `Chrome exited with code ${code}\n${stderr}`;
        finish(reject, new Error(message));
      });
    });

    const tick = () => {
      fs.stat(filePath, (err, stats) => {
        if (!err && stats.size > 0) {
          finish(resolve);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          finish(reject, new Error(`Timed out waiting for PDF output: ${filePath}`));
          return;
        }
        setTimeout(tick, 250);
      });
    };

    tick();
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;

    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      resolve();
    };

    child.on('exit', finish);
    setTimeout(finish, timeoutMs);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const inputPath = toAbsoluteRepoPath(opts.input);
  const outputPath = toAbsoluteRepoPath(opts.output);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }
  if (!fs.existsSync(opts.chromePath)) {
    throw new Error(`Chrome binary not found: ${opts.chromePath}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.rmSync(outputPath, { force: true });

  const server = await startStaticServer(opts.port);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modernslides-chrome-'));
  const deckUrl =
    `http://127.0.0.1:${opts.port}/modernslides/index.html` +
    `?export=1&xml=${toUrlPath(opts.input)}`;

  const chromeArgs = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=20000',
    '--allow-file-access-from-files',
    `--user-data-dir=${userDataDir}`,
    '--no-pdf-header-footer',
    `--print-to-pdf=${outputPath}`,
    deckUrl,
  ];

  try {
    const child = spawn(opts.chromePath, chromeArgs, { stdio: 'pipe' });
    await waitForPdfOrChromeFailure(child, outputPath, 30000);

    if (!child.killed) {
      child.kill('SIGTERM');
      await waitForExit(child, 3000);
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }

    console.log(`Wrote ${outputPath}`);
  } finally {
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
