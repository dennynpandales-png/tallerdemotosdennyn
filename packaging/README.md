# Empaquetado apartado del desarrollo

`npm start` abre HIDEP-SOFT-SG en Electron. `npm run start:web` inicia solo Express, para probar el sistema en un navegador. Ambos usan `PORT` si se define, con el puerto 3000 como valor predeterminado. Para probar sin usar la base ni las evidencias del taller, apunta `WORKSHOP_DATA_DIR` a un directorio temporal vacío.

`npm run check` valida la sintaxis y ejecuta las pruebas de integración con SQLite temporal. El portal necesita un dominio HTTPS y el proxy descrito en [SEGUIMIENTO.md](../SEGUIMIENTO.md) para recibir consultas de Internet.

`npm run build` usa `electron-builder.json` para crear la aplicación Windows en `dist/win-unpacked`. La distribución excluye las bases operativas y las fotos guardadas. Las instalaciones existentes siguen leyendo los datos de su directorio de usuario.

`setup.iss` se conserva para una futura publicación. Cuando se reactive, compílalo con Inno Setup después de generar `dist/win-unpacked`. El instalador se guardará en `dist_inno`.
