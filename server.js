const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const { NOMBRE_TALLER, directorioDatosTaller } = require('./marca');
const scrypt = promisify(crypto.scrypt);

const app = express();
const sessions = new Map();
const desktopBackupKey = crypto.randomBytes(32).toString('hex');
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
const publicDir = path.join(__dirname, 'public');
const publicFiles = new Set(fs.readdirSync(publicDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && !['seguimiento.html', 'seguimiento.js'].includes(entry.name))
    .map(entry => '/' + entry.name));
const servePublic = express.static(publicDir);
app.use((req, res, next) => {
    if (req.path === '/' || publicFiles.has(req.path)) return servePublic(req, res, next);
    next();
});

const configuredDataDir = process.env.WORKSHOP_DATA_DIR;
const isPackaged = process.env.APP_IS_PACKAGED === 'true' || __dirname.includes('app.asar');
const dbFile = resolveDbPath();
const uploadsDir = path.join((configuredDataDir || isPackaged) ? path.dirname(dbFile) : publicDir, 'uploads', 'ordenes');

function resolveDbPath() {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming');
    const directory = configuredDataDir ? path.resolve(configuredDataDir) :
        isPackaged ? process.env.APP_USER_DATA_PATH || directorioDatosTaller(appData) : __dirname;
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, 'database.db');
    if (isPackaged && !configuredDataDir && !fs.existsSync(target)) {
        const templates = [process.resourcesPath, __dirname, process.cwd()].filter(Boolean);
        const template = templates.map(dir => path.join(dir, 'database.db')).find(file => fs.existsSync(file));
        if (template) fs.copyFileSync(template, target);
    }
    return target;
}

let db;
let databaseReady;
let restoring = false;

const openDatabase = filename => new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(filename, (error) => error ? reject(error) : resolve(connection));
    connection.configure('busyTimeout', 10000);
});
const closeConnection = connection => new Promise((resolve, reject) =>
    connection.close(error => error ? reject(error) : resolve()));
const queryAll = (connection, sql, params = []) => new Promise((resolve, reject) =>
    connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));

function ensureDatabase() {
    return databaseReady ||= (async () => {
        fs.mkdirSync(uploadsDir, { recursive: true });
        db = await openDatabase(dbFile);
        await inicializarTablas(db);
        await refreshBackupInterval();
    })();
}

async function refreshBackupInterval() {
    const row = await getRow('SELECT backup_interval_min FROM configuracion WHERE id = 1', []);
    configurarAutoBackup(row?.backup_interval_min);
}

async function inicializarTablas(connection) {
    const tables = await queryAll(connection, "SELECT name FROM sqlite_master WHERE name IN ('ordenes', 'ordenes_servicio')");
    if (tables.length === 1 && tables[0].name === 'ordenes_servicio') {
        await runOrderQuery('ALTER TABLE ordenes_servicio RENAME TO ordenes', [], connection);
    }
    const statements = [];
    const schema = sql => statements.push(runOrderQuery(sql, [], connection).catch(error => {
        if (!sql.startsWith('ALTER TABLE') || !/duplicate column name/i.test(error.message)) throw error;
    }));
    connection.serialize(() => {
        schema(`CREATE TABLE IF NOT EXISTS clientes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cedula TEXT UNIQUE,
            nombre TEXT,
            telefono TEXT,
            direccion TEXT
        )`);

        schema(`CREATE TABLE IF NOT EXISTS motos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cliente_id INTEGER,
            placa TEXT UNIQUE,
            marca TEXT,
            modelo TEXT,
            cilindraje INTEGER,
            color TEXT,
            kilometraje INTEGER,
            FOREIGN KEY(cliente_id) REFERENCES clientes(id)
        )`);

        schema(`CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT,
            username TEXT UNIQUE,
            password TEXT,
            rol TEXT,
            permisos TEXT
        )`);
        schema('ALTER TABLE usuarios ADD COLUMN cedula TEXT');
        schema('ALTER TABLE usuarios ADD COLUMN pregunta_seguridad TEXT');
        schema('ALTER TABLE usuarios ADD COLUMN respuesta_hash TEXT');
        schema("CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_cedula_unique ON usuarios(cedula) WHERE cedula IS NOT NULL AND cedula <> ''");

        schema(`CREATE TABLE IF NOT EXISTS inventario (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            codigo TEXT UNIQUE,
            nombre TEXT,
            stock INTEGER,
            precio_costo REAL,
            precio_venta REAL
        )`);

        schema(`CREATE TABLE IF NOT EXISTS ordenes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            moto_id INTEGER,
            mecanico_id INTEGER,
            tipo_mantenimiento TEXT,
            motivo_ingreso TEXT,
            costo_mano_obra REAL,
            trabajo_realizado TEXT,
            estado TEXT DEFAULT 'En proceso',
            fecha_ingreso DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(moto_id) REFERENCES motos(id),
            FOREIGN KEY(mecanico_id) REFERENCES usuarios(id)
        )`);

        schema(`CREATE TABLE IF NOT EXISTS detalle_orden_repuestos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            orden_id INTEGER,
            repuesto_id INTEGER,
            cantidad INTEGER,
            precio_unitario REAL,
            FOREIGN KEY(orden_id) REFERENCES ordenes(id),
            FOREIGN KEY(repuesto_id) REFERENCES inventario(id)
        )`);
        schema('ALTER TABLE ordenes ADD COLUMN mano_obra_confirmada INTEGER NOT NULL DEFAULT 0');

        schema(`CREATE TABLE IF NOT EXISTS solicitudes_repuestos_orden (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            orden_id INTEGER NOT NULL,
            repuesto_id INTEGER NOT NULL,
            cantidad INTEGER NOT NULL CHECK(cantidad > 0),
            estado TEXT NOT NULL DEFAULT 'Solicitado',
            fecha_solicitud DATETIME DEFAULT CURRENT_TIMESTAMP,
            fecha_aprobacion DATETIME,
            FOREIGN KEY(orden_id) REFERENCES ordenes(id),
            FOREIGN KEY(repuesto_id) REFERENCES inventario(id)
        )`);

        schema(`CREATE TABLE IF NOT EXISTS citas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cliente_nombre TEXT,
            moto_placa TEXT,
            fecha_cita TEXT,
            hora_cita TEXT,
            motivo TEXT,
            estado TEXT DEFAULT 'Pendiente'
        )`);

        schema(`CREATE TABLE IF NOT EXISTS orden_fotos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            orden_id INTEGER NOT NULL,
            url TEXT NOT NULL,
            descripcion TEXT,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(orden_id) REFERENCES ordenes(id)
        )`);
        schema('ALTER TABLE orden_fotos ADD COLUMN publicada INTEGER NOT NULL DEFAULT 0');
        schema(`CREATE TABLE IF NOT EXISTS orden_bitacora (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            orden_id INTEGER NOT NULL REFERENCES ordenes(id),
            tipo TEXT NOT NULL,
            descripcion TEXT NOT NULL,
            fecha TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
        )`);
        schema('CREATE INDEX IF NOT EXISTS idx_orden_bitacora ON orden_bitacora(orden_id, fecha, id)');
        schema(`CREATE TABLE IF NOT EXISTS orden_seguimiento (
            orden_id INTEGER PRIMARY KEY REFERENCES ordenes(id),
            token_hash TEXT NOT NULL UNIQUE
        )`);
        schema(`CREATE TABLE IF NOT EXISTS orden_seguimiento_envios (
            token_hash TEXT PRIMARY KEY,
            orden_id INTEGER NOT NULL REFERENCES orden_seguimiento(orden_id),
            version TEXT NOT NULL
        )`);
        schema('CREATE INDEX IF NOT EXISTS idx_seguimiento_envios_orden ON orden_seguimiento_envios(orden_id)');
        schema(`CREATE TRIGGER IF NOT EXISTS limpiar_envios_rotados AFTER UPDATE OF token_hash ON orden_seguimiento BEGIN
            DELETE FROM orden_seguimiento_envios WHERE orden_id = OLD.orden_id;
        END`);
        schema(`CREATE TRIGGER IF NOT EXISTS limpiar_envios_revocados AFTER DELETE ON orden_seguimiento BEGIN
            DELETE FROM orden_seguimiento_envios WHERE orden_id = OLD.orden_id;
        END`);
        schema(`INSERT INTO orden_bitacora (orden_id, tipo, descripcion, fecha)
            SELECT id, 'Resumen anterior', trabajo_realizado, fecha_ingreso FROM ordenes
            WHERE trim(coalesce(trabajo_realizado, '')) NOT IN ('', 'En proceso', 'Ingreso desde cita')
              AND fecha_ingreso IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM orden_bitacora b WHERE b.orden_id = ordenes.id
                  AND b.tipo IN ('Resumen anterior', 'Avance'))`);
        schema(`INSERT INTO orden_bitacora (orden_id, tipo, descripcion, fecha)
            SELECT o.id, 'Repuesto anterior', i.nombre || ' × ' || d.cantidad, o.fecha_ingreso
            FROM detalle_orden_repuestos d JOIN ordenes o ON o.id = d.orden_id
            JOIN inventario i ON i.id = d.repuesto_id
            WHERE o.fecha_ingreso IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM orden_bitacora b WHERE b.orden_id = o.id AND b.tipo IN ('Repuesto anterior', 'Repuesto'))
            ORDER BY d.id`);
        schema(`CREATE TRIGGER IF NOT EXISTS orden_bitacora_estado AFTER UPDATE OF estado ON ordenes
            WHEN NEW.estado <> OLD.estado BEGIN
                INSERT INTO orden_bitacora (orden_id, tipo, descripcion) VALUES (NEW.id, 'Estado', NEW.estado);
            END`);
        schema(`CREATE TRIGGER IF NOT EXISTS orden_bitacora_repuesto AFTER INSERT ON detalle_orden_repuestos BEGIN
            INSERT INTO orden_bitacora (orden_id, tipo, descripcion)
            SELECT NEW.orden_id, 'Repuesto', nombre || ' × ' || NEW.cantidad FROM inventario WHERE id = NEW.repuesto_id;
            END`);
        schema(`CREATE TRIGGER IF NOT EXISTS orden_bitacora_avance AFTER INSERT ON orden_bitacora
            WHEN NEW.tipo = 'Avance' BEGIN
                UPDATE ordenes SET trabajo_realizado = CASE
                    WHEN trim(coalesce(trabajo_realizado, '')) IN ('', 'En proceso', 'Ingreso desde cita') THEN NEW.descripcion
                    ELSE trabajo_realizado || ' | ' || NEW.descripcion END WHERE id = NEW.orden_id;
            END`);

        schema(`CREATE TABLE IF NOT EXISTS alertas_stock (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            orden_id INTEGER,
            repuesto_id INTEGER,
            repuesto_nombre TEXT,
            cantidad_solicitada INTEGER,
            stock_actual INTEGER,
            mecanico_nombre TEXT,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
            leida INTEGER DEFAULT 0
        )`);

        schema(`CREATE TABLE IF NOT EXISTS configuracion (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre_taller TEXT,
            nit_taller TEXT,
            telefono_taller TEXT,
            email_taller TEXT,
            direccion_taller TEXT,
            tema TEXT,
            impresora_nombre TEXT,
            backup_path TEXT,
            tarifa_100 REAL,
            tarifa_200 REAL,
            tarifa_400 REAL,
            tarifa_mas REAL,
            backup_interval_min INTEGER DEFAULT 60,
            eslogan_taller TEXT DEFAULT 'Pasión y Precisión en Cada Kilómetro'
        )`);
        schema('ALTER TABLE configuracion ADD COLUMN backup_interval_min INTEGER DEFAULT 60');
        schema("ALTER TABLE configuracion ADD COLUMN eslogan_taller TEXT DEFAULT 'Pasión y Precisión en Cada Kilómetro'");
    });
    await Promise.allSettled(statements).then(results => {
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
    });

    const run = (sql, params) => runOrderQuery(sql, params, connection);
    await run(`INSERT OR IGNORE INTO configuracion (id, nombre_taller, nit_taller, tema, tarifa_100, tarifa_200,
        tarifa_400, tarifa_mas, backup_interval_min, eslogan_taller)
        VALUES (1, ?, '900123456-1', 'dark', 30000, 50000, 80000, 120000, 60, 'Pasión y Precisión en Cada Kilómetro')`, [NOMBRE_TALLER]);
    await run('UPDATE configuracion SET nombre_taller = ? WHERE nombre_taller IS NOT ?', [NOMBRE_TALLER, NOMBRE_TALLER]);

    const users = await queryAll(connection, 'SELECT id, username, password FROM usuarios');
    if (!users.some(user => user.username === 'admin')) {
        const hash = await hashPassword('1234');
        await run(`INSERT INTO usuarios (nombre, username, password, rol, permisos) VALUES (?, 'admin', ?, 'Administrador', ?)`,
            ['Administrador General', hash, JSON.stringify(rolePermissions.Administrador)]);
    }
    const legacyUsers = users.filter(user => user.password && !user.password.startsWith('scrypt$'));
    for (const user of legacyUsers) {
        await run('UPDATE usuarios SET password = ? WHERE id = ? AND password = ?',
            [await hashPassword(user.password), user.id, user.password]);
    }
}

