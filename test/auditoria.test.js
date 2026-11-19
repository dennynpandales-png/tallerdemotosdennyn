const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const sqlite = require('sqlite3');

const root = path.join(__dirname, '..');
const readFiles = async directory => (await fs.readdir(directory)).filter(file => /\.(html|js)$/.test(file));

test('los scripts de las vistas y del servidor tienen sintaxis válida', async () => {
    const source = path.join(root, 'public');
    const publicFiles = await readFiles(source);
    for (const file of ['main.js', 'server.js', 'marca.js', ...publicFiles.filter(name => name.endsWith('.js')).map(name => 'public/' + name)]) {
        const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    }
    for (const file of publicFiles.filter(name => name.endsWith('.html'))) {
        const markup = await fs.readFile(path.join(source, file), 'utf8');
        for (const [, script] of markup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
            if (!script.trim()) continue;
            const result = spawnSync(process.execPath, ['--check', '-'], { input: script, encoding: 'utf8' });
            assert.equal(result.status, 0, file + '\n' + result.stderr);
        }
    }
});

async function listeningPort() {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', resolve);
    });
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return port;
}

test('órdenes, roles, eventos, facturación, portal y restauración funcionan juntos', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hidep-auditoria-'));
    const trackingPort = await listeningPort();
    process.env.WORKSHOP_DATA_DIR = directory;
    process.env.TRACKING_PORT = String(trackingPort);
    process.env.TRACKING_PUBLIC_ORIGIN = 'https://seguimiento.example.test';
    const backend = require('../server');
    const listener = await backend.startServer(0);
    const base = 'http://127.0.0.1:' + listener.address().port;
    const external = 'http://127.0.0.1:' + trackingPort;
    const events = new AbortController();
    t.after(async () => {
        events.abort();
        listener.closeAllConnections();
        await new Promise(resolve => listener.close(resolve));
        await backend.closeDatabase();
        await fs.rm(directory, { recursive: true, force: true });
    });

    async function call(route, { method = 'GET', body, session, token, origin = base, status = 200 } = {}) {
        const headers = {};
        if (body) headers['Content-Type'] = 'application/json';
        if (session) headers.Cookie = session;
        if (token) headers.Authorization = 'Bearer ' + token;
        const response = await fetch(origin + route, {
            method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000)
        });
        assert.equal(response.status, status, method + ' ' + route + ' ' + (response.ok ? '' : await response.clone().text()));
        return response;
    }
    const json = async (route, options) => (await call(route, options)).json();
    const post = (route, session, body, status) => json(route, { method: 'POST', session, body, status });
    const put = (route, session, body, status) => json(route, { method: 'PUT', session, body, status });
    async function login(username, password) {
        const response = await call('/api/login', { method: 'POST', body: { username, password } });
        return { cookie: response.headers.get('set-cookie').split(';')[0], ...(await response.json()) };
    }
    const admin = await login('admin', '1234');
    const password = 'prueba-auditoria';
    for (const [username, rol] of [['recepcion', 'Recepcionista'], ['mecanico', 'Mecanico'], ['otro', 'Mecanico']]) {
        await post('/api/usuarios', admin.cookie, { nombre: username, username, rol, password });
    }
    const receiver = await login('recepcion', password);
    const mechanic = await login('mecanico', password);
    const other = await login('otro', password);

    for (const route of ['/api/reportes/contabilidad', '/api/reportes/detallado', '/api/usuarios', '/api/backup', '/api/inventario']) {
        await call(route, { session: receiver.cookie, status: 403 });
    }
    await call('/api/usuarios', { method: 'POST', session: receiver.cookie, body: { rol: 'Administrador' }, status: 403 });
    const workerList = await json('/api/mecanicos', { session: receiver.cookie });
    assert.deepEqual(workerList.map(user => user.id), [mechanic.id, other.id]);

    const client = await post('/api/clientes', receiver.cookie, { nombre: 'Cliente de prueba', cedula: '123', telefono: '3001234567' });
    const moto = await post('/api/motos', receiver.cookie, { cliente_id: client.id, placa: 'QA123', modelo: 'Modelo de prueba' });
    const order = await post('/api/ordenes', receiver.cookie, {
        moto_id: moto.id, mecanico_id: mechanic.id, tipo_mantenimiento: 'Preventivo', motivo_ingreso: 'Revisión'
    });
    const route = '/api/ordenes/' + order.orden_id;
    const mine = await json('/api/ordenes', { session: mechanic.cookie });
    assert.equal(mine[0].moto_modelo, 'Modelo de prueba');
    assert.equal(mine[0].costo_mano_obra, undefined);
    assert.deepEqual(await json('/api/ordenes', { session: other.cookie }), []);
    await call(route + '/fotos', { session: other.cookie, status: 403 });
    await put(route + '/asignacion', receiver.cookie, { mecanico_id: other.id });
    await call(route + '/fotos', { session: mechanic.cookie, status: 403 });
    await put(route + '/asignacion', receiver.cookie, { mecanico_id: mechanic.id });

    await post('/api/inventario', admin.cookie, { codigo: 'QA1', nombre: 'Filtro', stock: 5, precio_costo: 8000, precio_venta: 12000 });
    const inventory = await json('/api/inventario', { session: mechanic.cookie });
    assert.equal(inventory[0].precio_venta, undefined);
    await post(route + '/repuestos', mechanic.cookie, { repuesto_id: inventory[0].id, cantidad: 2 });
    const parts = await json(route + '/detalles', { session: receiver.cookie });
    assert.equal(parts[0].cantidad, 2);
    assert.equal(parts[0].precio_unitario, undefined);
    await put(route + '/reportar', mechanic.cookie, { trabajo_realizado: 'Filtro reemplazado' });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTn8AAAAASUVORK5CYII=';
    const { foto } = await post(route + '/fotos', mechanic.cookie, { imagen_base64: 'data:image/png;base64,' + png });
    assert.equal((await json(route + '/fotos', { session: receiver.cookie }))[0].id, foto.id);
    await call(foto.url, { status: 401 });

    const stream = await fetch(base + '/api/sync-events', { headers: { Cookie: receiver.cookie }, signal: events.signal });
    const reader = stream.body.getReader();
    const eventTimeout = setTimeout(() => events.abort(), 4000);
    try {
        await put(route + '/estado', mechanic.cookie, { estado: 'Terminada' });
        let received = '';
        while (!received.includes('orden_terminada')) {
            const chunk = await reader.read();
            assert.equal(chunk.done, false);
            received += Buffer.from(chunk.value).toString();
        }
    } finally {
        clearTimeout(eventTimeout);
        events.abort();
    }
    const history = await json(route + '/bitacora', { session: receiver.cookie });
    assert.deepEqual(history.map(row => row.tipo), ['Ingreso', 'Repuesto', 'Avance', 'Estado']);
    await put(route + '/mano-obra', receiver.cookie, { costo_mano_obra: 30000 }, 403);
    await put(route + '/facturar', receiver.cookie, { costo_mano_obra: 30000 }, 403);
    await put(route + '/mano-obra', admin.cookie, { costo_mano_obra: 30000 });
    const confirmed = (await json('/api/ordenes', { session: admin.cookie }))[0];
    const billable = await json(route + '/detalles', { session: admin.cookie });
    assert.equal(confirmed.costo_mano_obra + billable[0].cantidad * billable[0].precio_unitario, 54000);
    assert.equal(confirmed.mano_obra_confirmada, 1);
    const share = await post(route + '/whatsapp', receiver.cookie);
    assert.equal(share.phone, '573001234567');
    assert.equal(share.order.costo_mano_obra, undefined);
    assert.equal(new URL(share.link).origin, process.env.TRACKING_PUBLIC_ORIGIN);
    const token = new URL(share.link).hash.slice(1);
    await call('/api/ordenes', { origin: external, status: 404 });
    const portal = await call('/seguimiento/', { origin: external });
    assert.equal(portal.headers.get('access-control-allow-origin'), null);
    await call('/seguimiento/tema-taller.css', { origin: external });
    for (const identificador of ['QA123', String(order.orden_id)]) {
        const data = await json('/seguimiento/consulta', { method: 'POST', origin: external, token, body: { identificador } });
        assert.equal(data.orden.estado, 'Terminada');
        assert.equal(data.bitacora.length, 4);
        assert.equal(data.fotos[0].id, foto.id);
    }
    await call('/seguimiento/consulta', { method: 'POST', origin: external, token, body: { identificador: 'OTRA-PLACA' }, status: 404 });
    const photo = await call('/seguimiento/fotos/' + foto.id, { method: 'POST', origin: external, token, body: { identificador: 'QA123' } });
    assert.equal(Buffer.from(await photo.arrayBuffer()).toString('base64'), png);
    await put(route + '/facturar', admin.cookie, { costo_mano_obra: 30000 });
    await call(route + '/seguimiento', { method: 'DELETE', session: receiver.cookie, status: 204 });
    await call('/seguimiento/consulta', { method: 'POST', origin: external, token, body: { identificador: 'QA123' }, status: 404 });

    const snapshot = path.join(directory, 'respaldo-prueba.db');
    const backup = await call('/api/backup', { session: admin.cookie });
    await fs.writeFile(snapshot, Buffer.from(await backup.arrayBuffer()));
    const legacy = new sqlite.Database(snapshot);
    await new Promise((resolve, reject) => legacy.exec('ALTER TABLE ordenes RENAME TO ordenes_servicio', error => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => legacy.close(error => error ? reject(error) : resolve()));
    const restored = await post('/api/restore', admin.cookie, { sourcePath: snapshot });
    assert.equal(restored.success, true);
    await call('/api/session', { session: admin.cookie, status: 401 });
    const renewed = await login('admin', '1234');
    assert.equal((await json('/api/ordenes', { session: renewed.cookie }))[0].estado, 'Facturada');
});
