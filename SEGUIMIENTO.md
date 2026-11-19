# Portal de seguimiento de HIDEP-SOFT-SG - Taller de Motos

En **Bitácora y evidencias**, Administración y Recepción pueden generar, reemplazar o revocar el enlace de una orden. El botón **Compartir por WhatsApp** abre un mensaje para que el personal elija al destinatario. El cliente abre el enlace e ingresa el número de orden o la placa. También puede introducir el código manualmente desde la página del portal.

Cada código autoriza una sola orden y deja de funcionar al reemplazarlo o revocarlo. Las fotos nuevas que un mecánico reporta en su orden aparecen en el portal. Las fotos anteriores a la actualización y las adjuntadas por otros roles permanecen en la galería interna. Las entradas históricas sin fecha propia se muestran sin una hora estimada.

Cuando el mecánico marca la orden como **Terminada**, Administración y Recepción reciben un aviso. Administración confirma la mano de obra, prepara la factura y registra el cobro. Recepción puede revisar la orden y compartir un resumen de trabajos y evidencias sin importes. El botón **WhatsApp** de Facturación, reservado a Administración, incluye el total. Si está configurado el portal público, ambos resúmenes pueden incluir un enlace a las evidencias. El personal confirma el envío en WhatsApp. Reemplazar o revocar el enlace de la orden invalida los enlaces de WhatsApp que ya se hayan generado para ella.

La vista previa de cámara funciona en el equipo donde se ejecuta HIDEP-SOFT-SG o al acceder por HTTPS. En tablets o celulares conectados por HTTP a la red local, el navegador puede bloquear la vista previa. El formulario ofrece el selector de cámara del dispositivo y la opción de adjuntar un archivo.

## Acceso desde Internet

Antes de iniciar HIDEP-SOFT-SG, configura estas variables en el proceso que ejecuta la aplicación, sustituyendo el dominio del ejemplo por el del taller.

```powershell
$env:TRACKING_PORT = '3001'
$env:TRACKING_PUBLIC_ORIGIN = 'https://seguimiento.tu-dominio.com'
```

Configura un proxy HTTPS para que el dominio público reenvíe la ruta `/seguimiento/` y sus subrutas, sin reescribirlas, a `http://127.0.0.1:3001`. Conserva el encabezado `Authorization`. El puerto de seguimiento escucha únicamente en el equipo del taller y sirve solo el portal. Mantén el puerto de la aplicación administrativa fuera del proxy público.

La aplicación necesita estar encendida para responder a los clientes. El portal lee la misma base SQLite y el mismo directorio de evidencias que el panel. Al trasladar la instalación a otro equipo, conserva la base de datos y el directorio `uploads/ordenes`.
