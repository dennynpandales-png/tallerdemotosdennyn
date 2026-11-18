const form = document.getElementById('consulta');
const code = document.getElementById('codigo');
const message = document.getElementById('mensaje');
const result = document.getElementById('resultado');
const gallery = document.getElementById('fotos');
const timeline = document.getElementById('bitacora');
const button = form.querySelector('button');
const imageUrls = [];

if (/^#[a-f0-9]{64}$/.test(location.hash)) {
    code.value = location.hash.slice(1);
    document.getElementById('codigoCampo').hidden = true;
}

const dateFormat = new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota'
});
function formatDate(value) {
    if (!value) return '';
    const date = new Date(value.replace(' ', 'T') + 'Z');
    return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
}
function element(tag, value) {
    const node = document.createElement(tag);
    node.textContent = value;
    return node;
}

form.addEventListener('submit', async event => {
    event.preventDefault();
    button.disabled = true;
    result.hidden = true;
    message.textContent = 'Consultando la orden…';
    imageUrls.splice(0).forEach(url => URL.revokeObjectURL(url));
    gallery.replaceChildren();
    const request = {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + code.value.trim(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ identificador: document.getElementById('identificador').value.trim().replace(/^#/, '') })
    };
    try {
        const response = await fetch('/seguimiento/consulta', request);
        if (response.status === 404) {
            message.textContent = 'Revisa la placa o número de orden y el código que te compartió el taller.';
            return;
        }
        if (!response.ok) throw new Error();
        const { orden, bitacora, fotos } = await response.json();
        document.getElementById('orden').textContent = 'Orden #' + orden.id + ' · ' + orden.placa;
        document.getElementById('estado').textContent = 'Estado actual: ' + orden.estado;
        timeline.replaceChildren(...bitacora.map(entry => {
            const item = element('li', entry.tipo + ' · ' + entry.descripcion);
            if (!entry.tipo.endsWith('anterior')) item.append(element('time', formatDate(entry.fecha)));
            return item;
        }));
        message.textContent = '';
        result.hidden = false;
        if (!fotos.length) gallery.textContent = 'Aún no hay evidencias disponibles.';
        await Promise.all(fotos.map(async photo => {
            const figure = element('figure', '');
            const caption = element('figcaption', photo.descripcion);
            caption.append(element('time', formatDate(photo.fecha)));
            figure.append(caption);
            gallery.append(figure);
            try {
                const response = await fetch('/seguimiento/fotos/' + photo.id, request);
                if (!response.ok) throw new Error();
                const url = URL.createObjectURL(await response.blob());
                imageUrls.push(url);
                const image = element('img', '');
                image.alt = photo.descripcion;
                image.src = url;
                figure.prepend(image);
            } catch {
                figure.append(element('small', 'Foto no disponible.'));
            }
        }));
    } catch {
        message.textContent = 'No fue posible consultar la orden. Inténtalo de nuevo.';
    } finally {
        button.disabled = false;
    }
});