async function hashPassword(value) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = await scrypt(String(value), salt, 64);
    return `scrypt$${salt}$${derived.toString('hex')}`;
}

async function verifyPassword(value, stored) {
    if (!stored) return false;
    if (!stored.startsWith('scrypt$')) return stored === value;
    const [, salt, expectedHex] = stored.split('$');
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = await scrypt(String(value), salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeIdentity(value) {
    return String(value || '').trim().normalize('NFKD').replaceAll(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
}

const roleNames = new Map([
    ['administrador', 'Administrador'], ['administrator', 'Administrador'],
    ['recepcionista', 'Recepcionista'], ['recepcion', 'Recepcionista'], ['receptionist', 'Recepcionista'],
    ['mecanico', 'Mecanico'], ['mechanic', 'Mecanico']
]);
const canonicalRole = value => roleNames.get(normalizeIdentity(value));
const isAdmin = user => user?.rol === 'Administrador';
const rolePermissions = {
    Administrador: { clientes: true, ordenes: true, facturacion: true, inventario: true, citas: true, reportes: true, config: true },
    Recepcionista: { clientes: true, ordenes: true, citas: true },
    Mecanico: { ordenes: true }
};

function invalidateUserSessions(id) {
    for (const [token, user] of sessions) if (user.id === id) sessions.delete(token);
    for (const client of sseClients) {
        if (client.syncUser?.id === id) client.end('event: sesion_revocada\ndata: {}\n\n');
    }
}

function createDatabaseSnapshot(destinationPath, source = db) {
    return new Promise((resolve, reject) => {
        const backup = source.backup(destinationPath);
        backup.step(-1, (stepError) => {
            backup.finish((finishError) => {
                const error = stepError || finishError;
                if (error) return reject(error);
                resolve(destinationPath);
            });
        });
    });
}

// ================= GESTOR DE AUTO-RESPALDO PROGRAMADO =================
let backupIntervalTimer = null;
function configurarAutoBackup(minutos) {
    if (backupIntervalTimer) {
        clearInterval(backupIntervalTimer);
        backupIntervalTimer = null;
    }
    const mins = Number(minutos);
    if (!mins || mins <= 0) {
        return;
    }
    const ms = mins * 60 * 1000;
    backupIntervalTimer = setInterval(() => {
        db.get(`SELECT backup_path FROM configuracion WHERE id = 1`, (_err, row) => {
            if (row && row.backup_path && fs.existsSync(row.backup_path)) {
                try {
                    const autoFile = path.join(row.backup_path, `autobackup_${Date.now()}.db`);
                    createDatabaseSnapshot(autoFile).then(() => {
                        broadcastSyncEvent('backup_realizado', { fecha: new Date().toISOString(), archivo: autoFile });
                    }).catch(e => console.error('[BACKUP] Falló snapshot de auto-respaldo:', e.message));
                } catch (e) {
                    console.error('[BACKUP] Error preparando auto-respaldo:', e.message);
                }
            }
        });
    }, ms);
}

// ================= CANAL DE SINCRONIZACIÓN EN TIEMPO REAL (SSE) =================
const sseClients = new Set();

function broadcastSyncEvent(tipo, data = {}) {
    const payload = JSON.stringify({ tipo, data, timestamp: Date.now() });
    const adminsOnly = tipo === 'backup_realizado' || (tipo === 'orden_actualizada' && data.accion === 'mano_obra_actualizada');
    for (const client of sseClients) {
        try {
            if (client.syncUser.expires < Date.now()) {
                client.end();
                continue;
            }
            if (adminsOnly && !isAdmin(client.syncUser)) continue;
            if (tipo === 'orden_terminada' && !isWorkshopDesk(client.syncUser)) continue;
            if (client.syncUser.rol === 'Mecanico' && tipo !== 'asignacion_actualizada') {
                const orderId = data.ordenId || data.orden_id;
                if (orderId) db.get('SELECT mecanico_id FROM ordenes WHERE id = ?', [orderId], (err, order) => {
                    if (!err && order?.mecanico_id === client.syncUser.id && !client.destroyed) client.write(`event: sync\ndata: ${payload}\n\n`);
                });
                continue;
            }
            client.write(`event: sync\ndata: ${payload}\n\n`);
        } catch {
            sseClients.delete(client);
        }
    }
}

// ================= API RUTAS =================
app.use('/api', (_req, res, next) => {
    if (restoring) return res.status(503).json({ mensaje: 'Restauración en curso. Intente nuevamente.' });
    next();
});

// Canal SSE para sincronización instantánea entre PC, tablets y móviles
app.get('/api/sync-events', (req, res) => {
    const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('hidep_session='))?.slice(14);
    const user = sessions.get(token);
    if (!user || user.expires < Date.now()) return res.sendStatus(401);
    res.syncUser = user;
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('event: connected\ndata: {"status":"connected"}\n\n');
    sseClients.add(res);

    const heartbeat = setInterval(() => res.write(': sincronización\n\n'), 25000);
    res.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
    });
});

// Endpoint de verificación de salud del servidor
app.get('/api/health', (_req, res) => {
    db.get('SELECT 1 AS ready FROM usuarios LIMIT 1', (error) => {
        if (error) return res.status(503).json({ status: 'starting' });
        res.json({ status: 'ok', uptime: process.uptime(), time: Date.now() });
    });
});

