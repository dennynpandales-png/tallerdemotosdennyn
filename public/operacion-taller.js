'use strict';

const workshop = id => document.getElementById(id);
const normalizeSearch = value => String(value ?? '').trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const matchesWorkshop = (query, ...fields) => fields.some(field => normalizeSearch(field).includes(query));
const moneyCOP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 2 });

async function workshopApi(path, method = 'GET', data) {
    const response = await fetch('/api' + path, {
        method,
        ...(data && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.mensaje || 'No se pudo completar la operación.');
    return result;
}

function actionButton(label, action, title = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-small';
    button.textContent = label;
    if (title) {
        button.title = title;
        button.setAttribute('aria-label', title);
    }
    button.addEventListener('click', action);
    return button;
}

function searchResults(inputId, resultsId, find, label, choose) {
    const input = workshop(inputId);
    const box = workshop(resultsId);
    function render() {
        const query = normalizeSearch(input.value);
        box.replaceChildren();
        box.hidden = !query;
        if (!query) return;
        for (const item of find(query).slice(0, 20)) {
            box.append(actionButton(label(item), () => {
                input.value = label(item);
                box.hidden = true;
                choose(item);
            }));
        }
        if (!box.children.length) box.textContent = 'Sin coincidencias';
    }
    input.addEventListener('input', render);
    input.addEventListener('focus', render);
    box.parentElement.addEventListener('focusout', event => {
        if (!box.parentElement.contains(event.relatedTarget)) box.hidden = true;
    });
    return () => { if (!box.hidden) render(); };
}

// Inventario y catálogo de mano de obra
const inventoryForm = workshop('formInventario');
let inventarioCache = [];
function updateInventoryForm() {
    const type = workshop('invTipo').value;
    const selected = Boolean(workshop('invId').value);
    workshop('invTipo').disabled = selected;
    workshop('invCodigo').readOnly = selected;
    workshop('invPrefijo').textContent = selected ? '' : type + '-';
    workshop('nuevoInventario').hidden = !selected;
    const selectedLabel = workshop('invSeleccion');
    selectedLabel.hidden = !selected;
    selectedLabel.textContent = selected ? `${workshop('invCodigo').value || '#' + workshop('invId').value} · ${workshop('invNombre').value}` : '';
    workshop('guardarInventario').textContent = selected
        ? (type === 'REP' ? 'Guardar entrada' : 'Actualizar servicio')
        : 'Registrar artículo';
    for (const field of inventoryForm.querySelectorAll('[data-part-field]')) field.hidden = type === 'MO';
    workshop('invStock').disabled = type === 'MO';
}

function resetInventoryForm() {
    inventoryForm.reset();
    workshop('invId').value = '';
    workshop('resultadosInventario').hidden = true;
    updateInventoryForm();
}

function selectInventoryItem(item) {
    const values = { invId: item.id, invTipo: item.tipo, invCodigo: item.codigo,
        invNombre: item.nombre, invStock: 0, invCosto: item.precio_costo,
        invVenta: item.precio_venta, invProveedor: item.proveedor, invOrigen: item.origen };
    for (const [id, value] of Object.entries(values)) workshop(id).value = value ?? '';
    updateInventoryForm();
    workshop(item.tipo === 'REP' ? 'invStock' : 'invVenta').focus();
}

const inventoryMatches = query => inventarioCache.filter(item => matchesWorkshop(query, item.codigo || item.id, item.nombre));
const refreshInventorySearch = searchResults('buscarInventario', 'resultadosInventario', inventoryMatches,
    item => `${item.codigo || '#' + item.id} · ${item.nombre}${item.tipo === 'REP' ? ' · Stock ' + item.stock : ''}`, selectInventoryItem);

const orderPartSearch = workshop('inputBuscadorRepuesto');
const orderPartId = workshop('usoRepuestoId');
const orderPartResults = workshop('sugerenciasRepuestos');

function renderOrderPartResults() {
    const query = normalizeSearch(orderPartSearch.value);
    orderPartResults.style.display = query ? 'block' : 'none';
    if (!query) return;
    const parts = inventarioCache.filter(item => item.tipo === 'REP' &&
        (matchesWorkshop(query, item.codigo, item.nombre) || String(item.id) === query));
    if (!parts.length) {
        orderPartResults.textContent = 'No se encontraron repuestos';
        return;
    }
    orderPartResults.replaceChildren(...parts.map(part => {
        const code = part.codigo || 'N/A';
        const option = actionButton(`${part.nombre} [Ref: ${code}] - Stock: ${part.stock} - ${moneyCOP.format(part.precio_venta)}`, () => {
            orderPartSearch.value = `${part.nombre} (${code}) [Stock: ${part.stock}]`;
            orderPartId.value = part.id;
            orderPartResults.style.display = 'none';
        });
        option.className = 'suggestion-item';
        return option;
    }));
}

orderPartSearch.addEventListener('input', () => {
    orderPartId.value = '';
    renderOrderPartResults();
});

function renderInventory() {
    const query = normalizeSearch(workshop('buscarInventario').value);
    const items = workshop('invId').value || !query ? inventarioCache : inventoryMatches(query);
    workshop('tablaInventarioBody').replaceChildren(...items.map(item => {
        const row = document.createElement('tr');
        for (const value of [item.codigo || '#' + item.id, item.nombre, item.tipo === 'REP' ? item.stock : 'Servicio', item.proveedor || '—',
            item.origen || '—', moneyCOP.format(item.precio_costo || 0), item.precio_venta > 0 ? moneyCOP.format(item.precio_venta) : 'Pendiente']) {
            row.insertCell().textContent = value;
        }
        row.insertCell().append(actionButton(item.tipo === 'REP' ? 'Adicionar stock' : 'Editar servicio', () => selectInventoryItem(item)));
        return row;
    }));
}

async function cargarInventarioTabla() {
    try {
        inventarioCache = await workshopApi('/inventario');
        if (!esAdministrador()) return;
        renderInventory();
        refreshInventorySearch();
        if (orderPartResults.style.display === 'block') renderOrderPartResults();
        const stock = inventarioCache.filter(item => item.tipo === 'REP');
        for (const [id, price] of [['invValCosto', 'precio_costo'], ['invValVenta', 'precio_venta']]) {
            workshop(id).textContent = moneyCOP.format(stock.reduce((sum, item) => sum + item.stock * item[price], 0));
        }
        workshop('serviciosManoObra').replaceChildren(new Option('Seleccionar servicio', ''),
            ...inventarioCache.filter(item => item.tipo === 'MO' && item.precio_venta > 0).map(item => new Option(`${item.codigo} · ${item.nombre}`, item.precio_venta)));
    } catch (error) {
        workshop('msgInventario').textContent = error.message;
    }
}

workshop('invTipo').addEventListener('change', updateInventoryForm);
workshop('buscarInventario').addEventListener('input', renderInventory);
workshop('nuevoInventario').addEventListener('click', () => { resetInventoryForm(); renderInventory(); });
workshop('serviciosManoObra').addEventListener('change', event => {
    if (event.target.value) workshop('facturaManoObra').value = event.target.value;
    calcularTotalModal();
});
inventoryForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
        const fields = { id: 'invId', tipo: 'invTipo', codigo: 'invCodigo', nombre: 'invNombre',
            stock: 'invStock', precio_costo: 'invCosto', precio_venta: 'invVenta', proveedor: 'invProveedor', origen: 'invOrigen' };
        const data = Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, workshop(id).value]));
        const { codigo } = await workshopApi('/inventario', 'POST', data);
        resetInventoryForm();
        workshop('msgInventario').textContent = `Guardado · ${codigo}`;
        await cargarInventarioTabla();
    } catch (error) {
        workshop('msgInventario').textContent = error.message;
    } finally { button.disabled = false; }
});

