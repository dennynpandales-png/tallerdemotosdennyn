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
    for (const file of ['main.js', 'server.js', 'marca.js', 'whatsapp.js', ...publicFiles.filter(name => name.endsWith('.js')).map(name => 'public/' + name)]) {
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

    await post('/api/config', admin.cookie, { telefono_taller: '3101234567' });
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
    const migratedContact = await json('/api/config', { session: renewed.cookie });
    assert.equal(migratedContact.whatsapp_admin, '573101234567');
    assert.equal(migratedContact.telefono_taller, '3101234567');
    assert.equal((await json('/api/ordenes', { session: renewed.cookie }))[0].estado, 'Facturada');

    const newReceiver = await login('recepcion', password);
    const newMechanic = await login('mecanico', password);
    const securitySetup = { username: 'otro', password, cedula: '991001', pregunta_seguridad: '¿Qué frase elegiste?', respuesta_seguridad: 'Frase de prueba' };
    await post('/api/recuperaciones/configurar', null, { ...securitySetup, password: 'incorrecta' }, 401);
    await post('/api/recuperaciones/configurar', null, securitySetup);
    const securityIdentity = { username: 'otro', nombre: 'Otro', cedula: '991001' };
    await post('/api/recuperaciones/pregunta', null, { ...securityIdentity, cedula: '0000' }, 400);
    assert.equal((await post('/api/recuperaciones/pregunta', null, securityIdentity)).pregunta, securitySetup.pregunta_seguridad);
    const selfRecovery = { ...securityIdentity, respuesta_seguridad: '  FRASE de prueba  ' };
    await post('/api/recuperaciones/respuesta', null, { ...selfRecovery, respuesta_seguridad: 'incorrecta' }, 400);
    const verified = await post('/api/recuperaciones/respuesta', null, selfRecovery);
    await login('otro', password);
    const selfPassword = { username: 'otro', codigo: verified.codigo, nuevaPassword: 'clave-por-pregunta' };
    await post('/api/recuperaciones/cambiar-por-pregunta', null, { ...selfPassword, username: 'mecanico' }, 409);
    await post('/api/recuperaciones/cambiar-por-pregunta', null, selfPassword);
    await post('/api/recuperaciones/cambiar-por-pregunta', null, selfPassword, 409);
    await post('/api/login', null, { username: 'otro', password }, 401);
    await login('otro', selfPassword.nuevaPassword);
    for (let attempt = 0; attempt < 5; attempt++) {
        await post('/api/recuperaciones/respuesta', null, { ...selfRecovery, respuesta_seguridad: 'incorrecta' }, 400);
    }
    await post('/api/recuperaciones/respuesta', null, selfRecovery, 429);
    assert.deepEqual(await json('/api/recuperaciones', { session: renewed.cookie }), []);
    await call('/api/config', { session: newReceiver.cookie, status: 403 });
    await call('/api/identidad', { session: newReceiver.cookie });
    await call('/api/recuperaciones', { session: newReceiver.cookie, status: 403 });
    await post('/api/recuperaciones/solicitar', null, { username: 'mecanico' }, 202);
    const [recovery] = await json('/api/recuperaciones', { session: renewed.cookie });
    const { codigo } = await post(`/api/recuperaciones/${recovery.id}/aprobar`, renewed.cookie);
    const recoveryData = { username: 'mecanico', codigo, nuevaPassword: 'clave-nueva-auditoria' };
    await post('/api/recuperaciones/completar', null, recoveryData);
    await post('/api/recuperaciones/completar', null, recoveryData, 400);
    await call('/api/session', { session: newMechanic.cookie, status: 401 });
    const recoveredMechanic = await login('mecanico', recoveryData.nuevaPassword);

    const [part] = await json('/api/inventario', { session: renewed.cookie });
    assert.equal(part.codigo, 'REP-QA1');
    await Promise.all([2, 3].map(stock => post('/api/inventario', renewed.cookie, {
        ...part, stock, proveedor: 'Proveedor de prueba', origen: 'Genuino'
    })));
    const labor = await post('/api/inventario', renewed.cookie, { tipo: 'MO', nombre: 'Ajuste', precio_costo: 10, precio_venta: 20 });
    assert.match(labor.codigo, /^MO-/);
    const mechanicCatalog = await json('/api/inventario', { session: recoveredMechanic.cookie });
    const mechanicPart = mechanicCatalog.find(item => item.tipo === 'REP');
    assert.equal(mechanicPart.stock, 8);
    assert.equal(mechanicPart.origen, 'Genuino');
    assert.equal(mechanicPart.proveedor, undefined);
    const mechanicService = mechanicCatalog.find(item => item.tipo === 'MO');
    assert.equal(mechanicService.codigo, labor.codigo);
    assert.equal(mechanicService.precio_venta, undefined);
    assert.equal((await json('/api/inventario', { session: renewed.cookie })).find(item => item.id === part.id).proveedor, 'Proveedor de prueba');

    const temporaryPassword = 'acceso-temporal';
    const finalPassword = 'clave-elegida-usuario';
    const resetPath = `/api/usuarios/${recoveredMechanic.id}/password`;
    await put(resetPath, newReceiver.cookie, { nuevaPassword: temporaryPassword }, 403);
    await post('/api/recuperaciones/solicitar', null, { username: 'mecanico' }, 202);
    await put(resetPath, renewed.cookie, { nuevaPassword: temporaryPassword });
    assert.deepEqual(await json('/api/recuperaciones', { session: renewed.cookie }), []);
    await call('/api/session', { session: recoveredMechanic.cookie, status: 401 });
    const temporaryLogin = { username: 'mecanico', password: temporaryPassword };
    const changeRequired = await call('/api/login', { method: 'POST', body: temporaryLogin, status: 409 });
    assert.equal(changeRequired.headers.get('set-cookie'), null);
    assert.equal((await changeRequired.json()).requiereCambio, true);
    await post('/api/login', null, { ...temporaryLogin, nuevaPassword: temporaryPassword }, 400);
    const changedLogin = await call('/api/login', { method: 'POST', body: { ...temporaryLogin, nuevaPassword: finalPassword } });
    assert.equal((await changedLogin.json()).rol, 'Mecanico');
    assert.ok(changedLogin.headers.get('set-cookie'));
    await post('/api/login', null, temporaryLogin, 401);
    const activeMechanic = await login('mecanico', finalPassword);
    const pendingOrder = await post('/api/ordenes', newReceiver.cookie, {
        moto_id: moto.id, mecanico_id: recoveredMechanic.id, tipo_mantenimiento: 'Correctivo', motivo_ingreso: 'Servicio pendiente de precio'
    });
    const pendingRoute = '/api/ordenes/' + pendingOrder.orden_id;
    await put(pendingRoute + '/reportar-mano-obra', activeMechanic.cookie, { servicio_id: mechanicService.id, precio: '' });
    const catalogReading = (await json('/api/ordenes', { session: renewed.cookie })).find(item => item.id === pendingOrder.orden_id);
    assert.match(catalogReading.mano_obra_reporte, /^MO-/);
    assert.equal(catalogReading.mano_obra_sugerida, null);
    await post('/api/inventario', renewed.cookie, { codigo: 'SIN-PRECIO', nombre: 'Repuesto pendiente', stock: 1, precio_costo: 10, precio_venta: '' });
    const unpriced = (await json('/api/inventario', { session: renewed.cookie })).find(item => item.codigo === 'REP-SIN-PRECIO');
    await post(pendingRoute + '/repuestos', activeMechanic.cookie, { repuesto_id: unpriced.id, cantidad: 1 });
    await put(pendingRoute + '/estado', activeMechanic.cookie, { estado: 'Terminada' });
    await put(pendingRoute + '/facturar', renewed.cookie, { costo_mano_obra: '' }, 400);
    await put(pendingRoute + '/mano-obra', renewed.cookie, { costo_mano_obra: 30 });
    await put(pendingRoute + '/facturar', renewed.cookie, { costo_mano_obra: 30 }, 409);
    await post('/api/inventario', renewed.cookie, { ...unpriced, stock: 0, precio_venta: 23 });
    await put(pendingRoute + '/facturar', renewed.cookie, { costo_mano_obra: 30 });
    await post('/api/inventario', renewed.cookie, { ...unpriced, stock: 0, precio_venta: 24 });
    assert.equal((await json(pendingRoute + '/detalles', { session: renewed.cookie }))[0].precio_unitario, 23);

    await post('/api/config', renewed.cookie, { whatsapp_admin: '3101234567', impresora_formato: '58' });
    await post('/api/config', renewed.cookie, { whatsapp_admin: '3201234567' });
    const savedConfig = await json('/api/config', { session: renewed.cookie });
    assert.equal(savedConfig.whatsapp_admin, '573101234567');
    assert.equal(savedConfig.impresora_formato, '58');

    const outgoing = [];
    const originalFetch = global.fetch;
    const waConfig = {
        WHATSAPP_GRAPH_VERSION: 'v27.0', WHATSAPP_PHONE_ID: '12345', WHATSAPP_ACCESS_TOKEN: 'stub',
        WHATSAPP_CITA_TEMPLATE: 'cita_taller', WHATSAPP_RESET_TEMPLATE: 'reset_taller', WHATSAPP_ADMIN_NUMBER: ''
    };
    const previous = Object.fromEntries(Object.keys(waConfig).map(key => [key, process.env[key]]));
    Object.assign(process.env, waConfig);
    global.fetch = (url, options) => {
        if (!String(url).startsWith('https://graph.facebook.com/')) return originalFetch(url, options);
        outgoing.push(JSON.parse(options.body));
        return Promise.resolve(Response.json({ messages: [{ id: 'stub' }] }));
    };
    t.after(() => {
        global.fetch = originalFetch;
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    const appointmentFields = { cliente_nombre: 'Cliente de prueba', moto_placa: 'QA123', fecha_cita: '2027-01-16', hora_cita: '10:30' };
    const appointment = await post('/api/citas', newReceiver.cookie, appointmentFields);
    assert.equal(appointment.whatsapp, 'aceptado');
    assert.equal(outgoing[0].to, '573001234567');
    assert.deepEqual(outgoing[0].template.components[0].parameters.map(item => item.text),
        ['Cliente de prueba', 'QA123', '2027-01-16', '10:30', 'Servicio de taller']);
    const appointmentRoute = '/api/citas/' + appointment.id;
    const reminder = await post(appointmentRoute + '/recordatorio', newReceiver.cookie);
    const reminderUrl = new URL(reminder.url);
    assert.equal(reminderUrl.origin + reminderUrl.pathname, 'https://wa.me/573001234567');
    assert.match(reminderUrl.searchParams.get('text'), /QA123.*10:30/);
    await put(appointmentRoute, newReceiver.cookie, { ...appointmentFields, hora_cita: '11:00' });
    await call(appointmentRoute, { method: 'DELETE', session: newReceiver.cookie });
    await post(appointmentRoute + '/convertir', newReceiver.cookie, { mecanico_id: mechanic.id }, 404);
    assert.deepEqual(await json('/api/citas', { session: newReceiver.cookie }), []);

    await post('/api/reset-sistema/codigo', newReceiver.cookie, { password }, 403);
    await post('/api/reset-sistema', renewed.cookie, { password: '1234' }, 403);
    await post('/api/reset-sistema/codigo', renewed.cookie, { password: '1234' });
    assert.equal(outgoing[2].to, '573101234567');
    const resetCode = outgoing[2].template.components[0].parameters[0].text;
    assert.match(resetCode, /^\d{6}$/);
    assert.equal(outgoing[2].template.components[1].parameters[0].text, resetCode);
    await post('/api/reset-sistema', renewed.cookie, { codigo: 'incorrecto' }, 403);
    assert.equal((await json('/api/ordenes', { session: renewed.cookie })).length, 2);
    await post('/api/reset-sistema', renewed.cookie, { codigo: resetCode });
    await post('/api/reset-sistema', renewed.cookie, { codigo: resetCode }, 403);
    for (const route of ['/api/clientes', '/api/motos', '/api/citas', '/api/ordenes', '/api/inventario']) {
        assert.deepEqual(await json(route, { session: renewed.cookie }), []);
    }
});
