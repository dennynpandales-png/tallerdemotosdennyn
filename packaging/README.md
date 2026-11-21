# Empaquetado apartado del desarrollo

`npm start` abre HIDEP-SOFT-SG en Electron. `npm run start:web` inicia solo Express, para probar el sistema en un navegador. Ambos usan `PORT` si se define, con el puerto 3000 como valor predeterminado. Para probar sin usar la base ni las evidencias del taller, apunta `WORKSHOP_DATA_DIR` a un directorio temporal vacío.

`npm run check` valida la sintaxis y ejecuta las pruebas de integración con SQLite temporal. El portal necesita un dominio HTTPS y el proxy descrito en [SEGUIMIENTO.md](../SEGUIMIENTO.md) para recibir consultas de Internet.

`npm run build` usa `electron-builder.json` para crear la aplicación Windows en `dist/win-unpacked`. La distribución excluye las bases operativas y las fotos guardadas. Las instalaciones existentes siguen leyendo los datos de su directorio de usuario.

`setup.iss` se conserva para una futura publicación. Cuando se reactive, compílalo con Inno Setup después de generar `dist/win-unpacked`. El instalador se guardará en `dist_inno`.

## WhatsApp Business

Define estas variables en el entorno del proceso que inicia Express o Electron y reinicia la aplicación.

| Variable | Valor |
| --- | --- |
| `WHATSAPP_PHONE_ID` | Identificador del número emisor en Meta, diferente del número de teléfono. |
| `WHATSAPP_ACCESS_TOKEN` | Token con permiso de envío de WhatsApp Business. |
| `WHATSAPP_GRAPH_VERSION` | Versión habilitada de Graph API, con formato `vNN.N`. |
| `WHATSAPP_CITA_TEMPLATE` | Plantilla de utilidad aprobada con cinco parámetros posicionales de cuerpo, en orden de cliente, placa, fecha, hora de Colombia y motivo. |
| `WHATSAPP_LANGUAGE` | Idioma aprobado de la plantilla de citas. Valor predeterminado `es_CO`. |
| `WHATSAPP_RESET_TEMPLATE` | Plantilla de autenticación aprobada con botón para copiar el código. Configura la expiración de cinco minutos. |
| `WHATSAPP_RESET_LANGUAGE` | Idioma aprobado de la plantilla de autenticación. Valor predeterminado `es`. |
| `WHATSAPP_RECOVERY_TEMPLATE` | Plantilla de utilidad opcional para avisar al administrador de una solicitud de recuperación. Usa un parámetro posicional con el nombre de usuario. |
| `WHATSAPP_ADMIN_NUMBER` | Sobrescribe el destino guardado en Configuración. Usa indicativo internacional o un celular colombiano de diez dígitos. |

Al iniciar, el sistema reutiliza el **Teléfono del taller** si es válido y todavía no existe un **WhatsApp del administrador**. El destino queda guardado aparte. Para cambiarlo, configura `WHATSAPP_ADMIN_NUMBER` en el entorno del servidor. El reinicio requiere la aceptación de la API y el código recibido. La alerta de recuperación aparece en Usuarios y puede enviarse también por WhatsApp mediante la plantilla opcional. El botón **Recordatorio por WhatsApp** de Citas abre un mensaje listo para enviar con el teléfono registrado del cliente. Para preparar las plantillas, consulta la documentación de [envío de plantillas](https://www.postman.com/meta/whatsapp-business-platform/request/q2k7j58/send-sample-text-message) y [autenticación con código copiable](https://www.postman.com/meta/whatsapp-business-platform/request/6vkv46u/create-authentication-template-w-otp-copy-code-button).

## Impresión de facturas

En Electron, elige una impresora instalada desde **Configuración**. El modo automático usa media carta para una impresora convencional y detecta impresoras térmicas por su nombre. Si el nombre es genérico, selecciona manualmente 58 u 80 mm. Desde la vista previa puedes imprimir con la impresora guardada o abrir el PDF. Para imprimir media carta en papel carta desde un lector PDF, elige **Tamaño real** en el lector.