// Marcas y búsquedas de recepción
const colombianBrands = [
    'AIMA', 'AKT', 'Aprilia', 'Auteco', 'Bajaj', 'Benelli', 'Bera', 'Beta', 'BMW', 'Brixton', 'BSA',
    'CFMOTO', 'Daytona', 'Ducati', 'Fratelli', 'GasGas', 'Harley-Davidson', 'Hero', 'Honda',
    'Husqvarna', 'Indian', 'Italika', 'Jawa', 'Kawasaki', 'Keeway', 'Kove', 'KTM', 'Kymco',
    'Lambretta', 'Loncin', 'MBP', 'Moto Guzzi', 'Motomel', 'MV Agusta', 'NIU', 'Piaggio', 'QJMotor',
    'Royal Enfield', 'Segway', 'Sherco', 'Stärker', 'Super Soco', 'Suzuki', 'SYM', 'Talaria', 'Triumph',
    'TVS', 'United Motors', 'Vento', 'Vespa', 'Victory', 'Voge', 'Yadea', 'Yamaha', 'Zero', 'Zontes', 'Zuum'
];
workshop('marcasMoto').replaceChildren(...colombianBrands.sort((a, b) => a.localeCompare(b, 'es')).map(brand => new Option(brand)));

const findMotorbike = query => listaMotosCache.filter(moto => matchesWorkshop(query, moto.placa, moto.cliente_nombre, moto.cliente_cedula));
const motorbikeLabel = moto => `${moto.placa} · ${moto.cliente_nombre} · ${[moto.marca, moto.modelo].filter(Boolean).join(' ')}`;
searchResults('buscarMotoOrden', 'resultadosMotoOrden', findMotorbike, motorbikeLabel, moto => {
    workshop('ordenMotoId').value = moto.id;
    sugerirManoDeObra();
});

