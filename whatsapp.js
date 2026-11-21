function whatsappNumber(value) {
    const digits = String(value || '').replace(/\D/g, '');
    const number = digits.length === 10 ? '57' + digits : digits;
    return /^[1-9]\d{10,14}$/.test(number) ? number : '';
}

async function sendTemplate(recipient, name, language, components) {
    const { WHATSAPP_PHONE_ID: phoneId, WHATSAPP_ACCESS_TOKEN: token,
        WHATSAPP_GRAPH_VERSION: version } = process.env;
    const to = whatsappNumber(recipient);
    if (!to) return 'sin_numero';
    if (!name || !token || !/^\d+$/.test(phoneId || '') || !/^v\d+\.\d+$/.test(version || '')) return 'sin_configurar';
    try {
        const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(8000),
            body: JSON.stringify({
                messaging_product: 'whatsapp', to, type: 'template',
                template: { name, language: { code: language }, components }
            })
        });
        if (response.ok && (await response.json()).messages?.[0]?.id) return 'aceptado';
    } catch {
        // The caller decides how to handle an unconfirmed submission.
    }
    return 'sin_confirmar';
}

const textParameter = value => ({ type: 'text', text: String(value).replace(/\s+/g, ' ').trim() });

function sendAppointmentConfirmation(recipient, values) {
    return sendTemplate(recipient, process.env.WHATSAPP_CITA_TEMPLATE, process.env.WHATSAPP_LANGUAGE || 'es_CO',
        [{ type: 'body', parameters: values.map(textParameter) }]);
}

function sendResetCode(recipient, code) {
    const parameters = [textParameter(code)];
    return sendTemplate(recipient, process.env.WHATSAPP_RESET_TEMPLATE, process.env.WHATSAPP_RESET_LANGUAGE || 'es', [
        { type: 'body', parameters }, { type: 'button', sub_type: 'url', index: '0', parameters }
    ]);
}

function sendRecoveryNotice(recipient, username) {
    return sendTemplate(recipient, process.env.WHATSAPP_RECOVERY_TEMPLATE, process.env.WHATSAPP_LANGUAGE || 'es_CO',
        [{ type: 'body', parameters: [textParameter(username)] }]);
}

module.exports = { whatsappNumber, sendAppointmentConfirmation, sendResetCode, sendRecoveryNotice };