// Autenticación de usuarios
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ mensaje: 'Usuario y contraseña requeridos.' });
    const user = await getRow('SELECT id, password FROM usuarios WHERE username = ?', [username]);
    if (!user || !await verifyPassword(password, user.password)) {
        return res.status(401).json({ mensaje: 'Usuario o contraseña incorrectos.' });
    }
    const current = await getRow('SELECT id, nombre, rol, password FROM usuarios WHERE id = ? AND username = ?', [user.id, username]);
    const rol = canonicalRole(current?.rol);
    if (!rol || current.password !== user.password) return res.status(401).json({ mensaje: 'Inicie sesión nuevamente.' });

    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { id: current.id, nombre: current.nombre, username, rol, expires: Date.now() + 86400000 });
    res.setHeader('Set-Cookie', `hidep_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    res.json({ success: true, id: current.id, nombre: current.nombre, rol, permisos: rolePermissions[rol] });
});

// Recuperación / Restablecimiento de contraseña
app.post('/api/recuperacion-pregunta', (req, res) => {
    const { username, nombre, cedula } = req.body;
    db.get('SELECT nombre, cedula, pregunta_seguridad FROM usuarios WHERE username = ?', [String(username || '').trim()], (error, user) => {
        const identityMatches = user && user.cedula === String(cedula || '').trim() && normalizeIdentity(user.nombre) === normalizeIdentity(nombre);
        if (error || !identityMatches || !user.pregunta_seguridad) return res.status(400).json({ success: false, mensaje: 'No hay datos de recuperación válidos para esa cuenta.' });
        res.json({ success: true, pregunta_seguridad: user.pregunta_seguridad });
    });
});

app.post('/api/seguridad/recuperacion-configurar', async (req, res) => {
    const { username, password, cedula, pregunta_seguridad, respuesta_seguridad } = req.body;
    if (!username || !password || !cedula || !pregunta_seguridad || !respuesta_seguridad) {
        return res.status(400).json({ success: false, mensaje: 'Complete todos los campos de recuperación.' });
    }
    db.get('SELECT id, password FROM usuarios WHERE username = ?', [String(username).trim()], async (error, user) => {
        if (error || !user || !(await verifyPassword(password, user.password))) {
            return res.status(401).json({ success: false, mensaje: 'Usuario o contraseña incorrectos.' });
        }
        const answerHash = await hashPassword(String(respuesta_seguridad).trim().toLocaleLowerCase('es'));
        db.run('UPDATE usuarios SET cedula = ?, pregunta_seguridad = ?, respuesta_hash = ? WHERE id = ?',
            [String(cedula).trim(), String(pregunta_seguridad).trim(), answerHash, user.id], function(updateError) {
                if (updateError) return res.status(400).json({ success: false, mensaje: 'La cédula ya está asignada o no se pudo guardar la recuperación.' });
                res.json({ success: true, mensaje: 'Datos de recuperación configurados.' });
            });
    });
});

app.post('/api/recuperar-password', (_req, res) => {
    res.status(403).json({ success: false, mensaje: 'Solicite al administrador el restablecimiento de su contraseña.' });
});

const receptionRoutes = {
    GET: /^\/(?:clientes|motos(?:\/\d+\/historial)?|mecanicos|ordenes(?:\/\d+\/(?:detalles|bitacora|fotos(?:\/\d+)?))?|citas|config|alertas-stock)$/,
    POST: /^\/(?:clientes|motos|ordenes(?:\/\d+\/(?:seguimiento|whatsapp))?|citas(?:\/\d+\/convertir)?)$/,
    PUT: /^\/(?:ordenes\/\d+\/(?:estado|asignacion)|alertas-stock\/(?:\d+\/leer|leer-todas))$/,
    DELETE: /^\/ordenes\/\d+\/seguimiento$/
};
const mechanicRoutes = {
    GET: /^(?:detalles|bitacora|fotos(?:\/\d+)?|solicitudes-repuestos)$/,
    POST: /^(?:repuestos|solicitudes-repuestos|fotos)$/,
    PUT: /^(?:reportar|estado)$/
};

app.use('/api', (req, res, next) => {
    const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('hidep_session='))?.slice(14);
    const user = sessions.get(token);
    // Electron usa exclusivamente loopback para ejecutar el respaldo del botón seguro.
    if (req.method === 'POST' && req.path === '/backup-ejecutar' && req.get('X-Desktop-Backup') === desktopBackupKey &&
        ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return next();
    if (!user || user.expires < Date.now()) return res.status(401).json({ mensaje: 'Inicie sesión nuevamente.' });
    req.user = user;
    res.set('Cache-Control', 'no-store');
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (isAdmin(user) || (method === 'GET' && req.path === '/session') || (method === 'POST' && req.path === '/logout')) return next();
    if (user.rol === 'Recepcionista' && receptionRoutes[method]?.test(req.path)) return next();
    if (user.rol === 'Mecanico') {
        if (method === 'GET' && ['/ordenes', '/inventario'].includes(req.path)) return next();
        const match = req.path.match(/^\/ordenes\/(\d+)\/(.+)$/);
        if (!match || !mechanicRoutes[method]?.test(match[2])) return res.sendStatus(403);
        return db.get('SELECT mecanico_id FROM ordenes WHERE id = ?', [match[1]], (err, order) => {
            if (err) return res.status(500).json({ mensaje: 'No se pudo validar la orden.' });
            if (!order || order.mecanico_id !== user.id) return res.status(403).json({ mensaje: 'Orden no asignada a su usuario.' });
            if (match[2] === 'estado' && !['Terminada', 'Listo para entrega'].includes(req.body?.estado)) return res.sendStatus(403);
            next();
        });
    }
    res.status(403).json({ mensaje: 'Acceso no permitido para este rol.' });
});
app.get('/api/session', (req, res) => res.json(req.user));
app.post('/api/logout', (req, res) => {
    for (const [token, user] of sessions) if (user === req.user) sessions.delete(token);
    for (const client of sseClients) {
        if (client.syncUser === req.user) { client.end(); sseClients.delete(client); }
    }
    res.setHeader('Set-Cookie', 'hidep_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ success: true });
});

// Clientes
app.get('/api/clientes', (_req, res) => {
    db.all(`SELECT * FROM clientes ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/clientes', (req, res) => {
    const { cedula, nombre, telefono, direccion } = req.body;
    db.run(`INSERT INTO clientes (cedula, nombre, telefono, direccion) VALUES (?, ?, ?, ?)
            ON CONFLICT(cedula) DO UPDATE SET nombre=excluded.nombre, telefono=excluded.telefono, direccion=excluded.direccion`,
        [cedula, nombre, telefono, direccion], function(err) {
            if (err) return res.status(500).json({ mensaje: 'Error al guardar cliente' });
            db.get(`SELECT id FROM clientes WHERE cedula = ?`, [cedula], (_err, row) => {
                res.json({ success: true, id: row ? row.id : this.lastID, mensaje: 'Cliente guardado correctamente' });
            });
        });
});

