// Общие хелперы для тестов: запускают настоящий index.js на временной БД и свободном порту.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

// extraEnv: можно переопределить переменные окружения; значение undefined — удалить переменную
async function startServer(extraEnv = {}) {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-test-'));
    const env = {
        ...process.env,
        PORT: String(port),
        DB_PATH: path.join(dir, 'test.db'),
        JWT_SECRET: 'test-jwt-secret',
        SMS_WEBHOOK_SECRET: 'test-hook-secret',
        ...extraEnv
    };
    for (const key of Object.keys(env)) {
        if (env[key] === undefined) delete env[key];
    }

    const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = '';
    child.stdout.on('data', (d) => { logs += d; });
    child.stderr.on('data', (d) => { logs += d; });

    const baseUrl = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
        if (child.exitCode !== null) throw new Error(`Сервер завершился при запуске:\n${logs}`);
        try {
            const res = await fetch(`${baseUrl}/api/health`);
            ready = res.ok;
        } catch (e) { /* ещё не поднялся */ }
        if (!ready) await sleep(100);
    }
    if (!ready) {
        child.kill();
        throw new Error(`Сервер не запустился за 15 секунд:\n${logs}`);
    }

    const request = async (method, url, { token, json, headers = {}, body } = {}) => {
        const finalHeaders = { ...headers };
        if (token) finalHeaders.Authorization = `Bearer ${token}`;
        let finalBody = body;
        if (json !== undefined) {
            finalHeaders['Content-Type'] = 'application/json';
            finalBody = JSON.stringify(json);
        }
        const res = await fetch(`${baseUrl}${url}`, { method, headers: finalHeaders, body: finalBody });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) { data = text; }
        return { status: res.status, data };
    };

    let counter = 0;
    const register = async (label = 'user') => {
        counter += 1;
        const identifier = `${label}_${Date.now()}_${counter}@test.local`;
        const res = await request('POST', '/api/auth/register', {
            json: { identifier, password: 'secret123', name: label }
        });
        if (res.status !== 200) throw new Error(`register failed: ${JSON.stringify(res)}`);
        return { id: res.data.user.id, token: res.data.token };
    };

    const stop = async () => {
        child.kill();
        await sleep(100);
        fs.rmSync(dir, { recursive: true, force: true });
    };

    return { baseUrl, request, register, stop, logs: () => logs, port };
}

module.exports = { startServer, sleep };
