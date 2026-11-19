const ordersList = document.getElementById('contenedorOrdenesMovil');
const search = document.getElementById('inputBuscarMovil');
const connection = document.getElementById('connStatus');
const stockAlert = document.getElementById('stockAlert');
const cards = new Map();
let orders = [];
let inventory = [];
let orderRequest = 0;

const openStates = new Set(['En proceso', 'Terminada', 'Listo para entrega']);
const escapeText = value => String(value ?? '').replace(/[&<>]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;'
})[char]);

async function api(route, method = 'GET', data) {
    const response = await fetch('/api' + route, {
        method,
        headers: data ? { 'Content-Type': 'application/json' } : undefined,
        body: data ? JSON.stringify(data) : undefined
    });
    if (response.status === 401) location.replace('/');
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.mensaje || 'No se pudo completar la operación.');
    return result;
}

function feedback(target, message = '', error = false) {
    target.textContent = message;
    target.dataset.error = String(error);
}

function facts(order) {
    return [
        ['Placa', order.moto_placa || 'Sin placa'],
        ['Modelo', [order.moto_marca, order.moto_modelo].filter(Boolean).join(' ') || 'Sin registrar'],
        ['Cliente', order.cliente_nombre || 'Sin registrar'],
        ['Motivo / diagnóstico', order.motivo_ingreso || 'Sin registrar'],
        ['Trabajo reportado', order.trabajo_realizado || 'Sin avances registrados']
    ].map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeText(value)}</dd></div>`).join('');
}

function createCard(order) {
    const card = document.createElement('article');
    const id = Number(order.id);
    const active = order.estado === 'En proceso';
    card.className = 'order panel-taller';
    card.dataset.order = id;
    card.dataset.state = order.estado;
    card.setAttribute('aria-labelledby', 'order-title-' + id);
    card.innerHTML = `
        <section class="order-section">
            <div class="order-caption">
                <h2 id="order-title-${id}">Orden #${id}</h2>
                <span class="state${active ? '' : ' done'}">${active ? 'En reparación' : 'Terminada'}</span>
            </div>
            <dl class="facts"></dl>
            ${active ? `<form data-action="progress">
                <label>Nuevo avance
                    <textarea name="avance" rows="2" maxlength="4000" required></textarea>
                </label>
                <button class="secondary">Guardar avance</button>
                <p class="feedback" role="status"></p>
            </form>` : ''}
        </section>
        <section class="order-section" data-parts-section>
            <h3>Repuestos</h3>
            <ul class="parts" data-parts><li>Cargando repuestos utilizados…</li></ul>
            ${active ? `<form data-action="parts">
                <label>Buscar repuesto
                    <input type="search" name="buscar" placeholder="Nombre o código" autocomplete="off">
                </label>
                <label>Repuesto de inventario
                    <select name="repuesto" required></select>
                </label>
                <label>Cantidad utilizada
                    <input type="number" name="cantidad" inputmode="numeric" value="1" min="1" step="1" required>
                </label>
                <button class="secondary">Añadir repuesto</button>
                <p class="feedback" role="status"></p>
            </form>` : ''}
        </section>
        <section class="order-section" data-evidence>
            <h3>Evidencia fotográfica</h3>
            ${active ? `<label>Descripción de la foto
                <input type="text" name="descripcion" maxlength="500" placeholder="Ej. Disco de freno desgastado">
            </label>
            <p class="hint">Las fotos reportadas se comparten en el seguimiento de esta orden.</p>
            <button type="button" class="secondary" data-camera>Abrir cámara</button>
            <input type="file" data-native-camera accept="image/jpeg,image/png,image/webp" capture="environment" hidden>
            <label>Adjuntar foto
                <input type="file" accept="image/jpeg,image/png,image/webp">
            </label>
            <p class="feedback" role="status"></p>` : ''}
            <div class="gallery" data-gallery>Cargando evidencias…</div>
        </section>
        ${active ? `<section class="order-section" data-order-close>
            <button type="button" class="primary" data-finish>Marcar como Terminada</button>
            <p class="feedback" role="status"></p>
        </section>` : ''}`;
    card.querySelector('.facts').innerHTML = facts(order);
    const partsForm = card.querySelector('[data-action="parts"]');
    if (partsForm) fillInventory(partsForm);
    refreshParts(card);
    refreshPhotos(card);
    return card;
}

function renderOrders() {
    const query = search.value.trim().toLowerCase();
    const current = orders.filter(order => openStates.has(order.estado));
    const currentIds = new Set(current.map(order => Number(order.id)));
    const visible = current.filter(order =>
        [order.id, order.moto_placa, order.moto_modelo, order.moto_marca, order.cliente_nombre]
            .some(value => String(value ?? '').toLowerCase().includes(query)));
    const visibleIds = new Set(visible.map(order => Number(order.id)));
    for (const [id, card] of cards) {
        if (!currentIds.has(id)) {
            card.remove();
            cards.delete(id);
        } else if (!visibleIds.has(id)) {
            card.hidden = true;
        }
    }
    ordersList.querySelector('[data-empty]')?.remove();
    let lastCard = null;
    for (const order of visible) {
        const id = Number(order.id);
        const previous = cards.get(id);
        if (previous?.dataset.state === order.estado) {
            previous.hidden = false;
            previous.querySelector('.facts').innerHTML = facts(order);
            lastCard = previous;
            continue;
        }
        const card = createCard(order);
        if (previous) previous.replaceWith(card);
        else if (lastCard) lastCard.after(card);
        else ordersList.prepend(card);
        cards.set(id, card);
        lastCard = card;
    }
    if (!visible.length) {
        const empty = document.createElement('p');
        empty.dataset.empty = '';
        empty.setAttribute('role', 'status');
        empty.textContent = 'No hay órdenes para esta búsqueda.';
        ordersList.append(empty);
    }
}

async function loadOrders() {
    const request = ++orderRequest;
    const result = await api('/ordenes');
    if (request !== orderRequest) return;
    orders = result;
    ordersList.querySelector(':scope > p:not([data-empty])')?.remove();
    renderOrders();
}

function fillInventory(form) {
    const select = form.elements.repuesto;
    const selection = select.value;
    const query = form.elements.buscar.value.trim().toLowerCase();
    select.replaceChildren(new Option('Selecciona un repuesto', ''));
    for (const part of inventory) {
        if (!`${part.nombre} ${part.codigo || ''}`.toLowerCase().includes(query)) continue;
        select.add(new Option(`${part.nombre} · Stock ${part.stock}`, part.id));
    }
    select.value = [...select.options].some(option => option.value === selection) ? selection : '';
}

async function loadInventory() {
    inventory = await api('/inventario');
    ordersList.querySelectorAll('[data-action="parts"]').forEach(fillInventory);
}

async function refreshParts(card) {
    const list = card.querySelector('[data-parts]');
    try {
        const parts = await api(`/ordenes/${card.dataset.order}/detalles`);
        list.innerHTML = parts.length
            ? parts.map(part => `<li>${escapeText(part.repuesto_nombre)} · ${Number(part.cantidad)} un.</li>`).join('')
            : '<li>Aún no hay repuestos registrados.</li>';
    } catch {
        list.innerHTML = '<li>No se pudieron cargar los repuestos.</li>';
    }
}

async function refreshPhotos(card) {
    const gallery = card.querySelector('[data-gallery]');
    try {
        const photos = await api(`/ordenes/${card.dataset.order}/fotos`);
        gallery.replaceChildren(...photos.map(photo => {
            const figure = document.createElement('figure');
            const link = document.createElement('a');
            link.href = photo.url;
            link.target = '_blank';
            link.rel = 'noopener';
            const image = document.createElement('img');
            image.src = photo.url;
            image.loading = 'lazy';
            image.alt = photo.descripcion || 'Evidencia de la reparación';
            link.append(image);
            const caption = document.createElement('figcaption');
            caption.textContent = photo.descripcion || '';
            figure.append(link, caption);
            return figure;
        }));
        if (!photos.length) gallery.textContent = 'Aún no hay fotos.';
    } catch {
        gallery.textContent = 'No se pudieron cargar las fotos.';
    }
}

async function savePhoto(section, file) {
    if (!file || !section.isConnected || section.dataset.busy) return;
    const status = section.querySelector('.feedback');
    if (file.size > 10 * 1024 * 1024) {
        feedback(status, 'La foto debe pesar hasta 10 MB.', true);
        return;
    }
    const controls = section.querySelectorAll('button, input');
    section.dataset.busy = 'true';
    controls.forEach(control => { control.disabled = true; });
    feedback(status, 'Guardando evidencia…');
    try {
        const image = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
            reader.readAsDataURL(file);
        });
        const card = section.closest('.order');
        await api(`/ordenes/${card.dataset.order}/fotos`, 'POST', {
            imagen_base64: image, descripcion: section.querySelector('[name="descripcion"]').value.trim()
        });
        feedback(status, 'Evidencia guardada.');
        await refreshPhotos(card);
    } catch (error) {
        feedback(status, error.message, true);
    } finally {
        delete section.dataset.busy;
        controls.forEach(control => { control.disabled = false; });
    }
}

ordersList.addEventListener('submit', async event => {
    const form = event.target;
    if (!form.dataset.action) return;
    event.preventDefault();
    const card = form.closest('.order');
    const route = `/ordenes/${card.dataset.order}`;
    const button = form.querySelector('button');
    const status = form.querySelector('.feedback');
    button.disabled = true;
    try {
        if (form.dataset.action === 'parts') {
            const result = await api(route + '/repuestos', 'POST', {
                repuesto_id: form.elements.repuesto.value, cantidad: Number(form.elements.cantidad.value)
            });
            form.reset();
            feedback(status, result.mensaje);
            if (result.stock_insuficiente && !stockAlert.open) {
                document.getElementById('alarmaStockDetalle').textContent = result.mensaje;
                stockAlert.showModal();
            }
            await Promise.all([loadInventory(), refreshParts(card)]);
        } else {
            const advance = form.elements.avance.value.trim();
            if (!advance) throw new Error('Escribe el nuevo avance.');
            await api(route + '/reportar', 'PUT', { trabajo_realizado: advance });
            form.reset();
            feedback(status, 'Avance guardado.');
            await loadOrders();
        }
    } catch (error) {
        feedback(status, error.message, true);
    } finally {
        button.disabled = false;
    }
});

ordersList.addEventListener('input', event => {
    if (event.target.name === 'buscar') fillInventory(event.target.form);
});
ordersList.addEventListener('change', event => {
    const input = event.target;
    if (input.type !== 'file') return;
    const file = input.files[0];
    input.value = '';
    savePhoto(input.closest('[data-evidence]'), file);
});
ordersList.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-camera')) {
        const section = button.closest('[data-evidence]');
        if (!navigator.mediaDevices?.getUserMedia) {
            section.querySelector('[data-native-camera]').click();
        } else {
            savePhoto(section, await capturarEvidencia());
        }
    }
    if (!button.hasAttribute('data-finish')) return;
    const id = button.closest('.order').dataset.order;
    if (!confirm(`¿Marcar la orden #${id} como terminada y avisar a recepción?`)) return;
    button.disabled = true;
    try {
        await api(`/ordenes/${id}/estado`, 'PUT', { estado: 'Terminada' });
        await loadOrders();
    } catch (error) {
        feedback(button.parentElement.querySelector('.feedback'), error.message, true);
    } finally {
        button.disabled = false;
    }
});

