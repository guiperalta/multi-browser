// Open a WhatsApp Web conversation in place, without reloading the page.
//
// Loading https://web.whatsapp.com/send?phone=... works, but it reloads the
// whole app (chat list, sync, encryption keys) — several seconds. WhatsApp Web
// already has the code to open a chat by number; it runs when you click a
// wa.me link inside a message. We call the same internal modules directly in
// the page's main world:
//
//   WAWebWidFactory.createWid('<phone>@c.us')        -> user id
//   WAWebFindChatAction.findOrCreateLatestChat(wid)  -> chat (asks the server
//                                                       when the number is new;
//                                                       throws if it is not on
//                                                       WhatsApp)
//   WAWebCmd.Cmd.openChatBottom({chat, chatEntryPoint})
//
// The prefilled text is then pasted into the composer, which the editor treats
// like a user paste (multi-line text keeps its line breaks).
//
// These are private modules and WhatsApp can rename them. Every step is
// checked; on any failure the script resolves { ok: false } and the caller
// falls back to the old full reload, so a WhatsApp update degrades to "slow",
// never to "broken".

function openChatInPage(phone, text) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const fail = (reason) => ({ ok: false, reason });

    const waitFor = async (fn, timeoutMs) => {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            const value = fn();
            if (value) return value;
            await sleep(50);
        }
        return null;
    };

    const composerText = (el) => (el.innerText || '').replace(/\s+/g, ' ').trim();

    return (async () => {
        // Logged in and past the loading screen: the chat list is on screen.
        if (!document.querySelector('#pane-side')) return fail('chat list not ready');

        const req = window.require;
        if (typeof req !== 'function') return fail('no module loader');

        let WidFactory, FindChat, Cmd, ChatEntryPoint;
        try {
            WidFactory = req('WAWebWidFactory');
            FindChat = req('WAWebFindChatAction');
            Cmd = req('WAWebCmd').Cmd;
            ChatEntryPoint = req('WAWebChatEntryPoint').ChatEntryPoint;
        } catch (e) {
            return fail('module missing: ' + e.message);
        }
        if (!WidFactory?.createWid || !FindChat?.findOrCreateLatestChat || !Cmd?.openChatBottom) {
            return fail('module API changed');
        }

        let chat;
        try {
            const wid = WidFactory.createWid(phone + '@c.us');
            chat = await FindChat.findOrCreateLatestChat(wid, 'deeplink');
            // Some versions wrap the chat as { chat, created }
            if (chat && chat.chat && !chat.id) chat = chat.chat;
        } catch (e) {
            // Usually "not on WhatsApp": the reload path shows WhatsApp's own
            // message for that, so let it handle the case.
            return fail('chat lookup failed: ' + (e && e.message));
        }
        if (!chat || !chat.id) return fail('no chat returned');

        let opened;
        try {
            opened = await Cmd.openChatBottom({
                chat,
                chatEntryPoint: ChatEntryPoint?.Deeplink ?? ChatEntryPoint?.Chatlist,
            });
        } catch (e) {
            return fail('openChatBottom threw: ' + (e && e.message));
        }
        if (opened === false) return fail('openChatBottom refused');

        if (!text) return { ok: true };

        // The conversation pane re-renders after opening; wait for its composer.
        const composer = await waitFor(
            () => document.querySelector('#main footer [contenteditable="true"]'),
            4000
        );
        if (!composer) return { ok: true, textInserted: false, reason: 'composer not found' };

        composer.focus();
        // Replace any draft already in the box, like the reload path does.
        document.execCommand('selectAll', false, null);

        try {
            const data = new DataTransfer();
            data.setData('text/plain', text);
            composer.dispatchEvent(new ClipboardEvent('paste', {
                clipboardData: data, bubbles: true, cancelable: true,
            }));
        } catch (e) { /* fall through to insertText */ }

        const want = text.replace(/\s+/g, ' ').trim();
        let inserted = !!(await waitFor(() => composerText(composer) === want, 600));
        if (!inserted) {
            composer.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
            inserted = !!(await waitFor(() => composerText(composer) === want, 600));
        }
        return { ok: true, textInserted: inserted };
    })();
}

// Source to run with webContents.executeJavaScript (main world). Arguments are
// JSON-encoded, so a crafted text= value cannot break out of the string.
function buildOpenChatScript(phone, text) {
    return `(${openChatInPage.toString()})(${JSON.stringify(String(phone))}, ${JSON.stringify(text || '')})`;
}

module.exports = { buildOpenChatScript };