// Motos
app.get('/api/motos', (req, res) => {
    const buscar = req.query.buscar || '';
    const query = `SELECT motos.*, clientes.nombre as cliente_nombre, clientes.cedula as cliente_cedula, clientes.telefono as cliente_telefono, clientes.direccion as cliente_direccion 
                   FROM motos JOIN clientes ON motos.cliente_id = clientes.id
                   WHERE motos.placa LIKE ? OR clientes.nombre LIKE ? OR clientes.cedula LIKE ? ORDER BY motos.id DESC`;
    db.all(query, [`%${buscar}%`, `%${buscar}%`, `%${buscar}%`], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/motos', (req, res) => {
    const { cliente_id, placa, marca, modelo, cilindraje, color, kilometraje } = req.body;
    db.run(`INSERT INTO motos (cliente_id, placa, marca, modelo, cilindraje, color, kilometraje) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(placa) DO UPDATE SET marca=excluded.marca, modelo=excluded.modelo, cilindraje=excluded.cilindraje, color=excluded.color, kilometraje=excluded.kilometraje`,
        [cliente_id, (placa || '').toUpperCase(), marca, modelo, cilindraje, color, kilometraje], function(err) {
            if (err) return res.status(500).json({ mensaje: 'Error al registrar la moto' });
            db.get(`SELECT id FROM motos WHERE placa = ?`, [(placa || '').toUpperCase()], (_err, row) => {
                res.json({ success: true, id: row ? row.id : this.lastID, mensaje: 'Moto registrada correctamente' });
            });
        });
});

const operationalOrderFields = 'ordenes.id, ordenes.moto_id, ordenes.mecanico_id, ordenes.tipo_mantenimiento, ordenes.motivo_ingreso, ordenes.trabajo_realizado, ordenes.estado, ordenes.fecha_ingreso';
app.get('/api/motos/:id/historial', (req, res) => {
    db.all(`SELECT ${isAdmin(req.user) ? '*' : operationalOrderFields} FROM ordenes WHERE moto_id = ? ORDER BY id DESC`, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Inventario
app.get('/api/inventario', (req, res) => {
    db.all(`SELECT ${isAdmin(req.user) ? '*' : 'id, codigo, nombre, stock'} FROM inventario ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/inventario', (req, res) => {
    const { codigo, nombre, stock, precio_costo, precio_venta } = req.body;
    db.run(`INSERT INTO inventario (codigo, nombre, stock, precio_costo, precio_venta) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(codigo) DO UPDATE SET nombre=excluded.nombre, stock=stock+excluded.stock, precio_costo=excluded.precio_costo, precio_venta=excluded.precio_venta`,
        [codigo, nombre, stock, precio_costo, precio_venta], function(err) {
            if (err) return res.status(500).json({ mensaje: 'Error al guardar repuesto' });
            res.json({ success: true, mensaje: 'Repuesto guardado' });
        });
});

// Órdenes de Servicio
app.get('/api/ordenes', (req, res) => {
    const buscar = req.query.buscar || '';
    const mechanicId = req.user.rol === 'Mecanico' ? req.user.id : null;
    const query = `SELECT ${isAdmin(req.user) ? 'ordenes.*' : operationalOrderFields}, motos.placa as moto_placa, motos.marca as moto_marca, motos.modelo as moto_modelo, clientes.nombre as cliente_nombre, usuarios.nombre as mecanico_nombre
                   FROM ordenes LEFT JOIN motos ON ordenes.moto_id = motos.id LEFT JOIN clientes ON motos.cliente_id = clientes.id LEFT JOIN usuarios ON ordenes.mecanico_id = usuarios.id
                   WHERE (motos.placa LIKE ? OR ordenes.id LIKE ? OR clientes.nombre LIKE ?)
                   AND (? IS NULL OR ordenes.mecanico_id = ?) ORDER BY ordenes.id DESC`;
    db.all(query, [`%${buscar}%`, `%${buscar}%`, `%${buscar}%`, mechanicId, mechanicId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/ordenes', async (req, res) => {
    const { moto_id, mecanico_id, tipo_mantenimiento, motivo_ingreso, costo_mano_obra } = req.body;
    const mechanic = await obtenerMecanicoAsignable(mecanico_id);
    if (!mechanic) {
        return res.status(400).json({ mensaje: 'Selecciona una moto y un mecánico válidos.' });
    }
    const price = Number(costo_mano_obra ?? 0);
    if (isAdmin(req.user) && (!Number.isFinite(price) || price < 0)) {
        return res.status(400).json({ mensaje: 'Indica un valor de mano de obra válido.' });
    }
    db.run(`INSERT INTO ordenes (moto_id, mecanico_id, tipo_mantenimiento, motivo_ingreso, costo_mano_obra, trabajo_realizado, estado)
        SELECT m.id, u.id, ?, ?, ?, 'En proceso', 'En proceso'
        FROM motos m CROSS JOIN usuarios u WHERE m.id = ? AND u.id = ? AND u.rol = ?`,
        [tipo_mantenimiento, motivo_ingreso, isAdmin(req.user) ? price : 0, moto_id, mechanic.id, mechanic.rol], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (!this.changes) return res.status(400).json({ mensaje: 'Selecciona una moto y un mecánico válidos.' });
            const nuevaOrdenId = this.lastID;
            broadcastSyncEvent('orden_actualizada', { ordenId: nuevaOrdenId, accion: 'creada' });
            res.json({ success: true, orden_id: nuevaOrdenId });
        });
});

async function obtenerMecanicoAsignable(id) {
    const user = await getRow('SELECT id, rol FROM usuarios WHERE id = ?', [id]);
    return canonicalRole(user?.rol) === 'Mecanico' ? user : null;
}

app.put('/api/ordenes/:id/asignacion', async (req, res) => {
    const mechanic = await obtenerMecanicoAsignable(req.body?.mecanico_id);
    if (!mechanic) return res.status(400).json({ mensaje: 'Selecciona un mecánico válido.' });
    const result = await runOrderQuery(`UPDATE ordenes SET mecanico_id = ? WHERE id = ? AND estado = 'En proceso'
        AND EXISTS (SELECT 1 FROM usuarios WHERE id = ? AND rol = ?)`, [mechanic.id, req.params.id, mechanic.id, mechanic.rol]);
    if (!result.changes) return res.status(409).json({ mensaje: 'Solo puedes reasignar una orden en proceso.' });
    broadcastSyncEvent('asignacion_actualizada');
    res.json({ success: true });
});

app.put('/api/ordenes/:id/estado', (req, res) => {
    const estado = req.body?.estado === 'Listo para entrega' ? 'Terminada' : req.body?.estado;
    const estadosPermitidos = ['En proceso', 'Terminada', 'Cancelada'];
    if (!estadosPermitidos.includes(estado)) {
        return res.status(400).json({ success: false, mensaje: 'Estado de orden no válido.' });
    }
    const mechanicId = normalizeIdentity(req.user.rol) === 'mecanico' ? req.user.id : null;
    db.run(`UPDATE ordenes SET estado = ?, mano_obra_confirmada = 0 WHERE id = ?
        AND estado NOT IN ('Facturada', 'Cancelada') AND estado <> ?
        AND (? IS NULL OR (mecanico_id = ? AND estado = 'En proceso'))`,
        [estado, req.params.id, estado, mechanicId, mechanicId], function(err) {
        if (err) return res.status(500).json({ success: false, mensaje: err.message });
        if (!this.changes) return res.status(409).json({ mensaje: 'No se puede cambiar el estado de esta orden.' });
        broadcastSyncEvent('orden_actualizada', { ordenId: req.params.id, estado, accion: 'cambio_estado' });
        if (estado === 'Terminada') broadcastSyncEvent('orden_terminada', { ordenId: req.params.id });
        res.json({ success: true, mensaje: `Estado actualizado a "${estado}".` });
    });
});

// Evidencias: la ruta de disco se conserva en SQLite y se resuelve después de autorizar la orden.
const listPhotos = (orderId, publishedOnly = false) => new Promise((resolve, reject) => {
    db.all(`SELECT id, descripcion, fecha FROM orden_fotos WHERE orden_id = ?
        AND (? = 0 OR publicada = 1) ORDER BY fecha, id`, [orderId, +publishedOnly],
        (error, rows) => error ? reject(error) : resolve(rows));
});

function imageType(buffer) {
    if (buffer.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
    if (buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}

async function sendOrderPhoto(res, orderId, photoId, publishedOnly = false) {
    const row = await getRow(`SELECT url FROM orden_fotos WHERE orden_id = ? AND id = ?
        AND (? = 0 OR publicada = 1)`, [orderId, photoId, +publishedOnly]);
    if (!row) return res.sendStatus(404);
    const name = path.basename(row.url);
    if (!/^foto_ord_\d+_[\w-]+\.jpg$/.test(name)) return res.sendStatus(404);
    const buffer = await fs.promises.readFile(path.join(uploadsDir, name)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
    });
    const type = buffer && imageType(buffer);
    if (!type) return res.sendStatus(404);
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).type(type).send(buffer);
}

const getRow = (sql, params) => new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
});
const getTimeline = order => new Promise((resolve, reject) => {
    db.all(`SELECT tipo, descripcion, fecha FROM orden_bitacora WHERE orden_id = ?
        ORDER BY fecha, id`, [order.id], (error, rows) => {
        if (error) return reject(error);
        resolve([{ tipo: 'Ingreso', descripcion: 'Motocicleta recibida en el taller', fecha: order.fecha_ingreso }, ...rows]);
    });
});
const isWorkshopDesk = user => isAdmin(user) || user?.rol === 'Recepcionista';

const tracking = express.Router();
const trackingHash = token => crypto.createHash('sha256').update(token).digest('hex');
const trackingOrigin = process.env.TRACKING_PUBLIC_ORIGIN
    ? new URL(process.env.TRACKING_PUBLIC_ORIGIN) : null;
if (trackingOrigin && trackingOrigin.protocol !== 'https:') {
    throw new Error('TRACKING_PUBLIC_ORIGIN debe usar HTTPS.');
}

tracking.use((_req, res, next) => {
    res.set({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    });
    next();
});
tracking.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'seguimiento.html')));
tracking.get('/portal.js', (_req, res) => res.sendFile(path.join(publicDir, 'seguimiento.js')));
for (const asset of ['tema-taller.css', 'fondo_moto.jpg', 'icon.png', 'identidad.js']) {
    tracking.get('/' + asset, (_req, res) => res.sendFile(path.join(publicDir, asset)));
}
tracking.use(express.json({ limit: '2kb' }));
tracking.use(async (req, res, next) => {
    if (restoring) return res.sendStatus(503);
    const token = req.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) return res.sendStatus(404);
    req.trackingOrder = await getRow(`
        SELECT o.id, o.estado, o.fecha_ingreso, m.placa
        FROM orden_seguimiento s JOIN ordenes o ON o.id = s.orden_id
        JOIN motos m ON m.id = o.moto_id WHERE s.token_hash = ? OR EXISTS (
            SELECT 1 FROM orden_seguimiento_envios e WHERE e.token_hash = ?
            AND e.orden_id = s.orden_id AND e.version = s.token_hash)`, [trackingHash(token), trackingHash(token)]);
    if (!req.trackingOrder) return res.sendStatus(404);
    const order = req.trackingOrder;
    const identifier = typeof req.body?.identificador === 'string'
        ? req.body.identificador.trim().toUpperCase() : '';
    if (identifier !== String(order.id) && identifier !== String(order.placa || '').trim().toUpperCase()) return res.sendStatus(404);
    if (!identifier) return res.sendStatus(404);
    next();
});
tracking.post('/consulta', async (req, res) => {
    const order = req.trackingOrder;
    const [bitacora, fotos] = await Promise.all([getTimeline(order), listPhotos(order.id, true)]);
    res.json({ orden: order, bitacora, fotos });
});
tracking.post('/fotos/:fotoId', (req, res) =>
    sendOrderPhoto(res, req.trackingOrder.id, req.params.fotoId, true));
app.use('/seguimiento', tracking);

app.post('/api/ordenes/:id/seguimiento', (req, res) => {
    if (!isWorkshopDesk(req.user)) return res.sendStatus(403);
    const token = crypto.randomBytes(32).toString('hex');
    db.run(`INSERT INTO orden_seguimiento (orden_id, token_hash)
        SELECT id, ? FROM ordenes WHERE id = ?
        ON CONFLICT(orden_id) DO UPDATE SET token_hash = excluded.token_hash`,
        [trackingHash(token), req.params.id], function(error) {
            if (error) return res.sendStatus(500);
            if (!this.changes) return res.sendStatus(404);
            res.set('Cache-Control', 'no-store').json({
                enlace: `${trackingOrigin?.origin || ''}/seguimiento/#${token}`,
                externo: !!trackingOrigin
            });
        });
});
app.delete('/api/ordenes/:id/seguimiento', (req, res) => {
    if (!isWorkshopDesk(req.user)) return res.sendStatus(403);
    db.run('DELETE FROM orden_seguimiento WHERE orden_id = ?', [req.params.id], error => {
        if (error) return res.sendStatus(500);
        res.sendStatus(204);
    });
});

app.post('/api/ordenes/:id/whatsapp', async (req, res) => {
    if (!isWorkshopDesk(req.user)) return res.sendStatus(403);
    const order = await getRow(`
        SELECT o.id, o.estado, o.costo_mano_obra, o.trabajo_realizado, m.placa, c.nombre, c.telefono
        FROM ordenes o JOIN motos m ON m.id = o.moto_id JOIN clientes c ON c.id = m.cliente_id
        WHERE o.id = ? AND (o.estado = 'Facturada' OR
            (o.estado IN ('Terminada', 'Listo para entrega') AND o.mano_obra_confirmada = 1))`, [req.params.id]);
    if (!order) return res.status(409).json({ mensaje: isAdmin(req.user)
        ? 'Termina la orden y confirma la mano de obra antes de compartirla.'
        : 'La orden aún no está lista para compartir por WhatsApp.' });
    let phone = String(order.telefono || '').replace(/\D/g, '');
    if (phone.length === 10) phone = '57' + phone;
    if (!/^[1-9]\d{10,14}$/.test(phone)) return res.status(400).json({ mensaje: 'Registra un número de WhatsApp válido para el cliente.' });
    const photos = await listPhotos(order.id, true);
    if (photos.length && !trackingOrigin) {
        return res.status(409).json({ mensaje: 'Configura el dominio público de seguimiento para compartir las evidencias.' });
    }
    let link = '';
    if (trackingOrigin) {
        const token = crypto.randomBytes(32).toString('hex');
        await runOrderQuery(`INSERT OR IGNORE INTO orden_seguimiento (orden_id, token_hash)
            SELECT id, ? FROM ordenes WHERE id = ?`, [trackingHash(crypto.randomBytes(32).toString('hex')), order.id]);
        const saved = await runOrderQuery(`INSERT INTO orden_seguimiento_envios (token_hash, orden_id, version)
            SELECT ?, s.orden_id, s.token_hash FROM orden_seguimiento s JOIN ordenes o ON o.id = s.orden_id
            WHERE s.orden_id = ? AND (o.estado = 'Facturada' OR
                (o.estado IN ('Terminada', 'Listo para entrega') AND o.mano_obra_confirmada = 1))`, [trackingHash(token), order.id]);
        if (!saved.changes) return res.status(409).json({ mensaje: 'La orden cambió. Vuelve a abrir el resumen.' });
        link = `${trackingOrigin.origin}/seguimiento/#${token}`;
    }
    if (!isAdmin(req.user)) delete order.costo_mano_obra;
    delete order.telefono;
    res.set('Cache-Control', 'no-store').json({ order, phone, link });
});

const runOrderQuery = (sql, params = [], connection = db) => new Promise((resolve, reject) => {
    connection.run(sql, params, function(error) { error ? reject(error) : resolve(this); });
});

app.use(['/api/ordenes/:id/bitacora', '/api/ordenes/:id/fotos'], (req, res, next) => {
    if (!isWorkshopDesk(req.user) && normalizeIdentity(req.user.rol) !== 'mecanico') return res.sendStatus(403);
    res.set('Cache-Control', 'no-store');
    next();
});

app.get('/api/ordenes/:id/bitacora', async (req, res) => {
    const order = await getRow('SELECT id, fecha_ingreso FROM ordenes WHERE id = ?', [req.params.id]);
    if (!order) return res.sendStatus(404);
    res.json(await getTimeline(order));
});

app.get('/api/ordenes/:id/fotos', async (req, res) => {
    const photos = await listPhotos(req.params.id);
    res.json(photos.map(photo => ({ ...photo, url: `/api/ordenes/${req.params.id}/fotos/${photo.id}` })));
});
app.get('/api/ordenes/:id/fotos/:fotoId', (req, res) => sendOrderPhoto(res, req.params.id, req.params.fotoId));

app.post('/api/ordenes/:id/fotos', async (req, res) => {
    const { imagen_base64, descripcion } = req.body || {};
    const matches = typeof imagen_base64 === 'string' &&
        imagen_base64.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!matches || matches[2].length > 14_000_000) {
        return res.status(400).json({ mensaje: 'Adjunte una imagen JPEG, PNG o WebP de hasta 10 MB.' });
    }
    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > 10 * 1024 * 1024 || imageType(buffer) !== matches[1]) {
        return res.status(400).json({ mensaje: 'El archivo no corresponde a una imagen admitida.' });
    }
    const orderId = Number(req.params.id);
    if (!Number.isSafeInteger(orderId) || orderId < 1) return res.sendStatus(400);
    const filename = `foto_ord_${orderId}_${crypto.randomUUID()}.jpg`;
    const diskPath = path.join(uploadsDir, filename);
    const caption = String(descripcion || '').trim().slice(0, 500) || 'Evidencia de trabajo';
    const mechanicId = normalizeIdentity(req.user.rol) === 'mecanico' ? req.user.id : null;
    await fs.promises.writeFile(diskPath, buffer, { flag: 'wx' });
    let result;
    try {
        result = await new Promise((resolve, reject) => {
            db.run(`INSERT INTO orden_fotos (orden_id, url, descripcion, publicada)
                SELECT id, ?, ?, ? FROM ordenes WHERE id = ? AND estado = 'En proceso'
                AND (? IS NULL OR mecanico_id = ?)`, [`/uploads/ordenes/${filename}`, caption, +!!mechanicId,
                orderId, mechanicId, mechanicId], function(error) { error ? reject(error) : resolve(this); });
        });
    } finally {
        if (!result?.changes) await fs.promises.unlink(diskPath);
    }
    if (!result.changes) return res.status(409).json({ mensaje: 'La orden ya no está activa o asignada.' });
    broadcastSyncEvent('foto_agregada', { orden_id: orderId, id: result.lastID });
    res.json({ success: true, foto: { id: result.lastID, url: `/api/ordenes/${orderId}/fotos/${result.lastID}` } });
});