search.addEventListener('input', renderOrders);
document.getElementById('salirMecanico').addEventListener('click', async () => {
    try {
        await api('/logout', 'POST');
        location.replace('/');
    } catch (error) {
        connection.textContent = error.message;
    }
});

async function init() {
    try {
        const session = await api('/session');
        if (session.rol !== 'Mecanico') {
            location.replace('/dashboard.html');
            return;
        }
        await Promise.all([loadInventory(), loadOrders()]);
        const stream = new EventSource('/api/sync-events');
        stream.addEventListener('sesion_revocada', () => location.replace('/'));
        stream.onopen = () => { connection.textContent = 'Conectado'; };
        stream.onerror = () => { connection.textContent = 'Reconectando…'; };
        stream.addEventListener('sync', event => {
            const { tipo, data } = JSON.parse(event.data);
            const card = cards.get(Number(data.ordenId ?? data.orden_id));
            if (tipo === 'orden_actualizada' && data.accion === 'repuesto_agregado') {
                loadInventory().catch(error => { connection.textContent = error.message; });
                if (card) refreshParts(card);
            } else if (tipo === 'orden_actualizada' || tipo === 'asignacion_actualizada') {
                loadOrders().catch(error => { connection.textContent = error.message; });
            } else if (card && ['foto_agregada', 'foto_eliminada'].includes(tipo)) {
                refreshPhotos(card);
            }
        });
    } catch (error) {
        connection.textContent = error.message;
        ordersList.textContent = 'No se pudo cargar la vista de órdenes. Recarga la página para volver a intentar.';
    }
}

init();
