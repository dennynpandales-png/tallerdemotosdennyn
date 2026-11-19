// El servidor mantiene la sesión en la cookie HttpOnly. Elimina datos de clientes anteriores.
for (const type of ['localStorage', 'sessionStorage']) {
    try {
        const storage = window[type];
        for (const key of ['taller_nombre', 'taller_usuario', 'taller_rol', 'taller_permisos', 'hidep_operario_id']) {
            storage.removeItem(key);
        }
    } catch {
        // Un almacenamiento bloqueado no impide limpiar el siguiente.
        continue;
    }
}
