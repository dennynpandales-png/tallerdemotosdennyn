const fs = require('fs');
const path = require('path');

const NOMBRE_TALLER = 'HIDEP-SOFT-SG - Taller de Motos';

function directorioDatosTaller(appData) {
    const current = path.join(appData, 'HIDEP-SOFT-SG');
    const previous = path.join(appData, 'HIDEP-SOFT');
    if (fs.existsSync(path.join(current, 'database.db'))) return current;
    return fs.existsSync(path.join(previous, 'database.db')) ? previous : current;
}

module.exports = { NOMBRE_TALLER, directorioDatosTaller };
