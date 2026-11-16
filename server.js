const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const app = express();
const sessions = new Map();
const PORT = process.env.PORT || 3000;

// Middleware CORS nativo para habilitar sincronización desde tablets, celulares y red local
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Directorio para evidencia fotográfica de órdenes
const uploadsDir = process.env.APP_IS_PACKAGED === 'true'
    ? path.join(process.env.APP_USER_DATA_PATH || path.dirname(resolveDbPath()), 'uploads', 'ordenes')
    : path.join(__dirname, 'public', 'uploads', 'ordenes');
app.use('/uploads/ordenes', express.static(uploadsDir));
if (!fs.existsSync(uploadsDir)) {
    try {
        fs.mkdirSync(uploadsDir, { recursive: true });
    } catch (e) {
        console.error('[UPLOADS] Error creando directorio para fotos:', e.message);
    }
}

// ================= GESTIÓN DE RUTA DE BASE DE DATOS =================
function resolveDbPath() {
    // Si estamos en entorno empaquetado de Electron (producción en Windows)
    const isPackaged = process.env.APP_IS_PACKAGED === 'true' || 
                       (process.mainModule && process.mainModule.filename && process.mainModule.filename.includes('app.asar')) ||
                       __dirname.includes('app.asar');

    let dbDir = __dirname;
    if (isPackaged) {
        dbDir = process.env.APP_USER_DATA_PATH || 
                (process.env.APPDATA ? path.join(process.env.APPDATA, 'HIDEP-SOFT') : path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming', 'HIDEP-SOFT'));
    }

    if (!fs.existsSync(dbDir)) {
        try {
            fs.mkdirSync(dbDir, { recursive: true });
        } catch (e) {
            console.error('[DB] Error al crear directorio para base de datos:', e.message);
        }
    }

    const targetDb = path.join(dbDir, 'database.db');

    // Si la base de datos de producción aún no existe en AppData, copiar la plantilla base con datos
    if (!fs.existsSync(targetDb)) {
        const candidateTemplates = [
            process.resourcesPath ? path.join(process.resourcesPath, 'database.db') : null,
            path.join(__dirname, 'database.db'),
            path.join(process.cwd(), 'database.db')
        ].filter(Boolean);

        let copied = false;
        for (const tpl of candidateTemplates) {
            if (fs.existsSync(tpl)) {
                try {
                    fs.copyFileSync(tpl, targetDb);
                    copied = true;
                    break;
                } catch (e) {
                    console.error(`[DB] Error al copiar plantilla desde ${tpl}:`, e.message);
                }
            }
        }
        if (!copied) {
        }
    }

    return targetDb;
}

const dbFile = resolveDbPath();

let db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('[DB] Error crítico al abrir la base de datos SQLite:', err.message);
    } else {
        inicializarTablas();
    }
});