app.delete('/api/ordenes/:id/fotos/:fotoId', async (req, res) => {
    if (!isWorkshopDesk(req.user)) return res.sendStatus(403);
    const args = [req.params.id, req.params.fotoId];
    const row = await getRow('SELECT url FROM orden_fotos WHERE orden_id = ? AND id = ?', args);
    if (!row) return res.sendStatus(404);
    db.run('DELETE FROM orden_fotos WHERE orden_id = ? AND id = ?', args, async error => {
        if (error) return res.sendStatus(500);
        await fs.promises.unlink(path.join(uploadsDir, path.basename(row.url))).catch(unlinkError => {
            if (unlinkError.code !== 'ENOENT') console.error('[FOTOS]', unlinkError.message);
        });
        broadcastSyncEvent('foto_eliminada', { ordenId: req.params.id, fotoId: req.params.fotoId });
        res.json({ success: true });
    });
});

// Alertas de Stock Insuficiente
app.get('/api/alertas-stock', (_req, res) => {
    db.all(`SELECT * FROM alertas_stock WHERE leida = 0 ORDER BY id DESC LIMIT 50`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.put('/api/alertas-stock/:id/leer', (req, res) => {
    db.run(`UPDATE alertas_stock SET leida = 1 WHERE id = ?`, [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        broadcastSyncEvent('alerta_stock_leida', { id: req.params.id });
        res.json({ success: true });
    });
});

app.put('/api/alertas-stock/leer-todas', (_req, res) => {
    db.run(`UPDATE alertas_stock SET leida = 1`, [], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        broadcastSyncEvent('alerta_stock_leida_todas', {});
        res.json({ success: true });
    });
});

app.get('/api/ordenes/:id/detalles', (req, res) => {
    const fields = isAdmin(req.user) ? 'd.*' : 'd.id, d.orden_id, d.repuesto_id, d.cantidad';
    const query = `SELECT ${fields}, inventario.nombre as repuesto_nombre, inventario.codigo as repuesto_codigo
        FROM detalle_orden_repuestos d JOIN inventario ON d.repuesto_id = inventario.id WHERE d.orden_id = ?`;
    db.all(query, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Consulta de solicitudes guardadas por versiones anteriores.
app.get('/api/ordenes/:id/solicitudes-repuestos', (req, res) => {
    db.all(`SELECT solicitudes_repuestos_orden.*, inventario.nombre AS repuesto_nombre,
                   inventario.codigo AS repuesto_codigo, inventario.stock AS stock_disponible
            FROM solicitudes_repuestos_orden
            JOIN inventario ON inventario.id = solicitudes_repuestos_orden.repuesto_id
            WHERE solicitudes_repuestos_orden.orden_id = ?
            ORDER BY solicitudes_repuestos_orden.id DESC`, [req.params.id], (error, rows) => {
        if (error) return res.status(500).json({ mensaje: 'No se pudieron cargar los repuestos solicitados.' });
        res.json(rows || []);
    });
});

// Ambas rutas registran consumo inmediato; no existe aprobación previa.
app.post(['/api/ordenes/:id/repuestos', '/api/ordenes/:id/solicitudes-repuestos'], async (req, res) => {
    const ordenId = Number(req.params.id), repuestoId = Number(req.body.repuesto_id), cantidad = Number(req.body.cantidad);
    if (![ordenId, repuestoId, cantidad].every(n => Number.isSafeInteger(n) && n > 0)) return res.status(400).json({ mensaje: 'Orden, repuesto y cantidad deben ser enteros positivos.' });
    const connection = new sqlite3.Database(dbFile);
    connection.configure('busyTimeout', 10000);
    const run = (sql, args = []) => new Promise((resolve, reject) => connection.run(sql, args, function(err) { err ? reject(err) : resolve(this); }));
    const get = (sql, args = []) => new Promise((resolve, reject) => connection.get(sql, args, (err, row) => err ? reject(err) : resolve(row)));
    let transaction = false;
    try {
        await run('BEGIN IMMEDIATE'); transaction = true;
        const mechanicId = normalizeIdentity(req.user.rol) === 'mecanico' ? req.user.id : null;
        const order = await get(`SELECT id FROM ordenes WHERE id = ? AND estado = 'En proceso'
            AND (? IS NULL OR mecanico_id = ?)`, [ordenId, mechanicId, mechanicId]);
        const part = await get('SELECT * FROM inventario WHERE id = ?', [repuestoId]);
        if (!order || !part) {
            await run('ROLLBACK'); transaction = false;
            return res.status(404).json({ mensaje: 'Orden abierta o repuesto no encontrado.' });
        }
        await run('INSERT INTO detalle_orden_repuestos (orden_id, repuesto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)', [ordenId, repuestoId, cantidad, part.precio_venta]);
        await run('UPDATE inventario SET stock = stock - ? WHERE id = ?', [cantidad, repuestoId]);
        let alerta;
        if (part.stock < cantidad) {
            alerta = { orden_id: ordenId, repuesto_id: repuestoId, repuesto_nombre: part.nombre, cantidad_solicitada: cantidad, stock_actual: part.stock - cantidad, mecanico_nombre: req.user.nombre };
            const result = await run('INSERT INTO alertas_stock (orden_id, repuesto_id, repuesto_nombre, cantidad_solicitada, stock_actual, mecanico_nombre) VALUES (?, ?, ?, ?, ?, ?)', Object.values(alerta));
            alerta.id = result.lastID;
        }
        await run('COMMIT'); transaction = false;
        if (alerta) broadcastSyncEvent('alerta_stock', alerta);
        broadcastSyncEvent('orden_actualizada', { ordenId, accion: 'repuesto_agregado' });
        res.json({ success: true, stock_insuficiente: !!alerta, stock_actual: part.stock - cantidad, mensaje: alerta ? 'Repuesto registrado y descontado. Administración ha sido alertada del faltante.' : 'Repuesto registrado y descontado del inventario.' });
    } catch (error) {
        if (transaction) await run('ROLLBACK').catch(() => undefined);
        console.error('[REPUESTOS]', error.message);
        res.status(500).json({ mensaje: 'No se pudo confirmar la salida. Intente nuevamente.' });
    } finally { connection.close(); }
});
// Compatibilidad para clientes antiguos: las nuevas salidas nunca quedan pendientes.
app.get('/api/solicitudes-repuestos', (_req, res) => res.json([]));
app.post('/api/solicitudes-repuestos/:id/aprobar', (_req, res) => res.status(410).json({ mensaje: 'El flujo de aprobación fue retirado. Registre el repuesto directamente en la orden.' }));

app.put('/api/ordenes/:id/reportar', (req, res) => {
    const text = typeof req.body?.trabajo_realizado === 'string' ? req.body.trabajo_realizado.trim() : '';
    if (!text || text.length > 4000) return res.status(400).json({ mensaje: 'Escriba un avance de hasta 4000 caracteres.' });
    const mechanicId = normalizeIdentity(req.user.rol) === 'mecanico' ? req.user.id : null;
    db.run(`INSERT INTO orden_bitacora (orden_id, tipo, descripcion)
        SELECT id, 'Avance', ? FROM ordenes WHERE id = ? AND estado = 'En proceso'
        AND (? IS NULL OR mecanico_id = ?)`, [text, req.params.id, mechanicId, mechanicId], function(error) {
        if (error) return res.sendStatus(500);
        if (!this.changes) return res.status(409).json({ mensaje: 'La orden ya no está activa o asignada.' });
        broadcastSyncEvent('orden_actualizada', { ordenId: req.params.id, accion: 'avance_reportado' });
        res.json({ success: true });
    });
});

app.put('/api/ordenes/:id/mano-obra', (req, res) => {
    if (!isAdmin(req.user)) return res.sendStatus(403);
    const value = req.body?.costo_mano_obra;
    const costoManoObra = Number(value);
    if (!['string', 'number'].includes(typeof value) || !String(value).trim() ||
        !Number.isFinite(costoManoObra) || costoManoObra < 0) {
        return res.status(400).json({ success: false, mensaje: 'El valor de mano de obra debe ser un número igual o mayor que cero.' });
    }

    db.run(
        `UPDATE ordenes SET costo_mano_obra = ?, mano_obra_confirmada = CASE WHEN estado = 'En proceso' THEN 0 ELSE 1 END
         WHERE id = ? AND estado IN ('En proceso', 'Terminada', 'Listo para entrega')`,
        [costoManoObra, req.params.id],
        function(error) {
            if (error) return res.status(500).json({ success: false, mensaje: 'No se pudo actualizar la mano de obra.' });
            if (this.changes === 0) {
                return res.status(404).json({ success: false, mensaje: 'No se encontró una orden abierta con ese número.' });
            }
            broadcastSyncEvent('orden_actualizada', { ordenId: req.params.id, accion: 'mano_obra_actualizada' });
            res.json({ success: true, mensaje: 'Mano de obra actualizada.' });
        }
    );
});

app.put('/api/ordenes/:id/facturar', (req, res) => {
    if (!isAdmin(req.user)) return res.sendStatus(403);
    db.run(`UPDATE ordenes SET estado = 'Facturada'
        WHERE id = ? AND estado IN ('Terminada', 'Listo para entrega') AND mano_obra_confirmada = 1
        AND costo_mano_obra = ?`,
        [req.params.id, req.body?.costo_mano_obra], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (!this.changes) return res.status(409).json({ mensaje: 'Confirma el valor vigente de mano de obra antes del cobro.' });
            broadcastSyncEvent('orden_actualizada', { ordenId: req.params.id, accion: 'facturada' });
            res.json({ success: true });
        });
});

// Citas
app.get('/api/citas', (_req, res) => {
    db.all(`SELECT * FROM citas ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/citas', (req, res) => {
    const { cliente_nombre, moto_placa, fecha_cita, hora_cita, motivo } = req.body;
    if (!cliente_nombre || !moto_placa || !fecha_cita || !motivo) return res.status(400).json({ success: false, mensaje: 'Faltan campos.' });
    db.run(`INSERT INTO citas (cliente_nombre, moto_placa, fecha_cita, hora_cita, motivo, estado) VALUES (?, ?, ?, ?, ?, 'Pendiente')`,
        [cliente_nombre, moto_placa.toUpperCase(), fecha_cita, hora_cita || '08:00', motivo], function(err) {
            if (err) return res.status(500).json({ success: false, mensaje: 'Error al guardar.' });
            res.json({ success: true, mensaje: 'Cita agendada', id: this.lastID });
        });
});

app.post('/api/citas/:id/convertir', async (req, res) => {
    const mechanicId = req.body?.mecanico_id;
    const connection = new sqlite3.Database(dbFile);
    connection.configure('busyTimeout', 10000);
    const get = (sql, params) => new Promise((resolve, reject) =>
        connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
    const run = (sql, params = []) => new Promise((resolve, reject) =>
        connection.run(sql, params, function(error) { error ? reject(error) : resolve(this); }));
    let pending = false;
    try {
        await run('BEGIN IMMEDIATE');
        pending = true;
        const mechanic = await get('SELECT rol FROM usuarios WHERE id = ?', [mechanicId]);
        if (canonicalRole(mechanic?.rol) !== 'Mecanico') {
            return res.status(400).json({ mensaje: 'Selecciona un mecánico válido.' });
        }
        const cita = await get('SELECT * FROM citas WHERE id = ?', [req.params.id]);
        if (!cita) return res.status(404).json({ mensaje: 'Cita no encontrada.' });
        if (cita.estado === 'Atendida') return res.status(409).json({ mensaje: 'La cita ya ingresó al taller.' });
        const placa = cita.moto_placa.trim().toUpperCase();
        const existing = await get('SELECT id FROM motos WHERE upper(placa) = ?', [placa]);
        let motoId = existing?.id;
        if (!motoId) {
            const client = await run('INSERT INTO clientes (nombre) VALUES (?)', [cita.cliente_nombre]);
            const moto = await run("INSERT INTO motos (cliente_id, placa, marca, cilindraje, kilometraje) VALUES (?, ?, 'Genérica', 150, 0)",
                [client.lastID, placa]);
            motoId = moto.lastID;
        }
        const order = await run(`INSERT INTO ordenes (moto_id, mecanico_id, tipo_mantenimiento, motivo_ingreso, costo_mano_obra, trabajo_realizado, estado)
            VALUES (?, ?, 'Preventivo', ?, 0, 'Ingreso desde cita', 'En proceso')`, [motoId, mechanicId, req.body?.motivo_ingreso || cita.motivo]);
        await run("UPDATE citas SET estado = 'Atendida' WHERE id = ?", [cita.id]);
        await run('COMMIT');
        pending = false;
        broadcastSyncEvent('orden_actualizada', { ordenId: order.lastID, accion: 'creada' });
        res.json({ success: true, orden_id: order.lastID });
    } finally {
        if (pending) await run('ROLLBACK').catch(() => undefined);
        connection.close();
    }
});

// Reportes
app.get('/api/reportes/contabilidad', (_req, res) => {
    const q1 = `SELECT SUM(costo_mano_obra) as total_mano FROM ordenes WHERE estado = 'Facturada'`;
    const q2 = `SELECT SUM(detalle_orden_repuestos.cantidad * detalle_orden_repuestos.precio_unitario) as total_rep FROM detalle_orden_repuestos JOIN ordenes ON detalle_orden_repuestos.orden_id = ordenes.id WHERE ordenes.estado = 'Facturada'`;
    const q3 = `SELECT SUM(costo_mano_obra) as por_producir FROM ordenes WHERE estado = 'En proceso'`;
    db.get(q1, [], (_err, r1) => {
        db.get(q2, [], (_err, r2) => {
            db.get(q3, [], (_err, r3) => {
                const mano = r1?.total_mano || 0;
                const rep = r2?.total_rep || 0;
                res.json({ total_mano_obra: mano, total_repuestos_venta: rep, ganancia_repuestos: rep * 0.3, por_producir: r3?.por_producir || 0, ganancia_total: mano + rep });
            });
        });
    });
});

app.get('/api/reportes/mecanicos', (_req, res) => {
    db.all(`SELECT usuarios.nombre, COUNT(ordenes.id) as total_ordenes, SUM(ordenes.costo_mano_obra) as total_facturado_mano FROM usuarios LEFT JOIN ordenes ON usuarios.id = ordenes.mecanico_id AND ordenes.estado = 'Facturada' WHERE usuarios.rol = 'Mecanico' GROUP BY usuarios.id`, [], (_err, rows) => {
        res.json(rows || []);
    });
});

// Reporte detallado de ganancias y rentabilidad con filtros por orden, placa, cliente y fecha
app.get('/api/reportes/detallado', (req, res) => {
    const { orden_id, placa, cliente, fecha_inicio, fecha_fin, estado } = req.query;

    let query = `
        SELECT 
            o.id as orden_id,
            o.fecha_ingreso,
            o.costo_mano_obra,
            o.trabajo_realizado,
            o.estado,
            o.mano_obra_confirmada,
            o.tipo_mantenimiento,
            m.placa as moto_placa,
            m.marca as moto_marca,
            m.modelo as moto_modelo,
            m.kilometraje as moto_kilometraje,
            c.id as cliente_id,
            c.nombre as cliente_nombre,
            c.cedula as cliente_cedula,
            c.telefono as cliente_telefono,
            u.nombre as mecanico_nombre,
            COALESCE(SUM(dor.cantidad * dor.precio_unitario), 0) as total_repuestos_venta,
            COALESCE(SUM(dor.cantidad * inv.precio_costo), 0) as total_repuestos_costo
        FROM ordenes o
        JOIN motos m ON o.moto_id = m.id
        JOIN clientes c ON m.cliente_id = c.id
        LEFT JOIN usuarios u ON o.mecanico_id = u.id
        LEFT JOIN detalle_orden_repuestos dor ON o.id = dor.orden_id
        LEFT JOIN inventario inv ON dor.repuesto_id = inv.id
        WHERE 1=1
    `;
    const params = [];

    if (orden_id) {
        query += ` AND o.id = ?`;
        params.push(Number(orden_id));
    }
    if (placa) {
        query += ` AND m.placa LIKE ?`;
        params.push(`%${placa}%`);
    }
    if (cliente) {
        query += ` AND (c.nombre LIKE ? OR c.cedula LIKE ?)`;
        params.push(`%${cliente}%`, `%${cliente}%`);
    }
    if (estado) {
        if (estado === 'Terminada') query += " AND o.estado IN ('Terminada', 'Listo para entrega')";
        else {
            query += ' AND o.estado = ?';
            params.push(estado);
        }
    }
    if (fecha_inicio) {
        query += ` AND date(o.fecha_ingreso) >= date(?)`;
        params.push(fecha_inicio);
    }
    if (fecha_fin) {
        query += ` AND date(o.fecha_ingreso) <= date(?)`;
        params.push(fecha_fin);
    }

    query += ` GROUP BY o.id ORDER BY o.id DESC`;

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        let totalManoObra = 0;
        let totalRepuestosVenta = 0;
        let totalRepuestosCosto = 0;
        let totalGananciaRepuestos = 0;
        let totalGananciaNeta = 0;
        let totalFacturadoGeneral = 0;

        const ordenesDetalladas = (rows || []).map((row) => {
            const manoObra = Number(row.costo_mano_obra || 0);
            const repVenta = Number(row.total_repuestos_venta || 0);
            const repCosto = Number(row.total_repuestos_costo || 0);
            const gananciaRep = repVenta - repCosto;
            const gananciaNeta = manoObra + gananciaRep;
            const totalFacturado = manoObra + repVenta;

            totalManoObra += manoObra;
            totalRepuestosVenta += repVenta;
            totalRepuestosCosto += repCosto;
            totalGananciaRepuestos += gananciaRep;
            totalGananciaNeta += gananciaNeta;
            totalFacturadoGeneral += totalFacturado;

            return {
                ...row,
                costo_mano_obra: manoObra,
                total_repuestos_venta: repVenta,
                total_repuestos_costo: repCosto,
                ganancia_repuestos: gananciaRep,
                ganancia_neta: gananciaNeta,
                total_facturado: totalFacturado
            };
        });

        res.json({
            ordenes: ordenesDetalladas,
            totales: {
                total_mano_obra: totalManoObra,
                total_repuestos_venta: totalRepuestosVenta,
                total_repuestos_costo: totalRepuestosCosto,
                ganancia_total_repuestos: totalGananciaRepuestos,
                ganancia_neta_total: totalGananciaNeta,
                total_facturado_general: totalFacturadoGeneral,
                conteo_ordenes: ordenesDetalladas.length
            }
        });
    });
});

// Configuración general
app.get('/api/config', (req, res) => {
    const fields = isAdmin(req.user) ? '*' : 'nombre_taller, eslogan_taller, tema';
    db.get(`SELECT ${fields} FROM configuracion WHERE id = 1`, [], (_err, row) => {
        res.json({ ...row, nombre_taller: NOMBRE_TALLER });
    });
});

app.post('/api/config', (req, res) => {
    const { nit_taller, telefono_taller, email_taller, direccion_taller, tema, impresora_nombre, backup_interval_min, eslogan_taller } = req.body;
    const temasPermitidos = ['dark', 'dark-graphite', 'dark-emerald', 'light-amber', 'light-blue', 'light-emerald'];
    if (tema && !temasPermitidos.includes(tema)) return res.status(400).json({ success: false, mensaje: 'Tema visual no válido.' });
    
    db.run(`UPDATE configuracion SET 
            nombre_taller=?, nit_taller=?, telefono_taller=?, email_taller=?, direccion_taller=?, tema=?, impresora_nombre=?,
            backup_interval_min=COALESCE(?, backup_interval_min),
            eslogan_taller=COALESCE(?, eslogan_taller)
            WHERE id = 1`,
        [
            NOMBRE_TALLER, nit_taller, telefono_taller, email_taller, direccion_taller, tema, impresora_nombre,
            backup_interval_min !== undefined ? Number(backup_interval_min) : null,
            eslogan_taller || null
        ], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            if (backup_interval_min !== undefined) {
                configurarAutoBackup(backup_interval_min);
            }
            broadcastSyncEvent('config_actualizada', { nombre_taller: NOMBRE_TALLER, eslogan_taller });
            res.json({ success: true });
        });
});

// Copias de Seguridad (Backup)
app.get('/api/backup', (_req, res) => {
    const timestamp = Date.now();
    const backupName = `taller_backup_${timestamp}.db`;
    res.download(dbFile, backupName, (err) => {
        if (err) {
            console.error('[BACKUP] Error al descargar base de datos:', err.message);
        }
    });
});

app.post('/api/config-backup', (req, res) => {
    const { backup_path } = req.body;
    db.run(`UPDATE configuracion SET backup_path = ? WHERE id = 1`, [backup_path], function(err) {
        if (err) return res.status(500).json({ success: false, mensaje: 'Error al guardar la ruta de copia de seguridad.' });
        res.json({ success: true, mensaje: 'Ruta de copia de seguridad guardada correctamente.' });
    });
});

app.post('/api/backup-ejecutar', (_req, res) => {
    db.get(`SELECT backup_path FROM configuracion WHERE id = 1`, (err, row) => {
        if (err) {
            console.error('[BACKUP] Error al consultar la carpeta de respaldo:', err.message);
            return res.status(500).json({ success: false, mensaje: 'No se pudo consultar la configuración del respaldo.' });
        }
        if (!row || !row.backup_path) {
            return res.status(400).json({ success: false, mensaje: 'Debe configurar primero una carpeta de destino para el respaldo.' });
        }
        const destDir = row.backup_path;
        try {
            fs.mkdirSync(destDir, { recursive: true });
            const backupFile = path.join(destDir, `taller_backup_${Date.now()}.db`);
            createDatabaseSnapshot(backupFile).then(() => {
                res.json({ success: true, mensaje: `Copia de seguridad realizada exitosamente en: ${backupFile}` });
            }).catch((backupError) => res.status(500).json({ success: false, mensaje: `Error al crear respaldo: ${backupError.message}` }));
        } catch (error) {
            console.error('[BACKUP] Error al crear el respaldo:', error.message);
            res.status(500).json({ success: false, mensaje: `Error al crear respaldo: ${error.message}` });
        }
    });
});

app.post('/api/restore', async (req, res) => {
    const sourcePath = req.body?.sourcePath;
    if (typeof sourcePath !== 'string' || path.extname(sourcePath).toLowerCase() !== '.db' || !fs.existsSync(sourcePath)) {
        return res.status(400).json({ success: false, mensaje: 'Seleccione un archivo .db existente.' });
    }
    if (path.resolve(sourcePath) === path.resolve(dbFile)) {
        return res.status(400).json({ success: false, mensaje: 'Seleccione una copia distinta de la base en uso.' });
    }

    const suffix = crypto.randomUUID();
    const stagedPath = `${dbFile}.restore-${suffix}`;
    const previousPath = `${dbFile}.pre-restore-${suffix}`;
    let candidate;
    let staged;
    let previousClosed = false;
    let replaced = false;
    restoring = true;
    try {
        try {
            candidate = await new Promise((resolve, reject) => {
                const connection = new sqlite3.Database(sourcePath, sqlite3.OPEN_READONLY,
                    error => error ? reject(error) : resolve(connection));
            });
            const [integrity] = await queryAll(candidate, 'PRAGMA integrity_check');
            const tables = new Set((await queryAll(candidate, "SELECT name FROM sqlite_master WHERE type = 'table'")).map(row => row.name));
            const required = ['clientes', 'motos', 'usuarios', 'inventario', 'detalle_orden_repuestos', 'citas', 'configuracion'];
            if (integrity?.integrity_check !== 'ok' || !required.every(name => tables.has(name)) ||
                !(tables.has('ordenes') || tables.has('ordenes_servicio'))) {
                throw new Error('La copia no contiene una base íntegra de HIDEP-SOFT-SG.');
            }
        } catch {
            return res.status(400).json({ success: false, mensaje: 'El archivo no contiene una copia íntegra de HIDEP-SOFT-SG.' });
        }

        await createDatabaseSnapshot(stagedPath, candidate);
        staged = await openDatabase(stagedPath);
        await inicializarTablas(staged);
        await closeConnection(staged);
        staged = undefined;
        await createDatabaseSnapshot(previousPath);
        await closeConnection(db);
        previousClosed = true;
        fs.renameSync(stagedPath, dbFile);
        replaced = true;
        db = await openDatabase(dbFile);
        previousClosed = false;
        await refreshBackupInterval();
        res.json({ success: true, mensaje: 'Restauración completada. Inicie sesión de nuevo.' });
        for (const id of new Set([...sessions.values()].map(session => session.id))) invalidateUserSessions(id);
    } catch (error) {
        console.error('[RESTORE]', error.message);
        if (previousClosed) {
            if (replaced) fs.copyFileSync(previousPath, dbFile);
            db = await openDatabase(dbFile);
        }
        res.status(500).json({ success: false, mensaje: 'No se pudo completar la restauración.' });
    } finally {
        try {
            if (candidate) await closeConnection(candidate);
            if (staged) await closeConnection(staged);
            fs.rmSync(stagedPath, { force: true });
        } finally {
            restoring = false;
        }
    }
});

// Gestión de usuarios
app.get('/api/mecanicos', async (_req, res) => {
    db.all('SELECT id, nombre, rol FROM usuarios ORDER BY nombre', (error, rows) => {
        if (error) return res.status(500).json({ mensaje: 'No se pudieron consultar los mecánicos.' });
        res.json(rows.filter(user => canonicalRole(user.rol) === 'Mecanico').map(({ id, nombre }) => ({ id, nombre })));
    });
});

app.get('/api/usuarios', (_req, res) => {
    db.all(`SELECT id, nombre, username, rol, permisos, cedula, pregunta_seguridad FROM usuarios`, [], (err, rows) => {
        if (err) return res.status(500).json({ mensaje: 'No se pudieron consultar los usuarios.' });
        res.json(rows.map(user => {
            const rol = canonicalRole(user.rol) || user.rol;
            return { ...user, rol, permisos: JSON.stringify(rolePermissions[rol] || {}) };
        }));
    });
});

app.post('/api/usuarios', async (req, res) => {
    const { password, cedula, pregunta_seguridad, respuesta_seguridad } = req.body || {};
    const nombre = String(req.body?.nombre || '').trim();
    const username = String(req.body?.username || '').trim();
    const rol = canonicalRole(req.body?.rol);
    if (!nombre || !username || !rol || typeof password !== 'string' || password.trim().length < 10) {
        return res.status(400).json({ mensaje: 'Indica nombre, usuario, un rol válido y una contraseña de al menos 10 caracteres.' });
    }
    if ((cedula || pregunta_seguridad || respuesta_seguridad) && (!cedula || !pregunta_seguridad || !respuesta_seguridad)) {
        return res.status(400).json({ mensaje: 'Completa los tres campos de recuperación.' });
    }
    try {
        const [passwordHash, recoveryHash] = await Promise.all([hashPassword(password),
            respuesta_seguridad ? hashPassword(String(respuesta_seguridad).trim().toLocaleLowerCase('es')) : null]);
        await runOrderQuery(`INSERT INTO usuarios (nombre, username, password, rol, permisos, cedula, pregunta_seguridad, respuesta_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [nombre, username, passwordHash, rol, JSON.stringify(rolePermissions[rol]),
            cedula || null, pregunta_seguridad || null, recoveryHash]);
        res.json({ success: true });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ mensaje: 'El usuario o la cédula ya están registrados.' });
        throw error;
    }
});

app.put('/api/usuarios/:id', async (req, res) => {
    const id = Number(req.params.id);
    const nombre = String(req.body?.nombre || '').trim();
    const username = String(req.body?.username || '').trim();
    const rol = canonicalRole(req.body?.rol);
    if (!nombre || !username || !rol) return res.status(400).json({ mensaje: 'Indica nombre, usuario y un rol válido.' });
    const target = await getRow('SELECT username, rol FROM usuarios WHERE id = ?', [id]);
    if (!target) return res.sendStatus(404);
    if ((target.username === 'admin' && username !== 'admin') ||
        ((target.username === 'admin' || id === req.user.id) && rol !== 'Administrador')) {
        return res.status(409).json({ mensaje: 'La cuenta principal y la sesión actual deben conservar el rol Administrador.' });
    }
    try {
        const result = await runOrderQuery(`UPDATE usuarios SET nombre = ?, username = ?, rol = ?, permisos = ?
            WHERE id = ? AND username = ? AND rol = ? AND (? = 0 OR NOT EXISTS
                (SELECT 1 FROM ordenes WHERE mecanico_id = ? AND estado = 'En proceso'))`,
            [nombre, username, rol, JSON.stringify(rolePermissions[rol]), id, target.username, target.rol,
                +((canonicalRole(target.rol) === 'Mecanico') && rol !== 'Mecanico'), id]);
        if (!result.changes) return res.status(409).json({ mensaje: 'Reasigna las órdenes en proceso del mecánico o vuelve a cargar el usuario.' });
        if (canonicalRole(target.rol) !== rol) invalidateUserSessions(id);
        else for (const session of sessions.values()) if (session.id === id) {
            session.nombre = nombre;
            session.username = username;
        }
        res.json({ success: true });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ mensaje: 'El nombre de usuario ya está registrado.' });
        throw error;
    }
});

