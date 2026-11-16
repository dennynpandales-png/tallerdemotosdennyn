const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const http = require('http');
const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 3000;
const BACKEND_ORIGIN = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

// Configurar variables de entorno antes de cargar módulos
process.env.APP_IS_ELECTRON = 'true';
process.env.APP_USER_DATA_PATH = app.getPath('userData');
process.env.APP_IS_PACKAGED = app.isPackaged ? 'true' : 'false';

// Bloqueo de instancia única para evitar colisiones en el puerto 3000 y bloqueo múltiple de SQLite
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    console.warn('[MAIN] Ya existe una instancia en ejecución. Cerrando proceso duplicado.');
    app.quit();
}

// Iniciar el servidor backend Express
let serverModule;
try {
    if (gotTheLock) serverModule = require('./server.js');
    if (serverModule && typeof serverModule.startServer === 'function') {
        serverModule.startServer().catch(error => {
            console.error('[MAIN] No se pudo iniciar el servidor:', error.message);
            app.quit();
        });
    }
} catch (e) {
    console.error('[MAIN] Error crítico al iniciar server.js:', e);
}

// Función auxiliar para verificar disponibilidad del servidor Express antes de abrir la UI
function waitForServer(url, timeoutMs = 12000) {
    const startTime = Date.now();
    return new Promise((resolve) => {
        const check = () => {
            const req = http.get(url, (res) => {
                if (res.statusCode >= 200 && res.statusCode < 400) {
                    resolve(true);
                } else {
                    retry();
                }
            });
            req.on('error', () => retry());
            req.setTimeout(1000, () => {
                req.destroy();
                retry();
            });
        };

        const retry = () => {
            if (Date.now() - startTime > timeoutMs) {
                console.warn('[MAIN] Tiempo de espera agotado para el servidor backend.');
                resolve(false);
            } else {
                setTimeout(check, 150);
            }
        };

        check();
    });
}

let mainWindow;
let closeFlowInProgress = false;
let allowWindowClose = false;

function requestBackup() {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: BACKEND_HOST,
            port: BACKEND_PORT,
            path: '/api/backup-ejecutar',
            method: 'POST'
        }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => {
                let result;
                try {
                    result = JSON.parse(body);
                } catch (error) {
                    reject(new Error('El servidor devolvió una respuesta inválida al crear el respaldo.'));
                    return;
                }

                if (!result || typeof result !== 'object' ||
                    response.statusCode < 200 || response.statusCode >= 300 || !result.success) {
                    reject(new Error((result && result.mensaje) || 'No se pudo crear el respaldo.'));
                    return;
                }
                resolve(result);
            });
        });

        request.on('error', reject);
        request.setTimeout(15000, () => {
            request.destroy(new Error('Se agotó el tiempo de espera al crear el respaldo.'));
        });
        request.end();
    });
}

async function requestSafeExit(mode = 'close') {
    if (!mainWindow || mainWindow.isDestroyed() || closeFlowInProgress) return { cancelled: true };
    closeFlowInProgress = true;
    try {
        const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'question',
            buttons: ['Hacer copia y salir', 'Salir sin copia', 'Cancelar'],
            defaultId: 0, cancelId: 2,
            title: mode === 'logout' ? 'Cerrar sesi\u00f3n' : 'Cerrar HIDEP-SOFT',
            message: '\u00bfDesea realizar la copia de seguridad antes de salir?'
        });
        if (response === 2) return { cancelled: true };
        let backupOk = false;
        if (response === 0) {
            await requestBackup();
            backupOk = true;
        }
        if (mode === 'close') {
            allowWindowClose = true;
            mainWindow.close();
        }
        return { success: true, backupOk };
    } catch (error) {
        await dialog.showMessageBox(mainWindow, {
            type: 'error', title: 'No se pudo completar la salida',
            message: 'El respaldo no se pudo completar. La aplicaci\u00f3n permanece abierta.',
            detail: error.message
        });
        return { success: false, mensaje: error.message };
    } finally { closeFlowInProgress = false; }
}

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1360,
        height: 768,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'public', 'icon.ico')
    });

    // Poner la ventana maximizada como programa de escritorio POS
    mainWindow.maximize();

    mainWindow.on('close', (event) => {
        if (allowWindowClose) return;
        event.preventDefault();
        void requestSafeExit();
    });

    // Esperar sincronizadamente a que el servidor Express esté activo
    const isReady = await waitForServer(`${BACKEND_ORIGIN}/api/health`, 12000);

    if (isReady) {
        mainWindow.loadURL(BACKEND_ORIGIN);
    } else {
        console.warn('[MAIN] Servidor no respondió a tiempo. Cargando archivo local...');
        mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
    }

    // Mecanismo de recuperación ante fallos de carga transitorios
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        console.warn(`[MAIN] Reintento de conexión (Código: ${errorCode}, ${errorDescription})...`);
        setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.loadURL(BACKEND_ORIGIN);
            }
        }, 1200);
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Si el usuario intenta abrir una segunda ventana, enfocar la existente
app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

app.whenReady().then(() => {
    if (!gotTheLock) return;
    createWindow().catch(error => console.error('[MAIN]', error.message));

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Selector de directorios para copias de seguridad (utilizado en el panel de configuración)
ipcMain.handle('dialog:openDirectory', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openBackup', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Seleccionar copia de seguridad',
        properties: ['openFile'],
        filters: [{ name: 'Base de datos SQLite', extensions: ['db'] }]
    });
    return result.canceled ? null : result.filePaths[0];
});

// Control de ventana y cierre seguro con copia de seguridad
ipcMain.handle('app:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.minimize();
    }
    return true;
});

ipcMain.handle('app:closeWithBackup', () => requestSafeExit('close'));
ipcMain.handle('app:prepareLogout', () => requestSafeExit('logout'));