// Agenda
let appointments = [];
let appointmentClients = [];
let editingAppointment = null;
let appointmentClientId = null;
const appointmentForm = workshop('formCita');
const whatsappStatus = {
    aceptado: 'WhatsApp aceptado por Meta', sin_numero: 'Sin WhatsApp válido', pendiente: 'Enviando WhatsApp…',
    sin_configurar: 'Envío manual disponible', sin_confirmar: 'Envío automático sin confirmar'
};
const colombianDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });
const fechaColombia = () => colombianDate.format(new Date());

const refreshAppointmentSearch = searchResults('buscarCitaCliente', 'resultadosCitaCliente', query => {
    const withBikes = new Set(listaMotosCache.map(moto => moto.cliente_id));
    const withoutBikes = appointmentClients.filter(client => !withBikes.has(client.id) && matchesWorkshop(query, client.cedula, client.nombre));
    return findMotorbike(query).concat(withoutBikes);
}, item => item.placa ? motorbikeLabel(item) : `${item.nombre} · ${item.cedula || 'Sin cédula'} · Sin moto registrada`, item => {
    appointmentClientId = item.cliente_id || item.id;
    workshop('citaCliente').value = item.cliente_nombre || item.nombre;
    workshop('citaPlaca').value = item.placa || '';
    workshop('citaTelefono').value = item.cliente_telefono || item.telefono || '';
    workshop(item.placa ? 'citaFecha' : 'citaPlaca').focus();
});

workshop('buscarCitaCliente').addEventListener('focus', async () => {
    try {
        [listaMotosCache, appointmentClients] = await Promise.all([workshopApi('/motos'), workshopApi('/clientes')]);
        refreshAppointmentSearch();
    } catch (error) { workshop('msgCitaStatus').textContent = error.message; }
});
workshop('citaCliente').addEventListener('input', () => { appointmentClientId = null; });

function setAppointmentForm(item) {
    appointmentForm.reset();
    workshop('resultadosCitaCliente').hidden = true;
    editingAppointment = item?.id ?? null;
    appointmentClientId = item?.cliente_id ?? null;
    workshop('guardarCitaBtn').textContent = item ? 'Guardar cambios' : 'Agendar';
    workshop('cancelarEdicionCita').hidden = !item;
    if (!item) return;
    workshop('citaCliente').value = item.cliente_nombre;
    workshop('citaPlaca').value = item.moto_placa;
    workshop('citaTelefono').value = item.cliente_telefono;
    workshop('citaFecha').value = `${item.fecha_cita}T${item.hora_cita}`;
    workshop('citaMotivo').value = item.motivo;
    workshop('citaFecha').focus();
}

function updateAppointmentAlert() {
    const now = Date.now();
    const pending = appointments.filter(item => item.estado === 'Pendiente').map(item => ({
        item, time: Date.parse(`${item.fecha_cita}T${item.hora_cita}:00-05:00`)
    })).filter(({ time }) => time <= now + 3600000);
    const show = workshop('avisoCitas');
    show.hidden = !pending.length;
    const next = pending.find(({ time }) => time >= now) || pending.at(-1);
    const due = pending.filter(({ time }) => time <= now).length;
    const message = next ? `Citas · ${due} por atender · ${pending.length - due} en la próxima hora · ${next.item.hora_cita} ${next.item.moto_placa}` : '';
    if (show.textContent !== message) show.textContent = message;
}