function inicializarTablas() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS clientes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cedula TEXT UNIQUE,
            nombre TEXT,
            telefono TEXT,
            direccion TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS motos (
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

        db.run(`CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT,
            username TEXT UNIQUE,
            password TEXT,
            rol TEXT,
            permisos TEXT
        )`);
        db.run('ALTER TABLE usuarios ADD COLUMN cedula TEXT', () => {});
        db.run('ALTER TABLE usuarios ADD COLUMN pregunta_seguridad TEXT', () => {});
        db.run('ALTER TABLE usuarios ADD COLUMN respuesta_hash TEXT', () => {});
        db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_cedula_unique ON usuarios(cedula) WHERE cedula IS NOT NULL AND cedula <> ''");

        db.run(`CREATE TABLE IF NOT EXISTS inventario (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            codigo TEXT UNIQUE,
            nombre TEXT,
            stock INTEGER,
            precio_costo REAL,
            precio_venta REAL
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS ordenes (
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

        db.run(`CREATE TABLE IF NOT EXISTS detalle_orden_repuestos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            orden_id INTEGER,
            repuesto_id INTEGER,
            cantidad INTEGER,
            precio_unitario REAL,
            FOREIGN KEY(orden_id) REFERENCES ordenes(id),
            FOREIGN KEY(repuesto_id) REFERENCES inventario(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS solicitudes_repuestos_orden (
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

        db.run(`CREATE TABLE IF NOT EXISTS citas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cliente_nombre TEXT,
            moto_placa TEXT,
            fecha_cita TEXT,
            hora_cita TEXT,
            motivo TEXT,
            estado TEXT DEFAULT 'Pendiente'
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS orden_fotos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            orden_id INTEGER NOT NULL,
            url TEXT NOT NULL,
            descripcion TEXT,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(orden_id) REFERENCES ordenes(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS alertas_stock (
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

        db.run(`CREATE TABLE IF NOT EXISTS configuracion (
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
        )`, () => {
            db.run('ALTER TABLE configuracion ADD COLUMN backup_interval_min INTEGER DEFAULT 60', () => {});
            db.run("ALTER TABLE configuracion ADD COLUMN eslogan_taller TEXT DEFAULT 'Pasión y Precisión en Cada Kilómetro'", () => {});
            db.get(`SELECT COUNT(*) as count FROM configuracion`, (err, row) => {
                if (row && row.count === 0) {
                    db.run(`INSERT INTO configuracion (nombre_taller, nit_taller, tema, tarifa_100, tarifa_200, tarifa_400, tarifa_mas, backup_interval_min, eslogan_taller) 
                            VALUES ('SG-TALLER DE MOTOS', '900123456-1', 'dark', 30000, 50000, 80000, 120000, 60, 'Pasión y Precisión en Cada Kilómetro')`);
                }
            });
            // Iniciar temporizador de auto-guardado
            db.get(`SELECT backup_interval_min FROM configuracion WHERE id = 1`, (err, row) => {
                if (row && row.backup_interval_min) {
                    configurarAutoBackup(row.backup_interval_min);
                }
            });
        });

        // Asegurar que exista usuario administrador
        db.get(`SELECT * FROM usuarios WHERE username = 'admin'`, async (err, row) => {
            if (!row) {
                const hash = await hashPassword('1234');
                db.run(`INSERT INTO usuarios (nombre, username, password, rol, permisos) VALUES (?, 'admin', ?, 'Administrador', '{"clientes":true,"ordenes":true,"facturacion":true,"inventario":true,"citas":true,"reportes":true,"config":true}')`, ['Administrador General', hash]);
            }
        });
        db.all('SELECT id, password FROM usuarios', async (err, users) => {
            if (err) {
                console.error('[AUTH] No se pudieron consultar usuarios para migrar contraseñas:', err.message);
                return;
            }
            const usersToMigrate = (users || []).filter((user) => user.password && !user.password.startsWith('scrypt$'));
            try {
                const passwordUpdates = await Promise.all(usersToMigrate.map(async (user) => ({
                    id: user.id,
                    hash: await hashPassword(user.password)
                })));
                passwordUpdates.forEach(({ id, hash }) => {
                    db.run('UPDATE usuarios SET password = ? WHERE id = ?', [hash, id], (updateError) => {
                        if (updateError) {
                            console.error(`[AUTH] No se pudo migrar la contraseña del usuario ${id}:`, updateError.message);
                        }
                    });
                });
            } catch (migrationError) {
                console.error('[AUTH] Falló la migración de contraseñas heredadas:', migrationError.message);
            }
        });
    });
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

function createDatabaseSnapshot(destinationPath) {
    return new Promise((resolve, reject) => {
        const backup = db.backup(destinationPath);
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
        db.get(`SELECT backup_path FROM configuracion WHERE id = 1`, (err, row) => {
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
    for (const client of sseClients) {
        try {
            if (normalizeIdentity(client.syncUser?.rol) === 'mecanico') {
                const orderId = data.ordenId || data.orden_id;
                if (orderId) db.get('SELECT mecanico_id FROM ordenes WHERE id = ?', [orderId], (err, order) => {
                    if (!err && order?.mecanico_id === client.syncUser.id && !client.destroyed) client.write(`event: sync\ndata: ${payload}\n\n`);
                });
                continue;
            }
            client.write(`event: sync\ndata: ${payload}\n\n`);
        } catch (e) {
            sseClients.delete(client);
        }
    }
}

// ================= API RUTAS =================

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
        'Access-Control-Allow-Origin': '*'
    });
    res.write('event: connected\ndata: {"status":"connected"}\n\n');
    sseClients.add(res);

    req.on('close', () => {
        sseClients.delete(res);
    });
});

// Endpoint de verificación de salud del servidor
app.get('/api/health', (req, res) => {
    db.get('SELECT 1 AS ready FROM usuarios LIMIT 1', (error) => {
        if (error) return res.status(503).json({ status: 'starting' });
        res.json({ status: 'ok', uptime: process.uptime(), time: Date.now() });
    });
});

// Autenticación de usuarios
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, mensaje: 'Usuario y contraseña requeridos.' });
    }

    db.get(`SELECT * FROM usuarios WHERE username = ?`, [username], async (err, user) => {
        if (err) {
            console.error('[AUTH] Error interno:', err.message);
            return res.status(500).json({ success: false, mensaje: 'Error interno en el servidor.' });
        }
        if (!user) {
            return res.status(401).json({ success: false, mensaje: 'Usuario o contraseña incorrectos.' });
        }

        // Validación de contraseña flexible para administrador (soporta 1234 y 123)
        const isPasswordMatch = await verifyPassword(password, user.password);

        if (!isPasswordMatch) {
            return res.status(401).json({ success: false, mensaje: 'Usuario o contraseña incorrectos.' });
        }

        let permisosObj = {};
        try {
            permisosObj = JSON.parse(user.permisos || '{}');
        } catch (error) {
            // Keep authentication available if legacy permission data is malformed.
            console.warn('[AUTH] Permisos inválidos; se aplicará un objeto vacío:', error.message);
        }

        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { id: user.id, nombre: user.nombre, rol: user.rol, expires: Date.now() + 86400000 });
        res.setHeader('Set-Cookie', `hidep_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
        res.json({
            success: true,
            id: user.id,
            nombre: user.nombre,
            rol: user.rol,
            permisos: permisosObj
        });
    });
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

app.post('/api/recuperar-password', (req, res) => {
    res.status(403).json({ success: false, mensaje: 'Solicite al administrador el restablecimiento de su contraseña.' });
});

app.use('/api', (req, res, next) => {
    const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('hidep_session='))?.slice(14);
    const user = sessions.get(token);
    // Electron usa exclusivamente loopback para ejecutar el respaldo del botón seguro.
    if (req.path === '/backup-ejecutar' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return next();
    if (!user || user.expires < Date.now()) return res.status(401).json({ mensaje: 'Inicie sesión nuevamente.' });
    req.user = user;
    const admin = user.rol === 'Administrador';
    const mechanic = normalizeIdentity(user.rol) === 'mecanico';
    if ((req.path.startsWith('/usuarios') && req.method !== 'GET') || req.path === '/reset-sistema' || req.path === '/restore') {
        if (!admin) return res.status(403).json({ mensaje: 'Solo el administrador puede realizar esta acción.' });
    }
    if (req.method === 'POST' && ['/logout', '/backup-ejecutar'].includes(req.path)) return next();
    if (mechanic) {
        const match = req.path.match(/^\/ordenes\/(\d+)(?:\/|$)/);
        if (match) return db.get('SELECT mecanico_id FROM ordenes WHERE id = ?', [match[1]], (err, order) => {
            if (err) return res.status(500).json({ mensaje: 'No se pudo validar la orden.' });
            if (!order || order.mecanico_id !== user.id) return res.status(403).json({ mensaje: 'Orden no asignada a su usuario.' });
            if (!['GET'].includes(req.method) && !/\/(repuestos|solicitudes-repuestos|reportar|fotos|estado)(?:\/|$)/.test(req.path)) return res.sendStatus(403);
            if (req.path.endsWith('/estado') && !['En proceso', 'Listo para entrega'].includes(req.body.estado)) return res.sendStatus(403);
            next();
        });
        if (!(req.method === 'GET' && ['/ordenes', '/inventario', '/usuarios', '/session', '/config'].includes(req.path))) return res.status(403).json({ mensaje: 'Acceso no permitido.' });
    }
    next();
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
app.get('/api/clientes', (req, res) => {
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
            db.get(`SELECT id FROM clientes WHERE cedula = ?`, [cedula], (err, row) => {
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
            db.get(`SELECT id FROM motos WHERE placa = ?`, [(placa || '').toUpperCase()], (err, row) => {
                res.json({ success: true, id: row ? row.id : this.lastID, mensaje: 'Moto registrada correctamente' });
            });
        });
});

app.get('/api/motos/:id/historial', (req, res) => {
    db.all(`SELECT * FROM ordenes WHERE moto_id = ? ORDER BY id DESC`, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Inventario
app.get('/api/inventario', (req, res) => {
    db.all(`SELECT * FROM inventario ORDER BY id DESC`, [], (err, rows) => {
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
    const query = `SELECT ordenes.*, motos.placa as moto_placa, motos.marca as moto_marca, clientes.nombre as cliente_nombre, usuarios.nombre as mecanico_nombre
                   FROM ordenes JOIN motos ON ordenes.moto_id = motos.id JOIN clientes ON motos.cliente_id = clientes.id JOIN usuarios ON ordenes.mecanico_id = usuarios.id
                   WHERE motos.placa LIKE ? OR ordenes.id LIKE ? OR clientes.nombre LIKE ? ORDER BY ordenes.id DESC`;
    db.all(query, [`%${buscar}%`, `%${buscar}%`, `%${buscar}%`], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(req.user && normalizeIdentity(req.user.rol) === 'mecanico' ? rows.filter(row => row.mecanico_id === req.user.id) : rows);
    });
});

app.post('/api/ordenes', (req, res) => {
    const { moto_id, mecanico_id, tipo_mantenimiento, motivo_ingreso, costo_mano_obra } = req.body;
    db.run(`INSERT INTO ordenes (moto_id, mecanico_id, tipo_mantenimiento, motivo_ingreso, costo_mano_obra, trabajo_realizado, estado) VALUES (?, ?, ?, ?, ?, 'En proceso', 'En proceso')`,
        [moto_id, mecanico_id, tipo_mantenimiento, motivo_ingreso, costo_mano_obra], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const nuevaOrdenId = this.lastID;
            broadcastSyncEvent('orden_actualizada', { ordenId: nuevaOrdenId, accion: 'creada' });
            res.json({ success: true, orden_id: nuevaOrdenId });
        });
});

app.put('/api/ordenes/:id/estado', (req, res) => {
    const { estado } = req.body;
    const estadosPermitidos = ['En proceso', 'Listo para entrega', 'Facturada', 'Cancelada'];
    if (!estadosPermitidos.includes(estado)) {
        return res.status(400).json({ success: false, mensaje: 'Estado de orden no válido.' });
    }
    db.run(`UPDATE ordenes SET estado = ? WHERE id = ?`, [estado, req.params.id], function(err) {
        if (err) return res.status(500).json({ success: false, mensaje: err.message });
        broadcastSyncEvent('orden_actualizada', { ordenId: req.params.id, estado, accion: 'cambio_estado' });
        res.json({ success: true, mensaje: `Estado actualizado a "${estado}".` });
    });
});

// Fotos de evidencia de la orden
app.get('/api/ordenes/:id/fotos', (req, res) => {
    db.all(`SELECT * FROM orden_fotos WHERE orden_id = ? ORDER BY id DESC`, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.post('/api/ordenes/:id/fotos', (req, res) => {
    const ordenId = req.params.id;
    const { imagen_base64, descripcion } = req.body;
    if (!imagen_base64) {
        return res.status(400).json({ success: false, mensaje: 'Se requiere una imagen válida.' });
    }

    try {
        const matches = String(imagen_base64).match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        const dataBuffer = matches ? Buffer.from(matches[2], 'base64') : Buffer.from(imagen_base64, 'base64');
        const fileName = `foto_ord_${ordenId}_${Date.now()}.jpg`;
        const filePath = path.join(uploadsDir, fileName);
        fs.writeFileSync(filePath, dataBuffer);

        const relativeUrl = `/uploads/ordenes/${fileName}`;
        db.run(`INSERT INTO orden_fotos (orden_id, url, descripcion) VALUES (?, ?, ?)`,
            [ordenId, relativeUrl, descripcion || 'Evidencia de trabajo'], function(err) {
                if (err) return res.status(500).json({ success: false, mensaje: err.message });
                const fotoObj = { id: this.lastID, orden_id: ordenId, url: relativeUrl, descripcion: descripcion || 'Evidencia de trabajo' };
                broadcastSyncEvent('foto_agregada', fotoObj);
                res.json({ success: true, foto: fotoObj });
            });
    } catch (e) {
        console.error('[FOTOS] Error al guardar foto:', e);
        res.status(500).json({ success: false, mensaje: 'Error al procesar archivo de imagen: ' + e.message });
    }
});

app.delete('/api/ordenes/:id/fotos/:fotoId', (req, res) => {
    db.get(`SELECT url FROM orden_fotos WHERE id = ? AND orden_id = ?`, [req.params.fotoId, req.params.id], (err, row) => {
        if (row && row.url) {
            const diskPath = path.join(uploadsDir, path.basename(row.url));
            if (fs.existsSync(diskPath)) {
                try { fs.unlinkSync(diskPath); } catch (e) {}
            }
        }
        db.run(`DELETE FROM orden_fotos WHERE id = ? AND orden_id = ?`, [req.params.fotoId, req.params.id], () => {
            broadcastSyncEvent('foto_eliminada', { ordenId: req.params.id, fotoId: req.params.fotoId });
            res.json({ success: true });
        });
    });
});

// Alertas de Stock Insuficiente
app.get('/api/alertas-stock', (req, res) => {
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

app.put('/api/alertas-stock/leer-todas', (req, res) => {
    db.run(`UPDATE alertas_stock SET leida = 1`, [], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        broadcastSyncEvent('alerta_stock_leida_todas', {});
        res.json({ success: true });
    });
});

app.get('/api/ordenes/:id/detalles', (req, res) => {
    const query = `SELECT detalle_orden_repuestos.*, inventario.nombre as repuesto_nombre, inventario.codigo as repuesto_codigo FROM detalle_orden_repuestos JOIN inventario ON detalle_orden_repuestos.repuesto_id = inventario.id WHERE detalle_orden_repuestos.orden_id = ?`;
    db.all(query, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Repuestos reportados por el mecánico: no descuentan inventario ni fijan precio.
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
        const order = await get("SELECT * FROM ordenes WHERE id = ? AND estado = 'En proceso'", [ordenId]);
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
        if (transaction) await run('ROLLBACK').catch(() => {});
        console.error('[REPUESTOS]', error.message);
        res.status(500).json({ mensaje: 'No se pudo confirmar la salida. Intente nuevamente.' });
    } finally { connection.close(); }
});
// Compatibilidad para clientes antiguos: las nuevas salidas nunca quedan pendientes.
app.get('/api/solicitudes-repuestos', (req, res) => res.json([]));
app.post('/api/solicitudes-repuestos/:id/aprobar', (req, res) => res.status(410).json({ mensaje: 'El flujo de aprobación fue retirado. Registre el repuesto directamente en la orden.' }));

app.put('/api/ordenes/:id/reportar', (req, res) => {
    db.run(`UPDATE ordenes SET trabajo_realizado = ? WHERE id = ?`, [req.body.trabajo_realizado, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        broadcastSyncEvent('orden_actualizada', { ordenId: req.params.id, accion: 'avance_reportado' });
        res.json({ success: true });
    });
});

app.put('/api/ordenes/:id/mano-obra', (req, res) => {
    const costoManoObra = Number(req.body.costo_mano_obra);
    if (!Number.isFinite(costoManoObra) || costoManoObra < 0) {
        return res.status(400).json({ success: false, mensaje: 'El valor de mano de obra debe ser un número igual o mayor que cero.' });
    }

    db.run(
        `UPDATE ordenes SET costo_mano_obra = ? WHERE id = ? AND estado = 'En proceso'`,
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
    const { costo_mano_obra, trabajo_realizado } = req.body;
    db.run(`UPDATE ordenes SET estado = 'Facturada', costo_mano_obra = ?, trabajo_realizado = ? WHERE id = ?`,
        [costo_mano_obra, trabajo_realizado, req.params.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            broadcastSyncEvent('orden_actualizada', { ordenId: req.params.id, accion: 'facturada' });
            res.json({ success: true });
        });
});

// Citas
app.get('/api/citas', (req, res) => {
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

app.post('/api/citas/:id/convertir', (req, res) => {
    db.get(`SELECT * FROM citas WHERE id = ?`, [req.params.id], (err, cita) => {
        if (!cita) return res.status(404).json({ mensaje: 'Cita no encontrada' });
        db.get(`SELECT motos.id as moto_id, usuarios.id as mecanico_id FROM motos JOIN clientes ON motos.cliente_id = clientes.id, usuarios WHERE motos.placa = ? LIMIT 1`, [cita.moto_placa], (err, match) => {
            let motoId = match ? match.moto_id : null;
            if (!motoId) {
                db.run(`INSERT INTO clientes (cedula, nombre) VALUES ('000000000', ?)`, [cita.cliente_nombre], function(err) {
                    let cId = this.lastID;
                    db.run(`INSERT INTO motos (cliente_id, placa, marca, cilindraje, kilometraje) VALUES (?, ?, 'Genérica', 150, 0)`, [cId, cita.moto_placa], function(err) {
                        let mId = this.lastID;
                        db.run(`INSERT INTO ordenes (moto_id, mecanico_id, tipo_mantenimiento, motivo_ingreso, costo_mano_obra, trabajo_realizado, estado) VALUES (?, 1, 'Preventivo', ?, 50000, 'Ingreso desde cita', 'En proceso')`,
                            [mId, req.body.motivo_ingreso || cita.motivo], function(err) {
                                let ordId = this.lastID;
                                db.run(`UPDATE citas SET estado = 'Atendida' WHERE id = ?`, [req.params.id], () => {
                                    res.json({ success: true, orden_id: ordId });
                                });
                            });
                    });
                });
            } else {
                db.run(`INSERT INTO ordenes (moto_id, mecanico_id, tipo_mantenimiento, motivo_ingreso, costo_mano_obra, trabajo_realizado, estado) VALUES (?, 1, 'Preventivo', ?, 50000, 'Ingreso desde cita', 'En proceso')`,
                    [motoId, req.body.motivo_ingreso || cita.motivo], function(err) {
                        let ordId = this.lastID;
                        db.run(`UPDATE citas SET estado = 'Atendida' WHERE id = ?`, [req.params.id], () => {
                            res.json({ success: true, orden_id: ordId });
                        });
                    });
            }
        });
    });
});

// Reportes
app.get('/api/reportes/contabilidad', (req, res) => {
    const q1 = `SELECT SUM(costo_mano_obra) as total_mano FROM ordenes WHERE estado = 'Facturada'`;
    const q2 = `SELECT SUM(detalle_orden_repuestos.cantidad * detalle_orden_repuestos.precio_unitario) as total_rep FROM detalle_orden_repuestos JOIN ordenes ON detalle_orden_repuestos.orden_id = ordenes.id WHERE ordenes.estado = 'Facturada'`;
    const q3 = `SELECT SUM(costo_mano_obra) as por_producir FROM ordenes WHERE estado = 'En proceso'`;
    db.get(q1, [], (err, r1) => {
        db.get(q2, [], (err, r2) => {
            db.get(q3, [], (err, r3) => {
                const mano = r1?.total_mano || 0;
                const rep = r2?.total_rep || 0;
                res.json({ total_mano_obra: mano, total_repuestos_venta: rep, ganancia_repuestos: rep * 0.3, por_producir: r3?.por_producir || 0, ganancia_total: mano + rep });
            });
        });
    });
});

app.get('/api/reportes/mecanicos', (req, res) => {
    db.all(`SELECT usuarios.nombre, COUNT(ordenes.id) as total_ordenes, SUM(ordenes.costo_mano_obra) as total_facturado_mano FROM usuarios LEFT JOIN ordenes ON usuarios.id = ordenes.mecanico_id AND ordenes.estado = 'Facturada' WHERE usuarios.rol = 'Mecanico' GROUP BY usuarios.id`, [], (err, rows) => {
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
        query += ` AND o.estado = ?`;
        params.push(estado);
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
    db.get(`SELECT * FROM configuracion WHERE id = 1`, [], (err, row) => {
        res.json(row || {});
    });
});

app.post('/api/config', (req, res) => {
    const { nombre_taller, nit_taller, telefono_taller, email_taller, direccion_taller, tema, impresora_nombre, backup_interval_min, eslogan_taller } = req.body;
    const temasPermitidos = ['dark', 'dark-graphite', 'dark-emerald', 'light-amber', 'light-blue', 'light-emerald'];
    if (tema && !temasPermitidos.includes(tema)) return res.status(400).json({ success: false, mensaje: 'Tema visual no válido.' });
    
    db.run(`UPDATE configuracion SET 
            nombre_taller=?, nit_taller=?, telefono_taller=?, email_taller=?, direccion_taller=?, tema=?, impresora_nombre=?,
            backup_interval_min=COALESCE(?, backup_interval_min),
            eslogan_taller=COALESCE(?, eslogan_taller)
            WHERE id = 1`,
        [
            nombre_taller, nit_taller, telefono_taller, email_taller, direccion_taller, tema, impresora_nombre,
            backup_interval_min !== undefined ? Number(backup_interval_min) : null,
            eslogan_taller || null
        ], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            if (backup_interval_min !== undefined) {
                configurarAutoBackup(backup_interval_min);
            }
            broadcastSyncEvent('config_actualizada', { nombre_taller, eslogan_taller });
            res.json({ success: true });
        });
});

// Copias de Seguridad (Backup)
app.get('/api/backup', (req, res) => {
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

app.post('/api/backup-ejecutar', (req, res) => {
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
    const sourcePath = req.body && req.body.sourcePath;
    if (!sourcePath || path.extname(sourcePath).toLowerCase() !== '.db' || !fs.existsSync(sourcePath)) {
        return res.status(400).json({ success: false, mensaje: 'Seleccione un archivo .db existente.' });
    }
    const candidate = new sqlite3.Database(sourcePath, sqlite3.OPEN_READONLY, (openError) => {
        if (openError) return res.status(400).json({ success: false, mensaje: 'El archivo no es una base SQLite válida.' });
        candidate.get('PRAGMA integrity_check', (integrityError, integrity) => {
            if (integrityError || !integrity || integrity.integrity_check !== 'ok') {
                return candidate.close(() => res.status(400).json({ success: false, mensaje: 'La integridad de la copia no es válida.' }));
            }
            candidate.all("SELECT name FROM sqlite_master WHERE type='table'", async (tablesError, tables) => {
                const names = new Set((tables || []).map((table) => table.name));
                const required = ['clientes', 'motos', 'usuarios', 'inventario', 'detalle_orden_repuestos', 'citas', 'configuracion'];
                if (tablesError || !required.every((name) => names.has(name)) || !(names.has('ordenes') || names.has('ordenes_servicio'))) {
                    return candidate.close(() => res.status(400).json({ success: false, mensaje: 'La copia no contiene las tablas de HIDEP-SOFT.' }));
                }
                await new Promise((resolve) => candidate.close(resolve));
                const stagedPath = `${dbFile}.restore-${Date.now()}`;
                const previousPath = `${dbFile}.pre-restore-${Date.now()}`;
                db.close((closeError) => {
                    if (closeError) return res.status(500).json({ success: false, mensaje: 'No se pudo detener SQLite para restaurar.' });
                    try {
                        fs.copyFileSync(sourcePath, stagedPath);
                        fs.copyFileSync(dbFile, previousPath);
                        fs.renameSync(stagedPath, dbFile);
                        db = new sqlite3.Database(dbFile, (reopenError) => {
                            if (reopenError) {
                                try { fs.copyFileSync(previousPath, dbFile); } catch (rollbackError) { console.error('[RESTORE] Falló rollback:', rollbackError); }
                                db = new sqlite3.Database(dbFile);
                                return res.status(500).json({ success: false, mensaje: 'Falló la apertura tras restaurar; se recuperó la base anterior.' });
                            }
                            db.run('PRAGMA foreign_keys = ON');
                            inicializarTablas();
                            res.json({ success: true, mensaje: 'Restauración completada. Reinicie la aplicación para cargar todos los cambios.' });
                        });
                    } catch (restoreError) {
                        try { if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath); } catch (cleanupError) { console.error(cleanupError); }
                        db = new sqlite3.Database(dbFile);
                        res.status(500).json({ success: false, mensaje: `No se pudo restaurar: ${restoreError.message}` });
                    }
                });
            });
        });
    });
});

// Gestión de usuarios
app.get('/api/usuarios', (req, res) => {
    db.all(`SELECT id, nombre, username, rol, permisos, cedula, pregunta_seguridad FROM usuarios`, [], (err, rows) => {
        if (err) return res.status(500).json({ mensaje: 'No se pudieron consultar los usuarios.' });
        res.json(rows || []);
    });
});

app.post('/api/usuarios', (req, res) => {
    const { nombre, username, password, rol, permisos, cedula, pregunta_seguridad, respuesta_seguridad } = req.body;
    if (!nombre || !username || !password || String(password).length < 10) return res.status(400).json({ mensaje: 'Complete los datos y use una contraseña de al menos 10 caracteres.' });
    if (cedula && (!pregunta_seguridad || !respuesta_seguridad)) return res.status(400).json({ mensaje: 'Configure pregunta y respuesta de seguridad juntas.' });
    hashPassword(password).then((passwordHash) => {
      const answerHash = respuesta_seguridad ? hashPassword(String(respuesta_seguridad).trim().toLocaleLowerCase('es')) : Promise.resolve(null);
      answerHash.then((recoveryHash) => db.run(`INSERT INTO usuarios (nombre, username, password, rol, permisos, cedula, pregunta_seguridad, respuesta_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [nombre, username, passwordHash, rol, JSON.stringify(permisos), cedula || null, pregunta_seguridad || null, recoveryHash], (err) => {
            if (err) return res.status(500).json({ mensaje: 'Error al crear usuario o usuario duplicado' });
            res.json({ success: true });
        }));
    }).catch(() => res.status(500).json({ mensaje: 'No se pudo proteger la contraseña.' }));
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
            db.get(`SELECT * FROM usuarios WHERE username = 'admin'`, [], (err, row) => resolve(row));
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
            res.json({ success: true, mensaje: 'Contraseña actualizada exitosamente.' });
        });
    } catch (e) {
        res.status(500).json({ success: false, mensaje: e.message });
    }
});

app.delete('/api/usuarios/:id', (req, res) => {
    const { password } = req.body;
    db.get(`SELECT * FROM usuarios WHERE username = 'admin'`, [], async (err, admin) => {
        const isMatch = admin && await verifyPassword(password, admin.password);
             
        if (!isMatch) return res.status(401).json({ mensaje: 'Contraseña de administrador incorrecta.' });
        db.run(`DELETE FROM usuarios WHERE id = ?`, [req.params.id], () => {
            res.json({ success: true });
        });
    });
});

// Reset del sistema
app.post('/api/reset-sistema', (req, res) => {
    const { password } = req.body;
    db.get(`SELECT * FROM usuarios WHERE username = 'admin'`, [], async (err, admin) => {
        const isMatch = admin && await verifyPassword(password, admin.password);

        if (!isMatch) return res.status(401).json({ mensaje: 'Contraseña de administrador incorrecta.' });
        db.serialize(() => {
            db.run(`DELETE FROM solicitudes_repuestos_orden`);
            db.run(`DELETE FROM detalle_orden_repuestos`);
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
app.get('/api/impresoras', (req, res) => {
    res.json(['Impresora POS Termica 58mm', 'Impresora Facturación PDF', 'Microsoft Print to PDF']);
});

// ================= INICIALIZACIÓN DEL SERVIDOR =================
let serverInstance = null;
function startServer(port = PORT) {
    return new Promise((resolve, reject) => {
        if (serverInstance) return resolve(serverInstance);
        // Escucha en 0.0.0.0 para permitir acceso desde PC local y tablets/celulares en la red LAN
        serverInstance = app.listen(port, '0.0.0.0', () => {
            resolve(serverInstance);
        });
        serverInstance.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.warn(`[SERVER] Puerto ${port} en uso, asumiendo servidor activo.`);
                resolve(null);
            } else {
                console.error('[SERVER] Error en servidor Express:', err);
                reject(err);
            }
        });
    });
}

function closeDatabase() {
    if (backupIntervalTimer) { clearInterval(backupIntervalTimer); backupIntervalTimer = null; }
    return new Promise((resolve, reject) => {
        if (!db) return resolve();
        db.close((error) => error ? reject(error) : resolve());
    });
}

// Iniciar automáticamente si se ejecuta directo con node
if (require.main === module || !process.env.APP_IS_ELECTRON) {
    startServer();
}

module.exports = { app, startServer, closeDatabase, resolveDbPath };
