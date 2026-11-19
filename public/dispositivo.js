function esDispositivoTactilPortatil() {
    const ua = navigator.userAgent || '';
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    if (navigator.userAgentData?.mobile || /Android|iPad|iPhone|iPod|Tablet|Silk/i.test(ua)) return true;
    if (/^Mac/i.test(platform) && navigator.maxTouchPoints > 1) return true;
    return navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches &&
        !matchMedia('(hover: hover)').matches;
}

document.documentElement.classList.toggle('touch-device', esDispositivoTactilPortatil());