// Restablecimiento / cambio de contraseña exclusivo para Administrador
app.put('/api/usuarios/:id/password', async (req, res) => {
    const userId = req.params.id;
    const { nuevaPassword, adminPassword } = req.body;

    if (!nuevaPassword || String(nuevaPassword).trim().length < 4) {
        return res.status(400).json({ success: false, mensaje: 'La nueva contraseña debe tener al menos 4 caracteres.' });
    }

    if (adminPassword) {
        const admin = await new Promise((resolve) => {
            db.get(`SELECT * FROM usuarios WHERE username = 'admin'`, [], (_err, row) => resolve(row));
        });
        const isMatch = admin && await verifyPassword(adminPassword, admin.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, mensaje: 'Contraseña de administrador incorrecta.' });
        }
    }

    try {
        const hash = await hashPassword(nuevaPassword);
        db.run(`UPDATE usuarios SET password = ? WHERE id = ?`, [hash, userId], function(err) {
            if (err) return res.status(500).json({ success: false, mensaje: 'Error al actualizar contraseña: ' + err.message });
            if (!this.changes) return res.sendStatus(404);
            if (Number(userId) !== req.user.id) invalidateUserSessions(Number(userId));
            res.json({ success: true, mensaje: 'Contraseña actualizada exitosamente.' });
        });
    } catch (e) {
        res.status(500).json({ success: false, mensaje: e.message });
    }
});

