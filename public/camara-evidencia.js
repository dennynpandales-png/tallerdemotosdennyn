async function capturarEvidencia() {
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'width:min(92vw,560px);color:#162331;background:#fff;padding:1rem;border-radius:.6rem';
    dialog.innerHTML = `<h2 id="tituloCamaraEvidencia">Cámara de evidencia</h2>
        <video autoplay playsinline muted style="width:100%;max-height:60vh;background:#162331"></video>
        <p role="status">Abriendo cámara…</p>
        <button type="button" data-capture disabled>Capturar y reportar</button>
        <button type="button" data-close>Cerrar</button>`;
    dialog.setAttribute('aria-labelledby', 'tituloCamaraEvidencia');
    const video = dialog.querySelector('video');
    const capture = dialog.querySelector('[data-capture]');
    const status = dialog.querySelector('[role=status]');
    let stream;
    let photo;
    let active = true;
    const finished = new Promise(resolve => {
        dialog.addEventListener('close', () => {
            active = false;
            stream?.getTracks().forEach(track => track.stop());
            video.srcObject = null;
            dialog.remove();
            resolve(photo);
        }, { once: true });
    });
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    capture.onclick = () => {
        if (!video.videoWidth) return;
        capture.disabled = true;
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
            if (!active) return;
            if (!blob) {
                status.textContent = 'No se pudo capturar la imagen. Intenta de nuevo.';
                capture.disabled = false;
                return;
            }
            photo = new File([blob], 'evidencia.jpg', { type: 'image/jpeg' });
            dialog.close();
        }, 'image/jpeg', 0.9);
    };
    document.body.append(dialog);
    dialog.showModal();
    (async () => {
        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                status.textContent = 'La cámara directa requiere HTTPS o abrir la aplicación en este equipo. También puedes usar el selector del dispositivo.';
                return;
            }
            const camera = await navigator.mediaDevices.getUserMedia({
                audio: false, video: { facingMode: { ideal: 'environment' } }
            });
            if (!active) {
                camera.getTracks().forEach(track => track.stop());
                return;
            }
            stream = camera;
            video.srcObject = stream;
            const enableCapture = () => {
                if (!active || !video.videoWidth) return;
                status.textContent = '';
                capture.disabled = false;
            };
            video.addEventListener('loadeddata', enableCapture);
            await video.play();
            enableCapture();
        } catch {
            if (active) status.textContent = 'No se pudo abrir la cámara. Revisa los permisos o usa el selector del dispositivo.';
        }
    })();
    return finished;
}