async function cargarCitas() {
    try {
        appointments = await workshopApi('/citas');
        updateAppointmentAlert();
        const body = workshop('tablaCitasBody');
        body.replaceChildren(...appointments.map(item => {
            const row = document.createElement('tr');
            for (const value of [`#${item.id}`, item.cliente_nombre, item.moto_placa, `${item.fecha_cita} ${item.hora_cita}`,
                item.motivo, [item.estado, whatsappStatus[item.whatsapp_estado]].filter(Boolean).join(' · ')]) {
                row.insertCell().textContent = value;
            }
            const actions = row.insertCell();
            if (item.estado === 'Pendiente') actions.append(
                actionButton('Ingresar', () => convertirCitaAOrden(item.id, item.moto_placa, item.motivo)),
                actionButton('Editar', () => setAppointmentForm(item), 'Editar o reprogramar cita'),
                actionButton('Recordatorio por WhatsApp', () => openAppointmentReminder(item.id)),
                actionButton('Cancelar', () => cancelAppointment(item), 'Cancelar cita')
            );
            return row;
        }));
        if (!appointments.length) {
            const cell = body.insertRow().insertCell();
            cell.colSpan = 7;
            cell.textContent = 'No hay citas agendadas.';
        }
    } catch (error) { workshop('msgCitaStatus').textContent = error.message; }
}

async function openAppointmentReminder(id) {
    const electron = typeof require === 'function' && typeof process !== 'undefined' && process.versions?.electron ? require('electron') : null;
    const tab = electron ? null : window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
        const { url } = await workshopApi(`/citas/${id}/recordatorio`, 'POST');
        if (electron) await electron.shell.openExternal(url);
        else if (tab) tab.location.replace(url);
        else location.assign(url);
    } catch (error) {
        tab?.close();
        workshop('msgCitaStatus').textContent = error.message;
    }
}

function iniciarAgenda() {
    cargarCitas();
    setInterval(updateAppointmentAlert, 15000);
}

async function cancelAppointment(item) {
    if (!confirm(`¿Cancelar la cita de ${item.cliente_nombre} para la moto ${item.moto_placa}?`)) return;
    try {
        await workshopApi(`/citas/${item.id}`, 'DELETE');
        if (editingAppointment === item.id) setAppointmentForm();
        workshop('msgCitaStatus').textContent = 'Cita cancelada.';
        cargarCitas();
    } catch (error) { workshop('msgCitaStatus').textContent = error.message; }
}

workshop('cancelarEdicionCita').addEventListener('click', () => setAppointmentForm());
appointmentForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    const id = editingAppointment;
    const [fecha_cita, hora_cita] = workshop('citaFecha').value.split('T');
    try {
        const { whatsapp } = await workshopApi(id ? `/citas/${id}` : '/citas', id ? 'PUT' : 'POST', {
            cliente_id: appointmentClientId, cliente_nombre: workshop('citaCliente').value,
            moto_placa: workshop('citaPlaca').value, cliente_telefono: workshop('citaTelefono').value,
            fecha_cita, hora_cita, motivo: workshop('citaMotivo').value
        });
        setAppointmentForm();
        workshop('msgCitaStatus').textContent = `${id ? 'Cita actualizada' : 'Cita agendada'} · ${whatsappStatus[whatsapp]}`;
        cargarCitas();
    } catch (error) { workshop('msgCitaStatus').textContent = error.message; }
    finally { button.disabled = false; }
});