app.delete('/api/usuarios/:id', (req, res) => {
    const { password } = req.body;
    db.get(`SELECT * FROM usuarios WHERE username = 'admin'`, [], async (_err, admin) => {
        const isMatch = admin && await verifyPassword(password, admin.password);
             
        if (!isMatch) return res.status(401).json({ mensaje: 'Contraseña de administrador incorrecta.' });
        db.run(`DELETE FROM usuarios WHERE id = ? AND username <> 'admin' AND id <> ?
            AND NOT EXISTS (SELECT 1 FROM ordenes WHERE mecanico_id = usuarios.id)`, [req.params.id, req.user.id], function(error) {
            if (error) return res.sendStatus(500);
            if (!this.changes) return res.status(409).json({ mensaje: 'La cuenta está protegida o vinculada a órdenes.' });
            invalidateUserSessions(Number(req.params.id));
            res.json({ success: true });
        });
    });
});

// Reset del sistema
app.post('/api/reset-sistema', (req, res) => {
    const { password } = req.body;
    db.get(`SELECT * FROM usuarios WHERE username = 'admin'`, [], async (_err, admin) => {
        const isMatch = admin && await verifyPassword(password, admin.password);

        if (!isMatch) return res.status(401).json({ mensaje: 'Contraseña de administrador incorrecta.' });
        db.serialize(() => {
            db.run(`DELETE FROM solicitudes_repuestos_orden`);
            db.run(`DELETE FROM detalle_orden_repuestos`);
            db.run(`DELETE FROM orden_seguimiento_envios`);
            db.run(`DELETE FROM orden_seguimiento`);
            db.run(`DELETE FROM orden_bitacora`);
            db.run(`DELETE FROM orden_fotos`);
            db.run(`DELETE FROM ordenes`);
            db.run(`DELETE FROM motos`);
            db.run(`DELETE FROM clientes`);
            db.run(`DELETE FROM citas`);
            db.run(`DELETE FROM inventario`);
            res.json({ success: true });
        });
    });
});

