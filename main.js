const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { directorioDatosTaller } = require('./marca');
const BACKEND_HOST = '127.0.0.1';
let backendPort;
const invoicePreviews = new Set();

// Configurar variables de entorno antes de cargar módulos
if (process.env.WORKSHOP_DATA_DIR || app.isPackaged) {
    const directorio = process.env.WORKSHOP_DATA_DIR
        ? path.resolve(process.env.WORKSHOP_DATA_DIR, 'electron-profile')
        : directorioDatosTaller(app.getPath('appData'));
    fs.mkdirSync(directorio, { recursive: true });
    app.setPath('userData', directorio);
}
process.env.APP_USER_DATA_PATH = app.getPath('userData');
process.env.APP_IS_PACKAGED = app.isPackaged ? 'true' : 'false';

// Bloqueo de instancia única para evitar colisiones en el puerto 3000 y bloqueo múltiple de SQLite
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    console.warn('[MAIN] Ya existe una instancia en ejecución. Cerrando proceso duplicado.');
    app.quit();
}

let serverModule;

let mainWindow;
let closeFlowInProgress = false;
let allowWindowClose = false;

function requestBackup() {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: BACKEND_HOST,
            port: backendPort,
            path: '/api/backup-ejecutar',
            method: 'POST',
            headers: { 'X-Desktop-Backup': serverModule.desktopBackupKey }
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
                } catch {
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
            title: mode === 'logout' ? 'Cerrar sesi\u00f3n' : 'Cerrar HIDEP-SOFT-SG',
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

    await mainWindow.loadURL(`http://${BACKEND_HOST}:${backendPort}`);

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

app.whenReady().then(async () => {
    if (!gotTheLock) return;
    try {
        serverModule = require('./server.js');
        const listener = await serverModule.startServer();
        backendPort = listener.address().port;
        await createWindow();
        app.on('activate', () => {
            if (!BrowserWindow.getAllWindows().length) createWindow().catch(reportStartupError);
        });
    } catch (error) {
        reportStartupError(error);
    }
});

function reportStartupError(error) {
    console.error('[MAIN] No se pudo iniciar HIDEP-SOFT-SG:', error.message);
    dialog.showErrorBox('HIDEP-SOFT-SG', 'No se pudo iniciar la aplicación.\n' + error.message);
    allowWindowClose = true;
    app.exit(1);
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

function isDashboardFrame(event) {
    const origin = `http://${BACKEND_HOST}:${backendPort}`;
    return mainWindow && event.sender === mainWindow.webContents && event.senderFrame?.url === origin + '/dashboard.html';
}

ipcMain.handle('factura:impresoras', async event => {
    if (!isDashboardFrame(event)) return [];
    const printers = await event.sender.getPrintersAsync();
    return printers.map(({ name, displayName }) => ({ name, label: displayName || name }));
});

ipcMain.handle('factura:abrirVistaImpresion', async (event, markup, options = {}) => {
    const origin = `http://${BACKEND_HOST}:${backendPort}`;
    if (!isDashboardFrame(event) || typeof markup !== 'string' ||
        !markup.startsWith('<!doctype html>') || Buffer.byteLength(markup) > 2_000_000) {
        throw new Error('No se pudo preparar el documento de impresión.');
    }
    const { printerName, format, direct } = options || {};
    const printer = printerName && (await event.sender.getPrintersAsync()).find(item => item.name === printerName);
    if (direct && printerName && !printer) throw new Error('La impresora seleccionada no está disponible.');
    const printerLabel = [printerName, printer?.displayName].join(' ');
    const thermalWidth = format === '58' || format === '80' ? Number(format) :
        (format !== 'media-carta' && /t[eé]rm|thermal|(?:\bPOS\b)|(?:\bTM[- ]?[TMU]\d)|(?:\bTSP\d)|\b(?:58|80)\s*mm/i.test(printerLabel)
            ? (/58/.test(printerLabel) ? 58 : 80) : 0);
    const preview = new BrowserWindow({ show: false, webPreferences: {
        sandbox: true, nodeIntegration: false, contextIsolation: true
    } });
    preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    let directory;
    try {
        const load = style => {
            const html = markup.replace('<meta charset="utf-8">',
                `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${origin}; img-src ${origin}; base-uri ${origin}"><base href="${origin}/">`)
                .replace('</body>', `<style>${style}</style></body>`);
            return preview.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html).toString('base64'));
        };
        let pageSize = { width: 139700, height: 215900 };
        if (thermalWidth) {
            const style = `body.invoice-page { width: ${thermalWidth - 6}mm; padding: 0; }
                body .invoice-brand { padding: 2mm; gap: 2mm; color: black; background: white; }
                body .invoice-brand img { width: 10mm; height: 10mm; }
                body .invoice-content { padding: 2mm 0; font-size: 9px; }
                body .invoice-content h1 { font-size: 12px; }
                body .invoice-content td, body .invoice-content th { padding: 1mm 0.5mm; overflow-wrap: anywhere; }
                body .invoice-content table { table-layout: fixed; }`;
            await load(style);
            const pixels = await preview.webContents.executeJavaScript("document.getElementById('documento-venta').getBoundingClientRect().height");
            const height = Math.max(45, Math.ceil(pixels * 25.4 / 96) + 9);
            pageSize = { width: thermalWidth * 1000, height: height * 1000 };
            await load(style + `@page { size: ${thermalWidth}mm ${height}mm; margin: 3mm; }`);
        } else {
            await load('');
        }
        if (direct && printer) {
            await new Promise((resolve, reject) => preview.webContents.print({
                silent: true, deviceName: printer.name, printBackground: !thermalWidth, pageSize,
                margins: { marginType: 'none' }
            }, (success, reason) => success ? resolve() : reject(new Error(reason || 'No se pudo imprimir.'))));
            return 'impresa';
        }
        const pdf = await preview.webContents.printToPDF({ printBackground: !thermalWidth, preferCSSPageSize: true });
        directory = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'hidep-factura-'));
        const file = path.join(directory, 'Factura.pdf');
        await fs.promises.writeFile(file, pdf);
        const error = await shell.openPath(file);
        if (error) throw new Error('Windows no pudo abrir el lector de PDF.');
        invoicePreviews.add(directory);
        return 'pdf';
    } catch (error) {
        if (directory) await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
        throw error;
    } finally {
        preview.destroy();
    }
});

app.on('quit', () => {
    for (const directory of invoicePreviews) {
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch (error) {
            console.warn('[FACTURA] No se pudo retirar un archivo temporal:', error.code);
        }
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