// Aprobación de acceso y reinicio
workshop('abrirRecuperaciones').addEventListener('click', () => {
    workshop('navConfig').click();
    workshop('gestionUsuarios').scrollIntoView({ block: 'start' });
});
workshop('ocultarCodigoAprobado').addEventListener('click', () => {
    workshop('codigoAprobado').value = '';
    workshop('entregarCodigoRecuperacion').hidden = true;
});
async function cargarRecuperaciones() {
    try {
        const requests = await workshopApi('/recuperaciones');
        const notice = workshop('avisoRecuperaciones');
        notice.hidden = !requests.length;
        workshop('estadoAvisoRecuperaciones').textContent = `⚠ Solicitudes de recuperación pendientes (${requests.length})`;
        const title = workshop('tituloSolicitudesRecuperacion');
        title.textContent = requests.length ? `⚠ Solicitudes de recuperación pendientes (${requests.length})` : 'Solicitudes de recuperación';
        title.classList.toggle('recovery-alarm-title', Boolean(requests.length));
        const list = workshop('listaRecuperaciones');
        list.replaceChildren(...requests.map(request => {
            const row = document.createElement('p');
            row.textContent = `${request.nombre} (${request.username}) `;
            const button = actionButton('Aprobar', async () => {
                if (!confirm(`¿Confirmaste la identidad de ${request.nombre}?`)) return;
                button.disabled = true;
                try {
                    const { codigo } = await workshopApi(`/recuperaciones/${request.id}/aprobar`, 'POST');
                    workshop('instruccionCodigoRecuperacion').textContent = `Comparte el código de un solo uso con ${request.nombre}. Vence en 15 minutos.`;
                    const field = workshop('codigoAprobado');
                    field.value = codigo;
                    workshop('entregarCodigoRecuperacion').hidden = false;
                    field.focus();
                    field.select();
                    cargarRecuperaciones();
                } catch (error) {
                    workshop('estadoRecuperaciones').textContent = error.message;
                    button.disabled = false;
                }
            });
            row.append(button);
            return row;
        }));
        if (!requests.length) list.textContent = 'No hay solicitudes pendientes.';
    } catch (error) { workshop('estadoRecuperaciones').textContent = error.message; }
}

function limpiarSistemaACero() {
    workshop('pedirCodigoReinicio').reset();
    workshop('confirmarReinicio').reset();
    workshop('confirmarReinicio').hidden = true;
    workshop('estadoReinicio').textContent = '';
    workshop('modalReinicio').showModal();
}

workshop('pedirCodigoReinicio').addEventListener('submit', async event => {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
        await workshopApi('/reset-sistema/codigo', 'POST', { password: workshop('passwordReinicio').value });
        workshop('estadoReinicio').textContent = 'WhatsApp aceptó el envío. El código vence en cinco minutos.';
        workshop('confirmarReinicio').hidden = false;
        workshop('codigoReinicio').focus();
    } catch (error) { workshop('estadoReinicio').textContent = error.message; }
    finally {
        workshop('passwordReinicio').value = '';
        event.submitter.disabled = false;
    }
});

workshop('confirmarReinicio').addEventListener('submit', async event => {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
        await workshopApi('/reset-sistema', 'POST', { codigo: workshop('codigoReinicio').value.trim() });
        location.reload();
    } catch (error) { workshop('estadoReinicio').textContent = error.message; }
    finally { event.submitter.disabled = false; }
});

// Factura digital
const invoiceFrame = workshop('documentoFactura');
const printInvoiceButton = workshop('imprimirVistaFactura');
const pdfInvoiceButton = workshop('abrirPdfFactura');
const invoiceElectron = typeof require === 'function' && typeof process !== 'undefined' && process.versions?.electron ? require('electron') : null;
let invoicePrinter = {};
pdfInvoiceButton.hidden = !invoiceElectron;

async function outputInvoice(direct) {
    if (!invoiceElectron) {
        invoiceFrame.contentWindow.print();
        return;
    }
    const request = invoiceRequest;
    const status = workshop('estadoVistaFactura');
    pdfInvoiceButton.disabled = printInvoiceButton.disabled = true;
    status.textContent = direct && invoicePrinter.printerName ? 'Enviando a la impresora…' : 'Preparando el PDF…';
    try {
        const result = await invoiceElectron.ipcRenderer.invoke('factura:abrirVistaImpresion', invoiceFrame.srcdoc, { ...invoicePrinter, direct });
        if (request === invoiceRequest) status.textContent = result === 'impresa'
            ? `Factura enviada a ${invoicePrinter.printerName}.` : 'Factura abierta en el lector de PDF.';
    } catch (error) {
        if (request === invoiceRequest) status.textContent = error.message || 'No se pudo imprimir la factura.';
    } finally {
        if (request === invoiceRequest) pdfInvoiceButton.disabled = printInvoiceButton.disabled = false;
    }
}