// Impresoras
app.get('/api/impresoras', (_req, res) => {
    res.json(['Impresora POS Termica 58mm', 'Impresora Facturación PDF', 'Microsoft Print to PDF']);
});

app.use('/api', (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) console.error('[API]', error.message);
    res.status(status).json({ mensaje: status === 500 ? 'Error interno del servidor.' : 'Solicitud inválida.' });
});

// ================= INICIALIZACIÓN DEL SERVIDOR =================
let serverInstance;
let trackingServer;
let startPromise;

function listen(app, port, hostname) {
    return new Promise((resolve, reject) => {
        const listener = app.listen(port, hostname);
        listener.once('error', reject);
        listener.once('listening', () => {
            listener.removeListener('error', reject);
            resolve(listener);
        });
    });
}

function startServer(port = PORT) {
    return startPromise ||= (async () => {
        await ensureDatabase();
        serverInstance = await listen(app, Number(port), '0.0.0.0');
        try {
            if (process.env.TRACKING_PORT) {
                const trackingApp = express();
                trackingApp.disable('x-powered-by');
                trackingApp.use('/seguimiento', tracking);
                trackingServer = await listen(trackingApp, Number(process.env.TRACKING_PORT), '127.0.0.1');
            }
            return serverInstance;
        } catch (error) {
            await new Promise(resolve => serverInstance.close(resolve));
            throw error;
        }
    })();
}

async function closeDatabase() {
    trackingServer?.close();
    if (backupIntervalTimer) { clearInterval(backupIntervalTimer); backupIntervalTimer = null; }
    if (db) await closeConnection(db);
}

if (require.main === module) {
    startServer().then(listener => {
        console.log(`[SERVER] HIDEP-SOFT-SG disponible en el puerto ${listener.address().port}.`);
    }).catch(async error => {
        console.error('[SERVER] No se pudo iniciar:', error.message);
        await closeDatabase().catch(() => undefined);
        process.exitCode = 1;
    });
}

module.exports = { app, startServer, closeDatabase, resolveDbPath, desktopBackupKey };