printInvoiceButton.addEventListener('click', () => outputInvoice(true));
pdfInvoiceButton.addEventListener('click', () => outputInvoice(false));
invoiceFrame.addEventListener('load', () => {
    pdfInvoiceButton.disabled = printInvoiceButton.disabled = !invoiceFrame.contentDocument?.getElementById('documento-venta');
});

let invoiceRequest = 0;
async function imprimirFactura(ordenId) {
    const request = ++invoiceRequest;
    const dialog = workshop('vistaFactura');
    const status = workshop('estadoVistaFactura');
    pdfInvoiceButton.disabled = printInvoiceButton.disabled = true;
    invoiceFrame.srcdoc = '';
    status.textContent = 'Cargando factura…';
    if (!dialog.open) dialog.showModal();
    try {
        const id = Number(ordenId);
        const [orders, parts, config] = await Promise.all([
            workshopApi(`/ordenes?buscar=${id}`), workshopApi(`/ordenes/${id}/detalles`), workshopApi('/config')
        ]);
        if (request !== invoiceRequest) return;
        const order = orders.find(item => Number(item.id) === id);
        if (!order) throw new Error('No se encontró la orden.');
        const charged = order.estado === 'Facturada';
        invoicePrinter = { printerName: config.impresora_nombre, format: config.impresora_formato };
        const amount = charged || order.mano_obra_confirmada ? Number(order.costo_mano_obra || 0) : null;
        const labor = order.mano_obra_reporte ? `Mano de obra · ${order.mano_obra_reporte}` : 'Mano de obra';
        const lines = [...parts.map(part => [part.repuesto_nombre, part.cantidad, part.precio_unitario]), [labor, 1, amount]];
        const total = lines.reduce((sum, [, quantity, price]) => sum + quantity * price, 0);
        const totalLabel = lines.some(([, , price]) => price == null) ? 'Pendiente de precios' : moneyCOP.format(total);
        const rows = lines.map(([description, quantity, price]) => `<tr><td>${escaparHTML(description)}</td>
            <td>${Number(quantity)}</td><td>${price == null ? 'Pendiente' : moneyCOP.format(price)}</td><td>${price == null ? '—' : moneyCOP.format(quantity * price)}</td></tr>`).join('');
        const contact = [config.direccion_taller, config.telefono_taller, config.email_taller].filter(Boolean).map(escaparHTML).join(' · ');
        invoiceFrame.srcdoc = `<!doctype html><html lang="es"><meta charset="utf-8"><title>${charged ? 'Factura' : 'Resumen'} #${id}</title>
            <link rel="stylesheet" href="/operacion-taller.css">
            <body class="invoice-page"><main class="invoice-sheet" id="documento-venta">
            <header class="invoice-brand"><img src="/icon.png" alt="" width="68" height="68"><div>
                <strong>${escaparHTML(config.nombre_taller)}</strong>
                <div>${config.nit_taller ? 'NIT ' + escaparHTML(config.nit_taller) : ''}</div><small>${contact}</small>
            </div></header>
            <section class="invoice-content">
                <h1>${charged ? 'Factura de venta' : 'Resumen de servicio'} #${id}</h1>
                <dl><dt>Cliente</dt><dd>${escaparHTML(order.cliente_nombre)}${order.cliente_cedula ? ' · CC ' + escaparHTML(order.cliente_cedula) : ''}</dd>
                    <dt>Moto</dt><dd>${escaparHTML(order.moto_marca)} · ${escaparHTML(order.moto_placa)}</dd>
                    <dt>Trabajo realizado</dt><dd>${escaparHTML(order.trabajo_realizado || 'Sin descripción')}</dd></dl>
                <table><thead><tr><th>Descripción</th><th>Cantidad</th><th>Precio unitario</th><th>Importe</th></tr></thead>
                    <tbody>${rows}</tbody></table>
                <p class="invoice-total">Total <strong>${totalLabel}</strong></p>
            </section></main></body></html>`;
        status.textContent = '';
    } catch (error) {
        if (request === invoiceRequest) status.textContent = error.message;
    }
}
